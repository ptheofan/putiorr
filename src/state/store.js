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
import { GRAB_PROFILE_TYPE } from '../web/constants.js';
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
    -- The folder this download's files went into, frozen the first time it was
    -- staged. put.io renames transfers and the name column follows the rename;
    -- this does not, because the files on disk do not move either.
    staging_folder TEXT NOT NULL DEFAULT '',
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
    -- The id torrent-add handed the *arr apps. They poll torrent-get with it
    -- forever, so reassigning a quarantined row has to give it back rather
    -- than mint a new one (risk R4).
    legacy_download_id INTEGER,
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
    -- The Putiorr Grab profile that takes a browser grab no profile's
    -- browser_domains claimed. At most one row may hold it; the store enforces
    -- that rather than a unique index, because the refusal has to name the
    -- profile that already holds it and a constraint failure names a column.
    browser_catch_all INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const PROFILES_RPC_PATH_INDEX_DDL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_rpc_path
    ON profiles(rpc_path) WHERE rpc_path IS NOT NULL;
`;

// The tables the downloads collapse replaced, in the order they are dropped:
// children first, because dropping a parent cascades into them.
const LEGACY_DOWNLOAD_TABLES = ['association_files', 'transfer_associations', 'transfer_files', 'transfers'];

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

// Which upgrade summary the user has read, kept apart from the reports it
// refers to so that dismissing the sentence never destroys the record of the
// run.
const SCHEMA_MIGRATION_SUMMARY_DISMISSED_SETTING = 'schema_migration_summary_dismissed';

// The identity of the summary sentence: both reports it is built from, each by
// version and by the moment it was written. A later migration writes a new
// report, so the key moves and an older dismissal no longer matches it.
function schemaMigrationSummaryKey({ downloads, profiles }) {
  const part = (name, report) => (report ? `${name}:${report.version ?? 0}@${report.at ?? ''}` : '');
  const key = [part('downloads', downloads), part('profiles', profiles)].filter(Boolean).join('|');
  return key || undefined;
}

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
  const browserCatchAll = toBool(row.browser_catch_all);
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
    browser_catch_all: browserCatchAll,
    browserCatchAll,
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

// Stored absolute, always. Every local path a download resolves is built on
// this column, and a relative one resolves against whatever the process has as
// its working directory — a different answer per launch, and one that makes
// resolveInside's containment check meaningless. The HTTP API already resolved
// what it accepted; seeds from PUTIORR_PROFILES_JSON went in raw.
function profileDownloadAt(input) {
  const value = input.download_at ?? input.downloadAt ?? input.local_path ?? input.localPath;
  if (value === undefined || value === null) return value;
  const text = String(value).trim();
  return text ? path.resolve(text) : text;
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
function profileBrowserDomainsList(input) {
  const domains = input.browser_domains ?? input.browserDomains;
  return domains === undefined ? undefined : normalizeBrowserDomains(domains).domains;
}

function profileBrowserDomainsPatch(input) {
  const domains = profileBrowserDomainsList(input);
  return domains === undefined ? undefined : JSON.stringify(domains);
}

// Reads the same shapes profileAutoRemoveCompleted does, for the same reason:
// PUTIORR_PROFILES_JSON writes '1' and 'true' straight in, and the wizard sends
// a real boolean. `undefined` means "not mentioned", which leaves a stored flag
// alone on an update.
function profileBrowserCatchAll(input) {
  const value = input.browser_catch_all ?? input.browserCatchAll;
  if (value === undefined) return undefined;
  return value === true || value === 1 || value === '1' || value === 'true';
}

// "Set the catch-all on this profile, and clear whichever profile holds it."
// Read in the same shapes the flag itself is, for the same reason. Absent
// means the write refuses a second catch-all exactly as it always has: the
// takeover is an intent the caller has to state, never a default.
function profileTakeOverCatchAll(input) {
  const value = input.takeOverCatchAll ?? input.take_over_catch_all;
  return value === true || value === 1 || value === '1' || value === 'true';
}

// Which profile the caller was shown holding the catch-all. A takeover is
// answered against the database as it is now, not as it was when the refusal
// was rendered, and clearing a profile the user never saw is a side effect
// they never agreed to — so the write refuses when the holder has changed.
// Absent means "whichever profile holds it", which is what a seed or a script
// with nobody to have shown anything to is asking for.
function profileTakeOverCatchAllFrom(input) {
  const value = input.takeOverCatchAllFrom ?? input.take_over_catch_all_from;
  if (value == null || value === '') return undefined;
  return Number(value);
}

// The refusal, in both the forms it has to take. The sentence is what every
// human-facing surface has always shown and is unchanged; `catchAllHolder` is
// what a caller acts on, because offering "make this the fallback instead" out
// of prose means parsing a sentence for a profile name, and a client that
// string-matches its server is a client that breaks on the next reword.
export function pluralizeDownloads(count) {
  return `${count} download${count === 1 ? '' : 's'}`;
}

// Two folders naming the same directory are not a change, and the wizard sends
// the folder back on every save — so an unchanged value must never read as one.
// Resolved on both sides rather than compared as text: `/downloads` and
// `/downloads/` are one directory, and a caller that reaches writeProfilePatch
// without going through updateProfile's normalization is compared on the same
// terms as one that did. Nothing beyond that is followed: a symlink or a bind
// mount naming the same directory counts as a different one, exactly as it does
// for TransferService.reassignTargetsFor, and the refusal says so.
function sameDownloadFolder(left, right) {
  const from = String(left ?? '').trim();
  const to = String(right ?? '').trim();
  // path.resolve('') is the working directory, which would make "no folder at
  // all" equal to whatever the process happens to be sitting in.
  if (!from || !to) return from === to;
  return path.resolve(from) === path.resolve(to);
}

function downloadFolderLockedError(profile, count, from, to) {
  const error = new Error(
    `RR profile ${profile.name} still owns ${pluralizeDownloads(count)} staged under`
    + ` ${from || '(nothing)'}, and nothing here moves files: pointing it at ${to || '(nothing)'}`
    + ' would leave their files where they are and putiorr looking somewhere else — a finished'
    + ' download whose files are missing is deleted and cancelled on put.io. Let these downloads'
    + ' finish and leave putiorr, or delete them from the dashboard — the delete dialog can take'
    + ' their files with them — and the folder is free to change. The two folders are compared as'
    + ' they are written, so a symlink or a bind mount naming the same directory counts as a'
    + ' different one.',
  );
  // Not prose to be parsed: the wizard offers to put the folder back, and it
  // needs the folder this profile still has and how many downloads are behind
  // the refusal to say what that costs.
  error.downloadFolderLock = {
    profile: { id: profile.id, name: profile.name },
    downloads: count,
    from,
    to,
  };
  return error;
}

function catchAllConflictError(holder) {
  const error = new Error(
    `${holder.name} already takes grabs from any site no other profile claims;`
    + ' untick it on that profile first',
  );
  error.catchAllHolder = { id: holder.id, name: holder.name };
  return error;
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

// The preset defaults that used to live in the browser only. A profile created
// through POST /api/profiles or seeded from PUTIORR_PROFILES_JSON never went
// through the wizard, so a default kept in src/web/constants.js was a default
// two of the three doors did not have. Both presets want it for the same
// reason: nothing imports their downloads, so nobody would ever clear them.
function profileDefaultsToAutoRemoveCompleted(input) {
  // Only the type says a profile is a Putiorr Grab one — the server refuses a
  // browser grab to any other preset — so nothing looser is consulted here.
  if (profileTypeValue(input) === GRAB_PROFILE_TYPE) return true;
  // Prowlarr's is matched loosely because the preset predates the type column:
  // profiles set up before it exist with type 'custom' and prowlarr everywhere
  // else.
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
    this.ensureColumn('profiles', 'browser_catch_all', 'INTEGER NOT NULL DEFAULT 0');
    // Everything below only exists on a database written by an older putiorr.
    // A fresh database never creates these tables, and PRAGMA table_info on a
    // table that is not there answers with an empty list rather than an error —
    // so an ungated ensureColumn would ALTER a table that does not exist, and
    // an ungated SELECT would throw on the first boot of a new install.
    //
    // Gated on the collapse guard as well as on the table, so that a `transfers`
    // that reappears after a downgrade-and-upgrade is left strictly alone: the
    // legacy hop has already happened, and touching the table again would be
    // writing to storage this version does not read.
    const collapsed = this.getSetting('downloads_schema_v1') === '1';
    if (!collapsed && this.hasTable('transfers')) {
      this.ensureColumn('transfers', 'profile_id', 'INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
      this.ensureColumn('transfers', 'completion_percent', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('transfers', 'putio_status_message', "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn('transfers', 'putio_peers', 'INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('transfers', 'putio_availability', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (!collapsed && this.hasTable('transfer_files')) {
      this.ensureColumn('transfer_files', 'download_speed', 'INTEGER NOT NULL DEFAULT 0');
    }
    if (!collapsed && this.hasTable('transfers')) {
      this.migrateTransferAssociations();
      // Must run before the collapse: it rewrites transfers.hash in place, and
      // after the collapse there is no transfers table left to rewrite.
      this.migrateMagnetTransferHashes();
    }
    this.migrateDownloadsCollapse();
    if (this.hasTable('downloads')) {
      this.ensureColumn('downloads', 'staging_folder', "TEXT NOT NULL DEFAULT ''");
      this.freezeStagedDownloadFolders();
    }
    this.migrateProfilesSchema();
    this.absolutizeProfileDownloadFolders();
    this.db.exec(PROFILES_RPC_PATH_INDEX_DDL);
    this.dropRetiredSettings();
    // Before the warning, so an empty set is reclaimed rather than reported.
    this.reclaimEmptyLegacyTables();
    this.warnAboutDowngradedWrites();
  }

  // Settings rows a feature that no longer exists left behind. Nothing reads
  // them and nothing would ever rewrite them, so without this they outlive the
  // feature on every install that ran the version which wrote them.
  //
  // `adoption_notices` held the put.io transfers a poll could not attribute to
  // one RR profile, which the dashboard turned into a notice telling the user
  // to give every profile its own put.io folder — in the very setup the README
  // recommends. A transfer putiorr cannot place is now simply left alone.
  //
  // Deleting a key that is not there is not an error, so this is a no-op on a
  // database that never had it — which is every fresh install, and every boot
  // after the first.
  dropRetiredSettings() {
    this.deleteSetting('adoption_notices');
  }

  // Every download an older build already staged, frozen to the name it was
  // staged under. For those rows an empty staging folder does not mean "not
  // staged yet" — it means "staged, and we no longer know where", which
  // resolves to whatever put.io calls the transfer today. A rename then points
  // putiorr at an empty directory, the sweep reads that as files the user
  // deleted, and it deletes the download and cancels the put.io transfer.
  //
  // Only rows that have been written to disk are frozen. A 'remote' transfer
  // has nothing on disk yet, so it takes whatever name it has when it is first
  // staged.
  //
  // Guarded by a settings key, because "a no-op on every boot after the first"
  // was a claim about the data, not about the code, and the data stops
  // co-operating the moment anything else can produce the same shape: a
  // download whose staging claim was refused sits at 'downloading' with no
  // folder, and an unguarded rerun froze it to the name the refusal had just
  // asked the user to change. This is a one-way upgrade step; it runs once.
  freezeStagedDownloadFolders() {
    if (this.getSetting('downloads_staging_folder_backfill') === '1') return;
    const result = this.db.prepare(`
      UPDATE downloads
      SET staging_folder = name
      WHERE staging_folder = '' AND lifecycle IN ('downloading', 'processed')
    `).run();
    this.setSetting('downloads_staging_folder_backfill', '1');
    if (result.changes > 0) {
      logger.info('froze the staging folder of downloads staged before the upgrade', {
        downloads: Number(result.changes),
      });
    }
  }

  // Rows written before profiles stored their folder absolute. Every local
  // path a download resolves is built on this column, and phase 4 refuses a
  // relative root outright rather than resolving it against whatever the
  // process has as its working directory — so a profile seeded with a relative
  // folder would fail every download instead of quietly writing next to the
  // process. Frozen here to the same directory it has been resolving to.
  absolutizeProfileDownloadFolders() {
    const rows = this.db.prepare("SELECT id, name, download_at FROM profiles WHERE download_at <> ''").all();
    for (const row of rows) {
      if (path.isAbsolute(row.download_at)) continue;
      const resolved = path.resolve(row.download_at);
      this.db.prepare('UPDATE profiles SET download_at = ?, updated_at = ? WHERE id = ?')
        .run(resolved, nowIso(), row.id);
      logger.warn('rewrote a relative RR profile download folder as absolute', {
        profile: row.name,
        from: row.download_at,
        to: resolved,
      });
    }
  }

  // The tables the collapse dropped, back again because an older putiorr ran
  // against this database and recreated them as part of its own schema setup.
  // Starting one is enough to do it — a stale `:latest` that resolves to 2.0.x
  // recreates them and writes nothing — so their mere presence says nothing
  // about whether anything was written.
  //
  // Empty, they hold no data anyone could lose, and the state the migration
  // meant to leave is the one without them. Dropping them is what makes the
  // alarm below impossible to raise over nothing: it fired on presence alone,
  // told the user 0 downloads were unreadable, and sent them to restore a
  // pre-upgrade backup that would have cost them every download since.
  //
  // All four have to be empty. `transfers` alone being empty is not "nothing
  // was written" while a child still holds rows, and dropping a parent performs
  // an implicit DELETE FROM that cascades.
  reclaimEmptyLegacyTables() {
    if (this.getSetting('downloads_schema_v1') !== '1') return false;
    const present = LEGACY_DOWNLOAD_TABLES.filter((name) => this.hasTable(name));
    if (present.length === 0) return false;
    if (present.some((name) => this.countRows(name) > 0)) return false;
    // Dependency order, as in the collapse.
    this.db.exec(`
      DROP TABLE IF EXISTS association_files;
      DROP TABLE IF EXISTS transfer_associations;
      DROP TABLE IF EXISTS transfer_files;
      DROP TABLE IF EXISTS transfers;
    `);
    logger.info('dropped empty legacy transfer tables an older putiorr recreated', {
      tables: present,
      note: 'they held no rows, so nothing was written and nothing was lost',
    });
    return true;
  }

  // The migration is one-way. A user who rolls back to 2.0.x runs an older
  // putiorr that recreates `transfers` and writes into it, and the rows it adds
  // are invisible to every later version — silently, because a table nobody
  // reads raises nothing by itself. Say so loudly, but only once there is
  // something to say: the empty case is reclaimed above, so reaching this means
  // rows really are stranded.
  warnAboutDowngradedWrites() {
    if (this.getSetting('downloads_schema_v1') !== '1') return;
    if (!this.hasTable('transfers')) return;
    const stranded = this.legacyRowsAfterMigration();
    if (!stranded) return;
    logger.warn('legacy transfer tables reappeared after the downloads schema migration', {
      strandedLegacyRows: stranded,
      consequence: 'an older putiorr has written downloads this version cannot see',
      fix: 'restore the .pre-downloads-*.bak written before the migration, or delete the legacy tables',
    });
  }

  countRows(name) {
    return Number(this.db.prepare(`SELECT COUNT(*) AS total FROM ${name}`).get().total);
  }

  // The machine-readable record of what each schema migration did, so the
  // dashboard can show an upgrade's fallout instead of leaving it in the log.
  schemaMigrationReports() {
    const parse = (key) => {
      const raw = this.getSetting(key);
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    };
    const downloads = parse('downloads_schema_v1_report');
    const profiles = parse('profiles_schema_v2_report');
    const summaryKey = schemaMigrationSummaryKey({ downloads, profiles });
    return {
      downloads,
      profiles,
      // Computed live rather than recorded, because it describes what is in
      // the database right now: legacy tables that reappeared after the
      // migration mean an older putiorr has written downloads this version
      // cannot see.
      legacyTablesPresent: this.legacyRowsAfterMigration(),
      // Which upgrade the summary on the dashboard is about, and whether the
      // user has already read it. The reports themselves are never deleted —
      // they are the record of the run, and a support question a year later
      // still wants them.
      summaryKey,
      summaryDismissed: Boolean(summaryKey)
        && this.getSetting(SCHEMA_MIGRATION_SUMMARY_DISMISSED_SETTING) === summaryKey,
    };
  }

  // The summary is a fact about an upgrade that has finished: nothing to act
  // on, so it can be put away. What is recorded is the identity of the report
  // it was put away for, not a bare "hide it" — the next upgrade writes a new
  // report, the key moves, and the sentence comes back on its own. The
  // quarantine warning beside it is unresolved work and has no dismissal at
  // all.
  dismissSchemaMigrationSummary(expectedKey) {
    const summaryKey = this.schemaMigrationReports().summaryKey;
    if (!summaryKey) throw new Error('There is no database upgrade summary to dismiss');
    if (expectedKey !== undefined && expectedKey !== summaryKey) {
      throw new Error(
        'The database upgrade summary has changed since this page was loaded. Reload the dashboard and read it again.',
      );
    }
    this.setSetting(SCHEMA_MIGRATION_SUMMARY_DISMISSED_SETTING, summaryKey);
    return this.schemaMigrationReports();
  }

  // Staging folders more than one live download resolves to. put.io does not
  // deduplicate transfer names, and the staging folder is the name, so two
  // distinct transfers can land on one folder — which is refused rather than
  // interleaved, and has to be visible somewhere the user looks.
  stagingCollisions() {
    const raw = this.getSetting('staging_collisions');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveStagingCollisions(collisions) {
    if (!Array.isArray(collisions) || collisions.length === 0) {
      this.deleteSetting('staging_collisions');
      return;
    }
    this.setSetting('staging_collisions', JSON.stringify(collisions));
  }

  legacyRowsAfterMigration() {
    if (this.getSetting('downloads_schema_v1') !== '1') return undefined;
    if (!this.hasTable('transfers')) return undefined;
    try {
      return Number(this.db.prepare('SELECT COUNT(*) AS total FROM transfers').get().total);
    } catch {
      // A table of that name with a shape we cannot count is still a table
      // that should not be there.
      return 0;
    }
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
      this.recordStrandedLegacyRows();
      this.setSetting('downloads_schema_v1', '1');
      return;
    }

    const backup = this.backupBeforeCollapse();
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
        throw this.collapseFailure(error, backup);
      }
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // A failed collapse throws out of the constructor, so putiorr does not start
  // — correctly, because the alternative is running against a database it has
  // half-understood. But the bare SQLite text ("UNIQUE constraint failed:
  // downloads.putio_transfer_id") names neither the row that caused it nor the
  // backup taken seconds earlier, and it repeats on every boot forever. Both
  // belong in the one message the user will ever see.
  collapseFailure(error, backup) {
    const failure = new Error(
      `putiorr could not migrate its database to the downloads schema: ${error.message}.`
      + ' The database was left exactly as it was, so this will repeat on every start until it is'
      + ` fixed.${backup ? ` A backup taken before the attempt is at ${backup}.` : ''}`
      + ' Please report this with the log line above.',
    );
    failure.cause = error;
    return failure;
  }

  // `transfers` without `transfer_associations` means the association hop
  // already ran and its output is gone — a partially restored or hand-edited
  // database. The rows left in `transfers` are invisible to this version, and
  // saying so only in the log means nobody finds out.
  recordStrandedLegacyRows() {
    if (!this.hasTable('transfers')) return;
    const stranded = Number(this.db.prepare('SELECT COUNT(*) AS total FROM transfers').get().total);
    if (stranded === 0) return;
    this.setSetting('downloads_schema_v1_report', JSON.stringify({
      version: 1,
      at: nowIso(),
      migrated: 0,
      adoptedBySoleProfile: 0,
      extraAssociations: [],
      noPutioId: [],
      ownerless: [],
      droppedFiles: 0,
      strandedLegacyRows: stranded,
    }));
    logger.warn('legacy transfers were left behind by the downloads schema migration', {
      strandedLegacyRows: stranded,
      consequence: 'these downloads are not visible to this version of putiorr',
      fix: 'restore a backup taken before the upgrade, or re-add them',
    });
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
        legacy_download_id, legacy_download_dir, quarantined_at, reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

      this.insertCollapsedDownload(insertDownload, row, profileId);
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

  // Wrapped so a constraint that fires here names the row that caused it. The
  // migration filters every NOT NULL column before inserting, so this can only
  // be a bug in the collapse or a database shape the fixtures do not cover —
  // and either way the user's only route to a fix is telling us which row.
  insertCollapsedDownload(statement, row, profileId) {
    try {
      statement.run(
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
    } catch (error) {
      throw new Error(
        `${error.message} while migrating download ${row.id} `
        + `(put.io transfer ${row.putio_transfer_id}, ${row.name || 'unnamed'})`,
        { cause: error },
      );
    }
  }

  // The design asks the log to name the profile and the local path so a user
  // can find the files a quarantined row left behind. The stored download_dir
  // is what the *arr asked for, which is the right answer when the owner is
  // unknown; when it is known, the folder the files actually staged into is
  // the profile's own.
  //
  // Absolute or nothing. This used to fall through to a bare row.name — the
  // shape a poll-adopted transfer leaves behind, since nothing ever asked it
  // for a download-dir — and a relative path resolves against process.cwd()
  // wherever it is later used, which satisfies resolveInside's containment
  // check trivially. The quarantine's delete then recursively removed
  // <cwd>/<name>. An empty string is the honest answer for "putiorr does not
  // know where these files are", and every consumer has to handle it anyway.
  legacyLocalPath(row, owner) {
    const candidate = owner?.download_at
      ? path.join(owner.download_at, row.category ?? '', row.name ?? '')
      : (row.download_dir ? path.join(row.download_dir, row.name ?? '') : '');
    return path.isAbsolute(candidate) ? candidate : '';
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
      row.id ?? null,
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
        client_port, client_use_ssl, browser_domains, browser_catch_all, enabled,
        created_at, updated_at
      )
      SELECT
        id, name, type, slug, download_profile_id, auto_remove_completed,
        putio_folder_name, putio_folder_id, download_at,
        CASE WHEN lower(type) = 'grab' THEN NULL ELSE rpc_path END,
        client_host, client_port, client_use_ssl, browser_domains,
        browser_catch_all, enabled, created_at, updated_at
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
    if (this.listProfiles().length === 0) {
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
    const browserCatchAll = profileBrowserCatchAll(input) ?? false;
    const type = profileTypeValue(input);
    return this.writeProfileWithCatchAll({ type, catchAll: browserCatchAll, input }, () => {
      this.assertNoSharedBrowserSites(type, profileBrowserDomainsList(input));
      const result = this.db.prepare(`
        INSERT INTO profiles (
          name, type, slug, download_profile_id, auto_remove_completed, putio_folder_name, putio_folder_id,
          download_at, rpc_path, client_host, client_port, client_use_ssl, browser_domains,
          browser_catch_all, enabled, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.name,
        type,
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
        browserCatchAll ? 1 : 0,
        input.enabled === false ? 0 : 1,
        timestamp,
        timestamp,
      );
      return this.findProfileById(Number(result.lastInsertRowid));
    });
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
    const nextBrowserDomains = profileBrowserDomainsList(patch);
    if (nextBrowserDomains !== undefined) normalizedPatch.browser_domains = JSON.stringify(nextBrowserDomains);
    const nextBrowserCatchAll = profileBrowserCatchAll(patch);
    if (nextBrowserCatchAll !== undefined) normalizedPatch.browser_catch_all = nextBrowserCatchAll;
    // Both writes land in the same column and every read compares it exactly,
    // so an update normalizes the preset the way createProfile does. A patch
    // that does not mention it leaves the stored one alone.
    if (patch.type !== undefined) normalizedPatch.type = profileTypeValue(patch);
    // Checked against the row this update would leave behind, not against the
    // patch: switching a profile that already carries the flag onto the grab
    // preset is the moment the flag starts to route grabs, and the patch that
    // does it need not mention the flag at all.
    const nextType = normalizedPatch.type ?? existing.type;
    return this.writeProfileWithCatchAll({
      type: nextType,
      catchAll: nextBrowserCatchAll ?? existing.browser_catch_all,
      exceptId: id,
      input: patch,
    }, () => {
      // Checked against the row this update would leave behind, for the same
      // reason: switching a profile that already lists sites onto the grab
      // preset is the moment those sites start to route grabs, and the patch
      // that does it need not mention them.
      this.assertNoSharedBrowserSites(nextType, nextBrowserDomains ?? existing.browser_domains, id);
      return this.writeProfilePatch(id, normalizedPatch, existing);
    });
  }

  // The column write itself, split out so updateProfile's checks can wrap it in
  // the transaction a catch-all takeover needs. The allow-list is what keeps
  // takeOverCatchAll — an intent, not a column — out of the UPDATE.
  writeProfilePatch(id, normalizedPatch, existing) {
    this.assertDownloadFolderNotHeldByDownloads(id, normalizedPatch, existing);
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
      'browser_catch_all',
      'enabled',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(normalizedPatch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => (
      key === 'enabled' || key === 'client_use_ssl' || key === 'auto_remove_completed'
      || key === 'browser_catch_all'
        ? (normalizedPatch[key] ? 1 : 0)
        : normalizedPatch[key]
    ));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE profiles SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findProfileById(id);
  }

  // Issue #68. A download's files live at `<download_at>/<category>/<frozen
  // staging folder>` and nothing here moves anything on disk, so moving the
  // root points putiorr at a directory the files are not in — and the next
  // poll reads a finished download whose files are missing as user-deleted:
  // pruneProcessedTransfersMissingLocalData cancels the put.io transfer,
  // deletes the put.io file and drops the row, leaving the files orphaned with
  // nothing left to clean them up. Freezing the staging folder made a put.io
  // rename safe; it says nothing about the root moving out from under it.
  //
  // The same rule TransferService.reassignTargetsFor enforces from the other
  // side — there a download may not move to a profile with a different
  // download_at — and refused rather than migrated for the reason that one is:
  // putiorr does not move users' files.
  //
  // It sits on the column write rather than at the HTTP boundary, exactly as
  // assertSingleCatchAll does, so every door pays it: the wizard, PUT
  // /api/profiles/:id, and any seed or internal caller that updates an existing
  // profile all arrive here. Inside updateProfile's transaction, too, so a
  // refusal takes the catch-all clear back with it and no half-written profile
  // survives the save.
  //
  // Only a change is refused; a patch that does not mention the folder, or
  // sends back the one already stored, is an ordinary save.
  assertDownloadFolderNotHeldByDownloads(id, normalizedPatch, existing) {
    if (!Object.hasOwn(normalizedPatch, 'download_at')) return;
    const from = String(existing?.download_at ?? '');
    const to = String(normalizedPatch.download_at ?? '');
    if (sameDownloadFolder(from, to)) return;
    const held = this.countDownloadsForProfile(id);
    if (held === 0) return;
    throw downloadFolderLockedError(existing ?? { id, name: `#${id}` }, held, from, to);
  }

  // Every row that names this profile, tombstoned ones included: "remove from
  // putiorr, keep the files" leaves the row removed and the folder full, and
  // the staging claims (TransferService.downloadsStagingAt) still count it.
  //
  // Lifecycle is deliberately not a filter. 'remote' means putiorr has not
  // started fetching, not that there is nothing on disk: the staging folder is
  // claimed — and a part-file resumed from — while the row is still 'remote'
  // (DownloadManager.prepareTransfer), the *arr has already been told the
  // download-dir the current root derives, and nothing records the files a user
  // put there themselves. A distinction that unreliable is not one to hand a
  // user's files to.
  countDownloadsForProfile(profileId) {
    const row = this.db.prepare('SELECT COUNT(*) AS held FROM downloads WHERE profile_id = ?').get(profileId);
    return Number(row?.held ?? 0);
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

  // The Putiorr Grab profile that takes a browser grab no profile's browser
  // sites claimed. Only the grab preset is considered, because that is the
  // only set /api/grab resolves within: the flag on an *arr profile claims
  // nothing, so it must not block the profile that would claim something.
  //
  // Enabled is deliberately not a filter, exactly as it is not one for the site
  // match. A disabled profile still holds the role, and the grab is refused by
  // name rather than routed into a folder the user never chose.
  //
  // Ordered by id and capped at one so a database that somehow holds two —
  // hand-edited, or written before this rule existed — still answers every grab
  // the same way instead of by whatever order SQLite felt like.
  findCatchAllGrabProfile({ exceptId = 0 } = {}) {
    const row = this.db.prepare(`
      SELECT * FROM profiles
      WHERE browser_catch_all = 1 AND lower(type) = ? AND id <> ?
      ORDER BY id ASC
      LIMIT 1
    `).get(GRAB_PROFILE_TYPE, Number(exceptId) || 0);
    return normalizeProfileRow(row);
  }

  // Two catch-all grab profiles would make every unclaimed site ambiguous, and
  // this codebase refuses rather than guessing which folder a download lands in.
  //
  // The check is here rather than in the API's normalizeProfileInput because it
  // has to see the other rows, and because every door that can set the flag
  // goes through createProfile or updateProfile: the HTTP API, the wizard
  // behind it, PUTIORR_PROFILES_JSON, and createDefaultProfile alike. Putting
  // it at the API boundary would leave the seed paths free to write a second one.
  assertSingleCatchAll(type, catchAll, exceptId = 0) {
    if (!catchAll || type !== GRAB_PROFILE_TYPE) return;
    const holder = this.findCatchAllGrabProfile({ exceptId });
    if (!holder) return;
    throw catchAllConflictError(holder);
  }

  // The takeover, sat where assertSingleCatchAll is and for the same reason:
  // it has to see the other rows, and every door that sets the flag comes
  // through createProfile or updateProfile. Without the intent the refusal is
  // untouched — "exactly one profile holds it, or none does" is the invariant
  // either way, and only the number of saves it costs to move changes.
  //
  // One transaction around the clear and the write, so there is never a moment
  // where two profiles hold it or none does: a write that fails afterwards —
  // a duplicate slug, a browser site another profile claims — rolls the clear
  // back with it.
  //
  // The holder is re-read inside that transaction rather than trusted from the
  // refusal that prompted this: between the message being rendered and the
  // link being clicked, the other profile may have been changed by somebody
  // else. If the conflict is gone the save is just a save; if a profile the
  // caller was never shown holds it now, the refusal comes back naming that
  // one instead of quietly clearing it.
  writeProfileWithCatchAll({ type, catchAll, exceptId = 0, input }, write) {
    if (!profileTakeOverCatchAll(input)) {
      this.assertSingleCatchAll(type, catchAll, exceptId);
      return write();
    }
    return this.withTransaction(() => {
      const holder = catchAll && type === GRAB_PROFILE_TYPE
        ? this.findCatchAllGrabProfile({ exceptId })
        : undefined;
      if (!holder) return write();
      const expected = profileTakeOverCatchAllFrom(input);
      if (expected !== undefined && holder.id !== expected) throw catchAllConflictError(holder);
      this.db.prepare('UPDATE profiles SET browser_catch_all = 0, updated_at = ? WHERE id = ?')
        .run(nowIso(), holder.id);
      const saved = write();
      if (!saved) return saved;
      // Not a column, and never stored: a profile the caller may not even have
      // on screen just stopped being the fallback, and the confirmation has to
      // be able to name it.
      const takenFrom = { id: holder.id, name: holder.name };
      return { ...saved, catch_all_taken_from: takenFrom, catchAllTakenFrom: takenFrom };
    });
  }

  // The Putiorr Grab profile that lists `site` as one of its browser sites,
  // compared as the exact entry rather than by what it covers: "x.example" and
  // "*.x.example" are two different claims that resolve in a defined order, and
  // only the identical entry on two profiles is ambiguous.
  //
  // Enabled is deliberately not a filter, exactly as it is not one for a grab:
  // a disabled profile still holds its sites.
  findProfileClaimingBrowserSite(site, { exceptId = 0 } = {}) {
    if (!site) return undefined;
    return this.db.prepare(`
      SELECT * FROM profiles
      WHERE lower(type) = ? AND id <> ?
      ORDER BY id ASC
    `)
      .all(GRAB_PROFILE_TYPE, Number(exceptId) || 0)
      .map(normalizeProfileRow)
      .find((profile) => profile.browser_domains.includes(site));
  }

  // Two grab profiles holding the same browser site would make every grab from
  // it come down to creation order, and this codebase refuses rather than
  // guessing which folder a download lands in.
  //
  // Coverage that merely overlaps is not a conflict and is not refused here:
  // "dl.x.example" on one profile and "*.x.example" on another is a
  // configuration that says something, and matchProfileByHost resolves it —
  // exact first, then the longest wildcard base.
  //
  // The check is here rather than in the API's normalizeProfileInput for the
  // reasons assertSingleCatchAll is: it has to see the other rows, and every
  // door that writes a browser site goes through createProfile or
  // updateProfile — the HTTP API, the wizard behind it, the toolbar popup's
  // claim endpoint, and PUTIORR_PROFILES_JSON alike. At the API boundary the
  // seed paths would be free to write a duplicate.
  assertNoSharedBrowserSites(type, domains, exceptId = 0) {
    if (type !== GRAB_PROFILE_TYPE || !Array.isArray(domains)) return;
    for (const site of domains) {
      const holder = this.findProfileClaimingBrowserSite(site, { exceptId });
      if (holder) {
        throw new Error(
          `${holder.name} already claims ${site};`
          + ' remove the site there first if it should belong to this profile',
        );
      }
    }
  }

  // Enabled is deliberately not a filter here. A disabled profile still owns
  // its RPC path — disabling means it accepts no new work, not that it stopped
  // existing — and filtering it out made the request fall past the RPC route
  // into serveWeb, which answers any unknown path with index.html and HTTP
  // 200. Every *arr reads that as a successful grab.
  findProfileByRpcPath(rpcPath) {
    const row = this.db.prepare('SELECT * FROM profiles WHERE rpc_path = ?').get(rpcPath);
    return normalizeProfileRow(row);
  }

  // Every profile, always. The enabled-only default this used to carry is what
  // gave `enabled = 0` four meanings: each caller that forgot to opt out got a
  // profile that had silently ceased to exist, and the shared endpoint, the
  // site match and adoption each drew a different conclusion from that. A
  // profile that accepts no new work is still a profile, and the one door that
  // cares asks requireProfile.
  listProfiles() {
    return this.db.prepare('SELECT * FROM profiles ORDER BY id ASC')
      .all()
      .map(normalizeProfileRow);
  }

  // BEGIN IMMEDIATE fails inside an open transaction, and the profile writes
  // now take one of their own for a catch-all takeover — from paths a caller
  // is free to have wrapped already. Joining the open one keeps the write
  // atomic with respect to everything outside it, which is what the takeover
  // needs; it does not pretend to be a savepoint.
  withTransaction(fn) {
    return this.db.isTransaction ? fn() : this.transaction(fn);
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
      // An explicit id is only ever supplied by the quarantine repair path,
      // which is restoring the Transmission id an *arr is still polling with.
      // AUTOINCREMENT never reuses a value below its high-water mark, so a
      // restored id cannot collide with one handed out later.
      const restoredId = input.id == null ? undefined : Number(input.id);
      const result = this.db.prepare(`
        INSERT INTO downloads (
          ${restoredId === undefined ? '' : 'id, '}
          profile_id, putio_transfer_id, putio_file_id, save_parent_id, hash, name, source,
          source_type, category, lifecycle, putio_status, putio_status_message,
          putio_peers, putio_availability, percent_done, completion_percent,
          total_size, downloaded_ever, uploaded_ever, download_speed, upload_speed,
          eta, error, error_string, retry_count, created_at, updated_at
        )
        VALUES (${restoredId === undefined ? '' : '?, '}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ...(restoredId === undefined ? [] : [restoredId]),
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

    // Informational, never an identity, and corrected the moment put.io
    // reports a different one (design: "written when put.io reports it and
    // corrected on any later refresh that reports a different one"). An empty
    // input is not a correction: put.io reports no hash for a transfer it has
    // not started, and taking that would erase what the magnet already said.
    const nextHash = normalizeHash(input.hash) || existing.hash;

    this.db.prepare(`
      UPDATE downloads
      SET hash = ?, putio_file_id = ?, save_parent_id = ?, name = ?, source = ?, source_type = ?,
          category = ?, lifecycle = ?, putio_status = ?, putio_status_message = ?,
          putio_peers = ?, putio_availability = ?, percent_done = ?, completion_percent = ?,
          total_size = ?, downloaded_ever = ?, uploaded_ever = ?, download_speed = ?,
          upload_speed = ?, eta = ?, error = ?, error_string = ?, retry_count = ?,
          removed_at = CASE WHEN ? THEN NULL ELSE removed_at END,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextHash,
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
      'staging_folder',
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

  // A download whose hash put.io has not reported yet stores '', so an empty
  // needle would match an arbitrary one of them — and every hash lookup here
  // is a client naming a download it wants listed or removed. "I do not know
  // this download's hash" is not a way to address it.
  findDownloadByHash(hash, { profileId } = {}) {
    if (!normalizeHash(hash)) return undefined;
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

  // Everything one profile owns, tombstones included. Deleting a profile has to
  // account for every row that references it, and a tombstoned row references
  // it just as hard: ON DELETE RESTRICT does not care that the dashboard has
  // stopped showing it.
  listDownloadsForProfile(profileId) {
    return this.db.prepare('SELECT * FROM downloads WHERE profile_id = ? ORDER BY id ASC')
      .all(profileId)
      .map(normalizeDownloadRow);
  }

  // Ownership is resolved once and frozen (design rule 4), and this is the one
  // deliberate exception: the user is answering "who owns these now?" for a
  // profile that is about to stop existing. Nothing infers it.
  reassignDownloads(fromProfileId, toProfileId) {
    const result = this.db.prepare(`
      UPDATE downloads SET profile_id = ?, updated_at = ? WHERE profile_id = ?
    `).run(toProfileId, nowIso(), fromProfileId);
    return Number(result.changes ?? 0);
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
          -- 'complete' used to be terminal here, so a file whose local copy
          -- was deleted stayed complete forever and re-adding the release
          -- finalised it without downloading anything. The caller checks the
          -- disk, so its answer is the one that counts. 'deleted' is different:
          -- it is a decision the user made about a file put.io still has, and
          -- re-listing that file is not a reason to fetch it again.
          downloaded_bytes = CASE
            WHEN status = 'deleted' THEN downloaded_bytes
            ELSE ?
          END,
          download_speed = CASE
            WHEN status = 'deleted' THEN 0
            ELSE ?
          END,
          status = CASE
            WHEN status = 'deleted' THEN status
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

  // The file rows of a download are exactly what put.io lists for it. A row
  // for a file put.io no longer has is a job no worker can ever finish — it
  // 404s on every attempt — and it counts against the download's own totals,
  // so the download can never be complete either.
  deleteDownloadFilesNotIn(downloadId, putioFileIds) {
    const keep = (Array.isArray(putioFileIds) ? putioFileIds : []).filter((id) => id != null);
    // Nothing to keep is never a reason to delete everything: prepareTransfer
    // refuses a transfer put.io lists no files for rather than reaching here.
    if (keep.length === 0) return 0;
    const placeholders = keep.map(() => '?').join(', ');
    const result = this.db.prepare(`
      DELETE FROM download_files
      WHERE download_id = ? AND putio_file_id NOT IN (${placeholders})
    `).run(downloadId, ...keep);
    return result.changes;
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

  // A failed file stays in the queue so a restart retries it — that is what
  // the status is for — but only while it has attempts left. Without the
  // bound, a file that can never succeed was claimed, failed and re-claimed on
  // every pass for as long as the process ran. The caller owns the limit: it
  // is the same number it marks a file failed with.
  listPendingFiles(limit = 100, { maxAttempts = Number.MAX_SAFE_INTEGER } = {}) {
    return this.db.prepare(`
      SELECT f.*, d.category, d.name AS download_name, d.hash AS download_hash
      FROM download_files f
      JOIN downloads d ON d.id = f.download_id
      WHERE (f.status = 'pending' OR (f.status = 'failed' AND f.attempts < ?))
        AND d.removed_at IS NULL
      ORDER BY f.id ASC
      LIMIT ?
    `).all(maxAttempts, limit).map(normalizeFileRow);
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

  // The quarantine: rows the collapse could not represent, parked where the
  // dashboard can show them and the user can reassign or delete each one. This
  // is a repair path, never a re-derivation path — nothing here runs
  // automatically, and rule 4 is untouched for every download that has an owner.
  listOrphanedDownloads() {
    return this.db.prepare('SELECT * FROM orphaned_downloads ORDER BY id ASC').all();
  }

  findOrphanedDownloadById(id) {
    return this.db.prepare('SELECT * FROM orphaned_downloads WHERE id = ?').get(id);
  }

  deleteOrphanedDownload(id) {
    this.db.prepare('DELETE FROM orphaned_downloads WHERE id = ?').run(id);
  }

  // The quarantined row's files are deliberately not carried over: a reassigned
  // download re-prepares from put.io, which is also what repairs any file list
  // that drifted while it was parked. The *folder* is another matter — see
  // reassignedStagingFolder.
  assignOrphanedDownload(id, profileId) {
    const row = this.findOrphanedDownloadById(id);
    if (!row) throw new Error('Quarantined download not found');
    // Rule 3 gives a row without a put.io transfer id no identity at all, so
    // there is nothing to reassign it to; it is delete-only.
    if (row.putio_transfer_id == null) {
      throw new Error('This download has no put.io transfer id and cannot be reassigned; delete it instead');
    }
    const profile = this.findProfileById(profileId);
    if (!profile) throw new Error('Profile not found');
    const claimed = this.findDownloadByPutioTransferId(row.putio_transfer_id);
    if (claimed) {
      const owner = this.findProfileById(claimed.profile_id);
      throw new Error(
        `Put.io transfer ${row.putio_transfer_id} already belongs to RR profile `
        + `${owner?.name ?? claimed.profile_id}; delete this entry instead`,
      );
    }

    return this.transaction(() => {
      // The id the *arr apps are still polling with, unless something has taken
      // it since — a download created after the upgrade, or another quarantined
      // row restored first. A new id is the fallback, not the default: it means
      // that *arr's queue item stays invisible until it re-grabs.
      const restoredId = row.legacy_download_id != null && !this.findDownloadById(row.legacy_download_id)
        ? row.legacy_download_id
        : undefined;
      const created = this.upsertDownload({
        id: restoredId,
        profile_id: profile.id,
        putio_transfer_id: row.putio_transfer_id,
        putio_file_id: row.putio_file_id,
        save_parent_id: row.save_parent_id,
        hash: row.hash,
        name: row.name,
        source: row.source,
        source_type: row.source_type,
        category: row.category,
        // Back to 'remote' so the poll re-prepares it from put.io rather than
        // trusting a file list that has no rows behind it.
        lifecycle: 'remote',
        total_size: row.total_size,
        // Kept so a repaired download does not reappear at zero bytes, which
        // reads as a restart nobody asked for.
        downloaded_ever: row.downloaded_ever,
      });
      this.deleteOrphanedDownload(id);
      // Patched rather than inserted: staging_folder is claimed, once, by the
      // downloader, so the insert path deliberately has no way to set it. This
      // is the one caller that already knows where the files are.
      const folder = this.reassignedStagingFolder(row, profile);
      return folder ? this.updateDownload(created.id, { staging_folder: folder }) : created;
    });
  }

  // The quarantine records where the old build put the files. The repaired row
  // would otherwise resolve its folder from its new owner and put.io's *current*
  // name, and where those disagree with the recorded path the files are stranded
  // — nothing cleans them up, and the whole release downloads again.
  //
  // Carried only when the recorded path really is inside the folder this profile
  // and category resolve to, and then as the part below it, so a name spelling
  // nested directories survives intact. A target that stages elsewhere has no
  // claim on those files: freezing a folder outside its own root is how a
  // download ends up writing where its owner never said it could.
  reassignedStagingFolder(row, profile) {
    const recorded = String(row.legacy_download_dir ?? '');
    if (!recorded || !profile.download_at) return '';
    const parent = path.join(profile.download_at, row.category ?? '');
    const relative = path.relative(parent, recorded);
    if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) return '';
    return relative;
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
