import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { DownloadManager } from '../src/download/manager.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';

class FakePutio {
  constructor({ remoteFiles = [] } = {}) {
    this.remoteFiles = remoteFiles;
  }

  async listTransferFiles() {
    return this.remoteFiles;
  }
}

async function createHarness(env = {}, putio = new FakePutio()) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-download-resume-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    ...env,
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const service = new TransferService({
    config,
    store,
    putioFactory: () => putio,
  });
  return { root, config, store, service };
}

function createTransfer(store, patch = {}) {
  const profile = store.findProfileBySlug('default');
  return store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 10,
    putio_file_id: 20,
    save_parent_id: 42,
    hash: 'downloadresumehash',
    name: 'Download.Resume.Release',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 0,
    ...patch,
  });
}

function createResponse({ status = 200, body, signal }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of body) {
          if (signal?.aborted) throw signal.reason ?? new Error('aborted');
          yield Buffer.from(chunk);
        }
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      },
    },
  };
}

test('prepareTransfer records existing partial file bytes for resume', async () => {
  const putio = new FakePutio({
    remoteFiles: [{
      id: 901,
      name: 'movie.mkv',
      relativePath: 'movie.mkv',
      size: 10,
    }],
  });
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 10 });
    const targetPath = path.join(
      harness.config.targetDir,
      transfer.name,
      'movie.mkv',
    );
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(`${targetPath}.part`, 'abcd');

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.prepareTransfer(transfer);

    const [file] = harness.store.listFilesForTransfer(transfer.id);
    assert.equal(file.downloaded_bytes, 4);
    assert.equal(file.status, 'pending');
  } finally {
    harness.store.close();
  }
});

test('prepareTransferSafely removes a transfer whose files 404 on put.io and keeps local files', async () => {
  const removed = [];
  const putio = {
    async listTransferFiles() {
      const error = new Error('put.io 404: The requested URL was not found on the server.');
      error.status = 404;
      throw error;
    },
    async deleteFile(fileId) { removed.push(['file', fileId]); },
    async deleteTransfer(transferId) { removed.push(['transfer', transferId]); },
  };
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 10 });
    const fileOnDisk = path.join(harness.config.targetDir, transfer.name, 'movie.mkv');
    await mkdir(path.dirname(fileOnDisk), { recursive: true });
    await writeFile(fileOnDisk, 'already downloaded');

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    // Must not throw -> the poll loop continues to the remaining transfers.
    await manager.prepareTransferSafely(transfer);

    // Default bucket delete: also removed from put.io, downloaded file kept on disk,
    // and tombstoned locally (the poll prune physically removes the row afterwards).
    assert.deepEqual(removed, [['file', 20], ['transfer', 10]]);
    assert.ok(harness.store.findTransferById(transfer.id).removed_at);
    assert.deepEqual(harness.store.listActiveTransfers(), []);
    assert.equal(await readFile(fileOnDisk, 'utf8'), 'already downloaded');
  } finally {
    harness.store.close();
  }
});

test('prepareTransferSafely keeps the transfer for non-404 errors so the next poll retries', async () => {
  const putio = {
    async listTransferFiles() {
      const error = new Error('put.io 500: temporary failure');
      error.status = 500;
      throw error;
    },
  };
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 10 });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    await manager.prepareTransferSafely(transfer);

    // Transient error -> row is left intact for a later retry.
    assert.ok(harness.store.findTransferById(transfer.id));
  } finally {
    harness.store.close();
  }
});

test('manual start stores the failure reason on the download', async () => {
  const putio = {
    async listTransfers() {
      return [];
    },
    async listTransferFiles() {
      const error = new Error('put.io 500: temporary failure');
      error.status = 500;
      throw error;
    },
  };
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 10 });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    await assert.rejects(
      () => manager.startTransferDownload(transfer.id),
      /temporary failure/,
    );

    const updated = harness.store.findTransferById(transfer.id);
    assert.equal(updated.error, true);
    assert.equal(updated.error_string, 'put.io 500: temporary failure');
  } finally {
    harness.store.close();
  }
});

