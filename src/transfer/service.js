import crypto from 'node:crypto';
import path from 'node:path';
import { deleteLocalData, deleteLocalFileData, extractCategory } from '../download/paths.js';
import { logger } from '../logger.js';
import { PutioClient } from '../putio/client.js';
import { calculateTransmissionProgress } from '../transmission/progress.js';

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function generatedHash() {
  return crypto.randomBytes(20).toString('hex');
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

function putioTransferToStoreInput(transfer, fallback = {}) {
  const lifecycle = fallback.lifecycle ?? 'remote';
  const useLocalMetrics = lifecycle !== 'remote';
  return {
    profile_id: fallback.profile_id,
    putio_transfer_id: transfer.id ?? fallback.putio_transfer_id,
    putio_file_id: transfer.fileId ?? fallback.putio_file_id,
    save_parent_id: transfer.saveParentId ?? fallback.save_parent_id,
    hash: fallback.hash || transfer.hash || generatedHash(),
    name: transfer.name || fallback.name || deriveNameFromSource(fallback.source),
    source: fallback.source ?? transfer.magnetUri ?? '',
    source_type: fallback.source_type ?? 'remote',
    category: fallback.category,
    download_dir: fallback.download_dir,
    lifecycle,
    putio_status: transfer.status,
    percent_done: transfer.percentDone,
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

  getDefaultProfile() {
    return this.store.findProfileBySlug('default') ?? this.store.listProfiles()[0];
  }

  getProfileForRpcPath(rpcPath) {
    return this.store.findProfileByRpcPath(rpcPath) ?? this.getDefaultProfile();
  }

  findProfileByCategory(category) {
    const [firstSegment] = String(category ?? '').split(/[\\/]/).filter(Boolean);
    const normalized = firstSegment?.toLowerCase();
    if (!normalized) return undefined;
    return this.store.listProfiles().find((profile) => (
      profile.slug?.toLowerCase() === normalized
      || profile.type?.toLowerCase() === normalized
      || profile.name?.toLowerCase() === normalized
    ));
  }

  resolveProfileForAdd(args = {}, profile) {
    if (profile) return profile;
    const fallbackProfile = this.getDefaultProfile();
    const downloadDir = firstDefined(args.downloadDir, args['download-dir'], '');
    const category = extractCategory(fallbackProfile?.download_at ?? this.config.targetDir, downloadDir);
    return this.findProfileByCategory(category) ?? fallbackProfile;
  }

  requireProfile(profile) {
    if (!profile) throw new Error('No enabled RR profile is configured');
    if (!profile.enabled) throw new Error(`RR profile ${profile.name} is disabled`);
    return profile;
  }

  async ensureProfileFolder(profile) {
    const current = this.requireProfile(profile);
    if (current.putio_folder_id) return current;

    const folderId = await this.getPutio().ensureFolder(current.putio_folder_name);
    return this.store.updateProfile(current.id, { putio_folder_id: folderId });
  }

  async addTorrent(args = {}, profile) {
    const currentProfile = await this.ensureProfileFolder(this.resolveProfileForAdd(args, profile));
    const filename = firstDefined(args.filename, args.url);
    const magnetLink = firstDefined(args.magnetLink, args['magnet-link']);
    const metainfo = args.metainfo;
    const downloadDir = firstDefined(args.downloadDir, args['download-dir'], '');
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

    const row = this.store.createOrUpdateTransfer(putioTransferToStoreInput(putioTransfer, {
      profile_id: currentProfile.id,
      hash: deriveHashFromSource(source),
      source,
      source_type: sourceType,
      category,
      download_dir: downloadDir,
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

    const byFolderId = new Map(profiles.map((profile) => [profile.putio_folder_id, profile]));
    const remoteTransfers = await putio.listTransfers();
    const remoteIds = new Set();
    const remoteHashes = new Set();
    const rows = [];
    for (const remote of remoteTransfers) {
      if (remote.id != null) remoteIds.add(remote.id);
      if (remote.hash) remoteHashes.add(remote.hash);
      const profile = byFolderId.get(remote.saveParentId);
      if (!profile) continue;
      const existing = remote.id ? this.store.findTransferByPutioId(remote.id) : undefined;
      if (existing?.removed_at) continue;
      rows.push(this.store.createOrUpdateTransfer(putioTransferToStoreInput(remote, {
        profile_id: profile.id,
        hash: existing?.hash,
        category: existing?.category ?? '',
        download_dir: existing?.download_dir ?? '',
        lifecycle: existing?.lifecycle ?? 'remote',
        download_speed: existing?.download_speed,
        eta: existing?.eta,
        source: existing?.source ?? remote.magnetUri ?? '',
        source_type: existing?.source_type ?? 'remote',
      })));
    }
    this.pruneRemovedTransfers(remoteIds, remoteHashes);
    return rows;
  }

  // Tombstoned transfers (deleted from the dashboard but kept on put.io) only need to
  // survive long enough to suppress resurrection. Once put.io no longer lists them,
  // the tombstone is dead weight, so hard-delete it here (files cascade away). This
  // reuses the transfer list already fetched by the poll — no extra API calls.
  pruneRemovedTransfers(remoteIds, remoteHashes) {
    for (const removed of this.store.listRemovedTransfers()) {
      const stillRemote =
        (removed.putio_transfer_id != null && remoteIds.has(removed.putio_transfer_id)) ||
        (removed.hash && remoteHashes.has(removed.hash));
      if (!stillRemote) {
        this.store.deleteTransfer(removed.id);
        logger.info('pruned tombstoned transfer no longer on put.io', {
          id: removed.id,
          hash: removed.hash,
        });
      }
    }
  }

  async getTorrents(args = {}, profile) {
    if (this.config.refreshOnRpc) {
      await this.refreshRemoteTransfers();
    }

    const requestedIds = args.ids === 'recently-active'
      ? []
      : Array.isArray(args.ids) ? args.ids : [];

    const fields = Array.isArray(args.fields) ? args.fields : [];
    const rows = requestedIds.length > 0
      ? requestedIds.map((id) => this.store.findTransfer(id)).filter(Boolean)
      : this.store.listActiveTransfers({ profileId: profile?.id });

    const torrents = rows.map((row) => this.toTransmissionTorrent(row, fields));
    return { torrents };
  }

  async removeTorrents(args = {}, profile) {
    const ids = Array.isArray(args.ids) ? args.ids : [];
    const deleteLocal = Boolean(args['delete-local-data'] ?? args.deleteLocalData);

    for (const id of ids) {
      const transfer = this.store.findTransfer(id);
      if (!transfer) continue;
      if (profile?.id && transfer.profile_id !== profile.id) continue;

      await this.removeRemoteTransfer(transfer);
      if (deleteLocal) {
        const transferProfile = this.store.findProfileById(transfer.profile_id) ?? this.getDefaultProfile();
        const targetDir = path.join(transferProfile.download_at, transfer.category ?? '');
        await deleteLocalData(targetDir, transfer.name);
      }
      this.store.deleteTransfer(transfer.id);
      logger.info('torrent removed', {
        id: transfer.id,
        hash: transfer.hash,
        deleteLocal,
      });
    }

    return {};
  }

  async deleteDownloadBucket(transferId, { deleteRemote = true, deleteLocal = true } = {}) {
    const transfer = this.store.findTransfer(transferId);
    if (!transfer || transfer.removed_at) {
      throw new Error('Download bucket not found');
    }

    if (deleteRemote) {
      await this.removeRemoteTransfer(transfer, { throwOnError: true });
    }

    const profile = this.store.findProfileById(transfer.profile_id) ?? this.getDefaultProfile();
    const targetDir = path.join(profile.download_at, transfer.category ?? '');
    const fileCount = this.store.listFilesForTransfer(transfer.id).length;
    if (deleteLocal) {
      await deleteLocalData(targetDir, transfer.name);
    }
    // When the transfer is gone from put.io it can never be resurrected by a poll,
    // so the row (and its files via cascade) is hard-deleted. When it is kept on
    // put.io we must tombstone instead, or refreshRemoteTransfers would re-add it.
    if (deleteRemote) {
      this.store.deleteTransfer(transfer.id);
    } else {
      this.store.markTransferRemoved(transfer.id);
    }

    logger.info('download bucket deleted from dashboard', {
      id: transfer.id,
      hash: transfer.hash,
      deleteRemote,
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
    const transfer = this.store.findTransfer(transferId);
    if (!transfer || transfer.removed_at) {
      throw new Error('Download bucket not found');
    }

    const requestedIds = new Set(
      (Array.isArray(fileIds) ? fileIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    );
    const visibleFiles = this.store.listFilesForTransfer(transfer.id);
    const files = visibleFiles.filter((file) => requestedIds.has(Number(file.id)));
    if (files.length === 0) {
      throw new Error('No files selected');
    }

    if (files.length === visibleFiles.length) {
      return this.deleteDownloadBucket(transfer.id, { deleteRemote, deleteLocal });
    }

    if (deleteRemote) {
      await this.removeRemoteFiles(files, { throwOnError: true });
    }

    // Mirror the bucket logic at file granularity: a file removed from put.io is
    // hard-deleted (it cannot be re-listed during download prep), while a file kept
    // on put.io is tombstoned so the downloader leaves it alone instead of re-fetching.
    this.store.transaction(() => {
      for (const file of files) {
        if (deleteRemote) {
          this.store.deleteTransferFile(file.id);
        } else {
          this.store.markTransferFileDeleted(file.id);
        }
      }
    });

    if (deleteLocal) {
      const profile = this.store.findProfileById(transfer.profile_id) ?? this.getDefaultProfile();
      const targetDir = path.join(profile.download_at, transfer.category ?? '');
      for (const file of files) {
        await deleteLocalFileData(targetDir, transfer.name, file.relative_path);
      }
    }

    this.refreshTransferAfterFileDeletion(transfer.id);

    logger.info('download files deleted from dashboard', {
      id: transfer.id,
      hash: transfer.hash,
      deleteRemote,
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
    const transfer = this.store.findTransferById(transferId);
    if (!transfer || transfer.removed_at) return undefined;
    const stats = this.store.getTransferFileStats(transferId);
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

    return this.store.updateTransfer(transferId, patch);
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
      throw new Error(remoteDeleteErrorMessage(errors));
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
      throw new Error(remoteDeleteErrorMessage(errors));
    }
    return errors;
  }

  toTransmissionTorrent(row, requestedFields = []) {
    const profile = this.store.findProfileById(row.profile_id) ?? this.getDefaultProfile();
    const stats = this.store.getTransferFileStats(row.id);
    const progress = calculateTransmissionProgress(row, stats);
    const files = this.store.listFilesForTransfer(row.id);
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

  listDownloads() {
    return this.store.listActiveTransfers().map((row) => {
      const profile = this.store.findProfileById(row.profile_id) ?? this.getDefaultProfile();
      const downloadProfile = profile
        ? this.store.findDownloadProfileById(profile.download_profile_id) ?? this.store.findDefaultDownloadProfile()
        : this.store.findDefaultDownloadProfile();
      const stats = this.store.getTransferFileStats(row.id);
      const fileItems = this.store.listFilesForTransfer(row.id).map((file) => {
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
      const progress = calculateTransmissionProgress(row, stats);
      return {
        id: row.id,
        hash: row.hash,
        name: row.name,
        profileId: profile?.id,
        profileName: profile?.name ?? 'Unknown',
        profileType: profile?.type ?? 'custom',
        downloadProfileId: downloadProfile?.id,
        downloadProfileName: downloadProfile?.name ?? 'Default',
        putioFolder: profile?.putio_folder_name ?? '',
        downloadAt: profile ? path.join(profile.download_at, row.category ?? '') : '',
        lifecycle: row.lifecycle,
        putioStatus: row.putio_status,
        putioProgress: Math.max(0, Math.min(100, Number(row.percent_done ?? 0))),
        localProgress: Number(stats.total_size ?? 0) > 0
          ? Math.round((Number(stats.downloaded_size ?? 0) / Number(stats.total_size)) * 100)
          : 0,
        combinedProgress: Math.round(progress.percentDone * 100),
        speed: row.download_speed,
        eta: row.eta,
        error: row.error_string,
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
