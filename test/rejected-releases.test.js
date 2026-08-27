// Issue #111. A blocklist is permanent, invisible and made without asking, so
// the record of what was rejected is the only way a false positive is ever
// noticed. These cover the store, the summary copy, and — the one that matters
// — that a real rejection actually leaves a row behind.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { DownloadManager } from '../src/download/manager.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';
import { rejectedReleasesSummary } from '../src/web/util.js';

const MB = 1024 * 1024;
const HASH = 'abc123def456abc123def456abc123def456abcd';

class FakePutio {
  constructor(files) {
    this.files = files;
  }

  async ensureFolder() { return 42; }

  async listTransferFiles() { return this.files; }

  async deleteFile() {}

  async deleteTransfer() {}
}

function createFakeArr({
  queueRecords = [{ id: 77, downloadId: HASH.toUpperCase(), episodeId: 501 }],
} = {}) {
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.pathname === '/api/v3/queue' && (options.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ records: queueRecords }); } };
    }
    return { ok: true, status: 200, async text() { return ''; } };
  };
}

async function createHarness(putio) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-rejected-log-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_PUTIO_TOKEN: 'test-token',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const service = new TransferService({ config, store, putioFactory: () => putio });
  return { config, store, service };
}

function createSonarrProfile(harness) {
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
  });
}

const JUNK = [{ relativePath: 'Show.S01E01/setup.exe', size: 4 * MB, id: 1, name: 'x' }];

test('a blocklisted release leaves a row naming what was thrown away and why', async () => {
  const harness = await createHarness(new FakePutio(JUNK));
  try {
    const profile = createSonarrProfile(harness);
    const transfer = harness.store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: HASH,
      name: 'Show.S01E01.JUNK',
      lifecycle: 'remote',
      putio_status: 'COMPLETED',
      total_size: 4 * MB,
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: createFakeArr(),
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.deepEqual(harness.store.countRejectedReleases(), {
      total: 1, blocklisted: 1, downloaded: 0,
    });
    const [row] = harness.store.listRejectedReleases().rows;
    assert.equal(row.name, 'Show.S01E01.JUNK');
    assert.equal(row.profile_name, 'Sonarr');
    assert.equal(row.outcome, 'blocklisted');
    assert.match(row.reason, /can import/);
    assert.ok(row.rejected_at, 'the row is timestamped');
  } finally {
    harness.store.close();
  }
});

// The rejection that did NOT happen is the one worth surfacing: that release
// was downloaded and the *arr queue item is still stuck. It is only recorded
// once putiorr has stopped waiting — one row per release, not one per attempt.
test('a rejection the *arr was never told about is recorded as downloaded', async () => {
  const harness = await createHarness(new FakePutio(JUNK));
  try {
    const profile = createSonarrProfile(harness);
    const transfer = harness.store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: HASH,
      name: 'Show.S01E01.JUNK',
      lifecycle: 'remote',
      putio_status: 'COMPLETED',
      total_size: 4 * MB,
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    // Deferred while waiting for the *arr, then conceded once.
    for (let i = 0; i < 5; i += 1) {
      const row = harness.store.findDownloadById(transfer.id);
      if (row) await manager.prepareTransfer(row);
    }

    assert.deepEqual(harness.store.countRejectedReleases(), {
      total: 1, blocklisted: 0, downloaded: 1,
    });
    assert.equal(harness.store.listRejectedReleases().rows[0].outcome, 'downloaded');
    // ...and the release really was downloaded rather than dropped.
    assert.equal(harness.store.findDownloadById(transfer.id).lifecycle, 'downloading');
  } finally {
    harness.store.close();
  }
});

test('a release that passes the check records nothing', async () => {
  const good = [{ relativePath: 'Show.S01E01/Show.S01E01.mkv', size: 900 * MB, id: 2, name: 'z' }];
  const harness = await createHarness(new FakePutio(good));
  try {
    const profile = createSonarrProfile(harness);
    const transfer = harness.store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: HASH,
      name: 'Show.S01E01.GOOD',
      lifecycle: 'remote',
      putio_status: 'COMPLETED',
      total_size: 900 * MB,
    });

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
      fetchImpl: createFakeArr(),
    });
    await manager.prepareTransfer(harness.store.findDownloadById(transfer.id));

    assert.deepEqual(harness.store.countRejectedReleases(), {
      total: 0, blocklisted: 0, downloaded: 0,
    });
  } finally {
    harness.store.close();
  }
});

