import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';

// What an older putiorr leaves behind when it starts against a migrated
// database: the tables the collapse dropped, recreated by its own schema setup.
// Only the names and the parent/child link matter here, so the columns are the
// few the tests write; the real DDL is in store.js and is not what is under test.
const LEGACY_TABLES_AS_AN_OLDER_PUTIORR_RECREATES_THEM = `
  CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    putio_transfer_id INTEGER,
    name TEXT
  );

  CREATE TABLE IF NOT EXISTS transfer_associations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER,
    profile_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS transfer_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS association_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER
  );
`;

// downloads.profile_id is NOT NULL, so every download in these tests needs a
// profile to own it. The owner is resolved once, at ingestion, and frozen.
function seedProfile(store, overrides = {}) {
  return store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: '/downloads',
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
    ...overrides,
  });
}

test('upsertDownload matches later remote updates by put.io id', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const first = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: 'temporaryhash',
      name: 'Initial Name',
      source_type: 'magnet',
    });

    const second = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: 'realhashfromputio',
      name: 'Updated Name',
      putio_status: 'DOWNLOADING',
      percent_done: 25,
    });

    assert.equal(second.id, first.id);
    // The row is resolved by put.io id alone, and the hash is informational —
    // so a later refresh that reports a different one corrects it rather than
    // preserving whatever was known first. A stale hash is what an *arr
    // correlates its queue item against, so leaving it wrong is not neutral.
    assert.equal(second.hash, 'realhashfromputio');
    assert.equal(second.name, 'Updated Name');
    assert.equal(second.putio_status, 'DOWNLOADING');
    assert.equal(second.percent_done, 25);
    assert.equal(store.listActiveDownloads().length, 1);
  } finally {
    store.close();
  }
});

test('an upgrade freezes the staging folder of every download already staged', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'putiorr-freeze-backfill-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const first = new StateStore(dbPath);
  const ids = {};
  try {
    const profile = seedProfile(first);
    for (const [lifecycle, putioTransferId] of [['processed', 95], ['downloading', 96], ['remote', 97]]) {
      ids[lifecycle] = first.upsertDownload({
        profile_id: profile.id,
        putio_transfer_id: putioTransferId,
        hash: `${lifecycle}hash`,
        name: `${lifecycle}.Release`,
        lifecycle,
      }).id;
    }
    // The shape every upgrading install has: rows an older build already
    // staged, with no record of where it put them — and no record of the
    // backfill having run, because the build that wrote them had no backfill.
    first.db.exec("UPDATE downloads SET staging_folder = ''");
    first.db.exec("DELETE FROM settings WHERE key = 'downloads_staging_folder_backfill'");
  } finally {
    first.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    // A row that has been written to disk is frozen to the name it was written
    // under. Empty would mean "wherever put.io says it is called now", and a
    // rename then reads as files the user deleted — which deletes the download
    // and cancels its put.io transfer.
    assert.equal(reopened.findDownloadById(ids.processed).staging_folder, 'processed.Release');
    assert.equal(reopened.findDownloadById(ids.downloading).staging_folder, 'downloading.Release');
    // Nothing has been written for a remote transfer, so there is nothing to
    // freeze and it takes whatever name it has when it is first staged.
    assert.equal(reopened.findDownloadById(ids.remote).staging_folder, '');
  } finally {
    reopened.close();
  }
});

// The put.io adoption notice is gone: a transfer the poll cannot attribute to
// one RR profile is skipped, and nothing is reported about it. Every install
// that ran a version which did report it has the row still sitting in
// `settings`, where nothing would ever rewrite it — so the last thing that
// version saw would have outlived the feature.
test('an upgrade deletes the retired adoption notice setting', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'putiorr-retired-settings-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const first = new StateStore(dbPath);
  try {
    first.setSetting('adoption_notices', JSON.stringify([{ putioFolderId: 42, transferCount: 3 }]));
    first.setSetting('putio_token', 'kept');
  } finally {
    first.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    assert.equal(reopened.getSetting('adoption_notices'), undefined);
    // Only the retired key goes: this runs on every boot, of every install.
    assert.equal(reopened.getSetting('putio_token'), 'kept');
  } finally {
    reopened.close();
  }
});

// The same step on the overwhelming majority of boots: a database that never
// had the key, or has already had it removed. Deleting a row that is not there
// is not an error, and it must not become one.
test('deleting the retired adoption notice setting is a no-op when it was never written', () => {
  const store = new StateStore(':memory:');
  try {
    assert.equal(store.getSetting('adoption_notices'), undefined);
    store.dropRetiredSettings();
    assert.equal(store.getSetting('adoption_notices'), undefined);
  } finally {
    store.close();
  }
});

// "Idempotent, and a no-op on every boot after the first" was only true of the
// rows the upgrade found. It is an unguarded UPDATE, so every later boot froze
// whatever was sitting at 'downloading' with no staging folder — which is the
// state prepareTransfer leaves behind when it refuses to stage a download,
// naming a remedy this then removes.
test('the staging-folder backfill runs once, not on every boot', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'putiorr-freeze-once-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const first = new StateStore(dbPath);
  let staleId;
  try {
    const profile = seedProfile(first);
    staleId = first.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 98,
      hash: 'freezeoncehash',
      name: 'Not.Staged.Yet',
      lifecycle: 'downloading',
    }).id;
  } finally {
    first.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    // The upgrade already ran on the boot that created this database, so this
    // row was never one of the rows it was written for: nothing has staged it,
    // and its folder is still whatever it is called when something does.
    assert.equal(reopened.findDownloadById(staleId).staging_folder, '');
  } finally {
    reopened.close();
  }
});

test('an upgrade gives an existing downloads table its staging folder column', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'putiorr-staging-folder-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const first = new StateStore(dbPath);
  let downloadId;
  try {
    const profile = seedProfile(first);
    downloadId = first.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 90,
      hash: 'stagingcolumnhash',
      name: 'Staged.Release',
    }).id;
    // The shape a database collapsed by an earlier build of this phase has.
    first.db.exec('ALTER TABLE downloads DROP COLUMN staging_folder');
  } finally {
    first.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    // Empty means "not staged yet", which is the right answer for a download
    // nothing has prepared since the upgrade — and the put.io name is what it
    // resolves to until it is.
    const download = reopened.findDownloadById(downloadId);
    assert.equal(download.staging_folder, '');
    assert.equal(download.name, 'Staged.Release');
    assert.equal(reopened.updateDownload(downloadId, { staging_folder: 'Staged.Release' }).staging_folder, 'Staged.Release');
  } finally {
    reopened.close();
  }
});

