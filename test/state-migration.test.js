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
  // Every released schema has UNIQUE on transfers.putio_transfer_id, so a
  // duplicate can only reach the collapse from a database somebody rebuilt or
  // half-restored by hand. Dropping it here is how that shape gets written.
  transfersUnique = true,
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(SETTINGS_DDL);
    if (includeDownloadProfiles) db.exec(DOWNLOAD_PROFILES_DDL);
    db.exec(era === 'association' ? PROFILES_ASSOCIATION_DDL : PROFILES_PRE_ASSOCIATION_DDL);
    const transfersDdl = era === 'association' ? TRANSFERS_ASSOCIATION_DDL : TRANSFERS_PRE_ASSOCIATION_DDL;
    db.exec(transfersUnique
      ? transfersDdl
      : transfersDdl.replace('putio_transfer_id INTEGER UNIQUE', 'putio_transfer_id INTEGER'));
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
    const first = store.findDownloadById(7);
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
    assert.equal(store.findDownloadById(8).total_size, 700);

    const files = store.listFilesForDownload(7);
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
    const created = store.upsertDownload({
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
    const row = store.findDownloadById(5);
    assert.equal(row.id, 5);
    assert.equal(row.putio_transfer_id, 1005);
    assert.equal(row.profile_id, 1);
    assert.equal(row.lifecycle, 'downloading');
    assert.deepEqual(store.listFilesForDownload(5).map((file) => file.id), [9]);

    assert.equal(store.findDownloadById(6).profile_id, 1);
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
    assert.equal(store.findDownloadById(4).profile_id, 1);
    assert.equal(store.findDownloadById(5), undefined);
    assert.deepEqual(store.listFilesForDownload(4).map((file) => file.id), [20]);
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
    assert.equal(store.listActiveDownloads().length, 0);
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

    store.upsertDownload({
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
    assert.equal(store.listActiveDownloads().length, 0);
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
    assert.equal(second.findDownloadById(2).id, 2);
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
    assert.equal(store.findDownloadById(2).id, 2);
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

// F6a
test('profiles with no download profile are assigned the existing default', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 3, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [
      profileRow({ id: 1, download_profile_id: null }),
      profileRow({ id: 2, slug: 'radarr', name: 'Radarr', rpc_path: '/radarr/rpc', download_profile_id: 3 }),
    ],
  });

  const store = new StateStore(dbPath);
  try {
    assert.equal(store.findProfileById(1).download_profile_id, 3);
    assert.equal(store.findProfileById(2).download_profile_id, 3);
    const columns = new Map(store.getColumns('profiles').map((column) => [column.name, column]));
    assert.equal(columns.get('download_profile_id').notnull, 1);
    assert.equal(columns.get('rpc_path').notnull, 0);
    assert.equal(store.getSetting('profiles_schema_v2'), '1');
    assert.equal(JSON.parse(store.getSetting('profiles_schema_v2_report')).downloadProfilesAssigned, 1);
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);

    // ON DELETE RESTRICT: a download profile in use cannot be deleted.
    assert.throws(
      () => store.db.prepare('DELETE FROM download_profiles WHERE id = 3').run(),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    store.close();
  }
});

// F6b
test('a database predating download_profiles gets one created for it', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    includeDownloadProfiles: false,
    profiles: [profileRow({ id: 1 })],
  });

  const store = new StateStore(dbPath);
  try {
    const [downloadProfile] = store.listDownloadProfiles();
    assert.equal(downloadProfile.slug, 'default');
    assert.equal(store.findProfileById(1).download_profile_id, downloadProfile.id);
    assert.equal(
      new Map(store.getColumns('profiles').map((c) => [c.name, c])).get('download_profile_id').notnull,
      1,
    );
  } finally {
    store.close();
  }
});