test('downloadToPath resumes an existing part file with a Range request', async () => {
  const harness = await createHarness();
  try {
    const transfer = createTransfer(harness.store, { total_size: 10 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 902,
      relative_path: 'movie.mkv',
      size: 10,
      downloaded_bytes: 4,
      status: 'pending',
    });
    const targetPath = path.join(harness.root, 'movie.mkv');
    await writeFile(`${targetPath}.part`, 'abcd');

    const requests = [];
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async (_url, options = {}) => {
        requests.push(options.headers?.Range ?? '');
        return createResponse({
          status: options.headers?.Range ? 206 : 200,
          body: ['efghij'],
          signal: options.signal,
        });
      },
    });

    await manager.downloadToPath('https://example.test/file', targetPath, file);

    assert.deepEqual(requests, ['bytes=4-']);
    assert.equal((await readFile(targetPath, 'utf8')), 'abcdefghij');
    assert.equal(harness.store.findTransferFileById(file.id).downloaded_bytes, 10);
  } finally {
    harness.store.close();
  }
});

test('downloadToPath restarts bad partial downloads and records size mismatch', async () => {
  const harness = await createHarness();
  try {
    const transfer = createTransfer(harness.store, { total_size: 4 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 908,
      relative_path: 'movie.mkv',
      size: 4,
      downloaded_bytes: 8,
      status: 'pending',
    });
    const targetPath = path.join(harness.root, 'bad-partial.mkv');
    await writeFile(`${targetPath}.part`, 'too-long');

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async () => createResponse({ body: ['xy'] }),
    });

    await assert.rejects(
      () => manager.downloadToPath('https://example.test/file', targetPath, file),
      /download size mismatch/,
    );

    const updated = harness.store.findTransferFileById(file.id);
    assert.equal(updated.downloaded_bytes, 2);
    assert.equal(updated.status, 'pending');
  } finally {
    harness.store.close();
  }
});

test('downloadToPath restarts when the remote rejects a range request', async () => {
  const harness = await createHarness();
  try {
    const transfer = createTransfer(harness.store, { total_size: 6 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 909,
      relative_path: 'movie.mkv',
      size: 6,
      downloaded_bytes: 3,
      status: 'pending',
    });
    const targetPath = path.join(harness.root, 'range-retry.mkv');
    await writeFile(`${targetPath}.part`, 'abc');
    const requests = [];

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async (_url, options = {}) => {
        requests.push(options.headers?.Range ?? '');
        if (requests.length === 1) return createResponse({ status: 416, body: [] });
        return createResponse({ body: ['abcdef'] });
      },
    });

    await manager.downloadToPath('https://example.test/file', targetPath, file);

    assert.deepEqual(requests, ['bytes=3-', '']);
    assert.equal(await readFile(targetPath, 'utf8'), 'abcdef');
  } finally {
    harness.store.close();
  }
});

test('slow-speed reset keeps the part file and resumes without a failed attempt', async () => {
  const harness = await createHarness({
    PUTIORR_SLOW_SPEED_THRESHOLD_BYTES_PER_SECOND: '1000',
    PUTIORR_SLOW_SPEED_DURATION_SECONDS: '2',
    PUTIORR_SLOW_SPEED_GRACE_SECONDS: '0',
    PUTIORR_SLOW_SPEED_MIN_SIZE_BYTES: '0',
  });
  try {
    const transfer = createTransfer(harness.store, { total_size: 6 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 903,
      relative_path: 'movie.mkv',
      size: 6,
      downloaded_bytes: 0,
      attempts: 1,
      status: 'downloading',
    });
    const targetPath = path.join(harness.root, 'slow.mkv');
    let now = 0;
    const requests = [];

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      now: () => now,
      fetchImpl: async (_url, options = {}) => {
        const range = options.headers?.Range ?? '';
        requests.push(range);
        if (!range) {
          return {
            ok: true,
            status: 200,
            body: {
              async *[Symbol.asyncIterator]() {
                now += 1_000;
                yield Buffer.from('a');
                now += 2_500;
                yield Buffer.from('b');
                if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
              },
            },
          };
        }
        assert.equal(range, 'bytes=2-');
        return createResponse({
          status: 206,
          body: ['cdef'],
          signal: options.signal,
        });
      },
    });

    await manager.downloadToPath('https://example.test/slow', targetPath, file);

    const updated = harness.store.findTransferFileById(file.id);
    assert.deepEqual(requests, ['', 'bytes=2-']);
    assert.equal((await readFile(targetPath, 'utf8')), 'abcdef');
    assert.equal(updated.status, 'downloading');
    assert.equal(updated.attempts, 1);
    assert.equal(updated.downloaded_bytes, 6);
  } finally {
    harness.store.close();
  }
});