test('a profile download folder is stored absolute', () => {
  const store = new StateStore(':memory:');
  try {
    // PUTIORR_PROFILES_JSON seeds go straight into the store, so a relative
    // folder used to be stored verbatim and re-resolved against the working
    // directory on every read — a different directory per launch, and one no
    // containment check can vouch for.
    const profile = seedProfile(store, { downloadAt: './media/downloads' });
    assert.equal(profile.download_at, path.resolve('./media/downloads'));

    const updated = store.updateProfile(profile.id, { downloadAt: 'elsewhere' });
    assert.equal(updated.download_at, path.resolve('elsewhere'));
  } finally {
    store.close();
  }
});

test('an upgrade freezes a relative profile download folder as absolute', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'putiorr-download-at-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const first = new StateStore(dbPath);
  try {
    const profile = seedProfile(first);
    // Written before profiles stored their folder absolute. Left alone it
    // would fail every download of that profile, because a relative root is
    // refused outright now.
    first.db.prepare('UPDATE profiles SET download_at = ? WHERE id = ?').run('media/downloads', profile.id);
  } finally {
    first.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    assert.equal(reopened.findProfileBySlug('sonarr').download_at, path.resolve('media/downloads'));
  } finally {
    reopened.close();
  }
});

test('upsertDownload keeps the known hash when put.io reports none', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const created = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 15,
      hash: 'knownhash',
      name: 'Known Hash',
    });

    // put.io reports no hash for a transfer it has not started yet. That is
    // not a correction — an empty hash carries no information, and taking it
    // would erase the one the magnet already told us.
    const refreshed = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 15,
      hash: '',
      putio_status: 'DOWNLOADING',
    });

    assert.equal(refreshed.id, created.id);
    assert.equal(refreshed.hash, 'knownhash');
  } finally {
    store.close();
  }
});

test('a download with no hash yet is never resolved by an empty hash', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    // The state a torrent upload lands in when put.io reports no hash: real
    // download, no infohash yet. Nothing may match it by hash, or an *arr
    // asking for '' would be handed somebody's download.
    store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 16,
      hash: '',
      name: 'Hashless Upload',
    });

    assert.equal(store.findDownloadByHash(''), undefined);
    assert.equal(store.findDownloadByHash('   '), undefined);
    assert.equal(store.findDownloadByHash(undefined), undefined);
    assert.equal(store.findDownload(''), undefined);
  } finally {
    store.close();
  }
});

test('upsertDownload persists put.io completion_percent across updates', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const created = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 11,
      hash: 'completinghash',
      name: 'Completing Transfer',
      putio_status: 'COMPLETING',
      percent_done: 100,
      completion_percent: 67,
    });
    assert.equal(created.completion_percent, 67);

    const updated = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 11,
      hash: 'completinghash',
      putio_status: 'COMPLETING',
      percent_done: 100,
      completion_percent: 82,
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.completion_percent, 82);
  } finally {
    store.close();
  }
});

test('upsertDownload persists put.io status details across updates', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const created = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 12,
      hash: 'statusmessagehash',
      name: 'Waiting Transfer',
      putio_status: 'DOWNLOADING',
      putio_status_message: 'Waiting for torrent details from the network...',
      putio_peers: 0,
      putio_availability: 0,
    });
    assert.equal(created.putio_status_message, 'Waiting for torrent details from the network...');

    const updated = store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 12,
      hash: 'statusmessagehash',
      putio_status_message: '',
      putio_peers: 2,
      putio_availability: 11,
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.putio_status_message, '');
    assert.equal(updated.putio_peers, 2);
    assert.equal(updated.putio_availability, 11);
  } finally {
    store.close();
  }
});

