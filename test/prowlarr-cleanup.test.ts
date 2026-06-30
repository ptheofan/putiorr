import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { DownloadManager } from '../src/download/manager.ts';
import { StateStore } from '../src/state/store.ts';
import { TransferService } from '../src/transfer/service.ts';

class FakePutio {
  constructor() {
    this.deletedFiles = [];
    this.deletedTransfers = [];
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

test('finalize keeps a prowlarr transfer as processed (files intact) when the put.io delete fails', async () => {
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

    // The remote delete throws before the local row is removed, so the row
    // remains as `processed` and the on-disk file is untouched.
    assert.equal(harness.store.findTransferById(transfer.id)?.lifecycle, 'processed');
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