test('slow-speed guard uses the download profile attached to the RR profile', async () => {
  const harness = await createHarness();
  try {
    const rrProfile = harness.store.findProfileBySlug('default');
    const strictDownloadProfile = harness.store.createDownloadProfile({
      name: 'Strict movies',
      slug: 'strict-movies',
      slowSpeedThresholdBytesPerSecond: 1000,
      slowSpeedDurationSeconds: 5,
      slowSpeedGraceSeconds: 0,
      slowSpeedMinSizeBytes: 0,
    });
    harness.store.updateProfile(rrProfile.id, {
      download_profile_id: strictDownloadProfile.id,
    });

    const transfer = createTransfer(harness.store, { total_size: 10 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 904,
      relative_path: 'movie.mkv',
      size: 10,
      downloaded_bytes: 0,
      status: 'downloading',
    });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    const guard = manager.createSlowSpeedGuard(file, new AbortController(), 0, 0);
    try {
      assert.ok(guard);
    } finally {
      guard?.stop();
    }
  } finally {
    harness.store.close();
  }
});

test('processFile downloads a pending file, finalizes the transfer, and cleans up put.io', async () => {
  const deleted = [];
  const putio = {
    async getDownloadUrl(fileId) {
      assert.equal(fileId, 905);
      return 'https://example.test/movie';
    },
    async deleteFile(fileId) {
      deleted.push(fileId);
    },
  };
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 4 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 905,
      relative_path: 'movie.mkv',
      size: 4,
      downloaded_bytes: 0,
      status: 'pending',
    });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async () => createResponse({ body: ['done'] }),
    });

    await manager.processFile(file);

    const targetPath = path.join(harness.config.targetDir, transfer.name, 'movie.mkv');
    assert.equal(await readFile(targetPath, 'utf8'), 'done');
    assert.equal(harness.store.findTransferFileById(file.id).status, 'complete');
    assert.equal(harness.store.findTransferById(transfer.id).lifecycle, 'processed');
    assert.deepEqual(deleted, [20]);
  } finally {
    harness.store.close();
  }
});

test('processFile completes an already downloaded file without fetching it', async () => {
  const harness = await createHarness({}, { async deleteFile() {} });
  try {
    const transfer = createTransfer(harness.store, { total_size: 4 });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 910,
      relative_path: 'movie.mkv',
      size: 4,
      downloaded_bytes: 0,
      status: 'pending',
    });
    const targetPath = path.join(harness.config.targetDir, transfer.name, 'movie.mkv');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'done');
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });

    await manager.processFile(file);

    assert.equal(harness.store.findTransferFileById(file.id).status, 'complete');
    assert.equal(harness.store.findTransferById(transfer.id).lifecycle, 'processed');
  } finally {
    harness.store.close();
  }
});

test('processFile discards locally deleted files and nextPendingFile skips active work', async () => {
  const harness = await createHarness();
  try {
    const transfer = createTransfer(harness.store, { total_size: 8 });
    const pending = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 906,
      relative_path: 'pending.mkv',
      size: 4,
      downloaded_bytes: 0,
      status: 'pending',
    });
    const deleted = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 907,
      relative_path: 'season/deleted.mkv',
      size: 4,
      downloaded_bytes: 0,
      status: 'pending',
    });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    manager.activeFileIds.add(pending.id);
    assert.equal(manager.nextPendingFile().id, deleted.id);
    manager.activeFileIds.clear();
    assert.equal(manager.nextPendingFile().id, pending.id);

    harness.store.updateTransferFile(deleted.id, { status: 'deleted' });
    const targetPath = path.join(harness.config.targetDir, transfer.name, 'season', 'deleted.mkv');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'data');
    await writeFile(`${targetPath}.part`, 'part');

    await manager.processFile(deleted);

    await assert.rejects(readFile(targetPath), { code: 'ENOENT' });
    await assert.rejects(readFile(`${targetPath}.part`), { code: 'ENOENT' });
  } finally {
    harness.store.close();
  }
});

test('download manager start and stop are idempotent without a put.io token', async () => {
  const manager = new DownloadManager({
    config: { pollIntervalMs: 60_000, workers: 0 },
    store: {
      listActiveTransfers: () => [],
      purgeDeletedFilesForProcessedTransfers: () => 0,
    },
    service: {
      getPutioToken: () => '',
    },
  });

  await manager.start();
  await manager.start();
  assert.equal(manager.running, true);

  await manager.stop();
  await manager.stop();
  assert.equal(manager.running, false);
});