test('profile rows migrate local_path to downloadAt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const dbPath = path.join(root, 'state.sqlite');
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'custom',
        slug TEXT NOT NULL UNIQUE,
        putio_folder_name TEXT NOT NULL,
        putio_folder_id INTEGER,
        local_path TEXT NOT NULL,
        rpc_path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy.prepare(`
      INSERT INTO profiles (
        name, type, slug, putio_folder_name, local_path,
        rpc_path, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Radarr', 'radarr', 'radarr', 'movies', '/staged', '/radarr/transmission/rpc', 1, 'now', 'now');
  } finally {
    legacy.close();
  }

  const store = new StateStore(dbPath);
  try {
    const profile = store.findProfileBySlug('radarr');
    assert.equal(profile.downloadAt, '/staged');
    assert.equal(profile.download_at, '/staged');
    assert.equal(profile.client_host, 'putiorr');
    assert.equal(profile.client_port, '9091');
    assert.equal(profile.client_use_ssl, false);
    assert.equal(profile.auto_remove_completed, false);
    assert.equal(Object.hasOwn(profile, 'local_path'), false);
  } finally {
    store.close();
  }
});

test('prowlarr profiles default to removing completed local downloads', async () => {
  const store = new StateStore(':memory:');
  try {
    const prowlarr = store.createProfile({
      name: 'Prowlarr',
      type: 'prowlarr',
      slug: 'prowlarr',
      putio_folder_name: 'prowlarr',
      downloadAt: '/downloads',
      rpc_path: '/prowlarr/transmission/rpc',
      enabled: true,
    });
    const custom = store.createProfile({
      name: 'Custom',
      type: 'custom',
      slug: 'custom',
      putio_folder_name: 'custom',
      downloadAt: '/downloads',
      rpc_path: '/custom/transmission/rpc',
      enabled: true,
    });

    assert.equal(prowlarr.auto_remove_completed, true);
    assert.equal(prowlarr.autoRemoveCompleted, true);
    assert.equal(custom.auto_remove_completed, false);
  } finally {
    store.close();
  }
});

test('putiorr grab profiles default to removing completed local downloads', () => {
  const store = new StateStore(':memory:');
  try {
    // The wizard sends the flag explicitly, so this is the default every other
    // door gets: POST /api/profiles and PUTIORR_PROFILES_JSON.
    const grab = store.createProfile({
      name: 'Browser',
      type: 'grab',
      slug: 'browser',
      putio_folder_name: 'putiorr',
      downloadAt: '/downloads',
      enabled: true,
    });
    const explicitlyOff = store.createProfile({
      name: 'Browser Two',
      type: 'grab',
      slug: 'browser-two',
      putio_folder_name: 'putiorr',
      downloadAt: '/downloads',
      auto_remove_completed: false,
      enabled: true,
    });

    assert.equal(grab.auto_remove_completed, true);
    assert.equal(grab.autoRemoveCompleted, true);
    // A caller that says what it wants is never overridden by a preset default.
    assert.equal(explicitlyOff.auto_remove_completed, false);
  } finally {
    store.close();
  }
});

test('profiles with linked downloads cannot be deleted', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = store.createProfile({
      name: 'Sonarr',
      type: 'sonarr',
      slug: 'sonarr',
      putio_folder_name: 'putiorr',
      downloadAt: '/downloads',
      rpc_path: '/sonarr/transmission/rpc',
      enabled: true,
    });
    store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 10,
      hash: 'linkedhash',
      name: 'Linked.Release',
    });

    assert.throws(
      () => store.deleteProfile(profile.id),
      /cannot be deleted while downloads still reference it/,
    );
    // The pre-check carries the sentence the dashboard shows; ON DELETE
    // RESTRICT is what makes the rule true even for a raw statement.
    assert.throws(
      () => store.db.prepare('DELETE FROM profiles WHERE id = ?').run(profile.id),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(store.findProfileById(profile.id).id, profile.id);
  } finally {
    store.close();
  }
});

// Issue #68. The files stay where they are and the staging folder is frozen,
// so a moved root points putiorr at a directory the files are not in — and the
// next poll reads a finished download whose files are missing as user-deleted,
// cancels its put.io transfer and deletes the row over it.
function seedOwnedDownload(store, profile, overrides = {}) {
  return store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 500,
    hash: 'ownedhash',
    name: 'Owned.Release',
    lifecycle: 'processed',
    ...overrides,
  });
}

test('a profile that owns downloads refuses to move its download folder', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    seedOwnedDownload(store, profile);
    seedOwnedDownload(store, profile, { putio_transfer_id: 501, hash: 'ownedhash501' });

    const error = thrownBy(() => store.updateProfile(profile.id, { downloadAt: '/media/tv' }));
    assert.match(error.message, /Sonarr still owns 2 downloads staged under \/downloads/);
    assert.match(error.message, /pointing it at \/media\/tv/);
    // The two ways out, named: nothing here is a dead end.
    assert.match(error.message, /finish and leave putiorr/);
    assert.match(error.message, /delete them from the dashboard/);
    // Branchable without matching prose, exactly as the catch-all refusal is.
    assert.deepEqual(error.downloadFolderLock, {
      profile: { id: profile.id, name: 'Sonarr' },
      downloads: 2,
      from: '/downloads',
      to: '/media/tv',
    });
    assert.equal(store.findProfileById(profile.id).download_at, '/downloads');
  } finally {
    store.close();
  }
});

test('a refused download folder move writes nothing else in the same patch', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    seedOwnedDownload(store, profile);

    assert.throws(
      () => store.updateProfile(profile.id, { name: 'Renamed', downloadAt: '/media/tv' }),
      /still owns 1 download staged under/,
    );
    const unchanged = store.findProfileById(profile.id);
    assert.equal(unchanged.name, 'Sonarr');
    assert.equal(unchanged.download_at, '/downloads');
    assert.equal(unchanged.updated_at, profile.updated_at);
  } finally {
    store.close();
  }
});

test('a profile that owns downloads still saves while its download folder stands', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    seedOwnedDownload(store, profile);

    // Not a change: the wizard sends the folder back on every save, and a
    // profile that owns downloads has to stay editable.
    const renamed = store.updateProfile(profile.id, { name: 'Renamed', downloadAt: '/downloads' });
    assert.equal(renamed.name, 'Renamed');
    assert.equal(renamed.download_at, '/downloads');
    // Nor is a folder spelled differently for the same directory.
    const trailingSlash = store.updateProfile(profile.id, { downloadAt: '/downloads/' });
    assert.equal(trailingSlash.download_at, '/downloads');
    assert.equal(store.updateProfile(profile.id, { downloadAt: '/downloads/./' }).download_at, '/downloads');
    // And a patch that never mentions the folder is not a folder change.
    assert.equal(store.updateProfile(profile.id, { enabled: false }).download_at, '/downloads');
  } finally {
    store.close();
  }
});

test('a profile that owns no downloads moves its download folder freely', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    assert.equal(store.updateProfile(profile.id, { downloadAt: '/media/tv' }).download_at, '/media/tv');

    // And it is free again once the downloads that held it are gone.
    const download = seedOwnedDownload(store, profile);
    assert.throws(() => store.updateProfile(profile.id, { downloadAt: '/media/shows' }), /still owns 1 download/);
    store.deleteDownload(download.id);
    assert.equal(store.updateProfile(profile.id, { downloadAt: '/media/shows' }).download_at, '/media/shows');
  } finally {
    store.close();
  }
});

test('a download deleted from the dashboard still holds the folder its files are in', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const download = seedOwnedDownload(store, profile);
    // Tombstoned, not gone: "remove from putiorr, keep the files" leaves the
    // row removed and the folder full, and every staging claim still counts it.
    store.markDownloadRemoved(download.id);

    const error = thrownBy(() => store.updateProfile(profile.id, { downloadAt: '/media/tv' }));
    assert.equal(error.downloadFolderLock.downloads, 1);
    assert.equal(store.findProfileById(profile.id).download_at, '/downloads');
  } finally {
    store.close();
  }
});

// A 'remote' download has no files of its own yet — and that is not the same as
// nothing on disk. The staging folder is claimed, and a part-file resumed from,
// while the row is still 'remote'; the *arr has already been told the
// download-dir; and nothing records the files a user dropped in beside them.
test('a download that has not started yet holds the folder just as firmly', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    seedOwnedDownload(store, profile, { lifecycle: 'remote' });

    assert.throws(
      () => store.updateProfile(profile.id, { downloadAt: '/media/tv' }),
      /still owns 1 download staged under \/downloads/,
    );
  } finally {
    store.close();
  }
});

test('migration enables auto-remove for existing prowlarr profiles once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const dbPath = path.join(root, 'state.sqlite');
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'custom',
        slug TEXT NOT NULL UNIQUE,
        putio_folder_name TEXT NOT NULL,
        putio_folder_id INTEGER,
        download_at TEXT NOT NULL,
        rpc_path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    legacy.prepare(`
      INSERT INTO profiles (
        name, type, slug, putio_folder_name, download_at,
        rpc_path, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('Prowlarr', 'prowlarr', 'prowlarr', 'prowlarr', '/downloads', '/prowlarr/transmission/rpc', 1, 'now', 'now');
  } finally {
    legacy.close();
  }

  const store = new StateStore(dbPath);
  try {
    const profile = store.findProfileBySlug('prowlarr');
    assert.equal(profile.auto_remove_completed, true);
    store.updateProfile(profile.id, { auto_remove_completed: false });
  } finally {
    store.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    assert.equal(reopened.findProfileBySlug('prowlarr').auto_remove_completed, false);
  } finally {
    reopened.close();
  }
});

