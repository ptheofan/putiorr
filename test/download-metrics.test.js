import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DownloadManager } from '../src/download/manager.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';

class FakePutio {
  constructor(remoteTransfers = []) {
    this.remoteTransfers = remoteTransfers;
  }

  async ensureFolder() {
    return 42;
  }

  async listTransfers() {
    return this.remoteTransfers;
  }
}

async function createHarness(remoteTransfers = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-metrics-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_PUTIO_TOKEN: 'test-token',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const putio = new FakePutio(remoteTransfers);
  const service = new TransferService({
    config,
    store,
    putioFactory: () => putio,
  });
  return { config, store, service };
}

function createDownloadingTransfer(store) {
  const profile = store.findProfileBySlug('default');
  const transfer = store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 7,
    putio_file_id: 8,
    save_parent_id: 42,
    hash: 'localmetricshash',
    name: 'Local.Metrics.Release',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 1_000,
    download_speed: 0,
    eta: -1,
  });
  const file = store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 81,
    relative_path: 'movie.mkv',
    size: 1_000,
    downloaded_bytes: 100,
    status: 'downloading',
  });
  return { transfer, file };
}

test('local download progress updates dashboard speed and ETA metrics', async () => {
  const harness = await createHarness();
  try {
    const { transfer, file } = createDownloadingTransfer(harness.store);
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    manager.updateLocalProgressMetrics(file, 400, 300);

    const updated = harness.store.findTransferById(transfer.id);
    assert.equal(updated.download_speed, 300);
    assert.equal(updated.eta, 2);
    assert.equal(updated.downloaded_ever, 400);

    const [download] = harness.service.listDownloads();
    assert.equal(download.speed, 300);
    assert.equal(download.eta, 2);
    assert.equal(download.localProgress, 40);
    assert.equal(download.downloadedSize, 400);
  } finally {
    harness.store.close();
  }
});

test('put.io refresh preserves local speed and ETA while staged files are downloading', async () => {
  const remoteTransfers = [{
    id: 7,
    fileId: 8,
    saveParentId: 42,
    hash: 'localmetricshash',
    name: 'Local.Metrics.Release',
    status: 'COMPLETED',
    percentDone: 100,
    size: 1_000,
    downloaded: 1_000,
    uploaded: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    estimatedTime: -1,
    magnetUri: 'magnet:?xt=urn:btih:localmetricshash',
  }];
  const harness = await createHarness(remoteTransfers);
  try {
    const { transfer } = createDownloadingTransfer(harness.store);
    harness.store.updateTransfer(transfer.id, {
      download_speed: 300,
      eta: 2,
    });

    await harness.service.refreshRemoteTransfers();

    const updated = harness.store.findTransferById(transfer.id);
    assert.equal(updated.lifecycle, 'downloading');
    assert.equal(updated.download_speed, 300);
    assert.equal(updated.eta, 2);
  } finally {
    harness.store.close();
  }
});
