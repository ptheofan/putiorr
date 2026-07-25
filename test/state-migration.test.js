import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state/store.js';

// The schema migrations rewrite a live user's database in place, so every
// fixture here is a real on-disk database written the way an older putiorr
// would have left it — never a StateStore with rows deleted afterwards. The
// shapes come from the migration history in src/state/store.js:
//
//   'pre-association'  transfers + transfer_files, before transfer_associations
//                      existed and before the ensureColumn top-ups.
//   'association'      transfers + transfer_associations + association_files,
//                      the shape 2.0.x ships.

const SETTINGS_DDL = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const DOWNLOAD_PROFILES_DDL = `
  CREATE TABLE download_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    slow_speed_threshold_bytes_per_second INTEGER NOT NULL DEFAULT 0,
    slow_speed_duration_seconds INTEGER NOT NULL DEFAULT 120,
    slow_speed_grace_seconds INTEGER NOT NULL DEFAULT 30,
    slow_speed_min_size_bytes INTEGER NOT NULL DEFAULT 104857600,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const PROFILES_PRE_ASSOCIATION_DDL = `
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
`;

const PROFILES_ASSOCIATION_DDL = `
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'custom',
    slug TEXT NOT NULL UNIQUE,
    download_profile_id INTEGER REFERENCES download_profiles(id) ON DELETE SET NULL,
    auto_remove_completed INTEGER NOT NULL DEFAULT 0,
    putio_folder_name TEXT NOT NULL,
    putio_folder_id INTEGER,
    download_at TEXT NOT NULL,
    rpc_path TEXT NOT NULL UNIQUE,
    client_host TEXT NOT NULL DEFAULT 'putiorr',
    client_port TEXT NOT NULL DEFAULT '9091',
    client_use_ssl INTEGER NOT NULL DEFAULT 0,
    browser_domains TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const TRANSFERS_PRE_ASSOCIATION_DDL = `
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
`;

const TRANSFERS_ASSOCIATION_DDL = `
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
    putio_status_message TEXT NOT NULL DEFAULT '',
    putio_peers INTEGER NOT NULL DEFAULT 0,
    putio_availability INTEGER NOT NULL DEFAULT 0,
    percent_done INTEGER NOT NULL DEFAULT 0,
    completion_percent INTEGER NOT NULL DEFAULT 0,
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
`;

const TRANSFER_FILES_DDL = `
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
`;

const TRANSFER_ASSOCIATIONS_DDL = `
  CREATE TABLE transfer_associations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
    profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    category TEXT NOT NULL DEFAULT '',
    download_dir TEXT NOT NULL DEFAULT '',
    lifecycle TEXT NOT NULL DEFAULT 'remote',
    total_size INTEGER,
    downloaded_ever INTEGER NOT NULL DEFAULT 0,
    download_speed INTEGER NOT NULL DEFAULT 0,
    eta INTEGER NOT NULL DEFAULT -1,
    error INTEGER NOT NULL DEFAULT 0,
    error_string TEXT NOT NULL DEFAULT '',
    retry_count INTEGER NOT NULL DEFAULT 0,
    removed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(transfer_id, profile_id)
  );

  CREATE TABLE association_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id INTEGER NOT NULL REFERENCES transfer_associations(id) ON DELETE CASCADE,
    putio_file_id INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    download_speed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error_string TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(transfer_id, putio_file_id)
  );
`;

export async function tempDbPath(name = 'state.sqlite') {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-migration-'));
  return path.join(root, name);
}

function insertRows(db, table, rows) {
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...keys.map((key) => row[key]));
  }
}

