import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir } from 'node:fs/promises';
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


function collapseReport(store) {
  return JSON.parse(store.getSetting('downloads_schema_v1_report'));
}

function allRows(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

// F1
test('a fresh database gets only the collapsed schema', async () => {
  const dbPath = await tempDbPath();
  const store = new StateStore(dbPath);
  try {
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(store.getSetting('downloads_schema_v1'), '1');
    // A fresh database has nothing to collapse, so it records no report.
    assert.equal(store.getSetting('downloads_schema_v1_report'), undefined);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);

    const downloadColumns = store.getColumns('downloads');
    const byName = new Map(downloadColumns.map((column) => [column.name, column]));
    assert.equal(byName.get('profile_id').notnull, 1);
    assert.equal(byName.get('putio_transfer_id').notnull, 1);
    assert.equal(byName.has('download_dir'), false);
    assert.equal(byName.has('remote_id'), false);
    assert.ok(store.getColumns('download_files').some((column) => column.name === 'download_id'));
  } finally {
    store.close();
  }

  const tables = tableNames(dbPath);
  for (const legacy of ['transfers', 'transfer_files', 'transfer_associations', 'association_files']) {
    assert.equal(tables.includes(legacy), false, `${legacy} should never be created`);
  }
  assert.ok(tables.includes('downloads'));
  assert.ok(tables.includes('download_files'));
  assert.ok(tables.includes('orphaned_downloads'));
});

// F2
test('an association-era database collapses keeping every id and column', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'association',
    downloadProfiles: [{
      id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now',
    }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [
      transferRow({ id: 7, putio_transfer_id: 1007, total_size: 900, uploaded_ever: 12, upload_speed: 3 }),
      transferRow({
        id: 8,
        putio_transfer_id: 1008,
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        name: 'Second.Release',
        total_size: 700,
      }),
    ],
    associations: [
      associationRow({ id: 7, transfer_id: 7, total_size: 500 }),
      // A null association total_size falls back to the transfer's.
      associationRow({ id: 8, transfer_id: 8, total_size: null, category: 'movies' }),
    ],
    associationFiles: [associationFileRow({ id: 11, transfer_id: 7 })],
  });

  const store = new StateStore(dbPath);
  try {
    const first = store.findTransferById(7);
    assert.equal(first.id, 7);
    assert.equal(first.putio_transfer_id, 1007);
    assert.equal(first.profile_id, 1);
    assert.equal(first.hash, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(first.name, 'Example.Release');
    assert.equal(first.category, 'tv');
    assert.equal(first.lifecycle, 'downloading');
    assert.equal(first.putio_status, 'COMPLETED');
    assert.equal(first.total_size, 500);
    assert.equal(first.downloaded_ever, 250);
    assert.equal(first.uploaded_ever, 12);
    assert.equal(first.upload_speed, 3);
    assert.equal(first.eta, 25);
    assert.equal(first.created_at, '2026-01-01T00:00:00.000Z');
    assert.equal(store.findTransferById(8).total_size, 700);

    const files = store.listFilesForTransfer(7);
    assert.deepEqual(files.map((file) => file.id), [11]);
    assert.equal(files[0].download_id, 7);
    assert.equal(files[0].downloaded_bytes, 250);

    const report = collapseReport(store);
    assert.equal(report.migrated, 2);
    assert.equal(report.adoptedBySoleProfile, 0);
    assert.deepEqual(report.extraAssociations, []);
    assert.deepEqual(report.noPutioId, []);
    assert.deepEqual(report.ownerless, []);
    assert.equal(report.droppedFiles, 0);
  } finally {
    store.close();
  }

  const tables = tableNames(dbPath);
  for (const legacy of ['transfers', 'transfer_files', 'transfer_associations', 'association_files']) {
    assert.equal(tables.includes(legacy), false, `${legacy} should have been dropped`);
  }
});

// F2b — a new download's id cannot collide with one an *arr is still holding.
test('the collapse leaves AUTOINCREMENT above the highest migrated id', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 17, putio_transfer_id: 1017 })],
    associations: [associationRow({ id: 17, transfer_id: 17 })],
  });

  const store = new StateStore(dbPath);
  try {
    const created = store.createOrUpdateTransfer({
      profile_id: 1,
      putio_transfer_id: 2000,
      hash: 'cccccccccccccccccccccccccccccccccccccccc',
      name: 'Fresh.Release',
    });
    assert.equal(created.id, 18);
  } finally {
    store.close();
  }
});