// F10
test('grab profiles lose the RPC path they only held to satisfy NOT NULL UNIQUE', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [
      profileRow({ id: 1, download_profile_id: 1 }),
      profileRow({
        id: 2, slug: 'grab-a', name: 'Grab A', type: 'grab', rpc_path: '/grab/grab-a/rpc', download_profile_id: 1,
      }),
      profileRow({
        id: 3, slug: 'grab-b', name: 'Grab B', type: 'grab', rpc_path: '/grab/grab-b/rpc', download_profile_id: 1,
      }),
    ],
  });

  const store = new StateStore(dbPath);
  try {
    assert.equal(store.findProfileBySlug('grab-a').rpc_path, null);
    assert.equal(store.findProfileBySlug('grab-b').rpc_path, null);
    assert.equal(store.findProfileBySlug('sonarr').rpc_path, '/sonarr/transmission/rpc');
    assert.equal(JSON.parse(store.getSetting('profiles_schema_v2_report')).grabRpcPathsCleared, 2);

    // The partial unique index still refuses a duplicate *arr path...
    assert.throws(
      () => store.createProfile({
        name: 'Clash',
        slug: 'clash',
        putio_folder_name: 'clash',
        downloadAt: '/downloads',
        rpc_path: '/sonarr/transmission/rpc',
      }),
      /UNIQUE constraint failed: profiles.rpc_path/,
    );
    // ...and lets any number of profiles hold no path at all.
    const third = store.createProfile({
      name: 'Grab C',
      type: 'grab',
      slug: 'grab-c',
      putio_folder_name: 'grabc',
      downloadAt: '/downloads',
      rpc_path: null,
    });
    assert.equal(third.rpc_path, null);
  } finally {
    store.close();
  }
});

// R6 — ON DELETE RESTRICT inverts the delete-then-reassign order the endpoint used.
test('deleting a download profile in use reassigns the profiles that reference it', async () => {
  const store = new StateStore(':memory:');
  try {
    const fallback = store.createDownloadProfile({ name: 'Default', slug: 'default' });
    const fast = store.createDownloadProfile({ name: 'Fast', slug: 'fast' });
    const profile = store.createProfile({
      name: 'Sonarr',
      slug: 'sonarr',
      putio_folder_name: 'putiorr',
      downloadAt: '/downloads',
      rpc_path: '/sonarr/transmission/rpc',
      download_profile_id: fast.id,
    });

    assert.throws(() => store.deleteDownloadProfile(fast.id), /FOREIGN KEY constraint failed/);

    store.deleteDownloadProfile(fast.id, { reassignTo: fallback.id });
    assert.equal(store.findDownloadProfileById(fast.id), undefined);
    assert.equal(store.findProfileById(profile.id).download_profile_id, fallback.id);
  } finally {
    store.close();
  }
});

// The owner's ruling: an ownerless legacy row is quarantined for the user to
// reassign from the dashboard, not dropped. This is that repair path — it never
// runs automatically, so rule 4 (the owner is frozen at creation) is untouched
// for every download that has one.
test('a quarantined download can be reassigned to a profile', async () => {
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
    const [orphan] = store.listOrphanedDownloads();
    assert.equal(orphan.reason, 'no owner');

    const created = store.assignOrphanedDownload(orphan.id, 2);
    assert.equal(created.profile_id, 2);
    assert.equal(created.putio_transfer_id, 1003);
    assert.equal(created.name, 'Example.Release');
    // Back to 'remote' so the poll re-prepares it from put.io: the quarantine
    // carries no file rows, and re-preparing is what repairs a drifted list.
    assert.equal(created.lifecycle, 'remote');
    assert.deepEqual(store.listOrphanedDownloads(), []);
  } finally {
    store.close();
  }
});

