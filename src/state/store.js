import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  DEFAULT_DOWNLOAD_POLICY,
  DOWNLOAD_POLICY_COLUMNS,
  DOWNLOAD_POLICY_SETTING_KEYS,
  downloadPolicyInput,
  normalizeDownloadPolicy,
} from '../download/policy.js';
import { normalizeBrowserDomains } from '../transfer/browser-domains.js';
import { logger } from '../logger.js';

// One download item, one owning profile, one put.io transfer (design rules 1
// and 3). This replaced the transfers/transfer_associations split, whose only
// job was to let one put.io transfer belong to several profiles at once —
// something the ownership rules make unrepresentable. `id` is the id
// torrent-add handed the *arr apps, so the collapse copies it across verbatim.
const DOWNLOADS_DDL = `
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
    putio_transfer_id INTEGER NOT NULL UNIQUE,
    putio_file_id INTEGER,
    save_parent_id INTEGER,
    hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'unknown',
    category TEXT NOT NULL DEFAULT '',
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

  CREATE INDEX IF NOT EXISTS idx_downloads_profile_id ON downloads(profile_id);
  CREATE INDEX IF NOT EXISTS idx_downloads_lifecycle ON downloads(lifecycle);
  CREATE INDEX IF NOT EXISTS idx_downloads_hash ON downloads(hash);

  CREATE TABLE IF NOT EXISTS download_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
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
    UNIQUE(download_id, putio_file_id)
  );

  CREATE INDEX IF NOT EXISTS idx_download_files_download_id ON download_files(download_id);
  CREATE INDEX IF NOT EXISTS idx_download_files_status ON download_files(status);

  CREATE TABLE IF NOT EXISTS orphaned_downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    putio_transfer_id INTEGER,
    hash TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'unknown',
    category TEXT NOT NULL DEFAULT '',
    lifecycle TEXT NOT NULL DEFAULT 'remote',
    total_size INTEGER NOT NULL DEFAULT 0,
    downloaded_ever INTEGER NOT NULL DEFAULT 0,
    putio_file_id INTEGER,
    save_parent_id INTEGER,
    legacy_download_dir TEXT NOT NULL DEFAULT '',
    quarantined_at TEXT NOT NULL,
    reason TEXT NOT NULL
  );
`;

// A profile has exactly one download profile (design rule 2), so
// download_profile_id is NOT NULL and its delete is RESTRICTed. rpc_path is
// nullable with a partial unique index: only an *arr ingress needs a
// Transmission endpoint, and a Putiorr Grab profile held one solely because the
// column was NOT NULL UNIQUE — which quietly turned its derived
// /grab/<slug>/rpc into a live endpoint an *arr could add into.
const PROFILES_DDL = `
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'custom',
    slug TEXT NOT NULL UNIQUE,
    download_profile_id INTEGER NOT NULL REFERENCES download_profiles(id) ON DELETE RESTRICT,
    auto_remove_completed INTEGER NOT NULL DEFAULT 0,
    putio_folder_name TEXT NOT NULL,
    putio_folder_id INTEGER,
    download_at TEXT NOT NULL DEFAULT '',
    rpc_path TEXT,
    client_host TEXT NOT NULL DEFAULT 'putiorr',
    client_port TEXT NOT NULL DEFAULT '9091',
    client_use_ssl INTEGER NOT NULL DEFAULT 0,
    browser_domains TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const PROFILES_RPC_PATH_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_rpc_path
    ON profiles(rpc_path) WHERE rpc_path IS NOT NULL;
`;