// F3 — the chain: a pre-association database runs the association migration and
// then the collapse in one boot, and the ids survive both hops.
test('a pre-association database migrates through associations into downloads', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    profiles: [profileRow({ id: 1 })],
    transfers: [
      transferRow({
        id: 5,
        profile_id: 1,
        putio_transfer_id: 1005,
        lifecycle: 'downloading',
        downloaded_ever: 120,
      }),
      // No owner, but there is exactly one profile in the database — which is
      // determinism, not inference.
      transferRow({
        id: 6,
        profile_id: null,
        putio_transfer_id: 1006,
        hash: 'dddddddddddddddddddddddddddddddddddddddd',
        name: 'Adopted.Release',
      }),
    ],
    transferFiles: [{
      id: 9,
      transfer_id: 5,
      putio_file_id: 3005,
      relative_path: 'Episode.mkv',
      size: 500,
      downloaded_bytes: 120,
      status: 'pending',
      attempts: 0,
      error_string: '',
      created_at: 'now',
      updated_at: 'now',
    }],
  });

  const store = new StateStore(dbPath);
  try {
    const row = store.findTransferById(5);
    assert.equal(row.id, 5);
    assert.equal(row.putio_transfer_id, 1005);
    assert.equal(row.profile_id, 1);
    assert.equal(row.lifecycle, 'downloading');
    assert.deepEqual(store.listFilesForTransfer(5).map((file) => file.id), [9]);

    assert.equal(store.findTransferById(6).profile_id, 1);
    const report = collapseReport(store);
    assert.equal(report.migrated, 2);
    assert.equal(report.adoptedBySoleProfile, 1);
  } finally {
    store.close();
  }
});

// F4
test('only the oldest association of a put.io transfer becomes the download', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [
      profileRow({ id: 1, download_profile_id: 1 }),
      profileRow({
        id: 2,
        name: 'Radarr',
        slug: 'radarr',
        rpc_path: '/radarr/transmission/rpc',
        download_at: '/movies',
        download_profile_id: 1,
      }),
    ],
    transfers: [transferRow({ id: 4, putio_transfer_id: 1004 })],
    associations: [
      associationRow({ id: 4, transfer_id: 4, profile_id: 1, created_at: '2026-01-01T00:00:00.000Z' }),
      associationRow({
        id: 5,
        transfer_id: 4,
        profile_id: 2,
        category: 'films',
        created_at: '2026-02-01T00:00:00.000Z',
      }),
    ],
    associationFiles: [
      associationFileRow({ id: 20, transfer_id: 4 }),
      associationFileRow({ id: 21, transfer_id: 5, putio_file_id: 3002 }),
    ],
  });

  const store = new StateStore(dbPath);
  try {
    assert.equal(store.findTransferById(4).profile_id, 1);
    assert.equal(store.findTransferById(5), undefined);
    assert.deepEqual(store.listFilesForTransfer(4).map((file) => file.id), [20]);
    assert.equal(
      allRows(dbPath, 'SELECT id FROM download_files').some((row) => row.id === 21),
      false,
    );

    const report = collapseReport(store);
    assert.equal(report.migrated, 1);
    assert.equal(report.droppedFiles, 1);
    assert.equal(report.extraAssociations.length, 1);
    assert.equal(report.extraAssociations[0].associationId, 5);
    assert.equal(report.extraAssociations[0].profileName, 'Radarr');
    assert.equal(report.extraAssociations[0].localPath, path.join('/movies', 'films', 'Example.Release'));
    assert.equal(report.extraAssociations[0].fileCount, 1);

    const quarantined = store.db.prepare('SELECT * FROM orphaned_downloads').all();
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].reason, 'extra association');
    assert.equal(quarantined[0].putio_transfer_id, 1004);
    assert.equal(quarantined[0].legacy_download_dir, path.join('/movies', 'films', 'Example.Release'));
  } finally {
    store.close();
  }
});

// F5
test('a transfer with no put.io id is quarantined and the unique index survives', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 3, putio_transfer_id: null })],
    associations: [associationRow({ id: 3, transfer_id: 3 })],
    associationFiles: [associationFileRow({ id: 30, transfer_id: 3 })],
  });

  const store = new StateStore(dbPath);
  try {
    assert.equal(store.listActiveTransfers().length, 0);
    const report = collapseReport(store);
    assert.equal(report.migrated, 0);
    assert.equal(report.noPutioId.length, 1);
    assert.equal(report.noPutioId[0].associationId, 3);
    assert.equal(report.noPutioId[0].profileName, 'Sonarr');
    assert.equal(report.droppedFiles, 1);

    const quarantined = store.db.prepare('SELECT * FROM orphaned_downloads').all();
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].reason, 'no put.io transfer id');
    assert.equal(quarantined[0].putio_transfer_id, null);

    store.createOrUpdateTransfer({
      profile_id: 1, putio_transfer_id: 55, hash: 'e'.repeat(40), name: 'One',
    });
    assert.throws(
      () => store.db.prepare(`
        INSERT INTO downloads (profile_id, putio_transfer_id, name, created_at, updated_at)
        VALUES (1, 55, 'Duplicate', 'now', 'now')
      `).run(),
      /UNIQUE constraint failed: downloads.putio_transfer_id/,
    );
  } finally {
    store.close();
  }
});