test('a quarantined download with no identity or a claimed one cannot be reassigned', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [
      profileRow({ id: 1, download_profile_id: 1 }),
      profileRow({
        id: 2, slug: 'radarr', name: 'Radarr', rpc_path: '/radarr/rpc', download_profile_id: 1,
      }),
    ],
    transfers: [
      transferRow({ id: 3, putio_transfer_id: null }),
      transferRow({
        id: 4, putio_transfer_id: 1004, hash: 'f'.repeat(40), name: 'Claimed.Release',
      }),
    ],
    associations: [
      associationRow({ id: 3, transfer_id: 3 }),
      associationRow({ id: 4, transfer_id: 4, profile_id: 1, created_at: '2026-01-01T00:00:00.000Z' }),
      associationRow({ id: 5, transfer_id: 4, profile_id: 2, created_at: '2026-02-01T00:00:00.000Z' }),
    ],
  });

  const store = new StateStore(dbPath);
  try {
    const byReason = new Map(store.listOrphanedDownloads().map((row) => [row.reason, row]));

    // Rule 3: no put.io transfer id, no identity to reattach.
    assert.throws(
      () => store.assignOrphanedDownload(byReason.get('no put.io transfer id').id, 1),
      /cannot be reassigned; delete it instead/,
    );
    // Rule 3 again from the other side: the transfer is already a download.
    assert.throws(
      () => store.assignOrphanedDownload(byReason.get('extra association').id, 2),
      /already belongs to RR profile Sonarr; delete this entry instead/,
    );
    assert.equal(store.listOrphanedDownloads().length, 2);

    store.deleteOrphanedDownload(byReason.get('extra association').id);
    assert.equal(store.listOrphanedDownloads().length, 1);
  } finally {
    store.close();
  }
});

// R8 — the migration is one-way. Rolling back to 2.0.x recreates `transfers`
// and writes into it, and those rows are invisible to every later version.
test('reappearing legacy tables are reported after the migration has run', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 2, putio_transfer_id: 1002 })],
    associations: [associationRow({ id: 2, transfer_id: 2 })],
  });

  const first = new StateStore(dbPath);
  const reports = first.schemaMigrationReports();
  assert.equal(reports.downloads.migrated, 1);
  assert.equal(reports.profiles.version, 2);
  first.close();

  // An older putiorr booting against the migrated database.
  const downgraded = new DatabaseSync(dbPath);
  downgraded.exec('CREATE TABLE transfers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
  downgraded.close();

  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);
  let store;
  try {
    store = new StateStore(dbPath);
  } finally {
    console.log = originalLog;
  }
  try {
    const warned = logs.map((line) => JSON.parse(line))
      .find((entry) => entry.message === 'legacy transfer tables reappeared after the downloads schema migration');
    assert.ok(warned, 'the downgrade has to be loud: zero rows in a table nobody reads is a legal answer');
    assert.match(warned.meta.fix, /pre-downloads-\*\.bak/);
    // And it does not re-run the collapse against the decoy.
    assert.equal(store.findDownloadById(2).id, 2);
  } finally {
    store.close();
  }
});

// The store half of the same finding: a poll-adopted transfer never had a
// download-dir, so an ownerless one used to quarantine with its bare name as
// the "local path". Nothing may record a relative path.
test('a quarantined row never records a relative local path', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    profiles: [
      profileRow({ id: 1, slug: 'default', name: 'Default', rpc_path: '/transmission/rpc' }),
      profileRow({ id: 2, slug: 'radarr', name: 'Radarr', rpc_path: '/radarr/transmission/rpc' }),
    ],
    transfers: [
      // Adopted from the put.io poll: an owner it later lost, and no
      // download_dir, because nothing ever asked it for one.
      transferRow({ id: 3, profile_id: null, putio_transfer_id: 1003, category: '', download_dir: '' }),
      transferRow({
        id: 4,
        profile_id: null,
        putio_transfer_id: 1004,
        hash: 'e'.repeat(40),
        name: 'Relative.Release',
        category: '',
        download_dir: 'relative/fragment',
      }),
    ],
  });

  const store = new StateStore(dbPath);
  try {
    const quarantined = store.listOrphanedDownloads();
    assert.equal(quarantined.length, 2);
    for (const row of quarantined) {
      assert.equal(row.legacy_download_dir, '', `${row.name} recorded ${row.legacy_download_dir}`);
    }
    for (const entry of collapseReport(store).ownerless) {
      assert.equal(entry.localPath, '');
    }
  } finally {
    store.close();
  }
});

