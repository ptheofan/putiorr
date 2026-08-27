// Issue #111. These assert the end-to-end property: a put.io transfer with
// nothing importable in it never reaches the disk, and the *arr is told to
// blocklist and search again with exactly the query the Sonarr/Radarr queue
// controller expects.
//
// The *arr is mocked at the transport seam — a fake fetch under the real
// ArrClient — so URL construction, the X-Api-Key header, and the DELETE query
// string all stay under test rather than being stubbed away.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { DownloadManager } from '../src/download/manager.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';

const MB = 1024 * 1024;
const HASH = 'abc123def456abc123def456abc123def456abcd';

class FakePutio {
  constructor(files) {
    this.files = files;
    this.deletedFiles = [];
    this.deletedTransfers = [];
  }

  async ensureFolder() {
    return 42;
  }

  async listTransferFiles(fileId) {
    assert.equal(fileId, 20);
    return this.files;
  }

  async deleteFile(fileId) {
    this.deletedFiles.push(fileId);
  }

  async deleteTransfer(transferId) {
    this.deletedTransfers.push(transferId);
  }
}

// Answers the two *arr calls and records what it was asked. Anything else is a
// hard failure rather than a silent default, so an unexpected request shows up
// as the test failing instead of as a passing test proving nothing.
function createFakeArr({ queueRecords = [{ id: 77, downloadId: HASH.toUpperCase() }] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({
      method: options.method ?? 'GET',
      pathname: target.pathname,
      query: Object.fromEntries(target.searchParams),
      apiKey: options.headers?.['X-Api-Key'],
    });
    if (target.pathname === '/api/v3/queue' && (options.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ records: queueRecords }); } };
    }
    if (/^\/api\/v3\/queue\/\d+$/.test(target.pathname) && options.method === 'DELETE') {
      return { ok: true, status: 200, async text() { return ''; } };
    }
    throw new Error(`unexpected *arr request: ${options.method ?? 'GET'} ${target.pathname}`);
  };
  return { calls, fetchImpl };
}

async function createHarness(putio) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-arr-rejection-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_PUTIO_TOKEN: 'test-token',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const service = new TransferService({ config, store, putioFactory: () => putio });
  return { root, config, store, service, putio };
}

function createSonarrProfile(harness, patch = {}) {
  return harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: path.join(harness.config.targetDir, 'sonarr'),
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
    arr_base_url: 'http://sonarr.test:8989',
    arr_api_key: 'secret-key',
    reject_unimportable: true,
    ...patch,
  });
}

function seedReadyTransfer(harness, profile, patch = {}) {
  return harness.store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 10,
    putio_file_id: 20,
    save_parent_id: 42,
    hash: HASH,
    name: 'Show.S01E01.JUNK',
    lifecycle: 'remote',
    putio_status: 'COMPLETED',
    percent_done: 100,
    // Matches what the fake put.io delivers, so the short-delivery check stays
    // quiet and each test exercises the rule it names rather than this one.
    total_size: 4 * MB + 2048,
    ...patch,
  });
}

const JUNK_FILES = [
  { relativePath: 'Show.S01E01/Download instructions.txt', size: 2048, id: 1, name: 'x' },
  { relativePath: 'Show.S01E01/setup.exe', size: 4 * MB, id: 2, name: 'y' },
];

const GOOD_FILES = [
  { relativePath: 'Show.S01E01/Show.S01E01.mkv', size: 1900 * MB, id: 3, name: 'z' },
];