// F7 — the direct regression test for the deleted COALESCE.
test('an ownerless transfer in a multi-profile database is quarantined, not adopted', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    profiles: [
      profileRow({ id: 1, slug: 'default', name: 'Default', rpc_path: '/transmission/rpc' }),
      profileRow({ id: 2, slug: 'radarr', name: 'Radarr', rpc_path: '/radarr/transmission/rpc' }),
    ],
    transfers: [transferRow({ id: 3, profile_id: null, putio_transfer_id: 1003 })],
  });

  const store = new StateStore(dbPath);
  try {
    assert.equal(store.listActiveTransfers().length, 0);
    const report = collapseReport(store);
    assert.equal(report.adoptedBySoleProfile, 0);
    assert.equal(report.ownerless.length, 1);
    assert.equal(report.ownerless[0].putioTransferId, 1003);

    const quarantined = store.db.prepare('SELECT * FROM orphaned_downloads').all();
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].reason, 'no owner');
    assert.equal(quarantined[0].name, 'Example.Release');
  } finally {
    store.close();
  }
});

// F8
test('the collapse is idempotent and does not back up again on the second boot', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 2, putio_transfer_id: 1002 })],
    associations: [associationRow({ id: 2, transfer_id: 2 })],
  });

  const first = new StateStore(dbPath);
  const firstReport = first.getSetting('downloads_schema_v1_report');
  first.close();
  const backupsAfterFirst = (await readdir(path.dirname(dbPath)))
    .filter((name) => name.includes('.pre-downloads-'));

  const second = new StateStore(dbPath);
  try {
    assert.equal(second.getSetting('downloads_schema_v1_report'), firstReport);
    assert.equal(second.findTransferById(2).id, 2);
  } finally {
    second.close();
  }
  const backupsAfterSecond = (await readdir(path.dirname(dbPath)))
    .filter((name) => name.includes('.pre-downloads-'));
  assert.equal(backupsAfterFirst.length, 1);
  assert.deepEqual(backupsAfterSecond, backupsAfterFirst);
});

// F9 — a half-migrated database must be impossible.
test('a failure during the collapse rolls the whole database back', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 2, putio_transfer_id: 1002 })],
    associations: [associationRow({ id: 2, transfer_id: 2 })],
    associationFiles: [associationFileRow({ id: 40, transfer_id: 2 })],
  });

  class ExplodingStore extends StateStore {
    collapseTransfersIntoDownloads() {
      const report = super.collapseTransfersIntoDownloads();
      throw new Error(`boom after migrating ${report.migrated}`);
    }
  }

  assert.throws(() => new ExplodingStore(dbPath), /boom after migrating 1/);

  const tables = tableNames(dbPath);
  assert.ok(tables.includes('transfers'));
  assert.ok(tables.includes('transfer_associations'));
  assert.ok(tables.includes('association_files'));
  assert.equal(allRows(dbPath, 'SELECT id FROM transfer_associations').length, 1);
  assert.equal(allRows(dbPath, 'SELECT id FROM association_files').length, 1);
  assert.equal(allRows(dbPath, 'SELECT id FROM downloads').length, 0);
  assert.equal(
    allRows(dbPath, "SELECT value FROM settings WHERE key = 'downloads_schema_v1'").length,
    0,
  );

  // The next boot finishes the job.
  const store = new StateStore(dbPath);
  try {
    assert.equal(store.findTransferById(2).id, 2);
    assert.equal(store.getSetting('downloads_schema_v1'), '1');
  } finally {
    store.close();
  }
});

// F11
test('the collapse backs the database up first, and never for :memory:', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 2, putio_transfer_id: 1002 })],
    associations: [associationRow({ id: 2, transfer_id: 2 })],
  });

  const store = new StateStore(dbPath);
  store.close();

  const backups = (await readdir(path.dirname(dbPath)))
    .filter((name) => name.includes('.pre-downloads-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(path.join(path.dirname(dbPath), backups[0]));
  try {
    assert.equal(backup.prepare('SELECT COUNT(*) AS total FROM transfer_associations').get().total, 1);
  } finally {
    backup.close();
  }

  const memory = new StateStore(':memory:');
  try {
    assert.equal(memory.backupBeforeCollapse(), undefined);
  } finally {
    memory.close();
  }
});