// Risk R4: an *arr stores the id torrent-add returned and polls torrent-get
// with it forever. The collapse copies that id into downloads verbatim; a
// quarantined row has to carry it too, or reassigning the row hands the *arr's
// queue item a new id and its torrent-get stays empty forever — which is
// exactly the outcome the quarantine exists to avoid. R4 only accepted losing
// an id for rows that are dropped, and under the owner's ruling none are.
test('reassignment restores the Transmission id the *arr apps still hold', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    profiles: [
      profileRow({ id: 1, slug: 'default', name: 'Default', rpc_path: '/transmission/rpc' }),
      profileRow({ id: 2, slug: 'radarr', name: 'Radarr', rpc_path: '/radarr/transmission/rpc' }),
    ],
    transfers: [transferRow({ id: 31, profile_id: null, putio_transfer_id: 1031 })],
  });

  const store = new StateStore(dbPath);
  try {
    const [orphan] = store.listOrphanedDownloads();
    assert.equal(orphan.legacy_download_id, 31);

    const created = store.assignOrphanedDownload(orphan.id, 2);
    assert.equal(created.id, 31, 'the id Sonarr is polling has to survive the repair');
    assert.equal(created.profile_id, 2);
    assert.equal(store.findDownloadById(31).putio_transfer_id, 1031);
  } finally {
    store.close();
  }
});

test('reassignment falls back to a new id when the old one has been taken', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    profiles: [
      profileRow({ id: 1, slug: 'default', name: 'Default', rpc_path: '/transmission/rpc' }),
      profileRow({ id: 2, slug: 'radarr', name: 'Radarr', rpc_path: '/radarr/transmission/rpc' }),
    ],
    transfers: [transferRow({ id: 3, profile_id: null, putio_transfer_id: 1003, downloaded_ever: 640 })],
  });

  const store = new StateStore(dbPath);
  try {
    const [orphan] = store.listOrphanedDownloads();
    assert.equal(orphan.legacy_download_id, 3);
    // Something else has taken id 3 in the meantime.
    store.db.prepare(`
      INSERT INTO downloads (id, profile_id, putio_transfer_id, name, created_at, updated_at)
      VALUES (3, 1, 9999, 'Squatter', 'now', 'now')
    `).run();

    const created = store.assignOrphanedDownload(orphan.id, 2);
    assert.notEqual(created.id, 3);
    assert.equal(created.putio_transfer_id, 1003);
    assert.equal(store.findDownloadById(3).name, 'Squatter');
    // Progress made before the quarantine is not thrown away: a download that
    // reappears at 0 bytes reads as a restart nobody asked for.
    assert.equal(created.downloaded_ever, 640);
  } finally {
    store.close();
  }
});

// Finding 3: `transfers` without `transfer_associations` — a partially restored
// or hand-edited database. The migration cannot chain (the association hop's
// guard key says it already ran), so those rows are invisible to this version.
// Saying so only in the log means nobody finds out.
test('legacy rows the migration cannot reach are recorded, not silently stranded', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    era: 'pre-association',
    profiles: [profileRow({ id: 1 })],
    transfers: [
      transferRow({ id: 1, putio_transfer_id: 1001 }),
      transferRow({ id: 2, putio_transfer_id: 1002, hash: 'b'.repeat(40), name: 'Second' }),
    ],
    // The association hop's guard key is set, but its output is gone.
    settings: { transfer_associations_migrated_v1: '1' },
  });

  const store = new StateStore(dbPath);
  try {
    const report = store.schemaMigrationReports().downloads;
    assert.equal(report.strandedLegacyRows, 2);
    assert.equal(report.migrated, 0);
    assert.equal(store.getSetting('downloads_schema_v1'), '1');
  } finally {
    store.close();
  }
});

