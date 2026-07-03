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
  constructor() {
    this.deletedFiles = [];
    this.deletedTransfers = [];
  }

  async getDownloadUrl(fileId) {
    assert.equal(fileId, 30);
    return 'https://example.test/prowlarr-file';
  }

  async ensureFolder() {
    return 42;
  }

  async addTransfer() {
    return {
      id: 10,
      fileId: 20,
      saveParentId: 42,
      name: 'Direct.Integration.Release',
      status: 'COMPLETED',
      percentDone: 100,
      size: 4,
    };
  }

  async deleteFile(fileId) {
    this.deletedFiles.push(fileId);
  }

  async deleteTransfer(transferId) {
    this.deletedTransfers.push(transferId);
  }
}

async function createHarness(env = {}, putio = new FakePutio()) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-prowlarr-cleanup-'));
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
  return { root, config, store, service, putio };
}

// Creates a complete transfer (one fully-downloaded file) attached to `profile`,
// with the file written to disk so "kept on disk" can be asserted.
async function seedCompleteTransfer(harness, profile) {
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 10,
    putio_file_id: 20,
    save_parent_id: profile.putio_folder_id ?? 42,
    hash: 'prowlarrcleanuphash',
    name: 'Prowlarr.Release',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 10,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 20,
    relative_path: 'movie.mkv',
    size: 10,
    downloaded_bytes: 10,
    status: 'complete',
  });
  const filePath = path.join(profile.download_at, transfer.name, 'movie.mkv');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'downloaded!!');
  return { transfer, filePath };
}

function createResponse(body) {
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    },
  };
}

test('finalize auto-removes a prowlarr transfer from put.io and the list, keeping disk files', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.createProfile({
      name: 'Prowlarr',
      type: 'prowlarr',
      slug: 'prowlarr',
      putio_folder_name: 'prowlarr',
      downloadAt: path.join(harness.config.targetDir, 'prowlarr'),
      rpc_path: '/prowlarr/transmission/rpc',
      enabled: true,
    });
    const { transfer, filePath } = await seedCompleteTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.finalizeTransferIfComplete(transfer.id);

    // Deleted from put.io (both the file and the transfer entry).
    assert.deepEqual(harness.putio.deletedFiles, [20]);
    assert.deepEqual(harness.putio.deletedTransfers, [10]);
    // Removed from the list entirely (hard-deleted, not just tombstoned).
    assert.equal(harness.store.findTransferById(transfer.id), undefined);
    assert.deepEqual(harness.store.listActiveTransfers(), []);
    // Files left on disk untouched.
    assert.equal(await readFile(filePath, 'utf8'), 'downloaded!!');
  } finally {
    harness.store.close();
  }
});

test('finalize hides a prowlarr transfer from putiorr when the put.io delete fails', async () => {
  class ThrowingPutio extends FakePutio {
    async deleteFile() {
      throw new Error('put.io is down');
    }
  }
  const harness = await createHarness({}, new ThrowingPutio());
  try {
    const profile = harness.store.createProfile({
      name: 'Prowlarr',
      type: 'prowlarr',
      slug: 'prowlarr',
      putio_folder_name: 'prowlarr',
      downloadAt: path.join(harness.config.targetDir, 'prowlarr'),
      rpc_path: '/prowlarr/transmission/rpc',
      enabled: true,
    });
    const { transfer, filePath } = await seedCompleteTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    // Best-effort contract: a failed remote delete must NOT propagate.
    await assert.doesNotReject(() => manager.finalizeTransferIfComplete(transfer.id));

    // The local row is tombstoned so it disappears from putiorr and cannot be
    // resurrected by the next remote refresh. Disk files stay untouched.
    assert.ok(harness.store.findTransferById(transfer.id)?.removed_at);
    assert.deepEqual(harness.store.listActiveTransfers(), []);
    assert.equal(await readFile(filePath, 'utf8'), 'downloaded!!');
  } finally {
    harness.store.close();
  }
});

test('processFile removes a completed download for a profile with auto-remove enabled', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.createProfile({
      name: 'Direct Client',
      type: 'custom',
      slug: 'direct-client',
      auto_remove_completed: true,
      putio_folder_name: 'direct-client',
      downloadAt: path.join(harness.config.targetDir, 'direct-client'),
      rpc_path: '/direct-client/transmission/rpc',
      enabled: true,
    });
    await harness.service.addTorrent({
      magnetLink: 'magnet:?xt=urn:btih:abcdef1234567890&dn=Direct.Integration.Release',
    }, profile);
    const [transfer] = harness.store.listActiveTransfers({ profileId: profile.id });
    assert.equal(transfer.profile_id, profile.id);
    harness.store.updateTransfer(transfer.id, { lifecycle: 'downloading' });
    const file = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 30,
      relative_path: 'movie.mkv',
      size: 4,
      downloaded_bytes: 0,
      status: 'pending',
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async () => createResponse('done'),
    });

    await manager.processFile(file);

    assert.deepEqual(harness.service.listDownloads(), []);
    assert.equal(harness.store.findTransferById(transfer.id), undefined);
    assert.deepEqual(harness.putio.deletedFiles, [20]);
    assert.deepEqual(harness.putio.deletedTransfers, [10]);
    assert.equal(
      await readFile(path.join(profile.download_at, transfer.name, 'movie.mkv'), 'utf8'),
      'done',
    );
  } finally {
    harness.store.close();
  }
});

test('poll removes an already processed prowlarr download that still has local files', async () => {
  const harness = await createHarness({ PUTIORR_PUTIO_TOKEN: '' });
  try {
    const profile = harness.store.createProfile({
      name: 'Prowlarr',
      type: 'prowlarr',
      slug: 'prowlarr',
      putio_folder_name: 'prowlarr',
      downloadAt: path.join(harness.config.targetDir, 'prowlarr'),
      rpc_path: '/prowlarr/transmission/rpc',
      enabled: true,
    });
    const { transfer, filePath } = await seedCompleteTransfer(harness, profile);
    harness.store.updateTransfer(transfer.id, { lifecycle: 'processed' });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    await manager.pollOnce();

    assert.ok(harness.store.findTransferById(transfer.id)?.removed_at);
    assert.deepEqual(harness.service.listDownloads(), []);
    assert.equal(await readFile(filePath, 'utf8'), 'downloaded!!');
  } finally {
    harness.store.close();
  }
});

test('finalize leaves a non-prowlarr transfer in the list as processed', async () => {
  const harness = await createHarness({ PUTIORR_CLEANUP_REMOTE_FILES: 'false' });
  try {
    const profile = harness.store.findProfileBySlug('default');
    const { transfer } = await seedCompleteTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.finalizeTransferIfComplete(transfer.id);

    // No bucket delete: nothing removed from put.io, row retained as processed.
    assert.deepEqual(harness.putio.deletedFiles, []);
    assert.deepEqual(harness.putio.deletedTransfers, []);
    assert.equal(harness.store.findTransferById(transfer.id)?.lifecycle, 'processed');
  } finally {
    harness.store.close();
  }
});
