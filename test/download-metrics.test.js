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

test('put.io refresh exposes the transfer status message on the dashboard', async () => {
  const harness = await createHarness([{
    id: 70,
    fileId: 80,
    saveParentId: 42,
    hash: 'putiostatushash',
    name: 'Waiting Release',
    status: 'DOWNLOADING',
    statusMessage: 'Waiting for torrent details from the network...',
    peers: 2,
    availability: 11,
    percentDone: 0,
  }]);
  try {
    await harness.service.refreshRemoteTransfers();

    const [download] = harness.service.listDownloads();
    assert.equal(download.putioStatusMessage, 'Waiting for torrent details from the network...');
    assert.equal(download.putioPeers, 2);
    assert.equal(download.putioAvailability, 11);
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

// Phase 1 of the ownership cleanup (#67): the poll is the only thing that moves
// downloads forward, so anything that throws inside it stops every download on
// the box. Both sweeps below used to propagate out of pollOnce on their first
// bad row and take the whole cycle with them, every tick, forever.
test('a put.io transfer that collides with a stored row does not stop the refresh', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.findProfileBySlug('default');
    // A row that already owns the hash put.io is about to report for a
    // different transfer id...
    harness.store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 5,
      save_parent_id: 42,
      hash: 'collidinghash',
      name: 'Colliding.Release',
      lifecycle: 'remote',
    });
    // ...and an orphaned remote row that already owns that transfer id, so
    // adopting the remote transfer trips transfers.putio_transfer_id UNIQUE.
    const orphan = harness.store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 6,
      save_parent_id: 42,
      hash: 'orphanedhash',
      name: 'Orphaned.Release',
      lifecycle: 'remote',
    });
    harness.store.deleteTransfer(orphan.id);

    harness.putio.remoteTransfers = [
      { id: 6, fileId: 61, saveParentId: 42, hash: 'collidinghash', name: 'Colliding.Release', status: 'COMPLETED', percentDone: 100 },
      { id: 7, fileId: 71, saveParentId: 42, hash: 'healthyhash', name: 'Healthy.Release', status: 'COMPLETED', percentDone: 100 },
    ];

    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    let rows;
    try {
      rows = await harness.service.refreshRemoteTransfers();
    } finally {
      console.log = originalLog;
    }

    // The healthy transfer behind the bad one still gets processed.
    assert.ok(rows.some((row) => row.hash === 'healthyhash'));
    assert.ok(harness.store.findTransferByHash('healthyhash'));
    const logged = logs.map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'skipped put.io transfer that failed to refresh');
    assert.equal(logged.meta.putioTransferId, 6);
    assert.match(logged.meta.error, /UNIQUE constraint failed/);
  } finally {
    harness.store.close();
  }
});

test('a processed transfer put.io no longer has is pruned, not retried every tick', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.findProfileBySlug('default');
    const transfer = harness.store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 22,
      putio_file_id: 23,
      save_parent_id: 42,
      hash: 'prunefailurehash',
      name: 'Prune.Failure.Release',
      category: 'radarr',
      lifecycle: 'processed',
      putio_status: 'COMPLETED',
      percent_done: 100,
    });
    // Its local data is already gone, so the sweep tries to delete it on put.io
    // and put.io answers 404 because the files are gone there too. Nothing about
    // that can ever succeed on a later tick, so the row has to go now.
    harness.putio.deleteFile = async () => {
      const error = new Error('put.io file 23 not found');
      error.status = 404;
      throw error;
    };
    harness.putio.remoteTransfers = [
      { id: 31, fileId: 32, saveParentId: 42, hash: 'stillpollinghash', name: 'Still.Polling.Release', status: 'COMPLETED', percentDone: 100 },
    ];

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    try {
      await manager.pollOnce();
    } finally {
      console.log = originalLog;
    }

    // The rest of the cycle ran: the new put.io transfer was picked up.
    assert.ok(harness.store.findTransferByHash('stillpollinghash'));
    // And the dead row is gone rather than queued up to fail again forever.
    assert.equal(harness.store.findTransferById(transfer.id), undefined);
    const pruned = logs.map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'processed transfer pruned after local data disappeared');
    assert.equal(pruned.meta.transferId, transfer.id);
    assert.equal(pruned.meta.remoteMissing, true);

    // A second tick has nothing left to say about it.
    const secondLogs = [];
    console.log = (line) => secondLogs.push(line);
    try {
      await manager.pollOnce();
    } finally {
      console.log = originalLog;
    }
    assert.equal(
      secondLogs.map((line) => JSON.parse(line))
        .filter((entry) => String(entry.message).includes('processed transfer')).length,
      0,
    );
  } finally {
    harness.store.close();
  }
});

test('a transient prune failure is left for the next tick and does not abort the poll', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.findProfileBySlug('default');
    const transfer = harness.store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 42,
      putio_file_id: 43,
      save_parent_id: 42,
      hash: 'transientprunehash',
      name: 'Transient.Prune.Release',
      category: 'radarr',
      lifecycle: 'processed',
      putio_status: 'COMPLETED',
      percent_done: 100,
    });
    // put.io is having a bad day rather than having lost the transfer, so the
    // row must survive to be retried.
    harness.putio.deleteFile = async () => {
      const error = new Error('put.io is unavailable');
      error.status = 503;
      throw error;
    };
    harness.putio.remoteTransfers = [
      { id: 31, fileId: 32, saveParentId: 42, hash: 'stillpollinghash', name: 'Still.Polling.Release', status: 'COMPLETED', percentDone: 100 },
    ];

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    try {
      await manager.pollOnce();
    } finally {
      console.log = originalLog;
    }

    assert.ok(harness.store.findTransferByHash('stillpollinghash'));
    assert.ok(harness.store.findTransferById(transfer.id));
    const logged = logs.map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'failed to prune processed transfer with missing local data');
    assert.equal(logged.meta.transferId, transfer.id);
    assert.match(logged.meta.stack, /Error/);
  } finally {
    harness.store.close();
  }
});