test('seed creates a default download profile and attaches RR profiles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_SLOW_SPEED_THRESHOLD_BYTES_PER_SECOND: '2048',
    PUTIORR_SLOW_SPEED_DURATION_SECONDS: '45',
    PUTIORR_SLOW_SPEED_GRACE_SECONDS: '10',
    PUTIORR_SLOW_SPEED_MIN_SIZE_BYTES: '1048576',
  }, root);
  const store = new StateStore(':memory:');
  try {
    store.seedFromConfig(config);

    const [downloadProfile] = store.listDownloadProfiles();
    const rrProfile = store.findProfileBySlug('default');

    assert.equal(downloadProfile.slug, 'default');
    assert.equal(downloadProfile.slowSpeedThresholdBytesPerSecond, 2048);
    assert.equal(downloadProfile.slowSpeedDurationSeconds, 45);
    assert.equal(downloadProfile.slowSpeedGraceSeconds, 10);
    assert.equal(downloadProfile.slowSpeedMinSizeBytes, 1048576);
    assert.equal(rrProfile.download_profile_id, downloadProfile.id);
    assert.equal(rrProfile.downloadProfileId, downloadProfile.id);
  } finally {
    store.close();
  }
});

test('magnet-backed transfer hashes migrate to the torrent info hash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const dbPath = path.join(root, 'state.sqlite');
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'custom',
        slug TEXT NOT NULL UNIQUE,
        putio_folder_name TEXT NOT NULL,
        putio_folder_id INTEGER,
        download_at TEXT NOT NULL,
        rpc_path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        putio_transfer_id INTEGER UNIQUE,
        putio_file_id INTEGER,
        save_parent_id INTEGER,
        hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        source TEXT,
        source_type TEXT NOT NULL DEFAULT 'unknown',
        category TEXT NOT NULL DEFAULT '',
        download_dir TEXT NOT NULL DEFAULT '',
        lifecycle TEXT NOT NULL DEFAULT 'remote',
        putio_status TEXT NOT NULL DEFAULT 'UNKNOWN',
        percent_done INTEGER NOT NULL DEFAULT 0,
        total_size INTEGER NOT NULL DEFAULT 0,
        downloaded_ever INTEGER NOT NULL DEFAULT 0,
        uploaded_ever INTEGER NOT NULL DEFAULT 0,
        download_speed INTEGER NOT NULL DEFAULT 0,
        upload_speed INTEGER NOT NULL DEFAULT 0,
        eta INTEGER NOT NULL DEFAULT -1,
        error INTEGER NOT NULL DEFAULT 0,
        error_string TEXT NOT NULL DEFAULT '',
        retry_count INTEGER NOT NULL DEFAULT 0,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE transfer_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
        putio_file_id INTEGER NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error_string TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO profiles (
        name, type, slug, putio_folder_name, putio_folder_id,
        download_at, rpc_path, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Sonarr',
      'sonarr',
      'sonarr',
      'putiorr',
      42,
      '/downloads',
      '/sonarr/transmission/rpc',
      1,
      'now',
      'now',
    );
    legacy.prepare(`
      INSERT INTO transfers (
        profile_id, putio_transfer_id, putio_file_id, hash, name, source,
        source_type, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      123,
      456,
      'putiohash',
      'Example.Release',
      'magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=Example.Release',
      'magnet',
      'now',
      'now',
    );
    legacy.prepare(`
      INSERT INTO transfer_files (
        transfer_id, putio_file_id, relative_path, size, downloaded_bytes,
        status, attempts, error_string, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, 789, 'Episode.mkv', 5, 2, 'pending', 0, '', 'now', 'now');
  } finally {
    legacy.close();
  }

  const store = new StateStore(dbPath);
  try {
    assert.equal(store.findDownloadByHash('ABCDEF1234567890ABCDEF1234567890ABCDEF12').id, 1);
    assert.equal(
      store.findDownloadById(1).hash,
      'abcdef1234567890abcdef1234567890abcdef12',
    );
    assert.equal(store.findDownloadById(1).profile_id, 1);
    // The transfer id, the association id and the download id are all 1: the
    // chain copies the id at every hop so the ids the *arr apps hold survive.
    assert.equal(store.findDownloadById(1).id, 1);
    assert.deepEqual(store.listFilesForDownload(1).map((file) => file.putio_file_id), [789]);
  } finally {
    store.close();
  }
});

// A grab profile with no site listed on it is unreachable unless something
// says "and everything else lands here". That used to be the extension's
// Default profile setting; it is a column on the profile now, so the routing
// decision sits with the rest of them.
function seedGrabProfile(store, slug, overrides = {}) {
  return store.createProfile({
    name: slug.toUpperCase(),
    type: 'grab',
    slug,
    putio_folder_name: slug,
    downloadAt: `/downloads/${slug}`,
    rpc_path: null,
    ...overrides,
  });
}