test('an unimportable release is blocklisted, searched again, and never downloaded', async () => {
  const harness = await createHarness(new FakePutio(JUNK_FILES));
  const arr = createFakeArr();
  try {
    const profile = createSonarrProfile(harness);
    const transfer = seedReadyTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: arr.fetchImpl,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    // The *arr was asked for its queue, with the API key on the request.
    assert.equal(arr.calls[0].method, 'GET');
    assert.equal(arr.calls[0].pathname, '/api/v3/queue');
    assert.equal(arr.calls[0].apiKey, 'secret-key');

    // ...and then told to blocklist AND search again for the matched item.
    assert.equal(arr.calls[1].method, 'DELETE');
    assert.equal(arr.calls[1].pathname, '/api/v3/queue/77');
    assert.equal(arr.calls[1].query.blocklist, 'true');
    assert.equal(arr.calls[1].query.skipRedownload, 'false');
    // putiorr removes the download itself, so the *arr must not call back in.
    assert.equal(arr.calls[1].query.removeFromClient, 'false');

    // Nothing was staged: no file rows, and the download is gone from putiorr.
    assert.deepEqual(harness.store.listFilesForDownload(transfer.id), []);
    assert.equal(harness.store.findDownloadById(transfer.id), undefined);
    // The junk is dropped from put.io too.
    assert.deepEqual(harness.putio.deletedTransfers, [10]);
  } finally {
    harness.store.close();
  }
});

test('an importable release is downloaded and the *arr is never called', async () => {
  const harness = await createHarness(new FakePutio(GOOD_FILES));
  const arr = createFakeArr();
  try {
    const profile = createSonarrProfile(harness);
    const transfer = seedReadyTransfer(harness, profile, {
      name: 'Show.S01E01.GOOD',
      total_size: 1900 * MB,
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: arr.fetchImpl,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.deepEqual(arr.calls, []);
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'downloading');
    assert.equal(harness.store.listFilesForDownload(transfer.id).length, 1);
  } finally {
    harness.store.close();
  }
});

test('a profile with the feature off downloads junk exactly as before', async () => {
  const harness = await createHarness(new FakePutio(JUNK_FILES));
  const arr = createFakeArr();
  try {
    const profile = createSonarrProfile(harness, { reject_unimportable: false });
    const transfer = seedReadyTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: arr.fetchImpl,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.deepEqual(arr.calls, []);
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'downloading');
  } finally {
    harness.store.close();
  }
});

// Dropping a download the *arr still has queued is worse than downloading a bad
// one: nothing would ever search for a replacement again.
test('an unreachable *arr leaves the download alone rather than dropping it', async () => {
  const harness = await createHarness(new FakePutio(JUNK_FILES));
  try {
    const profile = createSonarrProfile(harness);
    const transfer = seedReadyTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'downloading');
    assert.deepEqual(harness.putio.deletedTransfers, []);
  } finally {
    harness.store.close();
  }
});

test('a hash the *arr has no queue item for is downloaded rather than dropped', async () => {
  const harness = await createHarness(new FakePutio(JUNK_FILES));
  const arr = createFakeArr({ queueRecords: [{ id: 5, downloadId: 'SOMEOTHERHASH' }] });
  try {
    const profile = createSonarrProfile(harness);
    const transfer = seedReadyTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: arr.fetchImpl,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.equal(arr.calls.length, 1, 'the queue is read but nothing is deleted');
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'downloading');
  } finally {
    harness.store.close();
  }
});

// An audio-only release is importable to *something*, which is exactly why a
// single union list let it through to Sonarr, downloaded it, and left the queue
// item stuck on a failed import.
test('an audio-only release is rejected on a sonarr profile', async () => {
  const files = [{ relativePath: 'Album/01 - Track.flac', size: 60 * MB, id: 4, name: 'a' }];
  const harness = await createHarness(new FakePutio(files));
  const arr = createFakeArr();
  try {
    const profile = createSonarrProfile(harness);
    const transfer = seedReadyTransfer(harness, profile, { total_size: 60 * MB });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: arr.fetchImpl,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.equal(arr.calls[1].method, 'DELETE');
    assert.equal(arr.calls[1].query.blocklist, 'true');
    assert.equal(harness.store.findDownloadById(transfer.id), undefined);
  } finally {
    harness.store.close();
  }
});

test('a lidarr profile never rejects, because putiorr does not speak its API', async () => {
  const harness = await createHarness(new FakePutio(JUNK_FILES));
  const arr = createFakeArr();
  try {
    const profile = createSonarrProfile(harness, {
      name: 'Lidarr', type: 'lidarr', slug: 'lidarr', rpc_path: '/lidarr/transmission/rpc',
    });
    const transfer = seedReadyTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: arr.fetchImpl,
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.deepEqual(arr.calls, []);
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'downloading');
  } finally {
    harness.store.close();
  }
});