// One helper so a fixture is a description of the rows it cares about rather
// than sixty lines of CREATE TABLE. Anything not named gets the era's default
// shape, which is the point: a fixture should read as the difference from a
// plain upgrade.
export function writeLegacyDb(dbPath, {
  era = 'association',
  downloadProfiles = [],
  profiles = [],
  transfers = [],
  transferFiles = [],
  associations = [],
  associationFiles = [],
  settings = {},
  includeDownloadProfiles = true,
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(SETTINGS_DDL);
    if (includeDownloadProfiles) db.exec(DOWNLOAD_PROFILES_DDL);
    db.exec(era === 'association' ? PROFILES_ASSOCIATION_DDL : PROFILES_PRE_ASSOCIATION_DDL);
    db.exec(era === 'association' ? TRANSFERS_ASSOCIATION_DDL : TRANSFERS_PRE_ASSOCIATION_DDL);
    db.exec(TRANSFER_FILES_DDL);
    if (era === 'association') db.exec(TRANSFER_ASSOCIATIONS_DDL);

    if (includeDownloadProfiles) insertRows(db, 'download_profiles', downloadProfiles);
    insertRows(db, 'profiles', profiles);
    insertRows(db, 'transfers', transfers);
    insertRows(db, 'transfer_files', transferFiles);
    if (era === 'association') {
      insertRows(db, 'transfer_associations', associations);
      insertRows(db, 'association_files', associationFiles);
    }

    const allSettings = era === 'association'
      ? { transfer_associations_migrated_v1: '1', ...settings }
      : settings;
    for (const [key, value] of Object.entries(allSettings)) {
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, String(value), 'now');
    }
  } finally {
    db.close();
  }
  return dbPath;
}

export function tableNames(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

export function profileRow(overrides = {}) {
  return {
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    putio_folder_id: 42,
    download_at: '/downloads',
    rpc_path: '/sonarr/transmission/rpc',
    enabled: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function transferRow(overrides = {}) {
  return {
    id: 1,
    profile_id: 1,
    putio_transfer_id: 1001,
    putio_file_id: 2001,
    save_parent_id: 42,
    hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Example.Release',
    source: '',
    source_type: 'magnet',
    category: 'tv',
    download_dir: '/downloads/tv',
    lifecycle: 'remote',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 500,
    downloaded_ever: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function associationRow(overrides = {}) {
  return {
    id: 1,
    transfer_id: 1,
    profile_id: 1,
    category: 'tv',
    download_dir: '/downloads/tv',
    lifecycle: 'downloading',
    total_size: 500,
    downloaded_ever: 250,
    download_speed: 10,
    eta: 25,
    error: 0,
    error_string: '',
    retry_count: 0,
    removed_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function associationFileRow(overrides = {}) {
  return {
    id: 1,
    transfer_id: 1,
    putio_file_id: 3001,
    relative_path: 'Episode.mkv',
    size: 500,
    downloaded_bytes: 250,
    download_speed: 10,
    status: 'pending',
    attempts: 0,
    error_string: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// F1
test('a fresh database gets the current schema and no legacy tables', async () => {
  const dbPath = await tempDbPath();
  const store = new StateStore(dbPath);
  try {
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally {
    store.close();
  }

  const tables = tableNames(dbPath);
  assert.ok(tables.includes('profiles'));
  assert.ok(tables.includes('download_profiles'));
  assert.ok(tables.includes('settings'));
});

// F2
test('an association-era database keeps every association id as the download id', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'association',
    downloadProfiles: [{
      id: 1,
      name: 'Default',
      slug: 'default',
      created_at: 'now',
      updated_at: 'now',
    }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 7, putio_transfer_id: 1007 })],
    associations: [associationRow({ id: 7, transfer_id: 7 })],
    associationFiles: [associationFileRow({ id: 11, transfer_id: 7 })],
  });

  const store = new StateStore(dbPath);
  try {
    const row = store.findTransferById(7);
    assert.equal(row.id, 7);
    assert.equal(row.putio_transfer_id, 1007);
    assert.equal(row.profile_id, 1);
    assert.equal(row.category, 'tv');
    assert.equal(row.lifecycle, 'downloading');
    assert.equal(row.total_size, 500);
    assert.equal(row.downloaded_ever, 250);
    assert.deepEqual(store.listFilesForTransfer(7).map((file) => file.id), [11]);
  } finally {
    store.close();
  }
});