test('a grab profile can be marked as the one that takes every unclaimed site', () => {
  const store = new StateStore(':memory:');
  try {
    const catchAll = seedGrabProfile(store, 'catch-all', { browser_catch_all: true });
    assert.equal(catchAll.browser_catch_all, true);
    assert.equal(catchAll.browserCatchAll, true);
    assert.equal(store.findProfileById(catchAll.id).browser_catch_all, true);

    // Off unless asked for: a profile that quietly took every site would route
    // grabs into a folder nobody chose.
    const plain = seedGrabProfile(store, 'plain');
    assert.equal(plain.browser_catch_all, false);
    assert.equal(plain.browserCatchAll, false);

    // Both key styles are accepted, and an unrelated update leaves it alone.
    assert.equal(store.updateProfile(catchAll.id, { browserCatchAll: false }).browser_catch_all, false);
    assert.equal(store.updateProfile(catchAll.id, { browser_catch_all: true }).browser_catch_all, true);
    assert.equal(store.updateProfile(catchAll.id, { name: 'Renamed' }).browser_catch_all, true);
  } finally {
    store.close();
  }
});

test('the catch-all grab profile is the one every unrouted grab resolves to', () => {
  const store = new StateStore(':memory:');
  try {
    assert.equal(store.findCatchAllGrabProfile(), undefined);

    seedGrabProfile(store, 'plain');
    const catchAll = seedGrabProfile(store, 'catch-all', { browser_catch_all: true });
    assert.equal(store.findCatchAllGrabProfile().id, catchAll.id);

    // Switched off is still the profile that holds the role: the grab is
    // refused by name rather than routed somewhere the user never chose.
    store.updateProfile(catchAll.id, { enabled: false });
    assert.equal(store.findCatchAllGrabProfile().id, catchAll.id);
  } finally {
    store.close();
  }
});

test('a second catch-all is refused by naming the profile that already holds it', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });

    // Two would make an unrouted grab ambiguous, and the fix is on a profile
    // the user has to be able to find — so the refusal names it.
    assert.throws(
      () => seedGrabProfile(store, 'music', { browser_catch_all: true }),
      /MOVIES already takes grabs from any site no other profile claims/,
    );
    assert.equal(store.findProfileBySlug('music'), undefined);

    const second = seedGrabProfile(store, 'music');
    assert.throws(
      () => store.updateProfile(second.id, { browser_catch_all: true }),
      /MOVIES already takes grabs/,
    );
    assert.equal(store.findProfileById(second.id).browser_catch_all, false);

    // The profile that already holds it may re-save without tripping over
    // itself, and handing the role over is two saves rather than an error.
    assert.equal(store.updateProfile(first.id, { browser_catch_all: true }).browser_catch_all, true);
    store.updateProfile(first.id, { browser_catch_all: false });
    assert.equal(store.updateProfile(second.id, { browser_catch_all: true }).browser_catch_all, true);
  } finally {
    store.close();
  }
});

// assert.throws answers whether it threw, not with what: these tests are about
// what rides along on the error, so the error itself has to come back.
function thrownBy(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the write to be refused');
}

// "Exactly one profile holds it, or none does" is the invariant every one of
// these tests ends on, takeover or refusal alike.
function catchAllHolderIds(store) {
  return store.listProfiles()
    .filter((profile) => profile.type === 'grab' && profile.browser_catch_all)
    .map((profile) => profile.id);
}

test('the refusal carries the profile that holds the fallback, not only a sentence', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });

    // The sentence is for a human and stays exactly as it was. What a caller
    // branches on is the holder riding along with it: the wizard has to offer
    // an action naming that profile, and matching prose to find its name is
    // how a client/server boundary rots.
    const error = thrownBy(() => seedGrabProfile(store, 'music', { browser_catch_all: true }));
    assert.equal(
      error.message,
      'MOVIES already takes grabs from any site no other profile claims; untick it on that profile first',
    );
    assert.deepEqual(error.catchAllHolder, { id: first.id, name: 'MOVIES' });

    const second = seedGrabProfile(store, 'music');
    const updateError = thrownBy(() => store.updateProfile(second.id, { browser_catch_all: true }));
    assert.match(updateError.message, /MOVIES already takes grabs/);
    assert.deepEqual(updateError.catchAllHolder, { id: first.id, name: 'MOVIES' });
    assert.deepEqual(catchAllHolderIds(store), [first.id]);
  } finally {
    store.close();
  }
});

test('takeOverCatchAll moves the fallback from the profile that held it', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });
    const second = seedGrabProfile(store, 'music');

    const moved = store.updateProfile(second.id, {
      browser_catch_all: true,
      takeOverCatchAll: true,
      takeOverCatchAllFrom: first.id,
    });

    assert.equal(moved.browser_catch_all, true);
    // Clearing a profile the user cannot see is a real side effect, so the
    // reply says whose it was rather than leaving it to be discovered.
    assert.deepEqual(moved.catch_all_taken_from, { id: first.id, name: 'MOVIES' });
    assert.equal(store.findProfileById(first.id).browser_catch_all, false);
    assert.deepEqual(catchAllHolderIds(store), [second.id]);
    assert.equal(store.findCatchAllGrabProfile().id, second.id);

    // A brand new profile may take it over too — every write path, not only
    // the one the wizard happens to use for an existing profile.
    const third = seedGrabProfile(store, 'books', {
      browser_catch_all: true,
      takeOverCatchAll: true,
      takeOverCatchAllFrom: second.id,
    });
    assert.deepEqual(third.catch_all_taken_from, { id: second.id, name: 'MUSIC' });
    assert.deepEqual(catchAllHolderIds(store), [third.id]);

    // Both key styles, like every other field the seed paths write:
    // PUTIORR_PROFILES_JSON goes straight into the store without passing the
    // API, and it can hand the role over too.
    const fourth = seedGrabProfile(store, 'shows', {
      browser_catch_all: '1',
      take_over_catch_all: 'true',
      take_over_catch_all_from: String(third.id),
    });
    assert.deepEqual(fourth.catchAllTakenFrom, { id: third.id, name: 'BOOKS' });
    assert.deepEqual(catchAllHolderIds(store), [fourth.id]);
  } finally {
    store.close();
  }
});

test('a takeover whose conflict vanished mid-flight is simply a save', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });
    const second = seedGrabProfile(store, 'music');
    // Between the refusal being rendered and the link being clicked, the other
    // profile stopped being the fallback.
    store.updateProfile(first.id, { browser_catch_all: false });

    const saved = store.updateProfile(second.id, {
      browser_catch_all: true,
      takeOverCatchAll: true,
      takeOverCatchAllFrom: first.id,
    });

    assert.equal(saved.browser_catch_all, true);
    // Nobody lost the fallback, so nothing claims anybody did.
    assert.equal(saved.catch_all_taken_from, undefined);
    assert.deepEqual(catchAllHolderIds(store), [second.id]);
  } finally {
    store.close();
  }
});

