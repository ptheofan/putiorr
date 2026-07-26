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
  constructor({ remoteFiles = [], remoteTransfers = [] } = {}) {
    this.remoteFiles = remoteFiles;
    this.remoteTransfers = remoteTransfers;
  }

  async ensureFolder() {
    return 42;
  }

  async listTransfers() {
    return this.remoteTransfers;
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
  return store.upsertDownload({
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

    const [file] = harness.store.listFilesForDownload(transfer.id);
    assert.equal(file.downloaded_bytes, 4);
    assert.equal(file.status, 'pending');
  } finally {
    harness.store.close();
  }
});

// Audit, structural findings: `complete` is sticky — a file row never left it,
// and prepareTransfer only consulted the disk on insert. Re-adding a release
// whose local files were deleted therefore finalised immediately and
// downloaded nothing. (Listed under phase 5 item 16; it is the same code path
// as this phase's stale-file reaping, so it is fixed here.)
test('a file whose local copy is gone is downloaded again, not reported complete', async () => {
  const putio = new FakePutio({
    remoteFiles: [{ id: 901, name: 'movie.mkv', relativePath: 'movie.mkv', size: 10 }],
  });
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 10, lifecycle: 'remote' });
    harness.store.upsertDownloadFile({
      download_id: transfer.id,
      putio_file_id: 901,
      relative_path: 'movie.mkv',
      size: 10,
      downloaded_bytes: 10,
      status: 'complete',
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    const [file] = harness.store.listFilesForDownload(transfer.id);
    assert.equal(file.status, 'pending');
    assert.equal(file.downloaded_bytes, 0);
    assert.notEqual(harness.store.findDownloadById(transfer.id).lifecycle, 'processed');
  } finally {
    harness.store.close();
  }
});

// The owner's ruling keeps the put.io name as the folder, so two *distinct*
// put.io transfers that put.io named the same thing, under one profile and
// category, resolve to one directory. They are not interleaved: both would
// write the same .part file and each would finish holding the other's bytes.
test('two downloads of the same name never stage into one folder', async () => {
  const putio = new FakePutio({
    remoteFiles: [{ id: 901, name: 'movie.mkv', relativePath: 'movie.mkv', size: 10 }],
  });
  const harness = await createHarness({}, putio);
  try {
    const first = createTransfer(harness.store, { total_size: 10, lifecycle: 'remote' });
    const second = createTransfer(harness.store, {
      putio_transfer_id: 11,
      putio_file_id: 21,
      hash: 'samenamehash',
      total_size: 10,
      lifecycle: 'remote',
    });
    assert.equal(second.name, first.name);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    // The one that got there first keeps the folder; the newcomer refuses
    // rather than writing into it.
    await manager.prepareTransfer(harness.store.findDownloadById(first.id));
    assert.equal(harness.store.listFilesForDownload(first.id).length, 1);

    await assert.rejects(
      () => manager.prepareTransfer(harness.store.findDownloadById(second.id)),
      new RegExp(`download ${first.id}`, 'i'),
    );
    assert.deepEqual(harness.store.listFilesForDownload(second.id), []);

    // And the poll reports it where the user will see it, rather than leaving
    // a download that silently never progresses.
    putio.remoteTransfers = [first, second].map((download) => ({
      id: download.putio_transfer_id,
      fileId: download.putio_file_id,
      saveParentId: 42,
      name: download.name,
      hash: download.hash,
      status: 'COMPLETED',
      percentDone: 100,
    }));
    await manager.pollOnce();
    const [collision] = harness.store.stagingCollisions();
    assert.equal(collision.localPath, path.join(harness.config.targetDir, first.name));
    assert.deepEqual(collision.downloads.map((download) => download.id), [first.id, second.id]);
    assert.match(harness.store.findDownloadById(second.id).error_string, /already/i);
  } finally {
    harness.store.close();
  }
});

// I5, re-review: a name too long for the filesystem used to get all the way
// to the per-file mkdir, which fails with ENAMETOOLONG inside the worker —
// leaving the download at 50% with error:false and an empty errorString over
// RPC while a worker retried the impossible mkdir on every poll. The refusal
// belongs where every other unusable name is refused: up front, on the row.
test('a put.io name too long for the filesystem fails on the download, loudly', async () => {
  const putio = new FakePutio({
    remoteFiles: [{ id: 901, name: 'movie.mkv', relativePath: 'movie.mkv', size: 10 }],
  });
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, {
      name: `${'W'.repeat(400)}.1080p.WEB.x264`,
      lifecycle: 'remote',
    });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    await manager.prepareTransferSafely(harness.store.findDownloadById(transfer.id));

    const row = harness.store.findDownloadById(transfer.id);
    assert.equal(row.error, true);
    assert.match(row.error_string, /at most 255/);
    assert.match(row.error_string, /rename it on put\.io/);
    assert.deepEqual(harness.store.listFilesForDownload(transfer.id), []);
  } finally {
    harness.store.close();
  }
});

