import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';

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

test('createOrUpdateTransfer matches later remote updates by put.io id', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const first = store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: 'temporaryhash',
      name: 'Initial Name',
      source_type: 'magnet',
    });

    const second = store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: 'realhashfromputio',
      name: 'Updated Name',
      putio_status: 'DOWNLOADING',
      percent_done: 25,
    });

    assert.equal(second.id, first.id);
    // The row is resolved by put.io id alone; the hash is informational and
    // still write-once. Phase 4 makes it correctable on a later refresh that
    // reports a different one.
    assert.equal(second.hash, 'temporaryhash');
    assert.equal(second.name, 'Updated Name');
    assert.equal(second.putio_status, 'DOWNLOADING');
    assert.equal(second.percent_done, 25);
    assert.equal(store.listActiveTransfers().length, 1);
  } finally {
    store.close();
  }
});

test('createOrUpdateTransfer persists put.io completion_percent across updates', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const created = store.createOrUpdateTransfer({
      profile_id: profile.id,
      putio_transfer_id: 11,
      hash: 'completinghash',
      name: 'Completing Transfer',
      putio_status: 'COMPLETING',
      percent_done: 100,
      completion_percent: 67,
    });
    assert.equal(created.completion_percent, 67);

    const updated = store.createOrUpdateTransfer({
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

test('createOrUpdateTransfer persists put.io status details across updates', () => {
  const store = new StateStore(':memory:');
  try {
    const profile = seedProfile(store);
    const created = store.createOrUpdateTransfer({
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

    const updated = store.createOrUpdateTransfer({
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
    store.createOrUpdateTransfer({
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
    assert.equal(store.findTransferByHash('ABCDEF1234567890ABCDEF1234567890ABCDEF12').id, 1);
    assert.equal(
      store.findTransferById(1).hash,
      'abcdef1234567890abcdef1234567890abcdef12',
    );
    assert.equal(store.findTransferById(1).profile_id, 1);
    // The transfer id, the association id and the download id are all 1: the
    // chain copies the id at every hop so the ids the *arr apps hold survive.
    assert.equal(store.findTransferById(1).id, 1);
    assert.deepEqual(store.listFilesForTransfer(1).map((file) => file.putio_file_id), [789]);
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
    // that would never fire.
    const wildcard = store.createProfile({
      name: 'Wildcard',
      type: 'custom',
      slug: 'wildcard',
      putio_folder_name: 'wildcard',
      downloadAt: '/downloads',
      rpc_path: '/wildcard/transmission/rpc',
      browser_domains: ['*.x.example'],
    });
    assert.deepEqual(wildcard.browser_domains, []);
    assert.deepEqual(store.updateProfile(seeded.id, { browser_domains: ['*.x.example'] }).browser_domains, []);

    // Normalizing an already normalized list must not change it.
    const normalized = store.updateProfile(seeded.id, { browser_domains: ['x.example', 'z.example'] });
    assert.deepEqual(normalized.browser_domains, ['x.example', 'z.example']);
    assert.deepEqual(
      store.updateProfile(seeded.id, { browser_domains: normalized.browser_domains }).browser_domains,
      ['x.example', 'z.example'],
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
        rpc_path: '/grab/movies-grab/rpc',
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
      () => store.createOrUpdateTransfer({
        putio_transfer_id: 91,
        hash: 'ownerlesshash',
        name: 'Ownerless.Release',
        lifecycle: 'remote',
      }),
      /profile id is required/,
    );

    // And seeding still never rewrites the owner of a download that has one.
    const owner = store.listProfiles()[0];
    const stored = store.createOrUpdateTransfer({
      profile_id: owner.id,
      putio_transfer_id: 92,
      hash: 'ownedhash',
      name: 'Owned.Release',
    });
    store.seedFromConfig(config);
    assert.equal(store.findTransferById(stored.id).profile_id, owner.id);
  } finally {
    store.close();
  }
});