test('a takeover refuses again when a different profile now holds the fallback', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });
    const second = seedGrabProfile(store, 'music');
    const third = seedGrabProfile(store, 'books');
    // The fallback moved to a profile the user was never shown. Clearing that
    // one silently would undo a decision this user never saw made.
    store.updateProfile(first.id, { browser_catch_all: false });
    store.updateProfile(third.id, { browser_catch_all: true });

    const error = thrownBy(() => store.updateProfile(second.id, {
      browser_catch_all: true,
      takeOverCatchAll: true,
      takeOverCatchAllFrom: first.id,
    }));
    assert.match(error.message, /BOOKS already takes grabs/);
    assert.deepEqual(error.catchAllHolder, { id: third.id, name: 'BOOKS' });
    assert.equal(store.findProfileById(second.id).browser_catch_all, false);
    assert.deepEqual(catchAllHolderIds(store), [third.id]);
  } finally {
    store.close();
  }
});

test('a takeover that cannot be saved leaves the previous fallback holding it', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });
    seedGrabProfile(store, 'music');

    // The clear and the write are one transaction, so a write that fails after
    // the clear cannot leave the fallback held by nobody.
    assert.throws(() => seedGrabProfile(store, 'music', {
      browser_catch_all: true,
      takeOverCatchAll: true,
      takeOverCatchAllFrom: first.id,
    }), /UNIQUE|constraint/i);

    assert.equal(store.findProfileById(first.id).browser_catch_all, true);
    assert.deepEqual(catchAllHolderIds(store), [first.id]);
  } finally {
    store.close();
  }
});

test('without the takeover flag the refusal changes nothing at all', () => {
  const store = new StateStore(':memory:');
  try {
    const first = seedGrabProfile(store, 'movies', { browser_catch_all: true });
    const second = seedGrabProfile(store, 'music');

    // Naming the holder without asking for the takeover is still a refusal:
    // "exactly one or none" stays the invariant on every write that does not
    // say otherwise.
    assert.throws(
      () => store.updateProfile(second.id, {
        browser_catch_all: true,
        takeOverCatchAllFrom: first.id,
      }),
      /MOVIES already takes grabs/,
    );
    assert.equal(store.findProfileById(first.id).browser_catch_all, true);
    assert.deepEqual(catchAllHolderIds(store), [first.id]);
  } finally {
    store.close();
  }
});

test('only a Putiorr Grab profile can hold the catch-all role', () => {
  const store = new StateStore(':memory:');
  try {
    // /api/grab consults grab profiles and nothing else, so the flag on an
    // *arr profile claims nothing — and must not block the profile that would.
    const arr = seedProfile(store, { browser_catch_all: true });
    assert.equal(store.findCatchAllGrabProfile(), undefined);

    const grab = seedGrabProfile(store, 'movies', { browser_catch_all: true });
    assert.equal(store.findCatchAllGrabProfile().id, grab.id);

    // Switching that *arr profile to the grab preset is the moment its flag
    // starts to mean something, so that is where the collision is caught.
    assert.throws(
      () => store.updateProfile(arr.id, { type: 'grab' }),
      /MOVIES already takes grabs/,
    );
  } finally {
    store.close();
  }
});

test('the same browser site on two grab profiles is refused by naming the holder', () => {
  const store = new StateStore(':memory:');
  try {
    seedGrabProfile(store, 'movies', { browser_domains: ['x.example', '*.z.example'] });

    // A conflict is the same entry twice. Only one of the two can ever answer
    // for it, and which one would come down to creation order — so it is
    // refused, naming the profile the fix is on.
    assert.throws(
      () => seedGrabProfile(store, 'music', { browser_domains: ['x.example'] }),
      /MOVIES already claims x\.example/,
    );
    assert.equal(store.findProfileBySlug('music'), undefined);

    // The wildcard form is an entry in its own right, and duplicates the same way.
    assert.throws(
      () => seedGrabProfile(store, 'music', { browser_domains: ['*.z.example'] }),
      /MOVIES already claims \*\.z\.example/,
    );

    // Normalization happens before the comparison: the same site spelled two
    // ways is still the same site.
    assert.throws(
      () => seedGrabProfile(store, 'music', { browser_domains: ['https://X.Example:8080/dl'] }),
      /MOVIES already claims x\.example/,
    );

    const music = seedGrabProfile(store, 'music', { browser_domains: ['y.example'] });
    assert.throws(
      () => store.updateProfile(music.id, { browser_domains: ['y.example', 'x.example'] }),
      /MOVIES already claims x\.example/,
    );
    assert.deepEqual(store.findProfileById(music.id).browser_domains, ['y.example']);

    // A profile re-saving its own sites is not in conflict with itself, and an
    // update that does not mention them leaves them alone.
    assert.deepEqual(store.updateProfile(music.id, { browser_domains: ['y.example'] }).browser_domains, ['y.example']);
    assert.deepEqual(store.updateProfile(music.id, { name: 'Renamed' }).browser_domains, ['y.example']);
  } finally {
    store.close();
  }
});

test('browser sites that merely overlap are allowed, because precedence resolves them', () => {
  const store = new StateStore(':memory:');
  try {
    // This is the configuration the wildcard rule exists for: one profile takes
    // one host by name, another takes the rest of the domain. Refusing it would
    // refuse the useful case along with the ambiguous one.
    seedGrabProfile(store, 'movies', { browser_domains: ['*.x.example'] });
    const named = seedGrabProfile(store, 'music', { browser_domains: ['dl.x.example'] });
    assert.deepEqual(named.browser_domains, ['dl.x.example']);

    // And a narrower wildcard under a broader one: longest base wins.
    const narrow = seedGrabProfile(store, 'books', { browser_domains: ['*.dl.x.example'] });
    assert.deepEqual(narrow.browser_domains, ['*.dl.x.example']);

    // One profile may hold both forms of the same domain; they are different
    // entries and neither absorbs the other.
    const both = seedGrabProfile(store, 'shows', { browser_domains: ['y.example', '*.y.example'] });
    assert.deepEqual(both.browser_domains, ['y.example', '*.y.example']);
  } finally {
    store.close();
  }
});

