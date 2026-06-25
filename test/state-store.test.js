import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';

test('createOrUpdateTransfer matches later remote updates by put.io id', () => {
  const store = new StateStore(':memory:');
  try {
    const first = store.createOrUpdateTransfer({
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: 'temporaryhash',
      name: 'Initial Name',
      source_type: 'magnet',
    });

    const second = store.createOrUpdateTransfer({
      putio_transfer_id: 10,
      putio_file_id: 20,
      hash: 'realhashfromputio',
      name: 'Updated Name',
      putio_status: 'DOWNLOADING',
      percent_done: 25,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.hash, 'temporaryhash');
    assert.equal(second.name, 'Updated Name');
    assert.equal(second.putio_status, 'DOWNLOADING');
    assert.equal(second.percent_done, 25);
    assert.equal(store.listActiveTransfers().length, 1);
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
    assert.equal(Object.hasOwn(profile, 'local_path'), false);
  } finally {
    store.close();
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
      INSERT INTO transfers (
        putio_transfer_id, putio_file_id, hash, name, source,
        source_type, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      123,
      456,
      'putiohash',
      'Example.Release',
      'magnet:?xt=urn:btih:ABCDEF1234567890ABCDEF1234567890ABCDEF12&dn=Example.Release',
      'magnet',
      'now',
      'now',
    );
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
  } finally {
    store.close();
  }
});
