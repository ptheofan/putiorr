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