test('only Putiorr Grab profiles are checked for a shared browser site', () => {
  const store = new StateStore(':memory:');
  try {
    // browser_domains on an *arr profile is consulted by nothing, so it can
    // neither conflict nor block the grab profile that would answer.
    const arr = seedProfile(store, { browser_domains: ['x.example'] });
    assert.deepEqual(arr.browser_domains, ['x.example']);
    const grab = seedGrabProfile(store, 'movies', { browser_domains: ['x.example'] });
    assert.deepEqual(grab.browser_domains, ['x.example']);

    // Switching that *arr profile to the grab preset is the moment its sites
    // start to route grabs, so that is where the collision is caught.
    assert.throws(
      () => store.updateProfile(arr.id, { type: 'grab' }),
      /MOVIES already claims x\.example/,
    );
  } finally {
    store.close();
  }
});

test('profile browser sites round-trip as a JSON array and default to none', () => {
  const store = new StateStore(':memory:');
  try {
    const withSites = store.createProfile({
      name: 'Browser',
      type: 'custom',
      slug: 'browser',
      putio_folder_name: 'browser',
      downloadAt: '/downloads',
      rpc_path: '/browser/transmission/rpc',
      browser_domains: ['x.example', 'xn--bcher-kva.example'],
    });
    assert.deepEqual(withSites.browser_domains, ['x.example', 'xn--bcher-kva.example']);
    assert.deepEqual(withSites.browserDomains, ['x.example', 'xn--bcher-kva.example']);
    assert.deepEqual(store.findProfileById(withSites.id).browser_domains, ['x.example', 'xn--bcher-kva.example']);

    // A profile written before the column existed reads back as "no sites"
    // rather than null, so callers never have to guard the field.
    const withoutSites = store.createProfile({
      name: 'Plain',
      type: 'custom',
      slug: 'plain',
      putio_folder_name: 'plain',
      downloadAt: '/downloads',
      rpc_path: '/plain/transmission/rpc',
    });
    assert.deepEqual(withoutSites.browser_domains, []);
    assert.deepEqual(withoutSites.browserDomains, []);

    const updated = store.updateProfile(withSites.id, { browser_domains: ['z.example'] });
    assert.deepEqual(updated.browser_domains, ['z.example']);
    assert.deepEqual(store.updateProfile(withSites.id, { browserDomains: [] }).browser_domains, []);

    // An unrelated update must not wipe the sites.
    store.updateProfile(withSites.id, { browser_domains: ['z.example'] });
    assert.deepEqual(store.updateProfile(withSites.id, { name: 'Renamed' }).browser_domains, ['z.example']);
  } finally {
    store.close();
  }
});

test('profile browser sites survive text no JSON parser can read', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = store.createProfile({
      name: 'Browser',
      type: 'custom',
      slug: 'browser',
      putio_folder_name: 'browser',
      downloadAt: '/downloads',
      rpc_path: '/browser/transmission/rpc',
      browser_domains: ['x.example'],
    });

    // Nothing in putiorr writes this, which is exactly why it is worth a test:
    // a hand-edited or half-migrated row must degrade to "no sites" instead of
    // throwing on every profile listing.
    for (const corrupt of ['not json', '{"domains":["x.example"]}', 'null', '["x.example", 5]']) {
      store.db.prepare('UPDATE profiles SET browser_domains = ? WHERE id = ?').run(corrupt, profile.id);
      const expected = corrupt === '["x.example", 5]' ? ['x.example'] : [];
      assert.deepEqual(store.findProfileById(profile.id).browser_domains, expected, corrupt);
    }
  } finally {
    store.close();
  }
});

test('the store normalizes browser sites it is handed directly', () => {
  const store = new StateStore(':memory:');
  try {
    // PUTIORR_PROFILES_JSON seeds profiles through createProfile without going
    // past the API's normalization, so the same comma-separated text the form
    // accepts has to survive here too rather than being stringified whole.
    const seeded = store.createProfile({
      name: 'Seeded',
      type: 'custom',
      slug: 'seeded',
      putio_folder_name: 'seeded',
      downloadAt: '/downloads',
      rpc_path: '/seeded/transmission/rpc',
      browser_domains: 'https://x.example/dl, bücher.example',
    });
    assert.deepEqual(seeded.browser_domains, ['x.example', 'xn--bcher-kva.example']);

    // An entry no hostname can match is dropped rather than stored as a site
    // that would never fire. A leading "*." is not one of those: it is the
    // wildcard form, and it survives the seed with the star kept.
    const wildcard = store.createProfile({
      name: 'Wildcard',
      type: 'custom',
      slug: 'wildcard',
      putio_folder_name: 'wildcard',
      downloadAt: '/downloads',
      rpc_path: '/wildcard/transmission/rpc',
      browser_domains: ['*.x.example', 'dl.*.x.example'],
    });
    assert.deepEqual(wildcard.browser_domains, ['*.x.example']);
    assert.deepEqual(store.updateProfile(seeded.id, { browser_domains: ['dl.*.x.example'] }).browser_domains, []);

    // Normalizing an already normalized list must not change it.
    const normalized = store.updateProfile(seeded.id, { browser_domains: ['x.example', '*.z.example'] });
    assert.deepEqual(normalized.browser_domains, ['x.example', '*.z.example']);
    assert.deepEqual(
      store.updateProfile(seeded.id, { browser_domains: normalized.browser_domains }).browser_domains,
      ['x.example', '*.z.example'],
    );
  } finally {
    store.close();
  }
});

test('profiles written before the browser sites column read as none and stay editable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const dbPath = path.join(root, 'state.db');

  const store = new StateStore(dbPath);
  try {
    store.createProfile({
      name: 'Sonarr',
      type: 'sonarr',
      slug: 'sonarr',
      putio_folder_name: 'putiorr',
      downloadAt: '/downloads',
      rpc_path: '/sonarr/transmission/rpc',
    });
  } finally {
    store.close();
  }

  // Drop the column back off a populated database: that is exactly the shape an
  // upgrade meets, and the migration has to add it without disturbing the rows.
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec('ALTER TABLE profiles DROP COLUMN browser_domains');
  } finally {
    legacy.close();
  }

  const reopened = new StateStore(dbPath);
  try {
    const profile = reopened.findProfileBySlug('sonarr');
    assert.deepEqual(profile.browser_domains, []);
    assert.deepEqual(reopened.updateProfile(profile.id, { browser_domains: ['x.example'] }).browser_domains, ['x.example']);
  } finally {
    reopened.close();
  }
});

