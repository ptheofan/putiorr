import path from 'node:path';
import {
  assertSoleOwnedDownloadRoot,
  deleteLocalData,
  deleteLocalFileData,
  downloadCategoryDir,
  downloadFolderSegments,
  downloadLocalRoot,
  extractCategory,
  measureDownloadFolder,
  oversizedFolderSegment,
  QUARANTINED_OWNER_PREFIX,
  stagingFolderName,
} from '../download/paths.js';
import { logger } from '../logger.js';
import { PutioClient } from '../putio/client.js';
import { calculateTransmissionProgress } from '../transmission/progress.js';
// The preset the dashboard writes into a profile; plain data with no imports of
// its own, so the one spelling serves both the browser and this process.
import { GRAB_PROFILE_TYPE, SHARED_RPC_PATH } from '../web/constants.js';
// One spelling of "3 downloads" for every refusal that counts them, and the
// store is where the count comes from.
import { pluralizeDownloads } from '../state/store.js';

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

// Only reached when put.io reports no name of its own. A magnet without a `dn`
// used to fall through to the whole magnet URI, which then became the staging
// folder: `magnet:?xt=urn:btih:…&tr=…` spells a path several levels deep, under
// directories named after query parameters. The infohash is the one thing such
// a magnet always carries, and it is a single legible segment.
function deriveNameFromSource(source) {
  if (!source) return 'unknown';
  if (source.startsWith('magnet:')) {
    const params = new URLSearchParams(source.slice(source.indexOf('?') + 1));
    return params.get('dn') || deriveHashFromSource(source) || 'unknown';
  }
  return path.basename(source);
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

// Punctuation and case are noise when comparing a client's name to a profile's:
// "Putiorr Grab", "putiorr-grab" and "putiorrgrab" are one identity.
function normalizedIdentity(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
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

// The single meaning of `enabled = 0`, in the words every door uses. Disabling
// a profile stops it accepting new work; the downloads it already has keep
// downloading and stay listable, removable and manageable, so the sentence
// says what was refused rather than that the profile is gone.
export function disabledProfileMessage(profile) {
  return `RR profile ${profile?.name ?? '(unnamed)'} is disabled and accepts no new downloads;`
    + ' enable it in the dashboard, or send this to a profile that is switched on.'
    + ' Its existing downloads are unaffected';
}

// Everything already done, in the order it was done, so a half-finished delete
// reads as the record of what is gone rather than as a row count.
function describeProfileDeletionProgress(report, total) {
  const parts = [`removing ${pluralizeDownloads(report.deleted)} of ${total}`];
  if (report.remoteDeleted > 0) parts.push(`${report.remoteDeleted} already cancelled on put.io`);
  if (report.localDeleted > 0) parts.push(`${report.localDeleted} already deleted from disk`);
  return parts.join(', ');
}

// The counts travel with the refusal, so the endpoint can answer a 400 with the
// same shape its success carries and a caller never has to parse the sentence.
function profileDeletionError(message, report) {
  const error = new Error(message);
  error.downloadsReport = { ...report };
  return error;
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
  //
  // Disabled profiles are counted. `enabled = 0` means the profile accepts no
  // new work, not that it is absent: if switching one off could decide who
  // owns the shared endpoint, an add that was refused as ambiguous yesterday
  // lands silently in the surviving profile's folder today.
  listArrProfiles() {
    return this.store.listProfiles()
      .filter((profile) => profile.type !== GRAB_PROFILE_TYPE);
  }

  // Which *arr is calling, from the name it puts in its own User-Agent:
  // `Sonarr/4.0.19.2932 (linux x64)` is the Sonarr profile. This is what lets
  // every *arr share one endpoint with no URL Base change in its advanced
  // settings, which is the whole convenience the shared path exists for.
  //
  // It routes a request and nothing else. It never decides who owns an existing
  // download — ownership is written once, at creation, and read back from the
  // row — and a profile addressed on its own RPC path is never overruled by it.
  //
  // The vendor token before the slash is the only part that names the app; the
  // version and platform after it differ per install. `type` is only an identity
  // for a real preset: every hand-made profile is type `custom`, so counting it
  // would make one client name match all of them and resolve nothing. A prefix
  // has to be at least four characters before it may match, so a two-letter slug
  // does not claim every client whose name happens to start with it, and only a
  // single match resolves: two profiles answering to one name is exactly the
  // case the RPC path override exists for.
  //
  // Grab profiles are excluded with the rest of listArrProfiles: nothing an
  // *arr sends may select one, whatever it is called.
  findProfileByUserAgent(userAgent) {
    const client = normalizedIdentity(String(userAgent ?? '').split('/')[0]);
    if (!client) return undefined;
    const matches = this.listArrProfiles().filter((profile) => {
      const identities = [profile.slug, profile.name];
      if (profile.type !== 'custom') identities.push(profile.type);
      return identities.some((value) => {
        const identity = normalizedIdentity(value);
        return identity && (client === identity || (identity.length >= 4 && client.startsWith(identity)));
      });
    });
    return matches.length === 1 ? matches[0] : undefined;
  }

  // The two mechanisms, in order. An RPC request is owned by the profile whose
  // path it arrived on; failing that, by the profile the calling app named
  // itself as. The shared path with neither serves a single-profile install, or
  // refuses — and torrent-add and torrent-remove are the methods that must
  // refuse, because one decides where files go and the other destroys them.
  // Nothing else may select an owner: not the download-dir category, not the
  // labels, not row order.
  //
  // This resolves; it does not admit. Whether the profile it names is switched
  // on is asked once, at the point new work would be created — so a disabled
  // profile's *arr can still list, remove and finish the downloads it already
  // has instead of having its whole queue answered with a refusal.
  resolveRpcProfile(profile, clientProfile) {
    if (profile) return profile;
    if (clientProfile) return clientProfile;
    const profiles = this.listArrProfiles();
    if (profiles.length === 1) return profiles[0];
    if (profiles.length === 0) throw new Error('No RR profile is configured');
    throw new Error(
      `The shared RPC endpoint ${SHARED_RPC_PATH} is ambiguous: ${profiles.length} RR profiles could have meant it,`
      + ' and this client did not name any of them in its User-Agent.'
      + ' Sonarr, Radarr, Lidarr, Readarr and Prowlarr name themselves and need no change;'
      + ' a client that does not, or one of two profiles answering to the same name,'
      + ` needs the RPC path of the profile it means — ${this.rpcPathAdvice(profiles)}`,
    );
  }

  // torrent-get is not only the *arr's Test button: it is the queue poll that
  // drives completed-download import. Refusing it strands the imports and shows
  // the client as failed, so it never refuses — a request that resolves to no
  // one listing every download is what the shared endpoint has always done, and
  // each row still carries its own owner's downloadDir.
  resolveListingProfile(profile, clientProfile) {
    if (profile) return profile;
    if (clientProfile) return clientProfile;
    const profiles = this.listArrProfiles();
    return profiles.length === 1 ? profiles[0] : undefined;
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

  // The one door check, asked wherever new work would be created: torrent-add,
  // /api/grab through all three of its resolution paths, and the adoption of a
  // put.io transfer nobody created here. One sentence for all of them — the
  // audit found four different answers depending on which door you knocked on,
  // one of which was an HTML page with HTTP 200.
  requireProfile(profile) {
    if (!profile) throw new Error('No RR profile is configured');
    if (!profile.enabled) throw new Error(disabledProfileMessage(profile));
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
    this.assertNotAStagingRoot(target);
    const owners = [];
    for (const download of [...this.store.listActiveDownloads(), ...this.store.listRemovedDownloads()]) {
      const profile = this.findDownloadOwner(download);
      if (!profile || !this.downloadClaimsPath(profile, download, target)) continue;
      owners.push(`download ${download.id} (${download.name}) of RR profile ${profile.name}`);
    }
    for (const orphan of this.store.listOrphanedDownloads()) {
      if (!orphan.legacy_download_dir) continue;
      if (path.resolve(orphan.legacy_download_dir) !== target) continue;
      owners.push(`${QUARANTINED_OWNER_PREFIX}${orphan.id} (${orphan.name})`);
    }
    return owners;
  }

  // A profile's staging root, and everything above it, is never deletable —
  // however many downloads happen to exist. The count is the wrong question
  // for these paths: a database with no downloads left is exactly the install
  // that gets one thing claiming the root and passes an exactly-one-owner
  // check. Thrown rather than reported as contested, because the reason is
  // different and the user needs to read it.
  assertNotAStagingRoot(target) {
    for (const profile of this.store.listProfiles()) {
      const root = profile.download_at ? path.resolve(profile.download_at) : '';
      if (!root) continue;
      if (target === root || root.startsWith(`${target}${path.sep}`)) {
        throw new Error(
          `refusing to delete ${target}: it is RR profile ${profile.name}'s download folder`
          + `${target === root ? '' : ' or holds it'}`,
        );
      }
    }
  }

  downloadClaimsPath(profile, download, target) {
    try {
      const root = downloadLocalRoot(profile, download);
      if (root === target) return true;
      // Anything holding a download's folder takes that download's files with
      // it, so it is claimed too — and a put.io name may spell a nested path,
      // which puts one download's folder inside another's. Without this, an
      // ordinary "remove and delete files" on the outer download answers "one
      // owner" and deletes the inner download's files while its row stays in
      // the *arr's queue.
      //
      // The category directory is the same rule one level up, and it is
      // checked separately because a download with no usable name of its own
      // still has one: a quarantined row whose recorded path is a whole
      // category directory is then contested by every download staging under
      // it rather than looking like one entry's private folder.
      if (root && root.startsWith(`${target}${path.sep}`)) return true;
      const categoryDir = downloadCategoryDir(profile, download);
      return target === categoryDir || categoryDir.startsWith(`${target}${path.sep}`);
    } catch {
      // A profile with no usable download folder cannot claim anything; it
      // must not make an unrelated path look unowned or contested either.
      return false;
    }
  }

  ownershipCheck() {
    return { ownersOfPath: (localPath) => this.localPathOwners(localPath) };
  }

  // Asked before the first irreversible step of any delete, not at the last
  // one. Resolving the path early is not the same as asking who owns it early:
  // a delete that cancels the put.io transfer and only then finds the folder
  // contested has destroyed the remote copy for a deletion it goes on to
  // refuse, leaving a row nothing can complete.
  assertDeletable(localPath) {
    return assertSoleOwnedDownloadRoot(localPath, this.ownershipCheck());
  }

  // Where this download's files go: `<download_at>/<category>/<put.io name>`,
  // the name exactly as put.io named it. Every caller either writes into the
  // answer or deletes it, so a name that cannot name a folder of its own — an
  // empty one, or one made only of separators and dots — is an error here
  // rather than a path that quietly resolves to the category directory holding
  // every other download of that profile.
  requireStagingRoot(profile, download) {
    const root = downloadLocalRoot(profile, download);
    if (!root) {
      throw new Error(
        `Download ${download?.id ?? '(unknown)'} has no usable put.io name (${JSON.stringify(download?.name ?? '')}),`
        + ' so putiorr cannot tell which folder its files belong in',
      );
    }
    return root;
  }

  // Refused rather than truncated, and refused before anything is written.
  // Truncating would give the download a folder that no longer matches the
  // name torrent-get reports, and the *arr would look for its files under the
  // untruncated one — a failure with no symptom. Left to the filesystem it was
  // worse: mkdir failed inside the worker, on every poll, while the download
  // sat at 50% reporting no error at all.
  //
  // Only the paths that write ask this. Such a download has staged nothing, so
  // the paths that delete have nothing to lose by resolving a folder that does
  // not exist — and refusing there would leave the user with a download they
  // cannot get rid of either.
  assertStageableName(download) {
    const oversized = oversizedFolderSegment(stagingFolderName(download));
    if (!oversized) return;
    throw new Error(
      `Download ${download?.id ?? '(unknown)'} cannot be staged: put.io named it`
      + ` "${oversized.slice(0, 40)}…", which is ${Buffer.byteLength(oversized, 'utf8')} bytes,`
      + ' and a folder name can be at most 255; rename it on put.io and it will start',
    );
  }

  // The staging folder is the put.io name, and put.io does not deduplicate
  // names — so two *distinct* transfers it named the same thing, under one
  // profile and category, resolve to one directory. Interleaving them means
  // two workers writing one `.part` and each download finishing with a mix of
  // the two, silently. The download that claimed the folder first keeps it,
  // which is the older id, and every other one refuses and says whose folder
  // it is. Ids only ever go up, so the winner never changes.
  requireExclusiveStagingRoot(profile, download) {
    const root = this.requireStagingRoot(profile, download);
    this.assertStageableName(download);
    const claimed = this.downloadsStagingAt(root)
      .filter((rival) => rival.id < Number(download.id));
    if (claimed.length === 0) return root;
    throw new Error(
      `${root} already belongs to download ${claimed[0].id} (${claimed[0].name}),`
      + `${claimed[0].removed ? ' which is deleted but still has its files there,' : ''}`
      + ' which put.io named the same thing; rename one of them on put.io,'
      + ' or delete the one you do not want along with its files',
    );
  }

  // Called once per download, the first time its files are about to be
  // written: the folder it gets is recorded, and every later resolution — the
  // downloader, the sweeps, the deletes, the name reported over RPC — reads
  // that instead of the put.io name. A put.io rename then changes what the
  // user sees and nothing else, rather than pointing putiorr at an empty
  // directory and the sweep at the conclusion that the files are gone.
  claimStagingRoot(profile, download) {
    const root = this.requireExclusiveStagingRoot(profile, download);
    if (download.staging_folder) return root;
    const folder = stagingFolderName(download);
    this.store.updateDownload(download.id, { staging_folder: folder });
    logger.info('staged download folder frozen', {
      transferId: download.id,
      folder: root,
    });
    return root;
  }

  // Tombstoned downloads count. "Delete from the dashboard, keep the files on
  // disk" leaves the row removed and the folder full, and a rival that cannot
  // see it size-matches those files, calls itself complete and finalises —
  // handing the *arr another release's file under this download's name.
  downloadsStagingAt(root) {
    const claims = [];
    for (const download of [...this.store.listActiveDownloads(), ...this.store.listRemovedDownloads()]) {
      const profile = this.findDownloadOwner(download);
      if (!profile) continue;
      let candidate;
      try {
        candidate = downloadLocalRoot(profile, download);
      } catch {
        continue;
      }
      if (candidate === root) {
        claims.push({
          id: download.id,
          name: download.name,
          profile: profile.name,
          removed: Boolean(download.removed_at),
        });
      }
    }
    return claims.sort((left, right) => left.id - right.id);
  }

  // Every folder more than one live download resolves to, computed from the
  // database alone. Rebuilt on every poll like the adoption notice, so it
  // clears itself the moment one of the two is renamed or removed.
  stagingCollisions() {
    const byRoot = new Map();
    for (const download of [...this.store.listActiveDownloads(), ...this.store.listRemovedDownloads()]) {
      const profile = this.findDownloadOwner(download);
      if (!profile) continue;
      let root;
      try {
        root = downloadLocalRoot(profile, download);
      } catch {
        continue;
      }
      if (!root) continue;
      const group = byRoot.get(root) ?? [];
      group.push({
        id: download.id,
        name: download.name,
        profile: profile.name,
        removed: Boolean(download.removed_at),
      });
      byRoot.set(root, group);
    }
    return [...byRoot.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([localPath, group]) => ({
        localPath,
        downloads: group.sort((left, right) => left.id - right.id),
      }));
  }

  recordStagingCollisions() {
    const collisions = this.stagingCollisions();
    if (JSON.stringify(collisions) === JSON.stringify(this.store.stagingCollisions())) return collisions;
    this.store.saveStagingCollisions(collisions);
    if (collisions.length === 0) {
      logger.info('no downloads are competing for a staging folder any more');
      return collisions;
    }
    logger.warn('downloads share a staging folder and cannot both use it', {
      consequence: 'only the oldest of each group is downloaded; the others wait',
      fix: 'rename one of them on put.io, or delete the one you do not want',
      folders: collisions,
    });
    return collisions;
  }

  async ensureProfileFolder(profile) {
    const current = this.requireProfile(profile);
    if (current.putio_folder_id) return current;

    const folderId = await this.getPutio().ensureFolder(current.putio_folder_name);
    return this.store.updateProfile(current.id, { putio_folder_id: folderId });
  }

  async addTorrent(args = {}, profile, clientProfile) {
    // The path, then the calling app's own name, then a refusal — the same
    // order torrent-remove uses, and one step stricter than torrent-get, which
    // may end at nobody. This has to know where the files go, so an add it
    // cannot attribute is refused rather than guessed at. It used to resolve by
    // download-dir category instead, so an ambiguous shared endpoint accepted
    // adds it would then refuse to list or remove: the *arr grabbed releases it
    // could never see, import or clean up, and re-grabbed them every RSS cycle.
    //
    // The only RPC method that creates new work, so the only one that asks
    // whether the resolved profile accepts any. torrent-get and torrent-remove
    // deliberately do not: a disabled profile's queue still has to be
    // listable and clearable.
    const currentProfile = await this.ensureProfileFolder(
      this.requireProfile(this.resolveRpcProfile(profile, clientProfile)),
    );
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
      // Creating a put.io folder is work, so a disabled profile does not get
      // one made for it. The folder it already has is still its own, though,
      // and it stays on the map: adoption has to refuse a transfer that lands
      // there by name, not let whichever other profile shares the folder take
      // it, and not fall silent.
      profiles.push(profile.enabled ? await this.ensureProfileFolder(profile) : profile);
    }

    const byFolderId = new Map();
    for (const profile of profiles) {
      if (profile.putio_folder_id == null) continue;
      const matches = byFolderId.get(profile.putio_folder_id) ?? [];
      matches.push(profile);
      byFolderId.set(profile.putio_folder_id, matches);
    }
    const remoteTransfers = await putio.listTransfers();
    const remoteIds = new Set();
    const remoteHashes = new Set();
    const rows = [];
    const unattributed = new Map();
    for (const remote of remoteTransfers) {
      if (remote.id != null) remoteIds.add(remote.id);
      if (remote.hash) remoteHashes.add(String(remote.hash).trim().toLowerCase());
      // The poll is the only thing that advances every download on the box, so
      // one row that throws — a hash colliding with another row's put.io id is
      // the reproducible case — used to stop polling for all of them, on every
      // tick, until a restart. A bad row is skipped and named; the next tick
      // retries it.
      try {
        this.refreshRemoteTransfer(remote, byFolderId, rows, unattributed);
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
    this.recordAdoptionNotices(unattributed);
    this.pruneRemoteTransfers(remoteIds, remoteHashes);
    this.pruneRemovedTransfers(remoteIds, remoteHashes);
    return rows;
  }

  // Audit finding 9: adoption maps a put.io folder to a profile and gives up
  // unless exactly one profile owns that folder. Every profile defaults to the
  // same `putiorr` folder, which the README recommends, so in the documented
  // setup nothing is ever adopted — and it used to give up without a word. The
  // notice is rewritten from scratch on every poll, so it disappears by itself
  // once the folders are separated or the transfers are gone.
  recordAdoptionNotices(unattributed) {
    const notices = [...unattributed.values()].map((entry) => ({
      putioFolderId: entry.putioFolderId,
      folderName: entry.folderName,
      profiles: entry.profiles,
      disabled: entry.disabled,
      transferCount: entry.transfers.length,
      // Enough to recognise which transfers are stuck without turning a
      // settings row into a copy of the put.io transfer list. Sorted by id
      // because put.io's list order is its own business: reordering it is not
      // a change in the configuration this reports, and re-warning on every
      // poll would train the user to ignore the warning.
      transfers: [...entry.transfers].sort((left, right) => Number(left.id) - Number(right.id)).slice(0, 5),
    }));
    // Nothing is written or logged while the answer is the same as last time:
    // the poll runs every few seconds, and this is a report about
    // configuration, which does not change on that timescale.
    if (JSON.stringify(notices) === JSON.stringify(this.store.adoptionNotices())) return;
    this.store.saveAdoptionNotices(notices);

    if (notices.length === 0) {
      logger.info('every put.io transfer can be attributed to one RR profile again');
      return;
    }
    logger.warn('put.io transfers cannot be attributed to one RR profile', {
      consequence: 'they are not adopted, so putiorr will not download them',
      fix: 'give each RR profile its own put.io folder, or remove the transfers from put.io',
      folders: notices.map((notice) => ({
        putioFolderId: notice.putioFolderId,
        folderName: notice.folderName,
        profiles: notice.profiles,
        transferCount: notice.transferCount,
      })),
    });
  }

  // One put.io transfer's worth of work, extracted so the caller can isolate a
  // failure to the row that caused it. Appends the refreshed rows to `rows`.
  refreshRemoteTransfer(remote, byFolderId, rows, unattributed = new Map()) {
    const existing = remote.id ? this.store.findDownloadByPutioTransferId(remote.id) : undefined;

    if (existing) {
      // Writing the hash changes the string every *arr correlates its queue
      // item against, so neither the first write nor a later correction is
      // silent: the log names both sides. The first write matters as much —
      // a download put.io had no hash for reported none to the *arr too.
      const reported = String(remote.hash ?? '').trim().toLowerCase();
      const known = String(existing.hash ?? '').trim().toLowerCase();
      if (reported && reported !== known) {
        logger.info(known ? 'corrected download hash from put.io' : 'recorded download hash from put.io', {
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

    // Adoption of a transfer putiorr did not create. profile_id is mandatory,
    // so a folder that maps to no profile, or to more than one, has no answer
    // — but "no answer" is a thing the user has to be told rather than a
    // reason to move on quietly.
    const folderProfiles = byFolderId.get(remote.saveParentId) ?? [];
    if (folderProfiles.length !== 1) {
      this.recordUnattributedTransfer(remote, folderProfiles, unattributed);
      return;
    }
    const [profile] = folderProfiles;
    // Adopting a transfer is accepting new work, which is the one thing a
    // disabled profile does not do. It is reported rather than skipped: the
    // audit's fourth meaning of "disabled" was this branch, which said nothing
    // at all while the transfer sat on put.io forever.
    if (!profile.enabled) {
      this.recordUnattributedTransfer(remote, folderProfiles, unattributed);
      return;
    }
    rows.push(this.store.upsertDownload(putioTransferToStoreInput(remote, {
      profile_id: profile.id,
      source: remote.magnetUri ?? '',
      source_type: 'remote',
    })));
  }

  // Grouped by folder rather than listed per transfer: the problem is the
  // folder's mapping, and one line per stuck transfer on every poll is noise
  // that buries it.
  recordUnattributedTransfer(remote, folderProfiles, unattributed) {
    const putioFolderId = remote.saveParentId ?? null;
    const entry = unattributed.get(putioFolderId) ?? {
      putioFolderId,
      folderName: folderProfiles[0]?.putio_folder_name ?? '',
      profiles: folderProfiles.map((profile) => profile.name),
      // One profile owns the folder outright and is switched off. Told apart
      // from an unclaimed or contested folder because the fix is different:
      // enable the profile, rather than separate the folders.
      disabled: folderProfiles.length === 1 && !folderProfiles[0].enabled,
      transfers: [],
    };
    entry.transfers.push({ id: remote.id ?? null, name: remote.name ?? '' });
    unattributed.set(putioFolderId, entry);
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

  async getTorrents(args = {}, profile, clientProfile) {
    // The path, then the calling app's own name, then — deliberately — nobody:
    // an unresolved listing returns every download rather than an error. This
    // is the *arr's queue poll, so a refusal here does not read as "address
    // your own RPC path", it stops completed downloads being imported and
    // shows the client as failed. Each row is rendered against its own owner,
    // so the downloadDir of a row from another profile is still that profile's.
    const currentProfile = this.resolveListingProfile(profile, clientProfile);
    if (this.config.refreshOnRpc) {
      await this.refreshRemoteTransfers();
    }

    const requestedIds = args.ids === 'recently-active'
      ? []
      : Array.isArray(args.ids) ? args.ids : [];

    const fields = Array.isArray(args.fields) ? args.fields : [];
    const rows = requestedIds.length > 0
      ? requestedIds.map((id) => this.store.findDownload(id, { profileId: currentProfile?.id })).filter(Boolean)
      : this.store.listActiveDownloads({ profileId: currentProfile?.id });

    const torrents = rows.map((row) => this.toTransmissionTorrent(row, fields));
    return { torrents };
  }

  async removeTorrents(args = {}, profile, clientProfile) {
    // Destructive, so it refuses what it cannot attribute rather than falling
    // back to everything the way the listing does: a remove that resolved to no
    // one would delete across every profile at once.
    const currentProfile = this.resolveRpcProfile(profile, clientProfile);
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

      // Resolved before anything irreversible happens, the way the dashboard's
      // bucket delete does it: a download whose put.io name cannot name a
      // folder has no local half to delete, and discovering that after
      // cancelling the put.io transfer leaves a row that fails the same way on
      // every retry. The row was found scoped to this profile, so this is that
      // profile.
      const localTarget = deleteLocal ? this.assertDeletable(this.requireStagingRoot(currentProfile, transfer)) : undefined;

      // One download owns its put.io transfer outright, so removing it always
      // removes the remote side too; there is no second profile left holding a
      // claim on it.
      await this.removeRemoteTransfer(transfer);
      if (deleteLocal) {
        await deleteLocalData(localTarget, this.ownershipCheck());
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
      ? this.assertDeletable(this.requireStagingRoot(this.requireDownloadOwner(transfer), transfer))
      : undefined;

    const remoteDeleted = deleteRemote;
    let remoteAlreadyGone = false;
    if (remoteDeleted) {
      ({ alreadyGone: remoteAlreadyGone } = await this.removeRemoteTransfer(transfer, { throwOnError: true }));
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
      // put.io answered 404 rather than deleting anything: the caller's sweep
      // logs that as a different event from a delete it performed.
      remoteAlreadyGone,
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
      ? this.assertDeletable(this.requireStagingRoot(this.requireDownloadOwner(transfer), transfer))
      : undefined;

    const remoteDeleted = deleteRemote;
    let remoteAlreadyGone = false;
    if (remoteDeleted) {
      ({ alreadyGone: remoteAlreadyGone } = await this.removeRemoteFiles(files, { throwOnError: true }));
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
      // Reported the same way the bucket delete reports it: put.io answered 404
      // rather than deleting anything, so there is no remote copy left to
      // re-fetch and the dashboard says so instead of "deleted".
      remoteAlreadyGone,
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

  // Reads a 404 the way removeRemoteTransfer does: put.io agreeing, not put.io
  // failing. Treated as an error it made a per-file delete unretryable — the
  // call threw before the rows were touched, so the file stayed in the list and
  // every later attempt got the same 404 for a file nobody has.
  //
  // Returns `{ errors, alreadyGone }`, the same shape and for the same reason:
  // "put.io had already lost it" is a different event from "putiorr deleted
  // it", and the caller reports which one happened.
  async removeRemoteFiles(files, { throwOnError = false } = {}) {
    const errors = [];
    let alreadyGone = false;
    const putio = this.getPutio();
    for (const file of files) {
      try {
        await putio.deleteFile(file.putio_file_id);
      } catch (error) {
        if (error?.status === 404) alreadyGone = true;
        else errors.push(error);
        logger.warn(error?.status === 404 ? 'put.io no longer has the file' : 'failed to delete put.io file', {
          transferFileId: file.id,
          putioFileId: file.putio_file_id,
          error: error.message,
        });
      }
    }
    if (errors.length > 0 && throwOnError) {
      throw remoteDeleteError(errors);
    }
    return { errors, alreadyGone };
  }

  // A 404 is put.io agreeing, not put.io failing: the caller asked for the
  // remote copy to be gone and it is. Treated as an error it made every delete
  // that got half-way through unretryable — the first attempt cancels the
  // transfer, the local half then throws, and every attempt after that dies on
  // the 404 for a transfer nobody has. `pruneProcessedTransfersMissingLocalData`
  // already had to special-case this one caller deep; it belongs here, where
  // put.io is actually being asked.
  //
  // Returns `{ errors, alreadyGone }` — the second is what the prune's log
  // called `remoteMissing`, kept because "put.io had already lost it" is a
  // different event from "putiorr deleted it".
  async removeRemoteTransfer(transfer, { throwOnError = false } = {}) {
    const errors = [];
    let alreadyGone = false;
    const putio = this.getPutio();
    if (transfer.putio_file_id) {
      try {
        await putio.deleteFile(transfer.putio_file_id);
      } catch (error) {
        if (error?.status === 404) alreadyGone = true;
        else errors.push(error);
        logger.warn(error?.status === 404 ? 'put.io no longer has the file' : 'failed to delete put.io file', {
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
        if (error?.status === 404) alreadyGone = true;
        else errors.push(error);
        logger.warn(error?.status === 404 ? 'put.io no longer has the transfer' : 'failed to delete put.io transfer', {
          id: transfer.id,
          putioTransferId: transfer.putio_transfer_id,
          error: error.message,
        });
      }
    }
    if (errors.length > 0 && throwOnError) {
      throw remoteDeleteError(errors);
    }
    return { errors, alreadyGone };
  }

  toTransmissionTorrent(row, requestedFields = []) {
    // downloads.profile_id is NOT NULL REFERENCES profiles(id), so an ownerless
    // row is a hand-edited database rather than a state to render around — and
    // the owner is read from the row even when the request resolved to no
    // profile at all, so an unscoped listing still labels every download with
    // the folder its own profile stages into.
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
      // The folder the files are in, which is the name the *arr joins onto
      // downloadDir to find them. Before the first prepare there is nothing on
      // disk and this is simply the put.io name; after it, a put.io rename
      // changes the name but not where the files are.
      name: stagingFolderName(row),
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

  // What deleting this profile would touch, in the counts the confirmation has
  // to state before the user commits. Read from the database rather than from
  // whatever the dashboard happens to be showing: tombstoned downloads are not
  // in the working list, still hold their put.io transfer and their files, and
  // still block the profile's deletion.
  async profileDeletionPreview(profileId) {
    const profile = this.store.findProfileById(profileId);
    if (!profile) throw new Error('Profile not found');
    const downloads = this.store.listDownloadsForProfile(profile.id);
    let localBytes = 0;
    let filesOnDisk = 0;
    let unreadableFolders = 0;
    for (const download of downloads) {
      // Measured off the disk, because that is what rm(recursive) will take.
      // The file rows count completed downloads only: an in-flight one reads
      // as zero while its `.part` holds the whole release, and nothing records
      // a file the user put there. A folder whose name cannot be resolved has
      // nothing staged under it yet.
      let root;
      try {
        root = downloadLocalRoot(profile, download);
      } catch {
        root = undefined;
      }
      const measured = await measureDownloadFolder(root);
      localBytes += measured.bytes;
      filesOnDisk += measured.files;
      if (measured.unreadable) unreadableFolders += 1;
    }
    return {
      profile: {
        id: profile.id,
        name: profile.name,
        slug: profile.slug,
        downloadAt: profile.download_at,
        autoRemoveCompleted: profile.auto_remove_completed,
      },
      downloads: {
        total: downloads.length,
        active: downloads.filter((download) => !download.removed_at).length,
        removed: downloads.filter((download) => download.removed_at).length,
        filesOnDisk,
        localBytes,
        unreadableFolders,
      },
      reassignTargets: this.reassignTargetsFor(profile).map((target) => ({
        id: target.id,
        name: target.name,
        slug: target.slug,
        type: target.type,
        // The picker names the preset, and the confirmation names what
        // auto-remove will do to a download moved here: it leaves putiorr as
        // soon as it finishes, taking the *arr's queue item with it.
        autoRemoveCompleted: target.auto_remove_completed,
      })),
    };
  }

  // Only a profile that stages into the same folder can take these downloads.
  // A download's files live at `<download_at>/<category>/<frozen folder>`, and
  // nothing here moves anything on disk — so handing a row to a profile with a
  // different download_at points putiorr at an empty directory, and a completed
  // download whose files are missing is deleted and cancelled on put.io.
  // Freezing the staging folder made a put.io rename safe; it says nothing
  // about a change of owner.
  reassignTargetsFor(profile) {
    const from = path.resolve(String(profile.download_at ?? ''));
    return this.store.listProfiles().filter((candidate) => (
      candidate.id !== profile.id
      && candidate.download_at
      && path.resolve(candidate.download_at) === from
    ));
  }

  // Design decision 5, plus the project owner's third answer. `ON DELETE
  // RESTRICT` means the profile cannot go while a download references it, so
  // this performs the answer the user gave and then deletes the profile —
  // reporting what it did rather than leaving them to infer it.
  //
  // The three answers are exclusive per download and the endpoint takes one
  // intent, never a mix: moving a download and deleting it are different
  // outcomes for the same row, and a request asking for both has not said
  // which one it wants.
  async deleteProfileWithDownloads(profileId, {
    reassignTo = null,
    deleteDownloads = false,
    deleteRemote = false,
    deleteLocal = false,
  } = {}) {
    const profile = this.store.findProfileById(profileId);
    if (!profile) throw new Error('Profile not found');
    const downloads = this.store.listDownloadsForProfile(profile.id);
    const report = {
      total: downloads.length,
      reassigned: 0,
      deleted: 0,
      remoteDeleted: 0,
      localDeleted: 0,
    };

    if (reassignTo != null && (deleteDownloads || deleteRemote || deleteLocal)) {
      throw new Error(
        `RR profile ${profile.name}'s downloads cannot both be moved and deleted;`
        + ' pick one and send it again',
      );
    }

    if (downloads.length > 0 && reassignTo == null && !deleteDownloads) {
      // Not a silent removal and not a bare foreign-key error: the user is told
      // exactly what stands in the way and what the two answers are.
      throw new Error(
        `RR profile ${profile.name} still owns ${pluralizeDownloads(downloads.length)}.`
        + ' Move them to another RR profile, or confirm they are to be removed from putiorr'
        + ' — deleting the profile cannot leave them without an owner',
      );
    }

    if (reassignTo != null) {
      const target = this.store.findProfileById(reassignTo);
      if (!target) throw new Error('Profile not found');
      if (target.id === profile.id) {
        throw new Error(`RR profile ${profile.name} cannot take over its own downloads`);
      }
      if (!this.reassignTargetsFor(profile).some((candidate) => candidate.id === target.id)) {
        throw new Error(
          `RR profile ${target.name} downloads into ${target.download_at || '(nothing)'},`
          + ` not ${profile.download_at || '(nothing)'}, so moving these downloads to it would leave`
          + ' their files where they are and point putiorr somewhere else — a finished download whose'
          + ' files are missing is deleted and cancelled on put.io. Move the files first, or pick a'
          + ` profile that downloads into ${profile.download_at || '(nothing)'}.`
          + ' The two folders are compared as they are written, so a symlink or a bind mount naming'
          + ' the same directory counts as a different one',
        );
      }
      report.reassigned = this.store.reassignDownloads(profile.id, target.id);
      this.store.deleteProfile(profile.id);
      logger.info('RR profile deleted, its downloads moved', {
        profile: profile.slug,
        to: target.slug,
        reassigned: report.reassigned,
      });
      return { ok: true, profile: { id: profile.id, name: profile.name }, downloads: report };
    }

    for (const download of downloads) {
      // Resolved and cleared for deletion before put.io is touched, the same
      // order every other delete path uses: a refusal that arrives after the
      // transfer is cancelled has destroyed the only remaining copy.
      let localTarget;
      try {
        localTarget = deleteLocal
          ? this.assertDeletable(this.requireStagingRoot(profile, download))
          : undefined;
        if (deleteRemote) {
          await this.removeRemoteTransfer(download, { throwOnError: true });
          report.remoteDeleted += 1;
        }
        if (deleteLocal) {
          await deleteLocalData(localTarget, this.ownershipCheck());
          report.localDeleted += 1;
        }
      } catch (error) {
        // Each download is its own irreversible sequence, so there is no
        // transaction to roll back to, and the user has to be told which half
        // of the list is gone before they retry. Every counter is quoted, not
        // just the rows: a delete that cancelled the put.io transfer and then
        // failed on the files had already destroyed the last copy while
        // "deleted 0 downloads" said nothing happened.
        throw profileDeletionError(
          `Stopped at download ${download.id} (${download.name}) after`
          + ` ${describeProfileDeletionProgress(report, downloads.length)}: ${error.message}`,
          report,
        );
      }
      // The row itself always goes. profile_id is NOT NULL, so there is no
      // owner left to keep it under, and a tombstone would only block the
      // profile's deletion. A put.io transfer the user chose to keep shows up
      // in the dashboard's adoption notice on the next poll instead.
      this.store.deleteDownload(download.id);
      report.deleted += 1;
    }

    // Asked again, because the list above was taken before a loop that awaits
    // put.io once per download and the poll adopts transfers in that window. A
    // row that arrived in the gap would otherwise reach the user as
    // ON DELETE RESTRICT's own sentence — which says nothing about the put.io
    // transfers this call has already cancelled.
    const arrived = this.store.listDownloadsForProfile(profile.id);
    if (arrived.length > 0) {
      throw profileDeletionError(
        `RR profile ${profile.name} took on ${arrived.length} more`
        + ` download${arrived.length === 1 ? '' : 's'} from put.io while this delete was running,`
        + ` after ${describeProfileDeletionProgress(report, downloads.length)}.`
        + ' Run the delete again to include them',
        report,
      );
    }

    this.store.deleteProfile(profile.id);
    logger.info('RR profile deleted with its downloads', {
      profile: profile.slug,
      ...report,
    });
    return { ok: true, profile: { id: profile.id, name: profile.name }, downloads: report };
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

  // The one deletion target putiorr does not compute from a live profile and
  // a live download: a path a previous version recorded, from a put.io name
  // that came out of torrent metadata. Three things have to be true before it
  // can go to rm(recursive), and every one of them was reproduced deleting
  // something else when it was missing.
  //
  // It must be absolute — a relative path resolves against process.cwd(), and
  // whatever sits there is not this download. It must be somewhere putiorr
  // stages, because putiorr never put files anywhere else and cannot claim
  // what it did not write. And it must be the folder this row's own name
  // spells, so a row whose name is empty cannot name the category directory
  // holding every other download, and one whose name is '..' cannot name the
  // directory above the staging root.
  quarantinedDownloadFolder(row) {
    const recorded = String(row.legacy_download_dir ?? '');
    const refusal = `putiorr cannot tell which files belong to ${row.name || 'this download'},`
      + ' so it will not delete any; remove them by hand, then delete this entry'
      + ' without the local-files option';
    if (!path.isAbsolute(recorded)) throw new Error(refusal);

    const target = path.resolve(recorded);
    const staged = this.store.listProfiles().some((profile) => (
      profile.download_at && target.startsWith(`${path.resolve(profile.download_at)}${path.sep}`)
    ));
    if (!staged) throw new Error(refusal);

    const segments = downloadFolderSegments(row.name);
    if (!segments || !target.endsWith(`${path.sep}${segments}`)) throw new Error(refusal);
    return target;
  }

  async deleteOrphanedDownload(orphanId, { deleteRemote = false, deleteLocal = false } = {}) {
    const row = this.store.findOrphanedDownloadById(orphanId);
    if (!row) throw new Error('Quarantined download not found');

    // Resolved and cleared for deletion before put.io is touched, the way
    // every other delete path does it. This is the worst place to get that
    // order wrong: a quarantined row has no live download, so the put.io copy
    // is the only recoverable one, and the local half goes on to refuse.
    const localTarget = deleteLocal ? this.assertDeletable(this.quarantinedDownloadFolder(row)) : undefined;

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
      await deleteLocalData(localTarget, this.ownershipCheck());
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