// Created by the one-shot transfers -> transfer_associations migration rather
// than by migrate(), because a database that has never seen them must never
// gain them: they exist only as the middle hop of the chain
// (pre-association DB -> associations -> downloads) that runs in a single boot.
const LEGACY_ASSOCIATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS transfer_associations (
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

  CREATE TABLE IF NOT EXISTS association_files (
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

function nowIso() {
  return new Date().toISOString();
}

function toBool(value) {
  return value === 1 || value === true;
}

function normalizeHash(value) {
  return String(value ?? '').trim().toLowerCase();
}

function magnetInfoHash(source) {
  const text = String(source ?? '');
  if (!text.startsWith('magnet:')) return '';
  const queryStart = text.indexOf('?');
  if (queryStart < 0) return '';
  const params = new URLSearchParams(text.slice(queryStart + 1));
  const xtValues = params.getAll('xt');
  for (const xt of xtValues) {
    const match = String(xt).match(/^urn:btih:([^&]+)$/i);
    if (match) return normalizeHash(match[1]);
  }
  return '';
}

function normalizeDownloadRow(row) {
  if (!row) return undefined;
  return {
    ...row,
    error: toBool(row.error),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeFileRow(row) {
  if (!row) return undefined;
  return {
    ...row,
    updated_at: row.updated_at,
  };
}

// The stored text is JSON written by putiorr itself, but a row can predate the
// column or have been edited by hand: an unreadable value degrades to "no
// sites" so listing profiles never throws over a setting this optional.
function profileBrowserDomains(row) {
  try {
    const parsed = JSON.parse(row.browser_domains ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((domain) => typeof domain === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeProfileRow(row) {
  if (!row) return undefined;
  const downloadAt = row.download_at ?? row.local_path;
  const autoRemoveCompleted = toBool(row.auto_remove_completed);
  const browserDomains = profileBrowserDomains(row);
  const {
    local_path: _localPath,
    download_at: _downloadAt,
    client_use_ssl: clientUseSsl,
    ...rest
  } = row;
  return {
    ...rest,
    browser_domains: browserDomains,
    browserDomains,
    download_at: downloadAt,
    downloadAt,
    downloadProfileId: row.download_profile_id,
    auto_remove_completed: autoRemoveCompleted,
    autoRemoveCompleted,
    client_use_ssl: toBool(clientUseSsl),
    clientHost: row.client_host,
    clientPort: row.client_port,
    clientUseSsl: toBool(clientUseSsl),
    enabled: toBool(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeDownloadProfileRow(row) {
  if (!row) return undefined;
  const policy = normalizeDownloadPolicy(downloadPolicyInput(row));
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    slow_speed_threshold_bytes_per_second: policy.slowSpeedThresholdBytesPerSecond,
    slow_speed_duration_seconds: policy.slowSpeedDurationSeconds,
    slow_speed_grace_seconds: policy.slowSpeedGraceSeconds,
    slow_speed_min_size_bytes: policy.slowSpeedMinSizeBytes,
    slowSpeedThresholdBytesPerSecond: policy.slowSpeedThresholdBytesPerSecond,
    slowSpeedDurationSeconds: policy.slowSpeedDurationSeconds,
    slowSpeedGraceSeconds: policy.slowSpeedGraceSeconds,
    slowSpeedMinSizeBytes: policy.slowSpeedMinSizeBytes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function profileDownloadAt(input) {
  return input.download_at ?? input.downloadAt ?? input.local_path ?? input.localPath;
}

function profileDownloadProfileId(input) {
  if (input.download_profile_id !== undefined) return input.download_profile_id;
  if (input.downloadProfileId !== undefined) return input.downloadProfileId;
  return undefined;
}

// Stored as JSON text in one column rather than a join table: the list is
// short, only ever read whole, and never queried by domain.
//
// Normalized here as well as at the API boundary because the store has callers
// that never pass one: seedFromConfig writes PUTIORR_PROFILES_JSON straight in,
// and storing that comma-separated text verbatim would read back as no sites at
// all. Re-normalizing an already normalized list is a no-op; unmatchable
// entries are dropped, since a seed has nobody to report an error to.
function profileBrowserDomainsPatch(input) {
  const domains = input.browser_domains ?? input.browserDomains;
  return domains === undefined ? undefined : JSON.stringify(normalizeBrowserDomains(domains).domains);
}

// The API lowercases the preset before it reaches the store, but the seed paths
// do not go through it: PUTIORR_PROFILES_JSON and PUTIORR_DEFAULT_PROFILE_TYPE
// are written straight in. A preset is only ever compared exactly, so storing
// "Grab" would leave a profile that no browser grab and no ?type= filter finds.
function profileTypeValue(input) {
  return String(input.type ?? '').trim().toLowerCase() || 'custom';
}

function profileClientHost(input) {
  return input.client_host ?? input.clientHost;
}

function profileClientPort(input) {
  return input.client_port ?? input.clientPort;
}

function profileClientUseSsl(input) {
  return input.client_use_ssl ?? input.clientUseSsl;
}

function profileAutoRemoveCompleted(input) {
  const value = input.auto_remove_completed ?? input.autoRemoveCompleted;
  if (value === undefined) return undefined;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function profileDefaultsToAutoRemoveCompleted(input) {
  return [
    input.type,
    input.slug,
    input.name,
    input.putio_folder_name,
    input.putioFolderName,
  ].some((value) => String(value ?? '').trim().toLowerCase() === 'prowlarr');
}

function normalizeOptionalId(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function downloadProfilePolicyFromConfigAndSettings(store, config) {
  const input = {};
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    const value = store.getSetting(key);
    if (value !== undefined) input[property] = value;
  }
  return normalizeDownloadPolicy(input, {
    slowSpeedThresholdBytesPerSecond: config.slowSpeedThresholdBytesPerSecond,
    slowSpeedDurationSeconds: config.slowSpeedDurationSeconds,
    slowSpeedGraceSeconds: config.slowSpeedGraceSeconds,
    slowSpeedMinSizeBytes: config.slowSpeedMinSizeBytes,
  });
}

function downloadProfilePolicyPatch(input, fallback = DEFAULT_DOWNLOAD_POLICY) {
  return normalizeDownloadPolicy(downloadPolicyInput(input), fallback);
}

export class StateStore {
  // config is optional and only ever used to seed the default download
  // profile's policy from PUTIORR_SLOW_SPEED_* on a database that predates
  // download_profiles. Without it that upgrade would silently fall back to the
  // built-in defaults, because ensureDefaultDownloadProfile returns an existing
  // row without applying config.
  constructor(filePath = ':memory:', { config } = {}) {
    this.filePath = filePath;
    this.config = config;
    if (filePath !== ':memory:') {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS download_profiles (
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

      ${PROFILES_DDL}

      ${DOWNLOADS_DDL}
    `);
    this.migrateProfileDownloadAt();
    this.migrateProfileAutoRemoveCompleted();
    this.ensureColumn('profiles', 'download_profile_id', 'INTEGER REFERENCES download_profiles(id) ON DELETE SET NULL');
    this.ensureColumn('profiles', 'client_host', "TEXT NOT NULL DEFAULT 'putiorr'");
    this.ensureColumn('profiles', 'client_port', "TEXT NOT NULL DEFAULT '9091'");
    this.ensureColumn('profiles', 'client_use_ssl', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('profiles', 'browser_domains', 'TEXT');
    // Everything below only exists on a database written by an older putiorr.
    // A fresh database never creates these tables, and PRAGMA table_info on a
    // table that is not there answers with an empty list rather than an error —
    // so an ungated ensureColumn would ALTER a table that does not exist, and
    // an ungated SELECT would throw on the first boot of a new install.
    if (this.hasTable('transfers')) {
      this.ensureColumn('transfers', 'profile_id', 'INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
      this.ensureColumn('transfers', 'completion_percent', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('transfers', 'putio_status_message', "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn('transfers', 'putio_peers', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('transfers', 'putio_availability', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (this.hasTable('transfer_files')) {
      this.ensureColumn('transfer_files', 'download_speed', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (this.hasTable('transfers')) {
      this.migrateTransferAssociations();
      // Must run before the collapse: it rewrites transfers.hash in place, and
      // after the collapse there is no transfers table left to rewrite.
      this.migrateMagnetTransferHashes();
    }
    this.migrateDownloadsCollapse();
    this.migrateProfilesSchema();
    this.db.exec(PROFILES_RPC_PATH_INDEX_DDL);
  }

  hasTable(name) {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name));
  }

  // The owner is copied, never guessed. This used to read
  // COALESCE(profile_id, first profile by slug then id), which is the audit's
  // finding 2 — "the finding most likely to lose files quietly": a transfer
  // that predates transfers.profile_id came out owned by whichever profile
  // sorted first, and the staging folder, the download policy and the put.io
  // folder all follow the owner. A row that stays ownerless here is handled by
  // exactly one rule, in migrateDownloadsCollapse: one profile in the database
  // means that profile owns it; otherwise it is quarantined for the user to
  // reassign from the dashboard.
  migrateTransferAssociations() {
    if (this.getSetting('transfer_associations_migrated_v1') === '1') return;

    this.db.exec(LEGACY_ASSOCIATIONS_DDL);
    this.db.exec(`
      INSERT OR IGNORE INTO transfer_associations (
        id, transfer_id, profile_id, category, download_dir, lifecycle,
        total_size, downloaded_ever, download_speed, eta, error, error_string,
        retry_count, removed_at, created_at, updated_at
      )
      SELECT
        id,
        id,
        profile_id,
        category,
        download_dir,
        lifecycle,
        total_size,
        downloaded_ever,
        download_speed,
        eta,
        error,
        error_string,
        retry_count,
        removed_at,
        created_at,
        updated_at
      FROM transfers;
    `);
    if (!this.hasTable('transfer_files')) {
      this.setSetting('transfer_associations_migrated_v1', '1');
      return;
    }
    this.db.exec(`
      INSERT OR IGNORE INTO association_files (
        id, transfer_id, putio_file_id, relative_path, size, downloaded_bytes,
        download_speed, status, attempts, error_string, created_at, updated_at
      )
      SELECT
        tf.id,
        ta.id,
        tf.putio_file_id,
        tf.relative_path,
        tf.size,
        tf.downloaded_bytes,
        tf.download_speed,
        tf.status,
        tf.attempts,
        tf.error_string,
        tf.created_at,
        tf.updated_at
      FROM transfer_files tf
      JOIN transfer_associations ta ON ta.transfer_id = tf.transfer_id;
    `);
    this.setSetting('transfer_associations_migrated_v1', '1');
  }

  // The only safe way to back up a WAL database from inside the process: copying
  // the .sqlite file alone loses whatever is still in the write-ahead log.
  // VACUUM INTO cannot run inside a transaction and refuses an existing target,
  // hence the timestamp. Never deleted automatically — a NAS user who discovers
  // a problem a week later still has it.
  backupBeforeCollapse() {
    if (this.filePath === ':memory:') return undefined;
    const target = `${this.filePath}.pre-downloads-${Date.now()}.bak`;
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    logger.info('database backed up before the downloads schema migration', { target });
    return target;
  }

  // transfers + transfer_associations -> downloads, in one transaction.
  //
  // Both settings writes are inside it. The older association migration writes
  // its key outside and gets away with it because INSERT OR IGNORE makes it
  // idempotent; this one drops tables, so a crash between the commit and the
  // key write would re-run it against a database that no longer has the source
  // tables. DDL is transactional in SQLite, so there are exactly two outcomes:
  // the whole collapse commits, or the database is byte-identical to before and
  // the next boot retries.
  //
  // The foreign_keys toggle brackets the transaction rather than sitting inside
  // it: PRAGMA foreign_keys is a no-op while a transaction is open. It is
  // restored in a finally, because leaving foreign keys off for the process
  // lifetime would turn ON DELETE RESTRICT into decoration.
  migrateDownloadsCollapse() {
    if (this.getSetting('downloads_schema_v1') === '1') return;
    if (!this.hasTable('transfer_associations')) {
      this.setSetting('downloads_schema_v1', '1');
      return;
    }

    this.backupBeforeCollapse();
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const report = this.collapseTransfersIntoDownloads();
        const dangling = this.db.prepare('PRAGMA foreign_key_check').all();
        if (dangling.length > 0) {
          throw new Error(
            `downloads schema migration left ${dangling.length} dangling reference(s): `
            + `${JSON.stringify(dangling)}`,
          );
        }
        this.setSetting('downloads_schema_v1', '1');
        this.setSetting('downloads_schema_v1_report', JSON.stringify(report));
        this.db.exec('COMMIT');
        this.logCollapseReport(report);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Row by row in JS rather than one INSERT ... SELECT. The tables hold
  // hundreds of rows on a real install, and the loop is what makes the report —
  // which profile, which local path, which put.io id — possible at all.
  //
  // Nothing on disk is touched. Every row this cannot represent is moved to
  // orphaned_downloads for the user to reassign or delete from the dashboard;
  // its files stay exactly where they are.
  collapseTransfersIntoDownloads() {
    const timestamp = nowIso();
    const profiles = this.db.prepare('SELECT id, name, download_at FROM profiles').all();
    const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
    // Not a guess: "the database has exactly one profile" is the same
    // determinism the shared RPC endpoint uses. Anything less certain is
    // quarantined instead.
    const soleProfileId = profiles.length === 1 ? profiles[0].id : null;

    const associations = this.db.prepare(`
      SELECT
        a.id, a.transfer_id, a.profile_id, a.category, a.download_dir, a.lifecycle,
        a.total_size, a.downloaded_ever, a.download_speed, a.eta, a.error,
        a.error_string, a.retry_count, a.removed_at, a.created_at, a.updated_at,
        r.putio_transfer_id, r.putio_file_id, r.save_parent_id, r.hash, r.name,
        r.source, r.source_type, r.putio_status, r.putio_status_message,
        r.putio_peers, r.putio_availability, r.percent_done, r.completion_percent,
        r.total_size AS remote_total_size, r.uploaded_ever, r.upload_speed
      FROM transfer_associations a
      JOIN transfers r ON r.id = a.transfer_id
      ORDER BY a.transfer_id ASC, a.created_at ASC, a.id ASC
    `).all();

    const countFiles = this.db.prepare(
      'SELECT COUNT(*) AS total FROM association_files WHERE transfer_id = ?',
    );
    const insertDownload = this.db.prepare(`
      INSERT INTO downloads (
        id, profile_id, putio_transfer_id, putio_file_id, save_parent_id, hash, name,
        source, source_type, category, lifecycle, putio_status, putio_status_message,
        putio_peers, putio_availability, percent_done, completion_percent, total_size,
        downloaded_ever, uploaded_ever, download_speed, upload_speed, eta, error,
        error_string, retry_count, removed_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const copyFiles = this.db.prepare(`
      INSERT INTO download_files (
        id, download_id, putio_file_id, relative_path, size, downloaded_bytes,
        download_speed, status, attempts, error_string, created_at, updated_at
      )
      SELECT
        id, transfer_id, putio_file_id, relative_path, size, downloaded_bytes,
        download_speed, status, attempts, error_string, created_at, updated_at
      FROM association_files
      WHERE transfer_id = ?
    `);
    const quarantine = this.db.prepare(`
      INSERT INTO orphaned_downloads (
        putio_transfer_id, hash, name, source, source_type, category, lifecycle,
        total_size, downloaded_ever, putio_file_id, save_parent_id,
        legacy_download_dir, quarantined_at, reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const report = {
      version: 1,
      at: timestamp,
      migrated: 0,
      adoptedBySoleProfile: 0,
      extraAssociations: [],
      noPutioId: [],
      ownerless: [],
      droppedFiles: 0,
    };
    const claimedTransferIds = new Set();

    for (const row of associations) {
      const fileCount = Number(countFiles.get(row.id)?.total ?? 0);
      const owner = row.profile_id == null ? undefined : profilesById.get(row.profile_id);
      const localPath = this.legacyLocalPath(row, owner);

      // The oldest association of a put.io transfer is the download; rule 1
      // makes the rest unrepresentable, so they are quarantined rather than
      // silently merged into the survivor.
      if (claimedTransferIds.has(row.transfer_id)) {
        report.extraAssociations.push({
          associationId: row.id,
          transferId: row.transfer_id,
          putioTransferId: row.putio_transfer_id,
          profileId: row.profile_id,
          profileName: owner?.name ?? null,
          name: row.name,
          localPath,
          fileCount,
        });
        this.quarantineLegacyRow(quarantine, row, localPath, 'extra association', timestamp);
        report.droppedFiles += fileCount;
        continue;
      }
      claimedTransferIds.add(row.transfer_id);

      // Rule 3: put.io's transfer id is the download's identity. A row without
      // one cannot be matched against put.io ever again.
      if (row.putio_transfer_id == null) {
        report.noPutioId.push({
          associationId: row.id,
          profileId: row.profile_id,
          profileName: owner?.name ?? null,
          name: row.name,
          localPath,
          fileCount,
        });
        this.quarantineLegacyRow(quarantine, row, localPath, 'no put.io transfer id', timestamp);
        report.droppedFiles += fileCount;
        continue;
      }

      // A profile_id pointing at a row that is gone should be impossible — the
      // old FK was ON DELETE SET NULL — but foreign keys have been off during
      // at least one legacy ALTER in this codebase's history, and the check is
      // the difference between a report line and a constraint failure that
      // aborts the whole upgrade.
      let profileId = owner?.id ?? null;
      if (profileId == null && soleProfileId != null) {
        profileId = soleProfileId;
        report.adoptedBySoleProfile += 1;
      }
      if (profileId == null) {
        report.ownerless.push({
          associationId: row.id,
          putioTransferId: row.putio_transfer_id,
          name: row.name,
          localPath,
          fileCount,
        });
        this.quarantineLegacyRow(quarantine, row, localPath, 'no owner', timestamp);
        report.droppedFiles += fileCount;
        continue;
      }

      insertDownload.run(
        row.id,
        profileId,
        row.putio_transfer_id,
        row.putio_file_id ?? null,
        row.save_parent_id ?? null,
        row.hash ?? '',
        row.name,
        row.source ?? '',
        row.source_type ?? 'unknown',
        row.category ?? '',
        row.lifecycle ?? 'remote',
        row.putio_status ?? 'UNKNOWN',
        row.putio_status_message ?? '',
        row.putio_peers ?? 0,
        row.putio_availability ?? 0,
        row.percent_done ?? 0,
        row.completion_percent ?? 0,
        row.total_size ?? row.remote_total_size ?? 0,
        row.downloaded_ever ?? 0,
        row.uploaded_ever ?? 0,
        row.download_speed ?? 0,
        row.upload_speed ?? 0,
        row.eta ?? -1,
        row.error ?? 0,
        row.error_string ?? '',
        row.retry_count ?? 0,
        row.removed_at ?? null,
        row.created_at,
        row.updated_at,
      );
      copyFiles.run(row.id);
      report.migrated += 1;
    }

    // Dependency order, with foreign keys already off. Load-bearing if anyone
    // ever turns them back on inside this block: dropping a parent performs an
    // implicit DELETE FROM, which cascades into the children.
    this.db.exec(`
      DROP TABLE IF EXISTS association_files;
      DROP TABLE IF EXISTS transfer_associations;
      DROP TABLE IF EXISTS transfer_files;
      DROP TABLE IF EXISTS transfers;
    `);
    return report;
  }

  // The design asks the log to name the profile and the local path so a user
  // can find the files a quarantined row left behind. The stored download_dir
  // is what the *arr asked for, which is the right answer when the owner is
  // unknown; when it is known, the folder the files actually staged into is
  // the profile's own.
  legacyLocalPath(row, owner) {
    if (owner?.download_at) {
      return path.join(owner.download_at, row.category ?? '', row.name ?? '');
    }
    if (row.download_dir) return path.join(row.download_dir, row.name ?? '');
    return row.name ?? '';
  }

  quarantineLegacyRow(statement, row, localPath, reason, timestamp) {
    statement.run(
      row.putio_transfer_id ?? null,
      row.hash ?? '',
      row.name ?? '',
      row.source ?? '',
      row.source_type ?? 'unknown',
      row.category ?? '',
      row.lifecycle ?? 'remote',
      row.total_size ?? row.remote_total_size ?? 0,
      row.downloaded_ever ?? 0,
      row.putio_file_id ?? null,
      row.save_parent_id ?? null,
      localPath,
      timestamp,
      reason,
    );
  }

  logCollapseReport(report) {
    for (const entry of report.extraAssociations) {
      logger.warn('download quarantined: its put.io transfer already belongs to another profile', entry);
    }
    for (const entry of report.noPutioId) {
      logger.warn('download quarantined: no put.io transfer id to identify it by', entry);
    }
    for (const entry of report.ownerless) {
      logger.warn('download quarantined: no owning RR profile', entry);
    }
    logger.info('downloads schema migration completed', {
      migrated: report.migrated,
      adoptedBySoleProfile: report.adoptedBySoleProfile,
      quarantined: report.extraAssociations.length + report.noPutioId.length + report.ownerless.length,
      droppedFiles: report.droppedFiles,
    });
  }

  profilesSchemaIsCurrent() {
    const columns = new Map(this.getColumns('profiles').map((column) => [column.name, column]));
    return columns.get('rpc_path')?.notnull === 0
      && columns.get('download_profile_id')?.notnull === 1;
  }

  // Design rules 2 and 5: a profile has exactly one download profile, and only
  // an *arr ingress needs an RPC path. One rebuild does both — two rebuilds of
  // the same table for one release is wasted risk.
  //
  // A separate transaction from the collapse. A kill between them leaves the
  // downloads collapsed but profiles unrebuilt, which is a consistent state the
  // next boot finishes; merging them would mean one transaction that drops four
  // tables and rebuilds a fifth, which is harder to reason about and harder to
  // test in isolation.
  migrateProfilesSchema() {
    // The shape check, not just the key: a database that somehow carries the
    // key without the shape must not be left half-done.
    if (this.profilesSchemaIsCurrent()) {
      if (this.getSetting('profiles_schema_v2') !== '1') this.setSetting('profiles_schema_v2', '1');
      return;
    }

    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const report = this.rebuildProfilesTable();
        const dangling = this.db.prepare('PRAGMA foreign_key_check').all();
        if (dangling.length > 0) {
          throw new Error(
            `profiles schema migration left ${dangling.length} dangling reference(s): `
            + `${JSON.stringify(dangling)}`,
          );
        }
        this.setSetting('profiles_schema_v2', '1');
        this.setSetting('profiles_schema_v2_report', JSON.stringify(report));
        this.db.exec('COMMIT');
        logger.info('profiles schema migration completed', report);
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  rebuildProfilesTable() {
    const timestamp = nowIso();
    const report = { version: 2, at: timestamp, downloadProfilesAssigned: 0, grabRpcPathsCleared: 0 };

    const unassigned = this.db.prepare(
      'SELECT COUNT(*) AS total FROM profiles WHERE download_profile_id IS NULL',
    ).get().total;
    if (unassigned > 0) {
      // seedFromConfig is what normally creates the default, and it runs after
      // the constructor — so on a database predating download_profiles the
      // migration has to create it, or NOT NULL fires on rows that were legal
      // when they were written.
      const fallback = this.ensureDefaultDownloadProfile(this.config ?? {});
      this.db.prepare(`
        UPDATE profiles SET download_profile_id = ?, updated_at = ?
        WHERE download_profile_id IS NULL
      `).run(fallback.id, timestamp);
      report.downloadProfilesAssigned = Number(unassigned);
    }

    // The derived /grab/<slug>/rpc was only ever there to satisfy NOT NULL
    // UNIQUE. Dropping it removes rows from the unique index, which can never
    // create a conflict — the constraint is only relaxed, never tightened. It
    // is dropped during the copy rather than by an UPDATE first, because the
    // old column is still NOT NULL at that point.
    report.grabRpcPathsCleared = Number(this.db.prepare(
      "SELECT COUNT(*) AS total FROM profiles WHERE lower(type) = 'grab' AND rpc_path IS NOT NULL",
    ).get().total);

    this.db.exec(PROFILES_DDL.replace('IF NOT EXISTS profiles', 'profiles_new'));
    this.db.exec(`
      INSERT INTO profiles_new (
        id, name, type, slug, download_profile_id, auto_remove_completed,
        putio_folder_name, putio_folder_id, download_at, rpc_path, client_host,
        client_port, client_use_ssl, browser_domains, enabled, created_at, updated_at
      )
      SELECT
        id, name, type, slug, download_profile_id, auto_remove_completed,
        putio_folder_name, putio_folder_id, download_at,
        CASE WHEN lower(type) = 'grab' THEN NULL ELSE rpc_path END,
        client_host, client_port, client_use_ssl, browser_domains, enabled,
        created_at, updated_at
      FROM profiles
    `);
    // Never the other order: ALTER TABLE ... RENAME rewrites other tables'
    // foreign keys to follow the new name, so renaming the old table aside
    // first would leave downloads pointing at profiles_old forever.
    this.db.exec('DROP TABLE profiles');
    this.db.exec('ALTER TABLE profiles_new RENAME TO profiles');
    this.db.exec(PROFILES_RPC_PATH_INDEX_DDL);
    return report;
  }

  getColumns(table) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all();
  }

  ensureColumn(table, column, definition) {
    const columns = this.getColumns(table);
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  migrateProfileAutoRemoveCompleted() {
    const columns = this.getColumns('profiles');
    if (columns.some((row) => row.name === 'auto_remove_completed')) return;
    this.db.exec('ALTER TABLE profiles ADD COLUMN auto_remove_completed INTEGER NOT NULL DEFAULT 0');
    this.db.prepare(`
      UPDATE profiles
      SET auto_remove_completed = 1, updated_at = ?
      WHERE lower(type) = 'prowlarr'
        OR lower(slug) = 'prowlarr'
        OR lower(name) = 'prowlarr'
        OR lower(putio_folder_name) = 'prowlarr'
    `).run(nowIso());
  }

  migrateProfileDownloadAt() {
    const columns = this.getColumns('profiles');
    const hasDownloadAt = columns.some((row) => row.name === 'download_at');
    const hasLocalPath = columns.some((row) => row.name === 'local_path');
    if (!hasDownloadAt) {
      this.db.exec("ALTER TABLE profiles ADD COLUMN download_at TEXT NOT NULL DEFAULT ''");
    }
    if (hasLocalPath) {
      this.db.exec(`
        UPDATE profiles
        SET download_at = local_path
        WHERE local_path IS NOT NULL
          AND local_path != ''
          AND (download_at IS NULL OR download_at = '')
      `);
    }
  }

  migrateMagnetTransferHashes() {
    const rows = this.db.prepare(`
      SELECT id, hash, source
      FROM transfers
      WHERE source LIKE 'magnet:%'
    `).all();
    for (const row of rows) {
      const nextHash = magnetInfoHash(row.source);
      if (!nextHash || nextHash === normalizeHash(row.hash)) continue;
      const conflict = this.db.prepare(`
        SELECT id
        FROM transfers
        WHERE lower(hash) = lower(?) AND id != ?
      `).get(nextHash, row.id);
      if (conflict) continue;
      this.db.prepare('UPDATE transfers SET hash = ?, updated_at = ? WHERE id = ?')
        .run(nextHash, nowIso(), row.id);
    }
  }

  setSetting(key, value) {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), nowIso());
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
  }

  deleteSetting(key) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  seedFromConfig(config) {
    if (config.putioToken && !this.getSetting('putio_token')) {
      this.setSetting('putio_token', config.putioToken);
    }
    const defaultDownloadProfile = this.ensureDefaultDownloadProfile(config);
    if (this.listProfiles({ includeDisabled: true }).length === 0) {
      const seedProfiles = Array.isArray(config.seedProfiles) && config.seedProfiles.length > 0
        ? config.seedProfiles
        : [{
            name: config.defaultProfileName,
            type: config.defaultProfileType,
            slug: 'default',
            download_profile_id: defaultDownloadProfile.id,
            putio_folder_name: config.putioFolder,
            downloadAt: config.targetDir,
            rpc_path: config.defaultRpcPath,
            enabled: true,
          }];

      for (const profile of seedProfiles) {
        this.createProfile({
          ...profile,
          slug: profile.slug ?? profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          type: profile.type ?? 'custom',
          download_profile_id: profileDownloadProfileId(profile) ?? defaultDownloadProfile.id,
          enabled: profile.enabled !== false,
        });
      }
    }
  }

  createDefaultProfile(config) {
    const defaultDownloadProfile = this.findDefaultDownloadProfile() ?? this.ensureDefaultDownloadProfile(config);
    return this.createProfile({
        name: config.defaultProfileName,
        type: config.defaultProfileType,
        slug: 'default',
        download_profile_id: defaultDownloadProfile.id,
        putio_folder_name: config.putioFolder,
        downloadAt: config.targetDir,
        rpc_path: config.defaultRpcPath,
        enabled: true,
    });
  }

  ensureDefaultDownloadProfile(config) {
    const existing = this.findDefaultDownloadProfile();
    if (existing) return existing;
    return this.createDownloadProfile({
      name: 'Default',
      slug: 'default',
      ...downloadProfilePolicyFromConfigAndSettings(this, config),
    });
  }

  createDownloadProfile(input) {
    const timestamp = nowIso();
    const policy = downloadProfilePolicyPatch(input);
    const result = this.db.prepare(`
      INSERT INTO download_profiles (
        name, slug, slow_speed_threshold_bytes_per_second,
        slow_speed_duration_seconds, slow_speed_grace_seconds,
        slow_speed_min_size_bytes, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.slug,
      policy.slowSpeedThresholdBytesPerSecond,
      policy.slowSpeedDurationSeconds,
      policy.slowSpeedGraceSeconds,
      policy.slowSpeedMinSizeBytes,
      timestamp,
      timestamp,
    );
    return this.findDownloadProfileById(Number(result.lastInsertRowid));
  }

  updateDownloadProfile(id, patch) {
    const existing = this.findDownloadProfileById(id);
    if (!existing) return undefined;
    const normalizedPatch = { ...patch };
    const currentPolicy = normalizeDownloadPolicy(downloadPolicyInput(existing));
    const nextPolicy = downloadProfilePolicyPatch(patch, currentPolicy);
    for (const [property, column] of Object.entries(DOWNLOAD_POLICY_COLUMNS)) {
      if (Object.hasOwn(patch, property) || Object.hasOwn(patch, column)) {
        normalizedPatch[column] = nextPolicy[property];
      }
    }

    const allowed = [
      'name',
      'slug',
      'slow_speed_threshold_bytes_per_second',
      'slow_speed_duration_seconds',
      'slow_speed_grace_seconds',
      'slow_speed_min_size_bytes',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(normalizedPatch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => normalizedPatch[key]);
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE download_profiles SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findDownloadProfileById(id);
  }

  // ON DELETE RESTRICT means the bare delete now throws whenever any profile
  // references it, so the reassignment the endpoint used to perform afterwards
  // has to happen first — and in the same transaction, or a failure leaves the
  // profiles pointing at a download profile that is about to disappear.
  deleteDownloadProfile(id, { reassignTo } = {}) {
    this.transaction(() => {
      if (reassignTo != null) {
        this.db.prepare(`
          UPDATE profiles SET download_profile_id = ?, updated_at = ?
          WHERE download_profile_id = ?
        `).run(reassignTo, nowIso(), id);
      }
      this.db.prepare('DELETE FROM download_profiles WHERE id = ?').run(id);
    });
  }

  findDownloadProfileById(id) {
    const row = this.db.prepare('SELECT * FROM download_profiles WHERE id = ?').get(id);
    return normalizeDownloadProfileRow(row);
  }

  findDownloadProfileBySlug(slug) {
    const row = this.db.prepare('SELECT * FROM download_profiles WHERE slug = ?').get(slug);
    return normalizeDownloadProfileRow(row);
  }

  findDefaultDownloadProfile() {
    return this.findDownloadProfileBySlug('default') ?? this.listDownloadProfiles()[0];
  }

  listDownloadProfiles() {
    return this.db.prepare('SELECT * FROM download_profiles ORDER BY id ASC').all().map(normalizeDownloadProfileRow);
  }

  createProfile(input) {
    const timestamp = nowIso();
    // Rule 2 makes the column NOT NULL, and the default download profile is an
    // existing user-visible concept (the settings' defaultDownloadProfileId,
    // preselected by the profile wizard) rather than a guessed owner — rule 4
    // is about which profile owns a download. A store that has never been
    // seeded has none yet, so one is created rather than refusing the profile.
    const downloadProfileId = profileDownloadProfileId(input)
      ?? this.findDefaultDownloadProfile()?.id
      ?? this.ensureDefaultDownloadProfile(this.config ?? {}).id;
    const autoRemoveCompleted = profileAutoRemoveCompleted(input) ?? profileDefaultsToAutoRemoveCompleted(input);
    const result = this.db.prepare(`
      INSERT INTO profiles (
        name, type, slug, download_profile_id, auto_remove_completed, putio_folder_name, putio_folder_id,
        download_at, rpc_path, client_host, client_port, client_use_ssl, browser_domains, enabled,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      profileTypeValue(input),
      input.slug,
      normalizeOptionalId(downloadProfileId),
      autoRemoveCompleted ? 1 : 0,
      input.putio_folder_name,
      input.putio_folder_id ?? null,
      profileDownloadAt(input),
      input.rpc_path ?? null,
      profileClientHost(input) ?? 'putiorr',
      profileClientPort(input) ?? '9091',
      profileClientUseSsl(input) ? 1 : 0,
      profileBrowserDomainsPatch(input) ?? null,
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
    return this.findProfileById(Number(result.lastInsertRowid));
  }

  updateProfile(id, patch) {
    const existing = this.findProfileById(id);
    if (!existing) return undefined;
    const normalizedPatch = { ...patch };
    const nextDownloadAt = profileDownloadAt(patch);
    if (nextDownloadAt !== undefined) normalizedPatch.download_at = nextDownloadAt;
    const nextDownloadProfileId = profileDownloadProfileId(patch);
    if (nextDownloadProfileId !== undefined) {
      normalizedPatch.download_profile_id = nextDownloadProfileId == null ? null : normalizeOptionalId(nextDownloadProfileId);
    }
    const nextClientHost = profileClientHost(patch);
    if (nextClientHost !== undefined) normalizedPatch.client_host = nextClientHost;
    const nextClientPort = profileClientPort(patch);
    if (nextClientPort !== undefined) normalizedPatch.client_port = nextClientPort;
    const nextClientUseSsl = profileClientUseSsl(patch);
    if (nextClientUseSsl !== undefined) normalizedPatch.client_use_ssl = nextClientUseSsl;
    const nextAutoRemoveCompleted = profileAutoRemoveCompleted(patch);
    if (nextAutoRemoveCompleted !== undefined) normalizedPatch.auto_remove_completed = nextAutoRemoveCompleted;
    const nextBrowserDomains = profileBrowserDomainsPatch(patch);
    if (nextBrowserDomains !== undefined) normalizedPatch.browser_domains = nextBrowserDomains;
    // Both writes land in the same column and every read compares it exactly,
    // so an update normalizes the preset the way createProfile does. A patch
    // that does not mention it leaves the stored one alone.
    if (patch.type !== undefined) normalizedPatch.type = profileTypeValue(patch);
    const allowed = [
      'name',
      'type',
      'slug',
      'download_profile_id',
      'auto_remove_completed',
      'putio_folder_name',
      'putio_folder_id',
      'download_at',
      'rpc_path',
      'client_host',
      'client_port',
      'client_use_ssl',
      'browser_domains',
      'enabled',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(normalizedPatch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => (
      key === 'enabled' || key === 'client_use_ssl' || key === 'auto_remove_completed'
        ? (normalizedPatch[key] ? 1 : 0)
        : normalizedPatch[key]
    ));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE profiles SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findProfileById(id);
  }

  deleteProfile(id) {
    // Kept alongside ON DELETE RESTRICT rather than replaced by it: the bare
    // constraint yields "FOREIGN KEY constraint failed", and this sentence is
    // what the dashboard shows.
    const linked = this.db.prepare(`
      SELECT 1 FROM downloads WHERE profile_id = ? LIMIT 1
    `).get(id);
    if (linked) throw new Error('RR profile cannot be deleted while downloads still reference it');
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  findProfileById(id) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return normalizeProfileRow(row);
  }

  findProfileBySlug(slug) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE slug = ?').get(slug);
    return normalizeProfileRow(row);
  }

  findProfileByRpcPath(rpcPath) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE rpc_path = ? AND enabled = 1').get(rpcPath);
    return normalizeProfileRow(row);
  }

  listProfiles({ includeDisabled = false } = {}) {
    const sql = includeDisabled
      ? 'SELECT * FROM profiles ORDER BY id ASC'
      : 'SELECT * FROM profiles WHERE enabled = 1 ORDER BY id ASC';
    return this.db.prepare(sql).all().map(normalizeProfileRow);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // One put.io transfer, one download row (design rule 3), so the put.io
  // transfer id is the only thing this resolves on. The old hash-first lookup
  // is gone with UNIQUE(hash): across a non-unique column it would return an
  // arbitrary row, and the hash is informational from here on.
  upsertDownload(input) {
    const timestamp = nowIso();
    const putioTransferId = input.putio_transfer_id;
    // Without an id from put.io the row can never be matched against put.io
    // again — it is one of the un-prunable zombies the collapse just removed,
    // and admitting a new one re-opens the hole.
    if (putioTransferId == null) throw new Error('put.io transfer id is required');
    const existing = this.db.prepare('SELECT * FROM downloads WHERE putio_transfer_id = ?')
      .get(putioTransferId);

    if (!existing) {
      if (input.profile_id == null) throw new Error('profile id is required');
      const hash = normalizeHash(input.hash);
      const result = this.db.prepare(`
        INSERT INTO downloads (
          profile_id, putio_transfer_id, putio_file_id, save_parent_id, hash, name, source,
          source_type, category, lifecycle, putio_status, putio_status_message,
          putio_peers, putio_availability, percent_done, completion_percent,
          total_size, downloaded_ever, uploaded_ever, download_speed, upload_speed,
          eta, error, error_string, retry_count, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.profile_id,
        putioTransferId,
        input.putio_file_id ?? null,
        input.save_parent_id ?? null,
        hash,
        input.name ?? hash,
        input.source ?? '',
        input.source_type ?? 'unknown',
        input.category ?? '',
        input.lifecycle ?? 'remote',
        input.putio_status ?? 'UNKNOWN',
        input.putio_status_message ?? '',
        input.putio_peers ?? 0,
        input.putio_availability ?? 0,
        input.percent_done ?? 0,
        input.completion_percent ?? 0,
        input.total_size ?? input.size ?? 0,
        input.downloaded_ever ?? 0,
        input.uploaded_ever ?? 0,
        input.download_speed ?? 0,
        input.upload_speed ?? 0,
        input.eta ?? -1,
        input.error ? 1 : 0,
        input.error_string ?? '',
        input.retry_count ?? 0,
        timestamp,
        timestamp,
      );
      return this.findDownloadById(Number(result.lastInsertRowid));
    }

    // The owner is frozen at creation (design rule 4). The poll passes the
    // row's own profile_id back in, so this only fires when a second profile
    // tries to claim a put.io transfer the first already owns — and answering
    // with the first profile's row would hand profile B a download owned by
    // profile A, which is the state this whole phase exists to remove.
    if (input.profile_id != null && input.profile_id !== existing.profile_id) {
      const owner = this.findProfileById(existing.profile_id);
      throw new Error(
        `Download ${existing.name} already belongs to RR profile ${owner?.name ?? existing.profile_id}`,
      );
    }

    this.db.prepare(`
      UPDATE downloads
      SET putio_file_id = ?, save_parent_id = ?, name = ?, source = ?, source_type = ?,
          category = ?, lifecycle = ?, putio_status = ?, putio_status_message = ?,
          putio_peers = ?, putio_availability = ?, percent_done = ?, completion_percent = ?,
          total_size = ?, downloaded_ever = ?, uploaded_ever = ?, download_speed = ?,
          upload_speed = ?, eta = ?, error = ?, error_string = ?, retry_count = ?,
          removed_at = CASE WHEN ? THEN NULL ELSE removed_at END,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.putio_file_id ?? existing.putio_file_id,
      input.save_parent_id ?? existing.save_parent_id,
      input.name ?? existing.name,
      input.source ?? existing.source,
      input.source_type ?? existing.source_type,
      input.category ?? existing.category,
      input.lifecycle ?? existing.lifecycle,
      input.putio_status ?? existing.putio_status,
      input.putio_status_message ?? existing.putio_status_message,
      input.putio_peers ?? existing.putio_peers,
      input.putio_availability ?? existing.putio_availability,
      input.percent_done ?? existing.percent_done,
      input.completion_percent ?? existing.completion_percent,
      input.total_size ?? input.size ?? existing.total_size,
      input.downloaded_ever ?? existing.downloaded_ever,
      input.uploaded_ever ?? existing.uploaded_ever,
      input.download_speed ?? existing.download_speed,
      input.upload_speed ?? existing.upload_speed,
      input.eta ?? existing.eta,
      (input.error ?? existing.error) ? 1 : 0,
      input.error_string ?? existing.error_string,
      input.retry_count ?? existing.retry_count,
      input.reactivate !== false ? 1 : 0,
      timestamp,
      existing.id,
    );
    return this.findDownloadById(existing.id);
  }

  updateDownload(id, patch) {
    const existing = this.findDownloadById(id);
    if (!existing) return undefined;
    // profile_id is deliberately absent: the owner is resolved once, at
    // ingestion, and frozen (design rule 4). Nothing in src/ patches it.
    const allowed = [
      'putio_file_id',
      'save_parent_id',
      'name',
      'putio_status',
      'putio_status_message',
      'putio_peers',
      'putio_availability',
      'percent_done',
      'completion_percent',
      'uploaded_ever',
      'upload_speed',
      'category',
      'lifecycle',
      'total_size',
      'downloaded_ever',
      'download_speed',
      'eta',
      'error',
      'error_string',
      'retry_count',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(patch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => (key === 'error' ? (patch[key] ? 1 : 0) : patch[key]));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE downloads SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findDownloadById(id);
  }

  findDownloadById(id) {
    return normalizeDownloadRow(this.db.prepare('SELECT * FROM downloads WHERE id = ?').get(id));
  }

  findDownloadByHash(hash, { profileId } = {}) {
    const params = [normalizeHash(hash)];
    let where = 'WHERE lower(hash) = lower(?)';
    if (profileId != null) {
      where += ' AND profile_id = ?';
      params.push(profileId);
    }
    const row = this.db.prepare(`SELECT * FROM downloads ${where} ORDER BY id ASC LIMIT 1`).get(...params);
    return normalizeDownloadRow(row);
  }

  findDownloadByPutioTransferId(putioTransferId, { profileId } = {}) {
    const params = [putioTransferId];
    let where = 'WHERE putio_transfer_id = ?';
    if (profileId != null) {
      where += ' AND profile_id = ?';
      params.push(profileId);
    }
    const row = this.db.prepare(`SELECT * FROM downloads ${where} LIMIT 1`).get(...params);
    return normalizeDownloadRow(row);
  }

  findDownload(identifier, { profileId } = {}) {
    if (identifier == null) return undefined;
    if (typeof identifier === 'number') {
      const row = this.findDownloadById(identifier);
      return profileId == null || row?.profile_id === profileId ? row : undefined;
    }
    const value = String(identifier);
    if (/^\d+$/.test(value)) {
      const row = this.findDownloadById(Number(value));
      if (row && (profileId == null || row.profile_id === profileId)) return row;
      return this.findDownloadByHash(value, { profileId });
    }
    return this.findDownloadByHash(value, { profileId });
  }

  listActiveDownloads({ profileId } = {}) {
    const params = [];
    let where = 'removed_at IS NULL';
    if (profileId != null) {
      where += ' AND profile_id = ?';
      params.push(profileId);
    }
    return this.db.prepare(`SELECT * FROM downloads WHERE ${where} ORDER BY id ASC`)
      .all(...params)
      .map(normalizeDownloadRow);
  }

  listRemovedDownloads() {
    return this.db.prepare('SELECT * FROM downloads WHERE removed_at IS NOT NULL ORDER BY id ASC')
      .all()
      .map(normalizeDownloadRow);
  }

  markDownloadRemoved(id) {
    this.db.prepare(`
      UPDATE downloads
      SET removed_at = ?, lifecycle = 'removed', updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), id);
  }

  // The only delete. There is no separate remote record to orphan any more:
  // the download row is the remote row.
  deleteDownload(id) {
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  deleteDownloadFile(id) {
    this.db.prepare('DELETE FROM download_files WHERE id = ?').run(id);
  }

  // A file deleted from the dashboard but kept on put.io is tombstoned (status='deleted')
  // so the downloader does not re-fetch it. Once its download is 'processed' the download
  // path never revisits it (see pollOnce / prepareTransfer), so the tombstone is dead weight
  // and is hard-deleted here to keep the table from accumulating rows over time.
  purgeDeletedFilesForProcessedDownloads() {
    const result = this.db.prepare(`
      DELETE FROM download_files
      WHERE status = 'deleted'
        AND download_id IN (
          SELECT id FROM downloads
          WHERE lifecycle = 'processed' AND removed_at IS NULL
        )
    `).run();
    return result.changes;
  }

  upsertDownloadFile(input) {
    const timestamp = nowIso();
    const existing = this.findDownloadFileByPutioId(input.putio_file_id, input.download_id);
    if (!existing) {
      const result = this.db.prepare(`
        INSERT INTO download_files (
          download_id, putio_file_id, relative_path, size, downloaded_bytes, download_speed,
          status, attempts, error_string, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.download_id,
        input.putio_file_id,
        input.relative_path,
        input.size ?? 0,
        input.downloaded_bytes ?? 0,
        input.download_speed ?? 0,
        input.status ?? 'pending',
        input.attempts ?? 0,
        input.error_string ?? '',
        timestamp,
        timestamp,
      );
      return this.findDownloadFileById(Number(result.lastInsertRowid));
    }

    this.db.prepare(`
      UPDATE download_files
      SET download_id = ?, relative_path = ?, size = ?,
          downloaded_bytes = CASE
            WHEN status IN ('complete', 'deleted') THEN downloaded_bytes
            ELSE ?
          END,
          download_speed = CASE
            WHEN status = 'deleted' THEN 0
            ELSE ?
          END,
          status = CASE
            WHEN status IN ('complete', 'deleted') THEN status
            ELSE ?
          END,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.download_id,
      input.relative_path,
      input.size ?? existing.size,
      input.downloaded_bytes ?? existing.downloaded_bytes,
      input.download_speed ?? existing.download_speed ?? 0,
      input.status ?? existing.status,
      timestamp,
      existing.id,
    );
    return this.findDownloadFileById(existing.id);
  }

  findDownloadFileById(id) {
    const row = this.db.prepare('SELECT * FROM download_files WHERE id = ?').get(id);
    return normalizeFileRow(row);
  }

  // putio_file_id is unique only within a download, so the id-less branch can
  // legitimately match several rows. It is a test and debug affordance; every
  // caller in src/ passes the download id.
  findDownloadFileByPutioId(putioFileId, downloadId) {
    const row = downloadId == null
      ? this.db.prepare('SELECT * FROM download_files WHERE putio_file_id = ? ORDER BY id ASC LIMIT 1').get(putioFileId)
      : this.db.prepare('SELECT * FROM download_files WHERE putio_file_id = ? AND download_id = ?').get(putioFileId, downloadId);
    return normalizeFileRow(row);
  }

  listFilesForDownload(downloadId) {
    return this.db.prepare(`
      SELECT * FROM download_files
      WHERE download_id = ?
        AND status != 'deleted'
      ORDER BY relative_path ASC
    `).all(downloadId).map(normalizeFileRow);
  }

  listPendingFiles(limit = 100) {
    return this.db.prepare(`
      SELECT f.*, d.category, d.name AS download_name, d.hash AS download_hash
      FROM download_files f
      JOIN downloads d ON d.id = f.download_id
      WHERE f.status IN ('pending', 'failed')
        AND d.removed_at IS NULL
      ORDER BY f.id ASC
      LIMIT ?
    `).all(limit).map(normalizeFileRow);
  }

  updateDownloadFile(id, patch) {
    const existing = this.findDownloadFileById(id);
    if (!existing) return undefined;
    if (existing.status === 'deleted' && patch.status !== 'deleted') return existing;

    const allowed = ['downloaded_bytes', 'download_speed', 'status', 'attempts', 'error_string'];
    const keys = allowed.filter((key) => Object.hasOwn(patch, key));
    if (keys.length === 0) return this.findDownloadFileById(id);
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => patch[key]);
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE download_files SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findDownloadFileById(id);
  }

  markDownloadFileDeleted(id) {
    return this.updateDownloadFile(id, {
      downloaded_bytes: 0,
      download_speed: 0,
      status: 'deleted',
      error_string: '',
    });
  }

  getDownloadFileStats(downloadId) {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_files,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
        COALESCE(SUM(size), 0) AS total_size,
        COALESCE(SUM(downloaded_bytes), 0) AS downloaded_size
      FROM download_files
      WHERE download_id = ?
        AND status != 'deleted'
    `).get(downloadId);
  }
}