test('seeded profiles store their preset in the spelling every comparison uses', async () => {
  // PUTIORR_PROFILES_JSON is written straight into the store without passing
  // through the API that lowercases a preset, so the store has to do it: a
  // profile typed "Grab" would be invisible to ?type=grab and refused for
  // browser grabs with a message telling the user to set the preset it has.
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_PROFILES_JSON: JSON.stringify([
      {
        name: 'Movies Grab',
        type: ' Grab ',
        slug: 'movies-grab',
        putio_folder_name: 'putiorr',
        downloadAt: path.join(root, 'downloads'),
        rpc_path: null,
      },
      {
        name: 'Plain',
        slug: 'plain',
        putio_folder_name: 'putiorr',
        downloadAt: path.join(root, 'downloads'),
        rpc_path: '/plain/rpc',
      },
    ]),
  }, root);
  const store = new StateStore(':memory:');
  try {
    store.seedFromConfig(config);

    assert.equal(store.findProfileBySlug('movies-grab').type, 'grab');
    assert.equal(store.findProfileBySlug('plain').type, 'custom', 'a seed without a preset stays custom');
  } finally {
    store.close();
  }
});

test('the default seeded profile keeps the preset spelling config normalized', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_DEFAULT_PROFILE_TYPE: 'Grab',
  }, root);
  const store = new StateStore(':memory:');
  try {
    store.seedFromConfig(config);

    assert.equal(store.findProfileBySlug('default').type, 'grab');
  } finally {
    store.close();
  }
});

test('updating a profile normalizes the preset the same way creating one does', async () => {
  // Both writes end in the same column, and every comparison against it is
  // exact: a preset normalized on create and stored raw on update would make a
  // profile stop matching the moment it is edited.
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-store-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
  }, root);
  const store = new StateStore(':memory:');
  try {
    store.seedFromConfig(config);
    const profile = store.findProfileBySlug('default');

    assert.equal(store.updateProfile(profile.id, { type: ' Grab ' }).type, 'grab');
    assert.equal(store.updateProfile(profile.id, { type: 'SONARR' }).type, 'sonarr');
    // An update that does not mention the preset leaves it alone.
    assert.equal(store.updateProfile(profile.id, { name: 'Renamed' }).type, 'sonarr');
  } finally {
    store.close();
  }
});

// Phase 2 of the ownership cleanup (#67): the owner is resolved once, at
// ingestion, and frozen. Boot-time reassignment handed every ownerless row to
// whichever profile sorted first, which is a silent change of owner — and the
// filesystem path, the download policy and the put.io folder all follow the
// owner, so the files went somewhere nobody asked for.
//
// Phase 3 makes the state unrepresentable rather than merely unrewritten:
// downloads.profile_id is NOT NULL, so the store refuses the row outright.
test('a download cannot be stored without an owning profile', () => {
  const root = process.cwd();
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
  }, root);
  const store = new StateStore(':memory:');
  try {
    store.seedFromConfig(config);
    assert.throws(
      () => store.upsertDownload({
        putio_transfer_id: 91,
        hash: 'ownerlesshash',
        name: 'Ownerless.Release',
        lifecycle: 'remote',
      }),
      /profile id is required/,
    );

    // And seeding still never rewrites the owner of a download that has one.
    const owner = store.listProfiles()[0];
    const stored = store.upsertDownload({
      profile_id: owner.id,
      putio_transfer_id: 92,
      hash: 'ownedhash',
      name: 'Owned.Release',
    });
    store.seedFromConfig(config);
    assert.equal(store.findDownloadById(stored.id).profile_id, owner.id);
  } finally {
    store.close();
  }
});

// A 2.0.x image started once against a migrated database recreates the legacy
// tables as part of its own schema setup and writes nothing into them — which
// is what a stale `:latest` pull does. They came back empty, so nothing is
// invisible and nothing is lost; reporting that as data loss and pointing the
// user at a pre-upgrade backup would cost them every download since.
test('legacy tables that came back empty are dropped, not reported as data loss', () => {
  const store = new StateStore(':memory:');
  try {
    assert.equal(store.getSetting('downloads_schema_v1'), '1');
    store.db.exec(LEGACY_TABLES_AS_AN_OLDER_PUTIORR_RECREATES_THEM);
    assert.equal(store.hasTable('transfers'), true, 'the reappeared table must exist to begin with');

    store.reclaimEmptyLegacyTables();

    assert.equal(store.hasTable('transfers'), false);
    assert.equal(store.hasTable('transfer_associations'), false);
    assert.equal(store.legacyRowsAfterMigration(), undefined, 'nothing left for the dashboard to warn about');
  } finally {
    store.close();
  }
});

test('legacy tables holding rows are kept and still reported', () => {
  const store = new StateStore(':memory:');
  try {
    store.db.exec(LEGACY_TABLES_AS_AN_OLDER_PUTIORR_RECREATES_THEM);
    store.db.prepare('INSERT INTO transfers (putio_transfer_id, name) VALUES (?, ?)').run(41, 'Written by 2.0.x');

    store.reclaimEmptyLegacyTables();

    assert.equal(store.hasTable('transfers'), true, 'a table with rows is never dropped');
    assert.equal(store.legacyRowsAfterMigration(), 1);
  } finally {
    store.close();
  }
});

// transfers empty while a child still holds rows is not "nothing was written";
// dropping the parent would take the child's rows with it.
test('an empty parent is kept while any legacy table still holds rows', () => {
  const store = new StateStore(':memory:');
  try {
    store.db.exec(LEGACY_TABLES_AS_AN_OLDER_PUTIORR_RECREATES_THEM);
    store.db.prepare('INSERT INTO transfer_associations (transfer_id, profile_id) VALUES (?, ?)').run(1, 1);

    store.reclaimEmptyLegacyTables();

    assert.equal(store.hasTable('transfers'), true);
    assert.equal(store.hasTable('transfer_associations'), true);
  } finally {
    store.close();
  }
});
