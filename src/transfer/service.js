import crypto from 'node:crypto';
import path from 'node:path';
import { deleteLocalData, extractCategory } from '../download/paths.js';
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
    const rows = [];
    for (const remote of remoteTransfers) {
      const profile = byFolderId.get(remote.saveParentId);
      if (!profile) continue;
      const existing = remote.id ? this.store.findTransferByPutioId(remote.id) : undefined;
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
    return rows;
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
      this.store.markTransferRemoved(transfer.id);
      logger.info('torrent removed', {
        id: transfer.id,
        hash: transfer.hash,
        deleteLocal,
      });
    }

    return {};
  }

  async removeRemoteTransfer(transfer) {
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
    return errors;
  }

  toTransmissionTorrent(row, requestedFields = []) {
    const profile = this.store.findProfileById(row.profile_id) ?? this.getDefaultProfile();
    const stats = this.store.getTransferFileStats(row.id);
    const progress = calculateTransmissionProgress(row, stats);
    const torrent = {
      id: row.id,
      hashString: row.hash,
      name: row.name,
      eta: row.eta ?? -1,
      status: progress.status,
      downloadDir: path.join(profile.download_at, row.category ?? ''),
      totalSize: row.total_size,
      leftUntilDone: progress.leftUntilDone,
      uploadedEver: row.uploaded_ever,
      downloadedEver: Math.max(row.downloaded_ever, Number(stats.downloaded_size ?? 0)),
      percentDone: progress.percentDone,
      rateDownload: row.download_speed,
      rateUpload: row.upload_speed,
      uploadRatio: row.total_size > 0 ? row.uploaded_ever / row.total_size : 0,
      error: row.error,
      errorString: row.error_string,
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

  listDownloads() {
    return this.store.listActiveTransfers().map((row) => {
      const profile = this.store.findProfileById(row.profile_id) ?? this.getDefaultProfile();
      const stats = this.store.getTransferFileStats(row.id);
      const progress = calculateTransmissionProgress(row, stats);
      return {
        id: row.id,
        hash: row.hash,
        name: row.name,
        profileId: profile?.id,
        profileName: profile?.name ?? 'Unknown',
        profileType: profile?.type ?? 'custom',
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
        },
      };
    });
  }
}