test('the history reads newest first and the counts split by outcome', async () => {
  const harness = await createHarness(new FakePutio(JUNK));
  try {
    harness.store.recordRejectedRelease({ name: 'first', outcome: 'blocklisted' });
    harness.store.recordRejectedRelease({ name: 'second', outcome: 'downloaded' });
    harness.store.recordRejectedRelease({ name: 'third', outcome: 'blocklisted' });

    assert.deepEqual(
      harness.store.listRejectedReleases().rows.map((row) => row.name),
      ['third', 'second', 'first'],
    );
    assert.deepEqual(harness.store.countRejectedReleases(), {
      total: 3, blocklisted: 2, downloaded: 1,
    });
    assert.equal(harness.store.listRejectedReleases({ limit: 2 }).rows.length, 2);
    assert.equal(harness.store.listRejectedReleases({ limit: 2 }).total, 3, 'total is the filter match, not the page');

    // Paging walks the whole log without repeating or skipping a row.
    const page2 = harness.store.listRejectedReleases({ limit: 2, offset: 2 });
    assert.deepEqual(page2.rows.map((row) => row.name), ['first']);

    // Search covers release, profile and reason; the outcome filter narrows it.
    assert.deepEqual(
      harness.store.listRejectedReleases({ search: 'seco' }).rows.map((row) => row.name),
      ['second'],
    );
    assert.equal(harness.store.listRejectedReleases({ outcome: 'downloaded' }).total, 1);

    // Unread until someone says otherwise, and marking is idempotent.
    assert.equal(harness.store.countUnreadRejectedReleases(), 3);
    assert.equal(harness.store.markAllRejectedReleasesRead(), 3);
    assert.equal(harness.store.countUnreadRejectedReleases(), 0);
    assert.equal(harness.store.markAllRejectedReleasesRead(), 0);
  } finally {
    harness.store.close();
  }
});

test('the summary hides itself at zero and never buries an undelivered rejection', () => {
  assert.equal(rejectedReleasesSummary({ total: 0 }), '');
  assert.match(
    rejectedReleasesSummary({ total: 3, blocklisted: 3, downloaded: 0 }),
    /3 releases rejected and sent back/,
  );
  // The mixed case has to state both numbers: a total alone would read as three
  // successful rejections when one release is still sitting in the *arr queue.
  const mixed = rejectedReleasesSummary({ total: 3, blocklisted: 2, downloaded: 1 });
  assert.match(mixed, /2 blacklisted/);
  assert.match(mixed, /1 downloaded because/);
  assert.match(
    rejectedReleasesSummary({ total: 1, blocklisted: 0, downloaded: 1 }),
    /never told/,
  );
  assert.match(rejectedReleasesSummary({ total: 1, blocklisted: 1 }), /1 release rejected/);
});

test('retention prunes a profile\'s old rows and keeps everyone else\'s', async () => {
  const harness = await createHarness(new FakePutio(JUNK));
  try {
    harness.store.createProfile({
      name: 'Sonarr', type: 'sonarr', slug: 'sonarr', putio_folder_name: 'putiorr',
      downloadAt: path.join(harness.config.targetDir, 'sonarr'),
      rpc_path: '/sonarr/transmission/rpc', reject_log_retention_days: 30,
    });
    // 0 means keep forever, which is what an operator who cleared the field meant.
    harness.store.createProfile({
      name: 'Radarr', type: 'radarr', slug: 'radarr', putio_folder_name: 'putiorr',
      downloadAt: path.join(harness.config.targetDir, 'radarr'),
      rpc_path: '/radarr/transmission/rpc', reject_log_retention_days: 0,
    });

    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    for (const profileName of ['Sonarr', 'Radarr']) {
      harness.store.recordRejectedRelease({ profileName, name: `${profileName}.fresh` });
      const row = harness.store.recordRejectedRelease({ profileName, name: `${profileName}.old` });
      harness.store.db.prepare('UPDATE rejected_releases SET rejected_at = ? WHERE id = ?').run(old, row.id);
    }

    assert.equal(harness.store.pruneRejectedReleases(), 1, 'only the retained profile loses a row');
    assert.deepEqual(
      harness.store.listRejectedReleases().rows.map((row) => row.name).sort(),
      ['Radarr.fresh', 'Radarr.old', 'Sonarr.fresh'],
    );
    // Running it again removes nothing: retention is a cutoff, not a countdown.
    assert.equal(harness.store.pruneRejectedReleases(), 0);
  } finally {
    harness.store.close();
  }
});

test('the default retention is three months, and it is per profile', async () => {
  const harness = await createHarness(new FakePutio(JUNK));
  try {
    const profile = createSonarrProfile(harness);
    assert.equal(profile.reject_log_retention_days, 90);
    const patched = harness.store.updateProfile(profile.id, { reject_log_retention_days: 14 });
    assert.equal(patched.reject_log_retention_days, 14);
    // Anything unreadable or negative reads as "keep forever" rather than as
    // "delete everything", which is the harmless direction to be wrong in.
    assert.equal(harness.store.updateProfile(profile.id, { reject_log_retention_days: -5 }).reject_log_retention_days, 0);
  } finally {
    harness.store.close();
  }
});
