import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { logger } from '../logger.js';
import { downloadPolicyForContext, isSlowSpeedResetEnabled } from './policy.js';
import { rejectRelease } from '../arr/client.js';
import { supportsArrRejection } from '../web/constants.js';
import { inspectRelease } from './release-check.js';
import {
  downloadLocalRoot,
  fileExistsWithSize,
  normalizeRelativePath,
  resolveInside,
} from './paths.js';

const READY_REMOTE_STATUSES = new Set(['COMPLETED', 'SEEDING']);
const SLOW_RESET_PAUSE_MS = 500;
// How many times a file is fetched before it is left alone. It bounds both
// ends of the retry: what counts as spent, and what the queue stops offering.
const MAX_FILE_ATTEMPTS = 3;
// Issue #111. How many polls a rejection waits for the *arr to notice the
// download before giving up and fetching it. The *arr rebuilds its queue from
// putiorr on its own schedule, so the first look after put.io finishes often
// finds nothing. At the default 30s poll this is about two and a half minutes.
const REJECTION_ATTEMPTS = 5;

class SlowSpeedResetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SlowSpeedResetError';
    this.code = 'SLOW_SPEED_RESET';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function profileAutoRemovesCompleted(profile) {
  return Boolean(profile?.auto_remove_completed ?? profile?.autoRemoveCompleted);
}

