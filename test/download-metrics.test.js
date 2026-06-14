import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DownloadManager } from '../src/download/manager.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';

class FakePutio {
  constructor(remoteTransfers = []) {
    this.remoteTransfers = remoteTransfers;
    this.deletedFiles = [];
    this.deletedTransfers = [];
  }

  async ensureFolder() {
    return 42;
  }

  async listTransfers() {
    return this.remoteTransfers;
  }

  async deleteFile(id) {
    this.deletedFiles.push(id);
  }

  async deleteTransfer(id) {
    this.deletedTransfers.push(id);
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
  return { config, store, service, putio };
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
    assert.deepEqual(download.files.items, [{
      id: file.id,
      relativePath: 'movie.mkv',
      size: 1_000,
      downloadedSize: 400,
      speed: 300,
      progress: 40,
      status: 'downloading',
      error: '',
    }]);
  } finally {
    harness.store.close();
  }
});

test('dashboard reports multi-file progress details', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.findProfileBySlug('default');
    const transfer = harness.store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 22,
      putio_file_id: 23,
      save_parent_id: 42,
      hash: 'multifilehash',
      name: 'Multi.File.Release',
      lifecycle: 'downloading',
      putio_status: 'COMPLETED',
      percent_done: 100,
      total_size: 13_700,
      download_speed: 0,
      eta: -1,
    });

    for (let index = 1; index <= 15; index += 1) {
      harness.store.upsertTransferFile({
        transfer_id: transfer.id,
        putio_file_id: 1_000 + index,
        relative_path: `Feature/file-${String(index).padStart(2, '0')}.mkv`,
        size: 600,
        downloaded_bytes: 600,
        status: 'complete',
      });
    }

    for (let index = 1; index <= 6; index += 1) {
      harness.store.upsertTransferFile({
        transfer_id: transfer.id,
        putio_file_id: 2_000 + index,
        relative_path: `Extras/extra-${String(index).padStart(2, '0')}.mkv`,
        size: 500,
        downloaded_bytes: 0,
        status: 'pending',
      });
    }

    const activeFile = harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 3_001,
      relative_path: 'Feature/currently-copying.mkv',
      size: 1_700,
      downloaded_bytes: 1_100,
      status: 'downloading',
    });

    const [download] = harness.service.listDownloads();

    assert.equal(download.files.total, 22);
    assert.equal(download.files.complete, 15);
    assert.equal(download.downloadedSize, 10_100);
    assert.equal(download.totalSize, 13_700);
    assert.equal(download.localProgress, 74);
    assert.equal(download.files.items.length, 22);
    assert.deepEqual(
      download.files.items.find((item) => item.id === activeFile.id),
      {
        id: activeFile.id,
        relativePath: 'Feature/currently-copying.mkv',
        size: 1_700,
        downloadedSize: 1_100,
        speed: 0,
        progress: 65,
        status: 'downloading',
        error: '',
      },
    );
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

test('poll prunes processed transfers after local staging data disappears', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.findProfileBySlug('default');
    const transfer = harness.store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 22,
      putio_file_id: 23,
      save_parent_id: 42,
      hash: 'prunemissinglocalhash',
      name: 'Prune.Missing.Local.Release',
      category: 'radarr',
      download_dir: path.join(harness.config.targetDir, 'radarr'),
      lifecycle: 'processed',
      putio_status: 'COMPLETED',
      percent_done: 100,
      total_size: 5,
      downloaded_ever: 5,
    });
    harness.store.upsertTransferFile({
      transfer_id: transfer.id,
      putio_file_id: 24,
      relative_path: 'movie.mkv',
      size: 5,
      downloaded_bytes: 5,
      status: 'complete',
    });

    const stagedFile = path.join(
      harness.config.targetDir,
      'radarr',
      'Prune.Missing.Local.Release',
      'movie.mkv',
    );
    await mkdir(path.dirname(stagedFile), { recursive: true });
    await writeFile(stagedFile, 'movie');

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    await manager.pollOnce();
    assert.equal(harness.store.findTransferById(transfer.id).id, transfer.id);

    await unlink(stagedFile);
    await manager.pollOnce();

    assert.equal(harness.store.findTransferById(transfer.id), undefined);
    assert.deepEqual(harness.putio.deletedFiles, [23]);
    assert.deepEqual(harness.putio.deletedTransfers, [22]);
    assert.deepEqual(harness.service.listDownloads(), []);
  } finally {
    harness.store.close();
  }
});