// Audit finding 8's rename half, and re-review RC2: put.io renames a transfer
// under putiorr's feet. The poll writes the new name into the row, and the
// next sweep looks for the files under the new name, finds nothing, reads that
// as "the user deleted them" — and deletes the download *and* its put.io
// transfer, leaving the files orphaned at the old path with no remote copy to
// re-fetch. The folder is frozen the first time it is prepared, so the rename
// cannot move where putiorr looks.
test('a put.io rename does not strand the files or cancel the transfer', async () => {
  const putio = new FakePutio({
    remoteFiles: [{ id: 901, name: 'movie.mkv', relativePath: 'movie.mkv', size: 5 }],
  });
  putio.deletedFiles = [];
  putio.deletedTransfers = [];
  putio.deleteFile = async (id) => { putio.deletedFiles.push(id); };
  putio.deleteTransfer = async (id) => { putio.deletedTransfers.push(id); };

  const harness = await createHarness({ PUTIORR_CLEANUP_REMOTE_FILES: 'false' }, putio);
  try {
    const transfer = createTransfer(harness.store, { name: 'Original.Name', lifecycle: 'remote', total_size: 5 });
    const staged = path.join(harness.config.targetDir, 'Original.Name');
    await mkdir(staged, { recursive: true });
    await writeFile(path.join(staged, 'movie.mkv'), 'movie');

    const remote = {
      id: transfer.putio_transfer_id,
      fileId: transfer.putio_file_id,
      saveParentId: 42,
      hash: transfer.hash,
      name: 'Original.Name',
      status: 'COMPLETED',
      percentDone: 100,
      size: 5,
    };
    putio.remoteTransfers = [remote];

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.pollOnce();
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'processed');

    // put.io renames the transfer. The row follows the name — it is what the
    // user sees — but the files do not move.
    remote.name = 'Renamed.By.Putio';
    await manager.pollOnce();

    const row = harness.store.findDownloadById(transfer.id);
    assert.ok(row, 'the download survived the rename');
    assert.equal(row.name, 'Renamed.By.Putio');
    assert.deepEqual(putio.deletedTransfers, []);
    assert.deepEqual(putio.deletedFiles, []);
    assert.equal(await readFile(path.join(staged, 'movie.mkv'), 'utf8'), 'movie');

    // And the *arr is still told where the files actually are.
    const { torrents } = await harness.service.getTorrents({ ids: [row.id] });
    assert.equal(torrents[0].name, 'Original.Name');
    assert.equal(path.join(torrents[0].downloadDir, torrents[0].name), staged);
  } finally {
    harness.store.close();
  }
});

test('prepareTransfer forgets files put.io no longer has', async () => {
  const putio = new FakePutio({
    remoteFiles: [{ id: 901, name: 'movie.mkv', relativePath: 'movie.mkv', size: 10 }],
  });
  const harness = await createHarness({}, putio);
  try {
    const transfer = createTransfer(harness.store, { total_size: 10, lifecycle: 'remote' });
    // A file put.io dropped — the release was replaced, or the user removed it
    // there. Its row used to survive forever: pending, so a worker kept trying
    // to fetch a file id that 404s, and counted against the download's own
    // total for good measure.
    harness.store.upsertDownloadFile({
      download_id: transfer.id,
      putio_file_id: 902,
      relative_path: 'sample.mkv',
      size: 4,
      status: 'pending',
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.deepEqual(
      harness.store.listFilesForDownload(transfer.id).map((file) => file.putio_file_id),
      [901],
    );
    assert.equal(harness.store.findDownloadById(transfer.id).total_size, 10);
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
    assert.ok(harness.store.findDownloadById(transfer.id).removed_at);
    assert.deepEqual(harness.store.listActiveDownloads(), []);
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
    assert.ok(harness.store.findDownloadById(transfer.id));
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

    const updated = harness.store.findDownloadById(transfer.id);
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
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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
    assert.equal(harness.store.findDownloadFileById(file.id).downloaded_bytes, 10);
  } finally {
    harness.store.close();
  }
});

test('downloadToPath restarts bad partial downloads and records size mismatch', async () => {
  const harness = await createHarness();
  try {
    const transfer = createTransfer(harness.store, { total_size: 4 });
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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

    const updated = harness.store.findDownloadFileById(file.id);
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
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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

    const updated = harness.store.findDownloadFileById(file.id);
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
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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
    assert.equal(harness.store.findDownloadFileById(file.id).status, 'complete');
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'processed');
    assert.deepEqual(deleted, [20]);
  } finally {
    harness.store.close();
  }
});

test('processFile completes an already downloaded file without fetching it', async () => {
  const harness = await createHarness({}, { async deleteFile() {} });
  try {
    const transfer = createTransfer(harness.store, { total_size: 4 });
    const file = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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

    assert.equal(harness.store.findDownloadFileById(file.id).status, 'complete');
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'processed');
  } finally {
    harness.store.close();
  }
});

test('processFile discards locally deleted files and nextPendingFile skips active work', async () => {
  const harness = await createHarness();
  try {
    const transfer = createTransfer(harness.store, { total_size: 8 });
    const pending = harness.store.upsertDownloadFile({
      download_id: transfer.id,
      putio_file_id: 906,
      relative_path: 'pending.mkv',
      size: 4,
      downloaded_bytes: 0,
      status: 'pending',
    });
    const deleted = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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

    harness.store.updateDownloadFile(deleted.id, { status: 'deleted' });
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
      listActiveDownloads: () => [],
      purgeDeletedFilesForProcessedDownloads: () => 0,
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