test('a database with nothing to collapse records no report at all', async () => {
  const dbPath = await tempDbPath();
  const store = new StateStore(dbPath);
  try {
    assert.equal(store.schemaMigrationReports().downloads, undefined);
  } finally {
    store.close();
  }
});

// Finding 5: rolling back is right; a bare "UNIQUE constraint failed" that
// names neither the row nor the backup, and repeats on every boot, is not.
test('a failed collapse names the offending row and the backup it just took', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfersUnique: false,
    transfers: [
      transferRow({ id: 1, putio_transfer_id: 1001 }),
      transferRow({ id: 2, putio_transfer_id: 1001, hash: 'b'.repeat(40), name: 'Duplicate.Release' }),
    ],
    associations: [
      associationRow({ id: 1, transfer_id: 1 }),
      associationRow({ id: 2, transfer_id: 2 }),
    ],
  });

  assert.throws(() => new StateStore(dbPath), (error) => {
    assert.match(error.message, /could not migrate its database to the downloads schema/);
    assert.match(error.message, /UNIQUE constraint failed: downloads\.putio_transfer_id/);
    assert.match(error.message, /while migrating download 2 \(put\.io transfer 1001, Duplicate\.Release\)/);
    assert.match(error.message, /A backup taken before the attempt is at .*\.pre-downloads-\d+\.bak/);
    assert.match(error.message, /repeat on every start/);
    return true;
  });

  // Rollback is intact: the source tables and their rows are untouched.
  assert.equal(allRows(dbPath, 'SELECT id FROM transfer_associations').length, 2);
  assert.equal(allRows(dbPath, 'SELECT id FROM downloads').length, 0);
});

// The foreign_key_check read-and-throw in each migration. Neither can fire
// through normal data, so each is reached by breaking the copy it guards.
test('the collapse refuses to commit a download pointing at a profile that is gone', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 1, putio_transfer_id: 1001 })],
    associations: [associationRow({ id: 1, transfer_id: 1 })],
  });

  class DanglingStore extends StateStore {
    collapseTransfersIntoDownloads() {
      const report = super.collapseTransfersIntoDownloads();
      // Foreign keys are off inside the transaction, so this writes.
      this.db.prepare('UPDATE downloads SET profile_id = 999999').run();
      return report;
    }
  }

  assert.throws(() => new DanglingStore(dbPath), /dangling reference/);
  assert.equal(allRows(dbPath, 'SELECT id FROM transfer_associations').length, 1);
  assert.equal(
    allRows(dbPath, "SELECT value FROM settings WHERE key = 'downloads_schema_v1'").length,
    0,
  );
});

test('the profiles rebuild refuses to commit a downloads row whose profile it lost', async () => {
  const dbPath = await tempDbPath();
  writeLegacyDb(dbPath, {
    downloadProfiles: [{ id: 1, name: 'Default', slug: 'default', created_at: 'now', updated_at: 'now' }],
    profiles: [profileRow({ id: 1, download_profile_id: 1 })],
    transfers: [transferRow({ id: 1, putio_transfer_id: 1001 })],
    associations: [associationRow({ id: 1, transfer_id: 1 })],
  });

  class LosingStore extends StateStore {
    rebuildProfilesTable() {
      const report = super.rebuildProfilesTable();
      // The copy dropped a profile a download still references.
      this.db.prepare('DELETE FROM profiles WHERE id = 1').run();
      return report;
    }
  }

  assert.throws(() => new LosingStore(dbPath), /dangling reference/);

  // The rollback left the old profiles table, so the next boot finishes.
  const store = new StateStore(dbPath);
  try {
    assert.equal(store.findProfileById(1).slug, 'sonarr');
    assert.equal(store.findDownloadById(1).profile_id, 1);
    assert.equal(store.getSetting('profiles_schema_v2'), '1');
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally {
    store.close();
  }
});
