import path from 'node:path';
import {
  deleteLocalData,
  deleteLocalFileData,
  downloadCategoryDir,
  extractCategory,
  legacyDownloadLocalRoot,
  resolveDownloadRoot,
} from '../download/paths.js';
import { logger } from '../logger.js';
import { PutioClient } from '../putio/client.js';
import { calculateTransmissionProgress } from '../transmission/progress.js';
// The preset the dashboard writes into a profile; plain data with no imports of
// its own, so the one spelling serves both the browser and this process.
import { GRAB_PROFILE_TYPE, SHARED_RPC_PATH } from '../web/constants.js';

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function deriveHashFromSource(source) {
  if (!source || !String(source).startsWith('magnet:')) return '';
  const text = String(source);
  const queryStart = text.indexOf('?');
  if (queryStart < 0) return '';
  const params = new URLSearchParams(text.slice(queryStart + 1));
  for (const xt of params.getAll('xt')) {
    const match = String(xt).match(/^urn:btih:([^&]+)$/i);
    if (match) return match[1].trim().toLowerCase();
  }
  return '';
}

function deriveNameFromSource(source) {
  if (!source) return 'unknown';
  if (source.startsWith('magnet:')) {
    const params = new URLSearchParams(source.slice(source.indexOf('?') + 1));
    return params.get('dn') ?? source;
  }
  return path.basename(source);
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

const READY_REMOTE_STATUSES = new Set(['COMPLETED', 'SEEDING']);

function remoteDeleteErrorMessage(errors) {
  const messages = errors
    .map((error) => error?.message)
    .filter(Boolean);
  return `Failed to delete from put.io${messages.length > 0 ? `: ${messages.join('; ')}` : ''}`;
}

// One error standing for several, without losing what they said. A 404 from
// put.io is not a failure to retry but an answer — the remote is already gone —
// and callers branch on that, so the status has to survive the wrapping. It is
// only carried up when every underlying error agrees: a mixed batch is not a
// single verdict.
function remoteDeleteError(errors) {
  const aggregate = new Error(remoteDeleteErrorMessage(errors));
  aggregate.causes = errors;
  const statuses = new Set(errors.map((error) => error?.status));
  if (statuses.size === 1) {
    const [status] = statuses;
    if (status !== undefined) aggregate.status = status;
  }
  return aggregate;
}

// Named the same way wherever it surfaces — the dashboard, the RPC result, the
// log — so a user who sees it in one place can search for it in another. After
// phase 3 only a hand-edited database can reach it; the legacy rows that used
// to are quarantined in orphaned_downloads, where the dashboard offers a
// profile picker and a delete control.
export function ownerlessDownloadMessage(transfer) {
  return `Download ${transfer?.id ?? '(unknown)'} (${transfer?.name ?? 'unnamed'}) has no owning RR profile;`
    + ' reassign it from the dashboard or delete it';
}

// A Transmission id may be a download id or a torrent hash. Only the first
// identifies exactly one download: the hash is informational and not unique.
function isDownloadId(identifier) {
  return typeof identifier === 'number' || /^\d+$/.test(String(identifier));
}

function isTransferStillListed(transfer, remoteIds, remoteHashes) {
  return (
    (transfer.putio_transfer_id != null && remoteIds.has(transfer.putio_transfer_id)) ||
    (transfer.hash && remoteHashes.has(String(transfer.hash).trim().toLowerCase()))
  );
}

function putioTransferToStoreInput(transfer, fallback = {}) {
  const lifecycle = fallback.lifecycle ?? 'remote';
  const useLocalMetrics = lifecycle !== 'remote';
  return {
    profile_id: fallback.profile_id,
    putio_transfer_id: transfer.id ?? fallback.putio_transfer_id,
    putio_file_id: transfer.fileId ?? fallback.putio_file_id,
    save_parent_id: transfer.saveParentId ?? fallback.save_parent_id,
    // put.io's report wins over what we derived from the source, and an
    // absent report changes nothing (the store keeps the stored hash). It
    // used to be 20 random bytes when neither side knew: a permanent identity
    // no *arr could ever correlate and put.io could never confirm. Empty is
    // the honest answer until put.io reports one.
    hash: transfer.hash || fallback.hash || '',
    name: transfer.name || fallback.name || deriveNameFromSource(fallback.source),
    source: fallback.source ?? transfer.magnetUri ?? '',
    source_type: fallback.source_type ?? 'remote',
    category: fallback.category,
    lifecycle,
    putio_status: transfer.status,
    putio_status_message: transfer.statusMessage,
    putio_peers: transfer.peers,
    putio_availability: transfer.availability,
    percent_done: transfer.percentDone,
    completion_percent: transfer.completionPercent,
    total_size: transfer.size,
    downloaded_ever: transfer.downloaded,
    uploaded_ever: transfer.uploaded,
    download_speed: useLocalMetrics
      ? fallback.download_speed ?? 0
      : transfer.downloadSpeed,
    upload_speed: transfer.uploadSpeed,
    eta: useLocalMetrics
      ? fallback.eta ?? -1
      : transfer.estimatedTime,
    error: Boolean(transfer.errorMessage),
    error_string: transfer.errorMessage ?? '',
    reactivate: fallback.reactivate,
  };
}

export class TransferService {
  constructor({ config, store, putioFactory } = {}) {
    this.config = config;
    this.store = store;
    this.putioFactory = putioFactory ?? ((token) => new PutioClient({ token }));
    this.putioClient = undefined;
    this.putioToken = undefined;
  }

  getPutioToken() {
    return this.store.getSetting('putio_token') || this.config.putioToken;
  }

  getPutio() {
    const token = this.getPutioToken();
    if (!token) {
      throw new Error('Put.io is not connected. Configure a token in the web UI first.');
    }
    if (!this.putioClient || this.putioToken !== token) {
      this.putioToken = token;
      this.putioClient = this.putioFactory(token);
    }
    return this.putioClient;
  }

  // The *arr side of putiorr — every RPC endpoint and everything torrent-add
  // resolves through — chooses only from these. A Putiorr Grab profile is
  // reachable exclusively through /api/grab, which always names the profile it
  // means, so nothing an *arr sends can select one: not the shared endpoint,
  // not a download-dir category, not the client's own name. A grab profile
  // whose slug, name or preset happens to read like an *arr category would
  // otherwise either swallow that download into a folder nothing imports from,
  // or refuse the add and point at an RPC path its wizard never shows.
  listArrProfiles() {
    return this.store.listProfiles().filter((profile) => profile.type !== GRAB_PROFILE_TYPE);
  }

  // The one mechanism. An RPC request is owned by the profile whose path it
  // arrived on; the shared path serves exactly one *arr profile, or refuses.
  // Nothing else may select an owner — not the download-dir category, not the
  // client's name, not row order.
  resolveRpcProfile(profile) {
    if (profile) return this.requireProfile(profile);
    const profiles = this.listArrProfiles();
    if (profiles.length === 1) return profiles[0];
    if (profiles.length === 0) throw new Error('No enabled RR profile is configured');
    throw new Error(
      `The shared RPC endpoint ${SHARED_RPC_PATH} is ambiguous: ${profiles.length} enabled RR profiles could have meant it.`
      + ` Point this download client at the RPC path of the profile it means — ${this.rpcPathAdvice(profiles)}`,
    );
  }

  // This message is the whole user experience of a misconfigured multi-profile
  // setup, so it names every profile and the exact path to type. A profile
  // still sitting on the shared path has no path to hand out; repeating the one
  // that just failed would read as a contradiction, so it is called out as the
  // thing to fix.
  rpcPathAdvice(profiles) {
    return profiles
      .map((profile) => (profile.rpc_path === SHARED_RPC_PATH
        ? `${profile.name} needs its own RPC path`
        : `${profile.name} → ${profile.rpc_path}`))
      .join('; ');
  }

  requireProfile(profile) {
    if (!profile) throw new Error('No enabled RR profile is configured');
    if (!profile.enabled) throw new Error(`RR profile ${profile.name} is disabled`);
    return profile;
  }

  // A download's owner is stored, never inferred. Everything that follows from
  // ownership — the folder the files stage into, the download policy, the
  // put.io folder — has no answer without it, and the old
  // `?? getDefaultProfile()` supplied one anyway: slug 'default', else whatever
  // sorted first, with no type filter, so a Putiorr Grab profile could quietly
  // become the owner of an *arr download and take its files with it.
  //
  // downloads.profile_id is NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT
  // from phase 3 on, so this can only come back empty for a database that was
  // edited by hand. It stays a runtime check rather than an assertion because
  // the dashboard has to be able to show such a row and let the user fix it.
  findDownloadOwner(download) {
    return download?.profile_id != null
      ? this.store.findProfileById(download.profile_id)
      : undefined;
  }

  requireDownloadOwner(download) {
    const profile = this.findDownloadOwner(download);
    if (!profile) throw new Error(ownerlessDownloadMessage(download));
    return profile;
  }

  // Who claims a directory on disk, in the words the refusal will use. The
  // design requires deleteLocalData to establish that a path belongs to
  // exactly one download before removing anything; this is where that answer
  // comes from. A download claims the folder carrying its id under its
  // profile's category directory, and the folder its name alone spelled before
  // phase 4 — which is the one two profiles could share, and the one the
  // quarantine recorded for rows it could not attach to a profile.
  localPathOwners(localPath) {
    const target = path.resolve(String(localPath ?? ''));
    const owners = [];
    for (const download of [...this.store.listActiveDownloads(), ...this.store.listRemovedDownloads()]) {
      const profile = this.findDownloadOwner(download);
      if (!profile || !this.downloadClaimsPath(profile, download, target)) continue;
      owners.push(`download ${download.id} (${download.name}) of RR profile ${profile.name}`);
    }
    for (const orphan of this.store.listOrphanedDownloads()) {
      if (!orphan.legacy_download_dir) continue;
      if (path.resolve(orphan.legacy_download_dir) !== target) continue;
      owners.push(`quarantined download ${orphan.id} (${orphan.name})`);
    }
    return owners;
  }

  downloadClaimsPath(profile, download, target) {
    try {
      const categoryDir = downloadCategoryDir(profile, download);
      if (
        path.dirname(target) === categoryDir
        && path.basename(target).startsWith(`${download.id}-`)
      ) {
        return true;
      }
      return legacyDownloadLocalRoot(profile, download) === target;
    } catch {
      // A profile with no usable download folder cannot claim anything; it
      // must not make an unrelated path look unowned or contested either.
      return false;
    }
  }

  ownershipCheck() {
    return { ownersOfPath: (localPath) => this.localPathOwners(localPath) };
  }

  async ensureProfileFolder(profile) {
    const current = this.requireProfile(profile);
    if (current.putio_folder_id) return current;

    const folderId = await this.getPutio().ensureFolder(current.putio_folder_name);
    return this.store.updateProfile(current.id, { putio_folder_id: folderId });
  }

  async addTorrent(args = {}, profile) {
    // Resolved exactly like torrent-get and torrent-remove. It used to resolve
    // by download-dir category instead, so an ambiguous shared endpoint
    // accepted adds it would then refuse to list or remove: the *arr grabbed
    // releases it could never see, import or clean up, and re-grabbed them on
    // every RSS cycle.
    const currentProfile = await this.ensureProfileFolder(this.resolveRpcProfile(profile));
    const filename = firstDefined(args.filename, args.url);
    const magnetLink = firstDefined(args.magnetLink, args['magnet-link']);
    const metainfo = args.metainfo;
    const downloadDir = firstDefined(args.downloadDir, args['download-dir'], '');
    // Purely the name of the staging subdirectory under the owner's folder, and
    // computed only now that the owner is known. It never selects or vetoes.
    const category = extractCategory(currentProfile.download_at, downloadDir);

    let putioTransfer;
    let source;
    let sourceType;

    if (metainfo) {
      const data = Buffer.from(metainfo, 'base64');
      const uploadName = filename || 'upload.torrent';
      putioTransfer = await this.getPutio().uploadTorrent(data, uploadName, currentProfile.putio_folder_id);
      source = uploadName;
      sourceType = 'torrent';
    } else {
      source = magnetLink || filename;
      if (!source || !String(source).startsWith('magnet:')) {
        throw new Error('torrent-add requires a magnet link or base64 metainfo');
      }
      sourceType = 'magnet';
      putioTransfer = await this.getPutio().addTransfer(source, currentProfile.putio_folder_id);
    }

    // put.io's transfer id is the download's identity (design rule 3). An add
    // that comes back without one used to be stored anyway, under a random
    // 20-byte fake hash, producing a row nothing could ever match against
    // put.io again and nothing could prune.
    if (putioTransfer?.id == null) {
      throw new Error('put.io accepted the torrent but returned no transfer id; nothing was recorded');
    }

    const row = this.store.upsertDownload(putioTransferToStoreInput(putioTransfer, {
      profile_id: currentProfile.id,
      hash: deriveHashFromSource(source),
      source,
      source_type: sourceType,
      category,
      lifecycle: 'remote',
      save_parent_id: currentProfile.putio_folder_id,
    }));

    logger.info('torrent added', {
      id: row.id,
      hash: row.hash,
      name: row.name,
      category,
      sourceType,
      profile: currentProfile.slug,
    });

    return {
      'torrent-added': {
        id: row.id,
        hashString: row.hash,
        name: row.name,
      },
    };
  }

  async refreshRemoteTransfers() {
    const putio = this.getPutio();
    const profiles = [];
    for (const profile of this.store.listProfiles()) {
      profiles.push(await this.ensureProfileFolder(profile));
    }

    const byFolderId = new Map();
    for (const profile of profiles) {
      const matches = byFolderId.get(profile.putio_folder_id) ?? [];
      matches.push(profile);
      byFolderId.set(profile.putio_folder_id, matches);
    }
    const remoteTransfers = await putio.listTransfers();
    const remoteIds = new Set();
    const remoteHashes = new Set();
    const rows = [];
    for (const remote of remoteTransfers) {
      if (remote.id != null) remoteIds.add(remote.id);
      if (remote.hash) remoteHashes.add(String(remote.hash).trim().toLowerCase());
      // The poll is the only thing that advances every download on the box, so
      // one row that throws — a hash colliding with another row's put.io id is
      // the reproducible case — used to stop polling for all of them, on every
      // tick, until a restart. A bad row is skipped and named; the next tick
      // retries it.
      try {
        this.refreshRemoteTransfer(remote, byFolderId, rows);
      } catch (error) {
        logger.warn('skipped put.io transfer that failed to refresh', {
          putioTransferId: remote.id,
          hash: remote.hash,
          name: remote.name,
          saveParentId: remote.saveParentId,
          error: error.message,
          stack: error.stack,
        });
      }
    }
    this.pruneRemoteTransfers(remoteIds, remoteHashes);
    this.pruneRemovedTransfers(remoteIds, remoteHashes);
    return rows;
  }

  // One put.io transfer's worth of work, extracted so the caller can isolate a
  // failure to the row that caused it. Appends the refreshed rows to `rows`.
  refreshRemoteTransfer(remote, byFolderId, rows) {
    const existing = remote.id ? this.store.findDownloadByPutioTransferId(remote.id) : undefined;

    if (existing) {
      // A corrected hash changes the string every *arr correlates its queue
      // item against, so it is never silent: the log names both sides.
      const reported = String(remote.hash ?? '').trim().toLowerCase();
      const known = String(existing.hash ?? '').trim().toLowerCase();
      if (reported && known && reported !== known) {
        logger.info('corrected download hash from put.io', {
          id: existing.id,
          putioTransferId: remote.id,
          name: existing.name,
          previousHash: known,
          hash: reported,
        });
      }
      // The row's own profile_id is passed back in, so the store's
      // already-belongs-to refusal can never fire on the poll path.
      const updated = this.store.upsertDownload(putioTransferToStoreInput(remote, {
        profile_id: existing.profile_id,
        hash: existing.hash,
        category: existing.category,
        lifecycle: existing.lifecycle,
        download_speed: existing.download_speed,
        eta: existing.eta,
        source: existing.source ?? remote.magnetUri ?? '',
        source_type: existing.source_type ?? 'remote',
        reactivate: !existing.removed_at,
      }));
      if (!existing.removed_at) rows.push(updated);
      return;
    }

    // Adoption of a transfer putiorr did not create. profile_id is mandatory
    // now, so this early return is load-bearing rather than cosmetic: a folder
    // that maps to no profile, or to more than one, has no answer, and phase 4
    // turns the silence into a log line and a dashboard notice.
    const folderProfiles = byFolderId.get(remote.saveParentId) ?? [];
    if (folderProfiles.length !== 1) return;
    const [profile] = folderProfiles;
    rows.push(this.store.upsertDownload(putioTransferToStoreInput(remote, {
      profile_id: profile.id,
      source: remote.magnetUri ?? '',
      source_type: 'remote',
    })));
  }

  pruneRemoteTransfers(remoteIds, remoteHashes) {
    for (const transfer of this.store.listActiveDownloads()) {
      if (transfer.lifecycle !== 'remote' || transfer.putio_transfer_id == null) continue;
      if (isTransferStillListed(transfer, remoteIds, remoteHashes)) continue;
      this.store.deleteDownload(transfer.id);
      logger.info('pruned remote transfer no longer on put.io', {
        id: transfer.id,
        putioTransferId: transfer.putio_transfer_id,
        hash: transfer.hash,
        name: transfer.name,
      });
    }
  }

  // Tombstoned transfers (deleted from the dashboard but kept on put.io) only need to
  // survive long enough to suppress resurrection. Once put.io no longer lists them,
  // the tombstone is dead weight, so hard-delete it here (files cascade away). This
  // reuses the transfer list already fetched by the poll — no extra API calls.
  pruneRemovedTransfers(remoteIds, remoteHashes) {
    for (const removed of this.store.listRemovedDownloads()) {
      if (!isTransferStillListed(removed, remoteIds, remoteHashes)) {
        this.store.deleteDownload(removed.id);
        logger.info('pruned tombstoned transfer no longer on put.io', {
          id: removed.id,
          hash: removed.hash,
        });
      }
    }
  }

  async getTorrents(args = {}, profile) {
    // Resolved the same way torrent-remove resolves it. Left optional, an
    // unresolved listing skipped the profile filter entirely and handed the
    // caller every profile's downloads, each labelled with another profile's
    // downloadDir — which is both a leak and an invitation for the *arr that
    // read it to act on a row it does not own.
    const currentProfile = this.resolveRpcProfile(profile);
    if (this.config.refreshOnRpc) {
      await this.refreshRemoteTransfers();
    }

    const requestedIds = args.ids === 'recently-active'
      ? []
      : Array.isArray(args.ids) ? args.ids : [];

    const fields = Array.isArray(args.fields) ? args.fields : [];
    const rows = requestedIds.length > 0
      ? requestedIds.map((id) => this.store.findDownload(id, { profileId: currentProfile.id })).filter(Boolean)
      : this.store.listActiveDownloads({ profileId: currentProfile.id });

    const torrents = rows.map((row) => this.toTransmissionTorrent(row, fields));
    return { torrents };
  }

  async removeTorrents(args = {}, profile) {
    const currentProfile = this.resolveRpcProfile(profile);
    const ids = Array.isArray(args.ids) ? args.ids : [];
    const deleteLocal = Boolean(args['delete-local-data'] ?? args.deleteLocalData);

    for (const id of ids) {
      const transfer = this.store.findDownload(id, { profileId: currentProfile.id });
      if (!transfer) {
        // An id nobody has is a no-op: Transmission clients routinely remove
        // ids they have already forgotten. An id that exists but belongs to
        // another profile is not — answering "success" to that told the client
        // a download was gone while it kept downloading, and hid the fact that
        // the client is addressing the wrong endpoint.
        //
        // Only a numeric download id can say that, though. A hash names a set
        // of downloads, since put.io can report one infohash for more than one
        // transfer, so "this hash exists under another profile" cannot
        // tell a mis-addressed client apart from one whose own copy is simply
        // gone already — and the second is routine: a repeat remove, or our own
        // auto-remove sweep having hard-deleted the row between the client's
        // get and its remove. A mis-addressed client has no valid ids either,
        // so the check keeps its value.
        const foreign = isDownloadId(id) ? this.store.findDownloadById(Number(id)) : undefined;
        // A tombstoned row is already gone as far as any client is concerned,
        // so there is nothing to correct anyone about.
        if (foreign && !foreign.removed_at) {
          const owner = this.findDownloadOwner(foreign);
          throw new Error(
            `Download ${id} belongs to RR profile ${owner ? owner.name : '(none)'}, not ${currentProfile.name}`
            + `${owner?.rpc_path ? `; use ${owner.rpc_path}` : ''}`,
          );
        }
        continue;
      }

      // One download owns its put.io transfer outright, so removing it always
      // removes the remote side too; there is no second profile left holding a
      // claim on it.
      await this.removeRemoteTransfer(transfer);
      if (deleteLocal) {
        // The row was found scoped to this profile, so this is that profile.
        await deleteLocalData(await resolveDownloadRoot(currentProfile, transfer), this.ownershipCheck());
      }
      this.store.deleteDownload(transfer.id);
      logger.info('torrent removed', {
        id: transfer.id,
        hash: transfer.hash,
        deleteLocal,
      });
    }

    return {};
  }

  async deleteDownloadBucket(transferId, { deleteRemote = true, deleteLocal = true } = {}) {
    const transfer = this.store.findDownload(transferId);
    if (!transfer || transfer.removed_at) {
      throw new Error('Download bucket not found');
    }

    // Resolved before anything irreversible happens. Only the local half needs
    // an owner, because only the local half needs a folder — but discovering
    // that after cancelling the put.io transfer would leave a row that can
    // never be removed again: put.io 404s on the retry and the local half
    // throws before it gets there.
    const localTarget = deleteLocal
      ? await resolveDownloadRoot(this.requireDownloadOwner(transfer), transfer)
      : undefined;

    const remoteDeleted = deleteRemote;
    if (remoteDeleted) {
      await this.removeRemoteTransfer(transfer, { throwOnError: true });
    }

    const fileCount = this.store.listFilesForDownload(transfer.id).length;
    if (deleteLocal) {
      await deleteLocalData(localTarget, this.ownershipCheck());
    }
    // The row can be hard-deleted once put.io has been cleaned up. If put.io is
    // intentionally kept, a tombstone stays behind so the next refresh cannot
    // recreate the download from the remote transfer.
    if (deleteRemote) {
      this.store.deleteDownload(transfer.id);
    } else {
      this.store.markDownloadRemoved(transfer.id);
    }

    logger.info('download bucket deleted from dashboard', {
      id: transfer.id,
      hash: transfer.hash,
      deleteRemote: remoteDeleted,
      deleteLocal,
      fileCount,
    });

    return {
      ok: true,
      bucketDeleted: true,
      transferId: transfer.id,
      filesDeleted: fileCount,
    };
  }

  async deleteDownloadFiles(transferId, fileIds, { deleteRemote = true, deleteLocal = true } = {}) {
    const transfer = this.store.findDownload(transferId);
    if (!transfer || transfer.removed_at) {
      throw new Error('Download bucket not found');
    }

    const requestedIds = new Set(
      (Array.isArray(fileIds) ? fileIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    const visibleFiles = this.store.listFilesForDownload(transfer.id);
    const files = visibleFiles.filter((file) => requestedIds.has(Number(file.id)));
    if (files.length === 0) {
      throw new Error('No files selected');
    }

    if (files.length === visibleFiles.length) {
      return this.deleteDownloadBucket(transfer.id, { deleteRemote, deleteLocal });
    }

    // Same rule as the bucket delete: resolve the owner before the first
    // irreversible step, never after it.
    const downloadRoot = deleteLocal
      ? await resolveDownloadRoot(this.requireDownloadOwner(transfer), transfer)
      : undefined;

    const remoteDeleted = deleteRemote;
    if (remoteDeleted) {
      await this.removeRemoteFiles(files, { throwOnError: true });
    }

    // Mirror the bucket logic at file granularity: a file removed from put.io is
    // hard-deleted (it cannot be re-listed during download prep), while a file kept
    // on put.io is tombstoned so the downloader leaves it alone instead of re-fetching.
    this.store.transaction(() => {
      for (const file of files) {
        if (remoteDeleted) {
          this.store.deleteDownloadFile(file.id);
        } else {
          this.store.markDownloadFileDeleted(file.id);
        }
      }
    });

    if (deleteLocal) {
      for (const file of files) {
        await deleteLocalFileData(downloadRoot, file.relative_path, this.ownershipCheck());
      }
    }

    this.refreshTransferAfterFileDeletion(transfer.id);

    logger.info('download files deleted from dashboard', {
      id: transfer.id,
      hash: transfer.hash,
      deleteRemote: remoteDeleted,
      deleteLocal,
      fileCount: files.length,
    });

    return {
      ok: true,
      bucketDeleted: false,
      transferId: transfer.id,
      filesDeleted: files.length,
    };
  }

  refreshTransferAfterFileDeletion(transferId) {
    const transfer = this.store.findDownloadById(transferId);
    if (!transfer || transfer.removed_at) return undefined;
    const stats = this.store.getDownloadFileStats(transferId);
    const totalFiles = Number(stats.total_files ?? 0);
    const completedFiles = Number(stats.completed_files ?? 0);
    const totalSize = Number(stats.total_size ?? 0);
    const downloadedSize = Number(stats.downloaded_size ?? 0);
    const patch = {
      downloaded_ever: downloadedSize,
      total_size: totalSize || Number(transfer.total_size ?? 0),
    };

    if (totalFiles > 0 && completedFiles === totalFiles && READY_REMOTE_STATUSES.has(transfer.putio_status)) {
      patch.lifecycle = 'processed';
      patch.percent_done = 100;
      patch.download_speed = 0;
      patch.eta = -1;
    }

    return this.store.updateDownload(transferId, patch);
  }

  async removeRemoteFiles(files, { throwOnError = false } = {}) {
    const errors = [];
    const putio = this.getPutio();
    for (const file of files) {
      try {
        await putio.deleteFile(file.putio_file_id);
      } catch (error) {
        errors.push(error);
        logger.warn('failed to delete put.io file', {
          transferFileId: file.id,
          putioFileId: file.putio_file_id,
          error: error.message,
        });
      }
    }
    if (errors.length > 0 && throwOnError) {
      throw remoteDeleteError(errors);
    }
    return errors;
  }

  async removeRemoteTransfer(transfer, { throwOnError = false } = {}) {
    const errors = [];
    const putio = this.getPutio();
    if (transfer.putio_file_id) {
      try {
        await putio.deleteFile(transfer.putio_file_id);
      } catch (error) {
        errors.push(error);
        logger.warn('failed to delete put.io file', {
          id: transfer.id,
          putioFileId: transfer.putio_file_id,
          error: error.message,
        });
      }
    }

    if (transfer.putio_transfer_id) {
      try {
        await putio.deleteTransfer(transfer.putio_transfer_id);
      } catch (error) {
        errors.push(error);
        logger.warn('failed to delete put.io transfer', {
          id: transfer.id,
          putioTransferId: transfer.putio_transfer_id,
          error: error.message,
        });
      }
    }
    if (errors.length > 0 && throwOnError) {
      throw remoteDeleteError(errors);
    }
    return errors;
  }

  toTransmissionTorrent(row, requestedFields = []) {
    // Rows reach here only from getTorrents, which selects them scoped to a
    // resolved profile, so an ownerless one is a bug rather than a state to
    // render around.
    const profile = this.requireDownloadOwner(row);
    const stats = this.store.getDownloadFileStats(row.id);
    const progress = calculateTransmissionProgress(row, stats);
    const files = this.store.listFilesForDownload(row.id);
    const totalSize = Number(stats.total_size ?? 0) > 0
      ? Number(stats.total_size)
      : Number(row.total_size ?? 0);
    const downloadedEver = Math.max(0, Math.round(totalSize * progress.percentDone));
    const torrent = {
      id: row.id,
      hashString: row.hash,
      name: row.name,
      eta: row.eta ?? -1,
      status: progress.status,
      downloadDir: path.join(profile.download_at, row.category ?? ''),
      totalSize,
      leftUntilDone: progress.leftUntilDone,
      uploadedEver: row.uploaded_ever,
      downloadedEver,
      percentDone: progress.percentDone,
      rateDownload: row.download_speed,
      rateUpload: row.upload_speed,
      uploadRatio: totalSize > 0 ? row.uploaded_ever / totalSize : 0,
      error: row.error,
      errorString: row.error_string,
      isFinished: progress.leftUntilDone === 0,
      secondsDownloading: 0,
      secondsSeeding: row.lifecycle === 'processed' ? 1 : 0,
      seedRatioLimit: 0,
      seedRatioMode: row.lifecycle === 'processed' ? 1 : 0,
      seedIdleLimit: 0,
      seedIdleMode: row.lifecycle === 'processed' ? 1 : 0,
      fileCount: files.length,
      'file-count': files.length,
      labels: row.category ? [row.category] : [],
      files: files.map((file) => this.toTransmissionFile(row, file)),
      fileStats: files.map((file) => this.toTransmissionFileStats(row, file)),
    };

    if (requestedFields.length === 0) return torrent;
    const filtered = {};
    for (const field of requestedFields) {
      if (Object.hasOwn(torrent, field)) {
        filtered[field] = torrent[field];
      }
    }
    if (!Object.hasOwn(filtered, 'id')) filtered.id = torrent.id;
    return filtered;
  }

  toTransmissionFile(row, file) {
    const size = Number(file.size ?? 0);
    return {
      bytesCompleted: Math.round(size * this.calculateFileRpcProgress(row, file)),
      length: size,
      name: file.relative_path,
    };
  }

  toTransmissionFileStats(row, file) {
    return {
      bytesCompleted: Math.round(Number(file.size ?? 0) * this.calculateFileRpcProgress(row, file)),
      wanted: true,
      priority: 0,
    };
  }

  calculateFileRpcProgress(row, file) {
    const size = Number(file.size ?? 0);
    const downloadedSize = Number(file.downloaded_bytes ?? 0);
    const remoteProgress = Math.min(100, Math.max(0, Number(row.percent_done ?? 0))) / 200;
    const localProgress = size > 0
      ? (downloadedSize / size) * 0.5
      : file.status === 'complete' ? 0.5 : 0;
    return clampUnit(remoteProgress + localProgress);
  }

  // The needs-attention list. These are legacy rows the schema collapse could
  // not represent — no owner, no put.io transfer id, or a put.io transfer an
  // older sibling already claimed — parked so the user can reassign or delete
  // each one rather than having them disappear on upgrade.
  listOrphanedDownloads() {
    return this.store.listOrphanedDownloads().map((row) => ({
      id: row.id,
      putioTransferId: row.putio_transfer_id,
      hash: row.hash,
      name: row.name,
      category: row.category,
      reason: row.reason,
      quarantinedAt: row.quarantined_at,
      localPath: row.legacy_download_dir,
      // The id the *arr apps are still polling with, so the dashboard can say
      // which queue item this repairs.
      legacyDownloadId: row.legacy_download_id,
      totalSize: row.total_size,
      downloadedSize: row.downloaded_ever,
      // Rule 3: without a put.io transfer id there is no identity to reattach,
      // so the dashboard offers delete only.
      assignable: row.putio_transfer_id != null,
    }));
  }

  assignOrphanedDownload(orphanId, profileId) {
    const profile = this.store.findProfileById(profileId);
    if (!profile) throw new Error('Profile not found');
    const created = this.store.assignOrphanedDownload(orphanId, profile.id);
    logger.info('quarantined download reassigned', {
      orphanId,
      downloadId: created.id,
      profile: profile.slug,
      putioTransferId: created.putio_transfer_id,
    });
    return { ok: true, downloadId: created.id };
  }

  async deleteOrphanedDownload(orphanId, { deleteRemote = false, deleteLocal = false } = {}) {
    const row = this.store.findOrphanedDownloadById(orphanId);
    if (!row) throw new Error('Quarantined download not found');

    // Refused rather than reported as done: removeRemoteTransfer with both ids
    // null calls put.io zero times and returns no errors, so the user would be
    // told the remote copy was deleted when nothing was even asked.
    if (deleteRemote) {
      if (row.putio_transfer_id == null && row.putio_file_id == null) {
        throw new Error(
          `putiorr has no put.io ids for ${row.name || 'this download'}, so it cannot delete it from put.io;`
          + ' remove it there by hand, then delete this entry without the put.io option',
        );
      }
      await this.removeRemoteTransfer({
        id: row.id,
        name: row.name,
        putio_file_id: row.putio_file_id,
        putio_transfer_id: row.putio_transfer_id,
      }, { throwOnError: true });
    }
    // legacy_download_dir already ends in the download's own folder, which is
    // the only thing the quarantine knows about where the files went. It is
    // recorded absolute or not at all: a relative path would resolve against
    // process.cwd() here, and rm(recursive) would take whatever happens to sit
    // there. Refusing is also the honest answer to "delete the files" when we
    // cannot say which files those are — silently skipping reported success
    // for a deletion that never happened.
    if (deleteLocal) {
      if (!path.isAbsolute(row.legacy_download_dir ?? '')) {
        throw new Error(
          `putiorr does not know where ${row.name || 'this download'}'s files are, so it cannot delete them;`
          + ' remove them by hand, then delete this entry without the local-files option',
        );
      }
      await deleteLocalData(row.legacy_download_dir, this.ownershipCheck());
    }
    this.store.deleteOrphanedDownload(orphanId);
    logger.info('quarantined download deleted', {
      orphanId,
      name: row.name,
      reason: row.reason,
      deleteRemote,
      deleteLocal,
    });
    return { ok: true };
  }

  listDownloads() {
    return this.store.listActiveDownloads().map((row) => {
      // The dashboard is where an ownerless download has to become visible, so
      // this is the one read path that reports the problem instead of throwing
      // — one broken row must not blank the whole list. It is still never
      // attributed to a profile that does not own it.
      //
      // Only a hand-edited database can produce one: profile_id is NOT NULL
      // with ON DELETE RESTRICT, and the legacy rows the schema upgrade could
      // not attach to a profile are quarantined in orphaned_downloads and
      // rendered as their own needs-attention section.
      const profile = this.findDownloadOwner(row);
      const ownerError = profile ? '' : ownerlessDownloadMessage(row);
      const downloadProfile = profile
        ? this.store.findDownloadProfileById(profile.download_profile_id) ?? this.store.findDefaultDownloadProfile()
        : undefined;
      const stats = this.store.getDownloadFileStats(row.id);
      const fileItems = this.store.listFilesForDownload(row.id).map((file) => {
        const size = Number(file.size ?? 0);
        const downloadedSize = Number(file.downloaded_bytes ?? 0);
        return {
          id: file.id,
          relativePath: file.relative_path,
          size,
          downloadedSize,
          speed: Number(file.download_speed ?? 0),
          progress: size > 0
            ? Math.max(0, Math.min(100, Math.round((downloadedSize / size) * 100)))
            : file.status === 'complete' ? 100 : 0,
          status: file.status,
          error: file.error_string,
        };
      });
      const failedFileErrors = fileItems
        .filter((file) => file.status === 'failed' && file.error)
        .map((file) => file.error);
      const fileError = failedFileErrors.length > 0
        ? `${failedFileErrors.length} file${failedFileErrors.length === 1 ? '' : 's'} failed: ${failedFileErrors[0]}`
        : '';
      const progress = calculateTransmissionProgress(row, stats);
      return {
        id: row.id,
        hash: row.hash,
        name: row.name,
        profileId: profile?.id ?? null,
        profileName: profile?.name ?? 'No RR profile',
        profileType: profile?.type ?? 'custom',
        downloadProfileId: downloadProfile?.id ?? null,
        downloadProfileName: downloadProfile?.name ?? 'Default',
        putioFolder: profile?.putio_folder_name ?? '',
        downloadAt: profile ? path.join(profile.download_at, row.category ?? '') : '',
        lifecycle: row.lifecycle,
        putioStatus: row.putio_status,
        putioStatusMessage: row.putio_status_message,
        putioPeers: row.putio_peers,
        putioAvailability: row.putio_availability,
        putioProgress: Math.max(0, Math.min(100, Number(row.percent_done ?? 0))),
        putioCompletion: Math.max(0, Math.min(100, Number(row.completion_percent ?? 0))),
        localProgress: Number(stats.total_size ?? 0) > 0
          ? Math.round((Number(stats.downloaded_size ?? 0) / Number(stats.total_size)) * 100)
          : 0,
        combinedProgress: Math.round(progress.percentDone * 100),
        speed: row.download_speed,
        eta: row.eta,
        error: ownerError || row.error_string || fileError,
        totalSize: row.total_size,
        downloadedSize: Number(stats.downloaded_size ?? 0),
        files: {
          total: Number(stats.total_files ?? 0),
          complete: Number(stats.completed_files ?? 0),
          failed: Number(stats.failed_files ?? 0),
          items: fileItems,
        },
      };
    });
  }
}
