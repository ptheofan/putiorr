import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
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
  const transfer = store.upsertDownload({
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
  const file = store.upsertDownloadFile({
    download_id: transfer.id,
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

    const updated = harness.store.findDownloadById(transfer.id);
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
    const transfer = harness.store.upsertDownload({
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
      harness.store.upsertDownloadFile({
        download_id: transfer.id,
        putio_file_id: 1_000 + index,
        relative_path: `Feature/file-${String(index).padStart(2, '0')}.mkv`,
        size: 600,
        downloaded_bytes: 600,
        status: 'complete',
      });
    }

    for (let index = 1; index <= 6; index += 1) {
      harness.store.upsertDownloadFile({
        download_id: transfer.id,
        putio_file_id: 2_000 + index,
        relative_path: `Extras/extra-${String(index).padStart(2, '0')}.mkv`,
        size: 500,
        downloaded_bytes: 0,
        status: 'pending',
      });
    }

    const activeFile = harness.store.upsertDownloadFile({
      download_id: transfer.id,
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
    harness.store.updateDownload(transfer.id, {
      download_speed: 300,
      eta: 2,
    });

    await harness.service.refreshRemoteTransfers();

    const updated = harness.store.findDownloadById(transfer.id);
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
    const transfer = harness.store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 22,
      putio_file_id: 23,
      save_parent_id: 42,
      hash: 'prunemissinglocalhash',
      name: 'Prune.Missing.Local.Release',
      category: 'radarr',
      lifecycle: 'processed',
      putio_status: 'COMPLETED',
      percent_done: 100,
      total_size: 5,
      downloaded_ever: 5,
    });
    harness.store.upsertDownloadFile({
      download_id: transfer.id,
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
    assert.equal(harness.store.findDownloadById(transfer.id).id, transfer.id);

    await unlink(stagedFile);
    await manager.pollOnce();

    assert.equal(harness.store.findDownloadById(transfer.id), undefined);
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
test('one put.io transfer that fails to refresh does not stop the poll', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.findProfileBySlug('default');
    // The reproducible case used to be a hash colliding with another row's
    // put.io id. Phase 3 removed UNIQUE(hash) and resolves rows by put.io id
    // alone, so that particular collision is gone — but the poll is still the
    // only thing that advances every download on the box, and any row that
    // throws must stay one row's problem.
    const upsert = harness.store.upsertDownload.bind(harness.store);
    harness.store.upsertDownload = (input) => {
      if (input.putio_transfer_id === 6) throw new Error('UNIQUE constraint failed: downloads.putio_transfer_id');
      return upsert(input);
    };

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
      harness.store.upsertDownload = upsert;
    }

    // The healthy transfer behind the bad one still gets processed.
    assert.ok(rows.some((row) => row.hash === 'healthyhash'));
    assert.ok(harness.store.findDownloadByHash('healthyhash'));
    assert.equal(harness.store.findDownloadByPutioTransferId(6), undefined);
    assert.equal(profile.id > 0, true);
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
    const transfer = harness.store.upsertDownload({
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
    assert.ok(harness.store.findDownloadByHash('stillpollinghash'));
    // And the dead row is gone rather than queued up to fail again forever.
    assert.equal(harness.store.findDownloadById(transfer.id), undefined);
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
    const transfer = harness.store.upsertDownload({
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

    assert.ok(harness.store.findDownloadByHash('stillpollinghash'));
    assert.ok(harness.store.findDownloadById(transfer.id));
    const logged = logs.map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'failed to prune processed transfer with missing local data');
    assert.equal(logged.meta.transferId, transfer.id);
    assert.match(logged.meta.stack, /Error/);
  } finally {
    harness.store.close();
  }
});

// Phase 2 of the ownership cleanup (#67): an owner is never guessed. Every path
// below used to fall back to `getDefaultProfile()` — slug 'default', else
// whichever profile sorted first — which is not type-filtered, so a Putiorr
// Grab profile could become the fallback owner of an *arr download and stage
// its files into a folder no *arr imports from, with no error and no log line.
//
// Phase 3 makes downloads.profile_id NOT NULL REFERENCES profiles(id) ON DELETE
// RESTRICT, so this state is no longer reachable through the store's API — the
// upsert refuses it and the profile delete is refused while it exists. It is
// still reachable by hand-editing the database, which is what the checks below
// are now defending against, so the fixture reaches for the same back door a
// user with sqlite3 would.
function createOwnerlessTransfer(store, patch = {}) {
  const owner = store.findProfileBySlug('default');
  const row = store.upsertDownload({
    profile_id: owner.id,
    putio_transfer_id: 55,
    putio_file_id: 56,
    save_parent_id: 42,
    hash: 'ownerlesshash',
    name: 'Ownerless.Release',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    ...patch,
  });
  store.db.exec('PRAGMA foreign_keys = OFF');
  store.db.prepare('UPDATE downloads SET profile_id = 999999 WHERE id = ?').run(row.id);
  store.db.exec('PRAGMA foreign_keys = ON');
  return store.findDownloadById(row.id);
}

test('preparing a download with no owning profile fails loudly instead of borrowing one', async () => {
  const harness = await createHarness();
  try {
    const transfer = createOwnerlessTransfer(harness.store);
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    await assert.rejects(
      () => manager.prepareTransfer(harness.store.findDownloadById(transfer.id)),
      /no owning RR profile/i,
    );
  } finally {
    harness.store.close();
  }
});

test('the dashboard shows an ownerless download as broken rather than under someone else', async () => {
  const harness = await createHarness();
  try {
    const owned = harness.store.upsertDownload({
      profile_id: harness.store.findProfileBySlug('default').id,
      putio_transfer_id: 60,
      hash: 'ownedhash',
      name: 'Owned.Release',
      lifecycle: 'downloading',
    });
    const orphan = createOwnerlessTransfer(harness.store);

    // One bad row must not take the whole list down with it.
    const downloads = harness.service.listDownloads();
    assert.equal(downloads.length, 2);

    const shown = downloads.find((download) => download.id === orphan.id);
    assert.equal(shown.profileId, null);
    assert.equal(shown.profileName, 'No RR profile');
    assert.equal(shown.downloadAt, '');
    assert.match(shown.error, /no owning RR profile/i);
    assert.equal(downloads.find((download) => download.id === owned.id).profileName, 'Custom');
  } finally {
    harness.store.close();
  }
});

test('the sweeps skip an ownerless download loudly instead of resolving its path', async () => {
  const harness = await createHarness();
  try {
    const transfer = createOwnerlessTransfer(harness.store, { lifecycle: 'processed' });
    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });

    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    try {
      await manager.pruneProcessedTransfersMissingLocalData();
      await manager.removeProcessedAutoRemoveTransfers();
    } finally {
      console.log = originalLog;
    }

    // Nothing was deleted on the strength of a borrowed profile's folder.
    assert.ok(harness.store.findDownloadById(transfer.id));
    assert.deepEqual(harness.putio.deletedFiles, []);
    assert.deepEqual(harness.putio.deletedTransfers, []);
    const warned = logs.map((line) => JSON.parse(line))
      .filter((entry) => entry.message === 'skipped download with no owning RR profile');
    assert.equal(warned.length, 2);
    assert.equal(warned[0].meta.transferId, transfer.id);
  } finally {
    harness.store.close();
  }
});

test('an ownerless download can still be deleted from the dashboard', async () => {
  // The error the dashboard shows tells the user to reassign or delete it, so
  // deleting it has to work. Only the local-files half needs an owner, because
  // only that half needs a folder.
  const harness = await createHarness();
  try {
    const transfer = createOwnerlessTransfer(harness.store);

    const result = await harness.service.deleteDownloadBucket(transfer.id, {
      deleteRemote: true,
      deleteLocal: false,
    });

    assert.equal(result.ok, true);
    assert.equal(harness.store.findDownloadById(transfer.id), undefined);
    assert.deepEqual(harness.putio.deletedTransfers, [55]);

    // Asking to delete files there is no folder for is the one refusal — and it
    // has to happen before anything irreversible. Deleting the put.io transfer
    // first and only then discovering there is no local folder would leave a row
    // that can never be removed again: put.io 404s and the local half throws.
    const second = createOwnerlessTransfer(harness.store, { putio_transfer_id: 57, putio_file_id: 58, hash: 'ownerlesstwo' });
    await assert.rejects(
      () => harness.service.deleteDownloadBucket(second.id, { deleteRemote: true, deleteLocal: true }),
      /no owning RR profile/i,
    );
    assert.ok(harness.store.findDownloadById(second.id));
    // Nothing of the second download reached put.io: 55/56 are the first one.
    assert.deepEqual(harness.putio.deletedTransfers, [55]);
    assert.deepEqual(harness.putio.deletedFiles, [56]);

    // Still removable afterwards, which is the promise the refusal has to keep.
    const cleaned = await harness.service.deleteDownloadBucket(second.id, {
      deleteRemote: true,
      deleteLocal: false,
    });
    assert.equal(cleaned.ok, true);
    assert.equal(harness.store.findDownloadById(second.id), undefined);
  } finally {
    harness.store.close();
  }
});

test('a mixed-status put.io failure is not read as "the remote is gone"', async () => {
  // Only a unanimous 404 means the transfer is gone. A 404 on the file and a
  // 500 on the transfer means put.io is half-broken, and deleting the local row
  // on the strength of that would throw away a download that still exists.
  const harness = await createHarness();
  try {
    const transfer = harness.store.upsertDownload({
      profile_id: harness.store.findProfileBySlug('default').id,
      putio_transfer_id: 70,
      putio_file_id: 71,
      save_parent_id: 42,
      hash: 'mixedstatushash',
      name: 'Mixed.Status.Release',
      category: 'radarr',
      lifecycle: 'processed',
      putio_status: 'COMPLETED',
      percent_done: 100,
    });
    harness.putio.deleteFile = async () => {
      const error = new Error('put.io file 71 not found');
      error.status = 404;
      throw error;
    };
    harness.putio.deleteTransfer = async () => {
      const error = new Error('put.io is unavailable');
      error.status = 503;
      throw error;
    };

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

    assert.ok(harness.store.findDownloadById(transfer.id));
    const logged = logs.map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'failed to prune processed transfer with missing local data');
    assert.equal(logged.meta.transferId, transfer.id);
  } finally {
    harness.store.close();
  }
});

// Phase 3 review, critical finding: legacyLocalPath used to fall through to a
// bare row.name when a quarantined row had neither an owner nor a stored
// download_dir — the shape a poll-adopted transfer leaves behind, since nothing
// ever asked it for a download-dir. deleteLocalData then resolved that name
// against process.cwd(), which satisfies resolveInside's containment check
// trivially, and rm(recursive, force) ran on <cwd>/<name>.
function quarantineRow(store, overrides = {}) {
  const row = {
    putio_transfer_id: 4242,
    hash: 'quarantinedhash',
    name: 'Quarantined.Release',
    source: '',
    source_type: 'magnet',
    category: '',
    lifecycle: 'remote',
    total_size: 0,
    downloaded_ever: 0,
    putio_file_id: null,
    save_parent_id: null,
    legacy_download_id: null,
    legacy_download_dir: '',
    quarantined_at: 'now',
    reason: 'no owner',
    ...overrides,
  };
  const keys = Object.keys(row);
  const result = store.db.prepare(
    `INSERT INTO orphaned_downloads (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...keys.map((key) => row[key]));
  return Number(result.lastInsertRowid);
}

test('deleting a quarantined download never resolves its files against the working directory', async () => {
  const harness = await createHarness();
  const cwd = process.cwd();
  const sandbox = await mkdtemp(path.join(tmpdir(), 'putiorr-cwd-'));
  try {
    // The exact reproduction: a relative path, and a directory of that name
    // sitting in whatever the process happens to have as its cwd.
    process.chdir(sandbox);
    const victim = path.join(sandbox, 'Quarantined.Release');
    await mkdir(victim, { recursive: true });
    await writeFile(path.join(victim, 'movie.mkv'), 'irreplaceable');

    const orphanId = quarantineRow(harness.store, { legacy_download_dir: 'Quarantined.Release' });

    await assert.rejects(
      () => harness.service.deleteOrphanedDownload(orphanId, { deleteLocal: true }),
      /does not know where .* files are/,
    );

    // Nothing was touched, and the entry is still there to be dealt with.
    await stat(path.join(victim, 'movie.mkv'));
    assert.equal(harness.store.listOrphanedDownloads().length, 1);
  } finally {
    process.chdir(cwd);
    harness.store.close();
  }
});

test('deleting a quarantined download removes the files at its recorded absolute path', async () => {
  const harness = await createHarness();
  try {
    const target = path.join(harness.config.targetDir, 'tv', 'Quarantined.Release');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'movie.mkv'), 'movie');

    const orphanId = quarantineRow(harness.store, { legacy_download_dir: target });
    const result = await harness.service.deleteOrphanedDownload(orphanId, { deleteLocal: true });

    assert.equal(result.ok, true);
    await assert.rejects(() => stat(target), { code: 'ENOENT' });
    assert.deepEqual(harness.store.listOrphanedDownloads(), []);
  } finally {
    harness.store.close();
  }
});