async function sizeOf(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : 0;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

export class DownloadManager {
  constructor({
    config,
    store,
    service,
    fetchImpl = globalThis.fetch,
    now = Date.now,
  }) {
    this.config = config;
    this.store = store;
    this.service = service;
    this.fetch = fetchImpl;
    this.now = now;
    this.controller = new AbortController();
    this.running = false;
    this.pollTimer = undefined;
    this.workers = [];
    this.activeFileIds = new Set();
    this.activeFileRates = new Map();
    // Issue #111. How many polls a rejection has waited for the *arr to catch
    // up, keyed by download id. In memory on purpose: a restart just starts the
    // wait again, which is harmless, and this is not worth a column.
    this.rejectionAttempts = new Map();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      await this.pollOnce();
    } catch (error) {
      logger.warn('initial poll failed', { error: error.message });
    }
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((error) => {
        logger.error('poll failed', { error: error.message });
      });
    }, this.config.pollIntervalMs);

    for (let index = 0; index < this.config.workers; index += 1) {
      this.workers.push(this.workerLoop(index));
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.controller.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    await Promise.allSettled(this.workers);
  }

  async pollOnce() {
    // Before anything reads or writes a staging folder: two downloads put.io
    // named the same thing resolve to one, and the poll is where that becomes
    // visible instead of one of them simply never progressing.
    this.service.recordStagingCollisions();
    await this.pruneProcessedTransfersMissingLocalData();
    const purgedFiles = this.store.purgeDeletedFilesForProcessedDownloads();
    if (purgedFiles > 0) {
      logger.info('purged tombstoned files under processed transfers', { count: purgedFiles });
    }
    await this.removeProcessedAutoRemoveTransfers();
    // Issue #111. The rejection log is append-only and nothing else trims it, so
    // it is pruned on the poll rather than growing without bound.
    const prunedRejections = this.store.pruneRejectedReleases();
    if (prunedRejections > 0) {
      logger.info('pruned rejected releases past their retention', { count: prunedRejections });
    }
    if (!this.service.getPutioToken()) return;
    const rows = await this.service.refreshRemoteTransfers();
    for (const row of rows) {
      if (READY_REMOTE_STATUSES.has(row.putio_status) && row.lifecycle !== 'processed') {
        await this.prepareTransferSafely(row);
      }
    }
  }

  // A single transfer failing must never abort the whole poll, or every other transfer
  // behind it in the list stops making progress. A put.io 404 means the transfer's files
  // no longer exist remotely, so it is handled like a dashboard bucket delete with default
  // options: put.io is already gone (nothing to delete there) and downloaded files are kept
  // on disk — only the local DB row (and its file rows, via cascade) is removed. Any other
  // error is transient and left for the next poll to retry.
  async prepareTransferSafely(row) {
    try {
      await this.prepareTransfer(row);
    } catch (error) {
      if (error.status === 404) {
        // The transfer's files no longer exist on put.io. Apply the default bucket-delete:
        // also remove it from put.io (best-effort) and keep the downloaded files on disk.
        // Tombstone rather than hard-delete so a still-listed transfer can't be resurrected
        // into an every-poll 404 loop; the poll prune physically removes the row once put.io
        // has dropped the transfer.
        if (this.service.getPutioToken()) {
          await this.service.removeRemoteTransfer(row);
        }
        this.store.markDownloadRemoved(row.id);
        logger.warn('transfer files missing on put.io; removed bucket, kept downloaded files', {
          transferId: row.id,
          name: row.name,
          error: error.message,
        });
        return;
      }
      this.recordTransferStartFailure(row, error, 'failed to prepare transfer; will retry next poll');
    }
  }

  async startTransferDownload(transferId) {
    let transfer = this.store.findDownloadById(transferId);
    if (!transfer || transfer.removed_at) throw new Error('Download not found');

    try {
      if (!this.service.getPutioToken()) {
        throw new Error('Put.io token is required before starting downloads');
      }

      if (!READY_REMOTE_STATUSES.has(transfer.putio_status) || !transfer.putio_file_id) {
        await this.service.refreshRemoteTransfers();
        transfer = this.store.findDownloadById(transferId);
      }

      if (!transfer || transfer.removed_at) throw new Error('Download not found');
      if (!READY_REMOTE_STATUSES.has(transfer.putio_status)) {
        throw new Error(`put.io transfer is ${transfer.putio_status || 'UNKNOWN'}, not ready to download yet`);
      }

      await this.prepareTransfer(transfer);
      const files = this.store.listFilesForDownload(transfer.id);
      logger.info('manual download start requested', {
        transferId: transfer.id,
        name: transfer.name,
        files: files.length,
      });
      return {
        ok: true,
        transferId: transfer.id,
        files: files.length,
      };
    } catch (error) {
      this.recordTransferStartFailure(transfer, error, 'manual download start failed');
      throw error;
    }
  }

  recordTransferStartFailure(transfer, error, message) {
    if (transfer?.id) {
      this.store.updateDownload(transfer.id, {
        error: true,
        error_string: error.message,
        download_speed: 0,
        eta: -1,
      });
    }
    logger.warn(message, {
      transferId: transfer?.id,
      putioTransferId: transfer?.putio_transfer_id,
      putioFileId: transfer?.putio_file_id,
      name: transfer?.name,
      status: error.status,
      error: error.message,
      stack: error.stack,
    });
  }

  async prepareTransfer(transfer) {
    if (!transfer.putio_file_id) {
      throw new Error('ready transfer has no put.io file id');
    }

    // No owner means no folder to stage into. This used to borrow whichever
    // profile sorted first and write another profile's files into its folder.
    const profile = this.service.requireDownloadOwner(transfer);
    const remoteFiles = await this.service.getPutio().listTransferFiles(transfer.putio_file_id);
    if (remoteFiles.length === 0) {
      throw new Error('ready transfer has no downloadable files on put.io');
    }

    // Issue #111. The last moment this is free: put.io has listed the files, and
    // nothing has been staged or fetched yet. A release that cannot be imported
    // is rejected here rather than downloaded, imported-and-failed, and left
    // blocking the *arr queue.
    if (await this.rejectUnimportableTransfer(transfer, profile, remoteFiles)) return;

    // Claimed before the row is moved on, because claiming is the step that can
    // refuse — a staging collision, or a put.io name too long to be a folder.
    // Flipping lifecycle first left a refused download sitting at 'downloading'
    // with no staging folder, which is exactly the shape the upgrade backfill
    // was written to freeze: the next boot recorded the folder as the very name
    // the refusal had just told the user to change, and both remedies stopped
    // working for good.
    const downloadRoot = this.service.claimStagingRoot(profile, transfer);
    const updated = this.store.updateDownload(transfer.id, {
      lifecycle: 'downloading',
      error: false,
      error_string: '',
    });
    const remoteFileIds = [];
    let totalSize = 0;
    for (const remoteFile of remoteFiles) {
      remoteFileIds.push(remoteFile.id);
      const relativePath = normalizeRelativePath(remoteFile.relativePath ?? remoteFile.name);
      const size = Number(remoteFile.size ?? 0);
      totalSize += size;
      const targetPath = resolveInside(downloadRoot, relativePath);
      const exists = await fileExistsWithSize(targetPath, size);
      const partSize = exists ? size : Math.min(await sizeOf(`${targetPath}.part`), size);
      this.store.upsertDownloadFile({
        download_id: updated.id,
        putio_file_id: remoteFile.id,
        relative_path: relativePath,
        size,
        downloaded_bytes: exists ? size : partSize,
        status: exists ? 'complete' : 'pending',
      });
    }

    // What put.io lists is the whole truth about this download's files. Rows
    // for files it no longer has were never removed, so they stayed pending
    // against a file id that 404s and kept the download from ever completing.
    const reaped = this.store.deleteDownloadFilesNotIn(updated.id, remoteFileIds);
    if (reaped > 0) {
      logger.info('forgot download files put.io no longer lists', {
        transferId: updated.id,
        name: updated.name,
        count: reaped,
      });
    }

    this.store.updateDownload(updated.id, { total_size: totalSize });
    await this.finalizeTransferIfComplete(updated.id);
  }

  // Issue #111. Returns true when the release was rejected and prepareTransfer
  // must stop. Every failure path returns false: a profile with no *arr
  // configured, an *arr that cannot be reached, or a queue it does not hold
  // this hash in all mean putiorr downloads the release as it always did.
  // Rejecting is the exceptional branch, and it never runs on a guess.
  async rejectUnimportableTransfer(transfer, profile, remoteFiles) {
    if (!profile?.reject_unimportable) return false;
    if (!supportsArrRejection(profile.type)) return false;
    if (!profile.arr_base_url || !profile.arr_api_key) return false;

    const verdict = inspectRelease({
      files: remoteFiles,
      announcedSize: Number(transfer.total_size ?? 0),
      minSize: Number(profile.reject_min_size ?? 0),
      // What the owning app can import is what makes a release valid, so the
      // preset decides the rule rather than only deciding whether it runs.
      preset: profile.type,
    });
    if (!verdict.reject) {
      this.rejectionAttempts.delete(transfer.id);
      return false;
    }

    const record = (outcome) => {
      try {
        this.store.recordRejectedRelease({
          profileName: profile.name,
          name: transfer.name,
          reason: verdict.reason,
          outcome,
        });
      } catch (error) {
        // Bookkeeping must never be the reason a rejection fails to happen.
        logger.warn('failed to record a rejected release', {
          transferId: transfer.id,
          error: error.message,
        });
      }
    };

    // Conceding means downloading the release and writing a row that says the
    // rejection did not happen. Both are worth delaying: the *arr often has not
    // refreshed its queue from putiorr yet, and one more poll is enough. Give
    // up only once waiting has stopped being plausible.
    const concede = (message, meta) => {
      const attempts = (this.rejectionAttempts.get(transfer.id) ?? 0) + 1;
      if (attempts < REJECTION_ATTEMPTS) {
        this.rejectionAttempts.set(transfer.id, attempts);
        logger.info(`${message}; waiting for the next poll`, { ...meta, attempt: attempts });
        // Nothing is staged and nothing is recorded: this transfer is simply
        // left ready, and the next poll asks again.
        return true;
      }
      this.rejectionAttempts.delete(transfer.id);
      logger.warn(`${message}; downloading it anyway`, { ...meta, attempts });
      record('downloaded');
      return false;
    };

    const meta = {
      transferId: transfer.id,
      name: transfer.name,
      profile: profile.name,
      reason: verdict.reason,
    };

    const hash = transfer.hash;
    if (!hash) {
      // No identity means no queue item can ever be matched, so waiting cannot
      // help and this is not deferred.
      logger.warn('cannot reject unimportable release without a torrent hash', meta);
      this.rejectionAttempts.delete(transfer.id);
      record('downloaded');
      return false;
    }

    let result;
    try {
      result = await rejectRelease({
        baseUrl: profile.arr_base_url,
        apiKey: profile.arr_api_key,
        hash,
        preset: profile.type,
        fetchImpl: this.fetch,
      });
    } catch (error) {
      // Downloading a bad release is recoverable by hand; silently dropping one
      // the *arr still has queued is not, because nothing would ever search
      // again for it.
      return concede('failed to tell the *arr to blocklist an unimportable release', {
        ...meta, error: error.message,
      });
    }

    if (!result.queued) {
      // queueSize is the diagnostic that separates "the *arr has not seen this
      // download yet" from "the hash putiorr reports is not the one the *arr
      // recorded": an empty queue is the first, a full one holding other items
      // is the second.
      return concede('the *arr has no queue item for this release', {
        ...meta, hash, arrQueueSize: result.queueSize,
      });
    }

    this.rejectionAttempts.delete(transfer.id);
    record('blocklisted');
    logger.info('rejected unimportable release; told the *arr to blocklist and search again', {
      ...meta,
      hash,
      searched: result.searched,
      searchCommand: result.searchCommand,
      searchIds: result.searchIds,
      matchedQueueIds: result.matchedQueueIds,
      arrQueueSize: result.queueSize,
    });
    if (!result.searched) {
      // The queue item carried no episode or movie id, so there is nothing to
      // name in a search command. Blocklisted, but nothing will replace it.
      logger.warn('blocklisted the release but could not ask the *arr to search again', meta);
    }

    // Nothing has been staged yet, so there is nothing local to delete. The
    // remote copy goes because keeping junk on put.io is the whole cost this
    // avoids.
    try {
      await this.service.deleteDownloadBucket(transfer.id, {
        deleteRemote: Boolean(this.service.getPutioToken()),
        deleteLocal: false,
      });
    } catch (error) {
      logger.warn('failed to remove a rejected release from putiorr', {
        transferId: transfer.id,
        name: transfer.name,
        error: error.message,
      });
    }
    return true;
  }

  async pruneProcessedTransfersMissingLocalData() {
    const transfers = this.store.listActiveDownloads()
      .filter((transfer) => transfer.lifecycle === 'processed');

    for (const transfer of transfers) {
      const profile = this.service.findDownloadOwner(transfer);
      if (!profile) {
        this.warnOwnerlessDownload(transfer, 'cannot check for local data');
        continue;
      }

      let hasLocalData;
      try {
        hasLocalData = await this.hasLocalTransferData(profile, transfer);
      } catch (error) {
        logger.warn('failed to inspect processed transfer local data', {
          transferId: transfer.id,
          name: transfer.name,
          error: error.message,
        });
        continue;
      }

      if (hasLocalData) continue;

      // This used to propagate out of pollOnce and abort the whole cycle, so one
      // dead row froze every download until a restart.
      let remoteMissing = false;
      try {
        if (this.service.getPutioToken()) {
          // A 404 says put.io no longer has it either, which is the outcome
          // this sweep wanted. That used to be caught here, because the delete
          // threw on it and would otherwise leave the row failing the same way
          // on every tick forever; removeRemoteTransfer now answers it where
          // put.io is actually asked, and reports it rather than raising it.
          const result = await this.service.deleteDownloadBucket(transfer.id, {
            deleteRemote: true,
            deleteLocal: false,
          });
          remoteMissing = Boolean(result?.remoteAlreadyGone);
        } else {
          this.store.deleteDownload(transfer.id);
        }
      } catch (error) {
        // Only a genuinely transient error reaches this now, and it is worth
        // leaving for the next tick.
        logger.warn('failed to prune processed transfer with missing local data', {
          transferId: transfer.id,
          putioTransferId: transfer.putio_transfer_id,
          putioFileId: transfer.putio_file_id,
          name: transfer.name,
          error: error.message,
          stack: error.stack,
        });
        continue;
      }
      logger.info('processed transfer pruned after local data disappeared', {
        transferId: transfer.id,
        name: transfer.name,
        remoteMissing,
      });
    }
  }

  async removeProcessedAutoRemoveTransfers() {
    const transfers = this.store.listActiveDownloads()
      .filter((transfer) => transfer.lifecycle === 'processed');

    for (const transfer of transfers) {
      const profile = this.autoRemoveProfileForTransfer(transfer);
      if (!profile) {
        this.warnOwnerlessDownload(transfer, 'cannot tell whether it should be auto-removed');
        continue;
      }
      if (!profileAutoRemovesCompleted(profile)) continue;
      await this.removeCompletedAutoRemoveTransfer(transfer);
    }
  }

  autoRemoveProfileForTransfer(transfer) {
    return this.service.findDownloadOwner(transfer);
  }

  // downloads.profile_id is NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  // so a download reaching a sweep without an owner means the database was
  // edited by hand — the legacy rows the schema upgrade could not attach to a
  // profile live in orphaned_downloads, not here. It is still a state the user
  // has to be able to see and fix, so every sweep that steps over one says so
  // rather than skipping in silence.
  warnOwnerlessDownload(transfer, consequence) {
    logger.warn('skipped download with no owning RR profile', {
      transferId: transfer.id,
      putioTransferId: transfer.putio_transfer_id,
      name: transfer.name,
      consequence,
    });
  }

  // Answering "no" deletes the download and cancels its put.io transfer, so a
  // download whose folder cannot even be resolved is reported as still having
  // its data rather than as data that disappeared.
  async hasLocalTransferData(profile, transfer) {
    const root = downloadLocalRoot(profile, transfer);
    if (!root) return true;
    const files = this.store.listFilesForDownload(transfer.id);
    if (files.length === 0) return this.pathExists(root);

    for (const file of files) {
      if (await this.pathExists(resolveInside(root, file.relative_path))) return true;
    }
    return false;
  }

  async pathExists(filePath) {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async workerLoop(index) {
    const signal = this.controller.signal;
    while (this.running && !signal.aborted) {
      const job = this.nextPendingFile();
      if (!job) {
        await sleep(1_000, signal);
        continue;
      }

      this.activeFileIds.add(job.id);
      try {
        await this.processFile(job);
      } catch (error) {
        if (signal.aborted || !this.running) {
          this.store.updateDownloadFile(job.id, {
            status: 'pending',
            download_speed: 0,
            error_string: '',
          });
          continue;
        }
        this.recordFileFailure(job, error, index);
      } finally {
        this.activeFileRates.delete(job.id);
        this.refreshTransferLocalMetrics(job.download_id);
        this.activeFileIds.delete(job.id);
      }
    }
  }

  // The attempt is already counted: nextPendingFile counts it when it claims
  // the file. Counting it again here spent three allowed attempts in one and a
  // half, so a file that hit two transient errors was marked failed and never
  // retried.
  recordFileFailure(job, error, worker) {
    const attempts = Number(job.attempts ?? 0);
    this.store.updateDownloadFile(job.id, {
      status: attempts >= MAX_FILE_ATTEMPTS ? 'failed' : 'pending',
      attempts,
      download_speed: 0,
      error_string: error.message,
    });
    const transfer = this.store.findDownloadById(job.download_id);
    logger.warn('file download failed', {
      worker,
      transferId: job.download_id,
      name: transfer?.name ?? job.download_name,
      fileId: job.id,
      putioFileId: job.putio_file_id,
      attempts,
      error: error.message,
      stack: error.stack,
    });
  }

  nextPendingFile() {
    const candidates = this.store.listPendingFiles(this.config.workers * 4, {
      maxAttempts: MAX_FILE_ATTEMPTS,
    });
    const job = candidates.find((candidate) => !this.activeFileIds.has(candidate.id));
    if (!job) return undefined;
    this.store.updateDownloadFile(job.id, {
      status: 'downloading',
      attempts: Number(job.attempts ?? 0) + 1,
      download_speed: 0,
      error_string: '',
    });
    return this.store.findDownloadFileById(job.id);
  }

  async processFile(file) {
    const transfer = this.store.findDownloadById(file.download_id);
    if (!transfer || transfer.removed_at) return;
    const profile = this.service.requireDownloadOwner(transfer);

    const targetPath = resolveInside(
      this.service.requireExclusiveStagingRoot(profile, transfer),
      file.relative_path,
    );
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (this.isFileDeletedOrTransferRemoved(file)) {
      await this.discardLocalFile(targetPath);
      return;
    }

    if (await fileExistsWithSize(targetPath, Number(file.size))) {
      const updated = this.store.updateDownloadFile(file.id, {
        status: 'complete',
        downloaded_bytes: Number(file.size),
        download_speed: 0,
        error_string: '',
      });
      if (updated?.status === 'deleted') {
        await this.discardLocalFile(targetPath);
        return;
      }
      await this.finalizeTransferIfComplete(transfer.id);
      return;
    }

    const downloadUrl = await this.service.getPutio().getDownloadUrl(file.putio_file_id);
    await this.downloadToPath(downloadUrl, targetPath, file);

    if (this.isFileDeletedOrTransferRemoved(file)) {
      await this.discardLocalFile(targetPath);
      return;
    }

    this.store.updateDownloadFile(file.id, {
      status: 'complete',
      downloaded_bytes: Number(file.size),
      download_speed: 0,
      error_string: '',
    });
    await this.finalizeTransferIfComplete(transfer.id);
  }

  isFileDeletedOrTransferRemoved(file) {
    const transfer = this.store.findDownloadById(file.download_id);
    if (!transfer || transfer.removed_at) return true;
    return this.store.findDownloadFileById(file.id)?.status === 'deleted';
  }

  async discardLocalFile(targetPath) {
    await unlink(targetPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await unlink(`${targetPath}.part`).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async downloadToPath(downloadUrl, targetPath, file) {
    const partPath = `${targetPath}.part`;
    const expectedSize = Number(file.size);
    let resetCount = 0;

    while (!this.controller.signal.aborted) {
      const partSize = await sizeOf(partPath);
      if (expectedSize > 0 && partSize === expectedSize) break;
      if (expectedSize > 0 && partSize > expectedSize) {
        await unlink(partPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }

      const result = await this.downloadAttempt(downloadUrl, partPath, file, resetCount);
      if (result.complete) break;
      if (result.reset) {
        resetCount += 1;
        await sleep(SLOW_RESET_PAUSE_MS, this.controller.signal);
        continue;
      }
    }

    if (this.controller.signal.aborted) {
      throw new Error('download manager stopped');
    }

    const actualSize = await sizeOf(partPath);
    if (expectedSize > 0 && actualSize !== expectedSize) {
      this.store.updateDownloadFile(file.id, {
        downloaded_bytes: actualSize,
        download_speed: 0,
        status: 'pending',
      });
      throw new Error(`download size mismatch: got ${actualSize}, expected ${expectedSize}`);
    }

    await rename(partPath, targetPath);
  }

  async downloadAttempt(downloadUrl, partPath, file, resetCount) {
    let startAt = await sizeOf(partPath);
    let downloaded = startAt;
    const attemptController = new AbortController();
    const unlinkAbort = this.linkAbortSignal(this.controller.signal, attemptController);
    let guard;
    let stream;

    try {
      let response = await this.fetch(downloadUrl, {
        headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : undefined,
        signal: attemptController.signal,
      });

      if (response.status === 416) {
        await unlink(partPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        startAt = 0;
        downloaded = 0;
        response = await this.fetch(downloadUrl, { signal: attemptController.signal });
      }

      if (startAt > 0 && response.status !== 206) {
        await unlink(partPath).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        startAt = 0;
        downloaded = 0;
        response = await this.fetch(downloadUrl, { signal: attemptController.signal });
      }

      if (!response.ok) {
        throw new Error(`download failed with HTTP ${response.status}`);
      }

      this.store.updateDownloadFile(file.id, {
        status: 'downloading',
        download_speed: 0,
        error_string: '',
      });
      this.updateLocalProgressMetrics(file, downloaded, 0);
      guard = this.createSlowSpeedGuard(file, attemptController, downloaded, resetCount);
      stream = createWriteStream(partPath, { flags: startAt > 0 ? 'a' : 'w' });
      let lastProgressUpdate = this.now();
      let lastMetricBytes = downloaded;

      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        downloaded += buffer.length;
        if (!stream.write(buffer)) {
          await once(stream, 'drain');
        }

        guard?.recordProgress(downloaded);
        const now = this.now();
        if (now - lastProgressUpdate >= 1_000) {
          const elapsedSeconds = Math.max(0.001, (now - lastProgressUpdate) / 1_000);
          const bytesPerSecond = Math.max(0, Math.round((downloaded - lastMetricBytes) / elapsedSeconds));
          this.updateLocalProgressMetrics(file, downloaded, bytesPerSecond);
          lastProgressUpdate = now;
          lastMetricBytes = downloaded;
        }
      }

      this.updateLocalProgressMetrics(file, downloaded, 0);
      return { complete: true };
    } catch (error) {
      if (guard?.triggered) {
        if (stream) {
          stream.end();
          await once(stream, 'finish');
          stream = undefined;
        }
        await this.updateAfterSlowReset(file, partPath, guard.message, resetCount + 1);
        return { reset: true };
      }
      throw error;
    } finally {
      guard?.stop();
      unlinkAbort();
      if (stream) {
        stream.end();
        await once(stream, 'finish');
      }
    }
  }

  linkAbortSignal(sourceSignal, targetController) {
    if (sourceSignal.aborted) {
      targetController.abort(sourceSignal.reason);
      return () => {};
    }

    const abort = () => targetController.abort(sourceSignal.reason);
    sourceSignal.addEventListener('abort', abort, { once: true });
    return () => sourceSignal.removeEventListener('abort', abort);
  }

  createSlowSpeedGuard(file, controller, initialBytes, resetCount) {
    const policy = this.downloadPolicyForFile(file);
    const fileSize = Number(file.size ?? 0);
    if (!isSlowSpeedResetEnabled(policy, fileSize)) return undefined;

    const threshold = Number(policy.slowSpeedThresholdBytesPerSecond);
    const durationMs = Number(policy.slowSpeedDurationSeconds) * 1_000;
    const graceMs = Number(policy.slowSpeedGraceSeconds) * 1_000;
    const startedAt = this.now();
    const intervalMs = Math.max(100, Math.min(1_000, Math.floor(durationMs / 4) || 1_000));
    let currentBytes = Number(initialBytes ?? 0);
    let lastCheckAt = startedAt;
    let lastCheckBytes = currentBytes;
    let slowSince;
    let triggered = false;
    let message = '';

    const check = () => {
      if (triggered || controller.signal.aborted) return;

      const now = this.now();
      if (now - startedAt < graceMs) {
        lastCheckAt = now;
        lastCheckBytes = currentBytes;
        return;
      }

      const elapsedSeconds = Math.max(0.001, (now - lastCheckAt) / 1_000);
      const bytesPerSecond = Math.max(0, Math.round((currentBytes - lastCheckBytes) / elapsedSeconds));
      if (bytesPerSecond < threshold) {
        slowSince ??= now;
      } else {
        slowSince = undefined;
      }

      lastCheckAt = now;
      lastCheckBytes = currentBytes;

      if (slowSince !== undefined && now - slowSince >= durationMs) {
        triggered = true;
        message = `Slow connection reset after ${policy.slowSpeedDurationSeconds}s below ${threshold} B/s`;
        controller.abort(new SlowSpeedResetError(message));
      }
    };

    const timer = setInterval(check, intervalMs);
    timer.unref?.();

    return {
      get triggered() {
        return triggered;
      },
      get message() {
        return message;
      },
      recordProgress(bytes) {
        currentBytes = Math.max(0, Number(bytes ?? 0));
        check();
      },
      stop() {
        clearInterval(timer);
      },
      resetCount,
    };
  }

  downloadPolicyForFile(file) {
    const transfer = this.store.findDownloadById(file.download_id);
    // Through the one resolver. profile_id is NOT NULL now, so a missing owner
    // means the row was edited by hand; it falls back to the server-wide policy
    // rather than to another profile's.
    const profile = this.service.findDownloadOwner(transfer);
    return downloadPolicyForContext(this.store, this.config, { profile });
  }

  async updateAfterSlowReset(file, partPath, message, resetCount) {
    const downloadedBytes = await sizeOf(partPath);
    const updated = this.store.updateDownloadFile(file.id, {
      downloaded_bytes: downloadedBytes,
      download_speed: 0,
      status: 'downloading',
      error_string: message,
    });
    if (updated?.status === 'deleted') {
      this.activeFileRates.delete(file.id);
      return;
    }
    this.activeFileRates.set(file.id, {
      transferId: file.download_id,
      bytesPerSecond: 0,
    });
    this.refreshTransferLocalMetrics(file.download_id);
    logger.warn('slow file download reset', {
      fileId: file.id,
      putioFileId: file.putio_file_id,
      downloadedBytes,
      resetCount,
      message,
    });
  }

  updateLocalProgressMetrics(file, downloadedBytes, bytesPerSecond) {
    const size = Number(file.size ?? 0);
    const downloaded = Math.max(0, Math.min(Number(downloadedBytes ?? 0), size > 0 ? size : Number.MAX_SAFE_INTEGER));
    const updated = this.store.updateDownloadFile(file.id, {
      downloaded_bytes: downloaded,
      download_speed: Math.max(0, Math.round(Number(bytesPerSecond ?? 0))),
      status: 'downloading',
    });
    if (updated?.status === 'deleted') {
      this.activeFileRates.delete(file.id);
      return;
    }
    this.activeFileRates.set(file.id, {
      transferId: file.download_id,
      bytesPerSecond: Math.max(0, Math.round(Number(bytesPerSecond ?? 0))),
    });
    this.refreshTransferLocalMetrics(file.download_id);
  }

  refreshTransferLocalMetrics(transferId) {
    const transfer = this.store.findDownloadById(transferId);
    if (!transfer || transfer.lifecycle === 'remote') return;

    const stats = this.store.getDownloadFileStats(transferId);
    const activeSpeed = Array.from(this.activeFileRates.values())
      .filter((rate) => rate.transferId === transferId)
      .reduce((total, rate) => total + rate.bytesPerSecond, 0);
    const totalSize = Number(stats.total_size ?? transfer.total_size ?? 0);
    const downloadedSize = Number(stats.downloaded_size ?? 0);
    const remainingBytes = Math.max(0, totalSize - downloadedSize);

    this.store.updateDownload(transferId, {
      downloaded_ever: downloadedSize,
      total_size: totalSize || Number(transfer.total_size ?? 0),
      download_speed: activeSpeed,
      eta: activeSpeed > 0 && remainingBytes > 0
        ? Math.ceil(remainingBytes / activeSpeed)
        : -1,
    });
  }

  async finalizeTransferIfComplete(transferId) {
    const transfer = this.store.findDownloadById(transferId);
    if (!transfer || transfer.lifecycle === 'processed') return;

    const stats = this.store.getDownloadFileStats(transferId);
    if (Number(stats.total_files) === 0) return;
    if (Number(stats.completed_files) !== Number(stats.total_files)) return;

    this.store.updateDownload(transferId, {
      lifecycle: 'processed',
      percent_done: 100,
      downloaded_ever: Number(stats.downloaded_size ?? 0),
      total_size: Number(stats.total_size ?? transfer.total_size ?? 0),
      download_speed: 0,
      eta: -1,
    });

    const profile = this.autoRemoveProfileForTransfer(transfer);
    if (profileAutoRemovesCompleted(profile)) {
      await this.removeCompletedAutoRemoveTransfer(transfer);
      return;
    }

    // The third predicate this used to carry — "every active association of the
    // remote transfer is processed" — is structurally always true now that one
    // put.io transfer has exactly one download.
    if (this.config.cleanupRemoteFiles && transfer.putio_file_id) {
      try {
        await this.service.getPutio().deleteFile(transfer.putio_file_id);
      } catch (error) {
        logger.warn('failed to cleanup put.io source file', {
          transferId,
          putioFileId: transfer.putio_file_id,
          error: error.message,
        });
      }
    }

    logger.info('transfer processed locally', {
      transferId,
      name: transfer.name,
      files: Number(stats.total_files),
    });
  }

  async removeCompletedAutoRemoveTransfer(transfer) {
    if (this.service.getPutioToken()) {
      try {
        await this.service.deleteDownloadBucket(transfer.id, {
          deleteRemote: true,
          deleteLocal: false,
        });
        logger.info('completed transfer auto-removed after local download; kept files on disk', {
          transferId: transfer.id,
          name: transfer.name,
        });
        return;
      } catch (error) {
        logger.warn('failed to auto-remove completed transfer', {
          transferId: transfer.id,
          name: transfer.name,
          error: error.message,
        });
      }
    }

    try {
      await this.service.deleteDownloadBucket(transfer.id, {
        deleteRemote: false,
        deleteLocal: false,
      });
    } catch (error) {
      logger.warn('failed to hide completed transfer after remote cleanup failure', {
        transferId: transfer.id,
        name: transfer.name,
        error: error.message,
      });
    }
  }
}
