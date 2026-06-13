import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { logger } from '../logger.js';
import { fileExistsWithSize, normalizeRelativePath, resolveInside } from './paths.js';

const READY_REMOTE_STATUSES = new Set(['COMPLETED', 'SEEDING']);

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
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
  constructor({ config, store, service, fetchImpl = globalThis.fetch }) {
    this.config = config;
    this.store = store;
    this.service = service;
    this.fetch = fetchImpl;
    this.controller = new AbortController();
    this.running = false;
    this.pollTimer = undefined;
    this.workers = [];
    this.activeFileIds = new Set();
    this.activeFileRates = new Map();
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
    if (!this.service.getPutioToken()) return;
    const rows = await this.service.refreshRemoteTransfers();
    for (const row of rows) {
      if (READY_REMOTE_STATUSES.has(row.putio_status) && row.lifecycle !== 'processed') {
        await this.prepareTransfer(row);
      }
    }
  }

  async prepareTransfer(transfer) {
    if (!transfer.putio_file_id) {
      logger.warn('ready transfer has no put.io file id', { id: transfer.id, name: transfer.name });
      return;
    }

    const profile = this.store.findProfileById(transfer.profile_id) ?? this.service.getDefaultProfile();
    const remoteFiles = await this.service.getPutio().listTransferFiles(transfer.putio_file_id);
    if (remoteFiles.length === 0) {
      logger.warn('ready transfer has no files', { id: transfer.id, name: transfer.name });
      return;
    }

    const updated = this.store.updateTransfer(transfer.id, { lifecycle: 'downloading' });
    let totalSize = 0;
    for (const remoteFile of remoteFiles) {
      const relativePath = normalizeRelativePath(remoteFile.relativePath ?? remoteFile.name);
      totalSize += Number(remoteFile.size ?? 0);
      const targetPath = resolveInside(
        profile.download_at,
        updated.category ?? '',
        updated.name,
        relativePath,
      );
      const exists = await fileExistsWithSize(targetPath, Number(remoteFile.size ?? 0));
      this.store.upsertTransferFile({
        transfer_id: updated.id,
        putio_file_id: remoteFile.id,
        relative_path: relativePath,
        size: Number(remoteFile.size ?? 0),
        downloaded_bytes: exists ? Number(remoteFile.size ?? 0) : 0,
        status: exists ? 'complete' : 'pending',
      });
    }

    this.store.updateTransfer(updated.id, { total_size: totalSize });
    await this.finalizeTransferIfComplete(updated.id);
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
        const attempts = Number(job.attempts ?? 0) + 1;
        this.store.updateTransferFile(job.id, {
          status: attempts >= 3 ? 'failed' : 'pending',
          attempts,
          download_speed: 0,
          error_string: error.message,
        });
        logger.warn('file download failed', {
          worker: index,
          fileId: job.id,
          putioFileId: job.putio_file_id,
          attempts,
          error: error.message,
        });
      } finally {
        this.activeFileRates.delete(job.id);
        this.refreshTransferLocalMetrics(job.transfer_id);
        this.activeFileIds.delete(job.id);
      }
    }
  }

  nextPendingFile() {
    const candidates = this.store.listPendingFiles(this.config.workers * 4);
    const job = candidates.find((candidate) => !this.activeFileIds.has(candidate.id));
    if (!job) return undefined;
    this.store.updateTransferFile(job.id, {
      status: 'downloading',
      attempts: Number(job.attempts ?? 0) + 1,
      download_speed: 0,
      error_string: '',
    });
    return this.store.findTransferFileById(job.id);
  }

  async processFile(file) {
    const transfer = this.store.findTransferById(file.transfer_id);
    if (!transfer || transfer.removed_at) return;
    const profile = this.store.findProfileById(transfer.profile_id) ?? this.service.getDefaultProfile();

    const targetPath = resolveInside(
      profile.download_at,
      transfer.category ?? '',
      transfer.name,
      file.relative_path,
    );
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (await fileExistsWithSize(targetPath, Number(file.size))) {
      this.store.updateTransferFile(file.id, {
        status: 'complete',
        downloaded_bytes: Number(file.size),
        download_speed: 0,
        error_string: '',
      });
      await this.finalizeTransferIfComplete(transfer.id);
      return;
    }

    const downloadUrl = await this.service.getPutio().getDownloadUrl(file.putio_file_id);
    await this.downloadToPath(downloadUrl, targetPath, file);

    this.store.updateTransferFile(file.id, {
      status: 'complete',
      downloaded_bytes: Number(file.size),
      download_speed: 0,
      error_string: '',
    });
    await this.finalizeTransferIfComplete(transfer.id);
  }

  async downloadToPath(downloadUrl, targetPath, file) {
    const partPath = `${targetPath}.part`;
    let startAt = await sizeOf(partPath);
    let response = await this.fetch(downloadUrl, {
      headers: startAt > 0 ? { Range: `bytes=${startAt}-` } : undefined,
      signal: this.controller.signal,
    });

    if (response.status === 416) {
      await unlink(partPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      startAt = 0;
      response = await this.fetch(downloadUrl, { signal: this.controller.signal });
    }

    if (startAt > 0 && response.status !== 206) {
      await unlink(partPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      startAt = 0;
      response = await this.fetch(downloadUrl, { signal: this.controller.signal });
    }

    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }

    const stream = createWriteStream(partPath, { flags: startAt > 0 ? 'a' : 'w' });
    let downloaded = startAt;
    let lastProgressUpdate = Date.now();
    let lastMetricBytes = downloaded;

    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        downloaded += buffer.length;
        if (!stream.write(buffer)) {
          await once(stream, 'drain');
        }

        const now = Date.now();
        if (now - lastProgressUpdate >= 1_000) {
          const elapsedSeconds = Math.max(0.001, (now - lastProgressUpdate) / 1_000);
          const bytesPerSecond = Math.max(0, Math.round((downloaded - lastMetricBytes) / elapsedSeconds));
          this.updateLocalProgressMetrics(file, downloaded, bytesPerSecond);
          lastProgressUpdate = now;
          lastMetricBytes = downloaded;
        }
      }
    } finally {
      stream.end();
      await once(stream, 'finish');
    }

    const expectedSize = Number(file.size);
    const actualSize = await sizeOf(partPath);
    if (expectedSize > 0 && actualSize !== expectedSize) {
      this.store.updateTransferFile(file.id, {
        downloaded_bytes: actualSize,
        download_speed: 0,
        status: 'pending',
      });
      throw new Error(`download size mismatch: got ${actualSize}, expected ${expectedSize}`);
    }

    await rename(partPath, targetPath);
  }

  updateLocalProgressMetrics(file, downloadedBytes, bytesPerSecond) {
    const size = Number(file.size ?? 0);
    const downloaded = Math.max(0, Math.min(Number(downloadedBytes ?? 0), size > 0 ? size : Number.MAX_SAFE_INTEGER));
    this.store.updateTransferFile(file.id, {
      downloaded_bytes: downloaded,
      download_speed: Math.max(0, Math.round(Number(bytesPerSecond ?? 0))),
      status: 'downloading',
    });
    this.activeFileRates.set(file.id, {
      transferId: file.transfer_id,
      bytesPerSecond: Math.max(0, Math.round(Number(bytesPerSecond ?? 0))),
    });
    this.refreshTransferLocalMetrics(file.transfer_id);
  }

  refreshTransferLocalMetrics(transferId) {
    const transfer = this.store.findTransferById(transferId);
    if (!transfer || transfer.lifecycle === 'remote') return;

    const stats = this.store.getTransferFileStats(transferId);
    const activeSpeed = Array.from(this.activeFileRates.values())
      .filter((rate) => rate.transferId === transferId)
      .reduce((total, rate) => total + rate.bytesPerSecond, 0);
    const totalSize = Number(stats.total_size ?? transfer.total_size ?? 0);
    const downloadedSize = Number(stats.downloaded_size ?? 0);
    const remainingBytes = Math.max(0, totalSize - downloadedSize);

    this.store.updateTransfer(transferId, {
      downloaded_ever: downloadedSize,
      total_size: totalSize || Number(transfer.total_size ?? 0),
      download_speed: activeSpeed,
      eta: activeSpeed > 0 && remainingBytes > 0
        ? Math.ceil(remainingBytes / activeSpeed)
        : -1,
    });
  }

  async finalizeTransferIfComplete(transferId) {
    const transfer = this.store.findTransferById(transferId);
    if (!transfer || transfer.lifecycle === 'processed') return;

    const stats = this.store.getTransferFileStats(transferId);
    if (Number(stats.total_files) === 0) return;
    if (Number(stats.completed_files) !== Number(stats.total_files)) return;

    this.store.updateTransfer(transferId, {
      lifecycle: 'processed',
      percent_done: 100,
      downloaded_ever: Number(stats.downloaded_size ?? 0),
      total_size: Number(stats.total_size ?? transfer.total_size ?? 0),
      download_speed: 0,
      eta: -1,
    });

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
}
