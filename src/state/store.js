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

function normalizeTransferRow(row) {
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

function normalizeProfileRow(row) {
  if (!row) return undefined;
  const downloadAt = row.download_at ?? row.local_path;
  const autoRemoveCompleted = toBool(row.auto_remove_completed);
  const {
    local_path: _localPath,
    download_at: _downloadAt,
    client_use_ssl: clientUseSsl,
    ...rest
  } = row;
  return {
    ...rest,
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
  constructor(filePath = ':memory:') {
    this.filePath = filePath;
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

      CREATE TABLE IF NOT EXISTS profiles (
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
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transfers (
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

      CREATE INDEX IF NOT EXISTS idx_transfers_hash ON transfers(hash);
      CREATE INDEX IF NOT EXISTS idx_transfers_profile_id ON transfers(profile_id);
      CREATE INDEX IF NOT EXISTS idx_transfers_putio_status ON transfers(putio_status);
      CREATE INDEX IF NOT EXISTS idx_transfers_lifecycle ON transfers(lifecycle);

      CREATE TABLE IF NOT EXISTS transfer_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
        putio_file_id INTEGER NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        download_speed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error_string TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transfer_files_transfer_id ON transfer_files(transfer_id);
      CREATE INDEX IF NOT EXISTS idx_transfer_files_status ON transfer_files(status);

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

      CREATE INDEX IF NOT EXISTS idx_transfer_associations_transfer_id
        ON transfer_associations(transfer_id);
      CREATE INDEX IF NOT EXISTS idx_transfer_associations_profile_id
        ON transfer_associations(profile_id);
      CREATE INDEX IF NOT EXISTS idx_transfer_associations_lifecycle
        ON transfer_associations(lifecycle);

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

      CREATE INDEX IF NOT EXISTS idx_association_files_transfer_id
        ON association_files(transfer_id);
      CREATE INDEX IF NOT EXISTS idx_association_files_status
        ON association_files(status);
    `);
    this.migrateProfileDownloadAt();
    this.migrateProfileAutoRemoveCompleted();
    this.ensureColumn('profiles', 'download_profile_id', 'INTEGER REFERENCES download_profiles(id) ON DELETE SET NULL');
    this.ensureColumn('profiles', 'client_host', "TEXT NOT NULL DEFAULT 'putiorr'");
    this.ensureColumn('profiles', 'client_port', "TEXT NOT NULL DEFAULT '9091'");
    this.ensureColumn('profiles', 'client_use_ssl', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('transfers', 'profile_id', 'INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
    this.ensureColumn('transfers', 'completion_percent', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('transfer_files', 'download_speed', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateTransferAssociations();
    this.migrateMagnetTransferHashes();
  }

  migrateTransferAssociations() {
    if (this.getSetting('transfer_associations_migrated_v1') === '1') return;

    this.db.exec(`
      INSERT OR IGNORE INTO transfer_associations (
        id, transfer_id, profile_id, category, download_dir, lifecycle,
        total_size, downloaded_ever, download_speed, eta, error, error_string,
        retry_count, removed_at, created_at, updated_at
      )
      SELECT
        id,
        id,
        COALESCE(
          profile_id,
          (SELECT id FROM profiles ORDER BY CASE WHEN slug = 'default' THEN 0 ELSE 1 END, id LIMIT 1)
        ),
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
    this.assignMissingProfileDownloadProfiles(defaultDownloadProfile.id);
    this.assignMissingTransferProfiles();
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

  assignMissingProfileDownloadProfiles(downloadProfileId) {
    this.db.prepare(`
      UPDATE profiles
      SET download_profile_id = ?, updated_at = ?
      WHERE download_profile_id IS NULL
    `).run(downloadProfileId, nowIso());
  }

  assignMissingTransferProfiles() {
    const profile = this.findProfileBySlug('default') ?? this.listProfiles()[0];
    if (!profile) return;
    this.db.prepare(`
      UPDATE transfer_associations
      SET profile_id = ?, updated_at = ?
      WHERE profile_id IS NULL
    `).run(profile.id, nowIso());
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

  deleteDownloadProfile(id) {
    this.db.prepare('DELETE FROM download_profiles WHERE id = ?').run(id);
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
    const downloadProfileId = profileDownloadProfileId(input);
    const autoRemoveCompleted = profileAutoRemoveCompleted(input) ?? profileDefaultsToAutoRemoveCompleted(input);
    const result = this.db.prepare(`
      INSERT INTO profiles (
        name, type, slug, download_profile_id, auto_remove_completed, putio_folder_name, putio_folder_id,
        download_at, rpc_path, client_host, client_port, client_use_ssl, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.type ?? 'custom',
      input.slug,
      downloadProfileId == null ? null : normalizeOptionalId(downloadProfileId),
      autoRemoveCompleted ? 1 : 0,
      input.putio_folder_name,
      input.putio_folder_id ?? null,
      profileDownloadAt(input),
      input.rpc_path,
      profileClientHost(input) ?? 'putiorr',
      profileClientPort(input) ?? '9091',
      profileClientUseSsl(input) ? 1 : 0,
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
    const linked = this.db.prepare(`
      SELECT 1 FROM transfer_associations WHERE profile_id = ? LIMIT 1
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

  createOrUpdateTransfer(input) {
    const timestamp = nowIso();
    const hash = normalizeHash(input.hash);
    if (!hash) throw new Error('transfer hash is required');
    let remote = this.findRemoteTransferByHash(hash)
      ?? (input.putio_transfer_id ? this.findRemoteTransferByPutioId(input.putio_transfer_id) : undefined);

    if (!remote) {
      const result = this.db.prepare(`
        INSERT INTO transfers (
          profile_id, putio_transfer_id, putio_file_id, save_parent_id, hash, name, source,
          source_type, category, download_dir, lifecycle, putio_status,
          percent_done, completion_percent, total_size, downloaded_ever, uploaded_ever,
          download_speed, upload_speed, eta, error, error_string,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.profile_id ?? null,
        input.putio_transfer_id ?? null,
        input.putio_file_id ?? null,
        input.save_parent_id ?? null,
        hash,
        input.name ?? hash,
        input.source ?? '',
        input.source_type ?? 'unknown',
        input.category ?? '',
        input.download_dir ?? '',
        input.lifecycle ?? 'remote',
        input.putio_status ?? 'UNKNOWN',
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
        timestamp,
        timestamp,
      );
      remote = this.findRemoteTransferById(Number(result.lastInsertRowid));
    } else {
      const merged = {
        putio_transfer_id: input.putio_transfer_id ?? remote.putio_transfer_id,
        putio_file_id: input.putio_file_id ?? remote.putio_file_id,
        save_parent_id: input.save_parent_id ?? remote.save_parent_id,
        name: input.name ?? remote.name,
        source: input.source ?? remote.source,
        source_type: input.source_type ?? remote.source_type,
        putio_status: input.putio_status ?? remote.putio_status,
        percent_done: input.percent_done ?? remote.percent_done,
        completion_percent: input.completion_percent ?? remote.completion_percent,
        total_size: input.total_size ?? input.size ?? remote.total_size,
        uploaded_ever: input.uploaded_ever ?? remote.uploaded_ever,
        upload_speed: input.upload_speed ?? remote.upload_speed,
      };
      this.db.prepare(`
        UPDATE transfers
        SET putio_transfer_id = ?, putio_file_id = ?, save_parent_id = ?, name = ?,
            source = ?, source_type = ?, putio_status = ?, percent_done = ?,
            completion_percent = ?, total_size = ?, uploaded_ever = ?, upload_speed = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        merged.putio_transfer_id,
        merged.putio_file_id,
        merged.save_parent_id,
        merged.name,
        merged.source,
        merged.source_type,
        merged.putio_status,
        merged.percent_done,
        merged.completion_percent,
        merged.total_size,
        merged.uploaded_ever,
        merged.upload_speed,
        timestamp,
        remote.id,
      );
    }

    const association = this.findTransferAssociation(remote.id, input.profile_id ?? null);
    if (!association) {
      const result = this.db.prepare(`
        INSERT INTO transfer_associations (
          transfer_id, profile_id, category, download_dir, lifecycle, total_size,
          downloaded_ever, download_speed, eta, error, error_string, retry_count,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        remote.id,
        input.profile_id ?? null,
        input.category ?? '',
        input.download_dir ?? '',
        input.lifecycle ?? 'remote',
        input.total_size ?? input.size ?? remote.total_size ?? 0,
        input.downloaded_ever ?? 0,
        input.download_speed ?? 0,
        input.eta ?? -1,
        input.error ? 1 : 0,
        input.error_string ?? '',
        input.retry_count ?? 0,
        timestamp,
        timestamp,
      );
      return this.findTransferById(Number(result.lastInsertRowid));
    }

    this.db.prepare(`
      UPDATE transfer_associations
      SET category = ?, download_dir = ?, lifecycle = ?, total_size = ?,
          downloaded_ever = ?, download_speed = ?, eta = ?, error = ?, error_string = ?,
          retry_count = ?,
          removed_at = CASE WHEN ? THEN NULL ELSE removed_at END, updated_at = ?
      WHERE id = ?
    `).run(
      input.category ?? association.category,
      input.download_dir ?? association.download_dir,
      input.lifecycle ?? association.lifecycle,
      input.total_size ?? input.size ?? association.total_size,
      input.downloaded_ever ?? association.downloaded_ever,
      input.download_speed ?? association.download_speed,
      input.eta ?? association.eta,
      (input.error ?? association.error) ? 1 : 0,
      input.error_string ?? association.error_string,
      input.retry_count ?? association.retry_count,
      input.reactivate !== false ? 1 : 0,
      timestamp,
      association.id,
    );
    return this.findTransferById(association.id);
  }

  updateTransfer(id, patch) {
    const existing = this.findTransferById(id);
    if (!existing) return undefined;
    const remoteAllowed = [
      'putio_transfer_id',
      'putio_file_id',
      'save_parent_id',
      'name',
      'putio_status',
      'percent_done',
      'completion_percent',
      'uploaded_ever',
      'upload_speed',
    ];
    const associationAllowed = [
      'profile_id',
      'category',
      'download_dir',
      'lifecycle',
      'total_size',
      'downloaded_ever',
      'download_speed',
      'eta',
      'error',
      'error_string',
      'retry_count',
    ];
    const remoteKeys = remoteAllowed.filter((key) => Object.hasOwn(patch, key));
    const associationKeys = associationAllowed.filter((key) => Object.hasOwn(patch, key));
    const timestamp = nowIso();
    if (remoteKeys.length > 0) {
      const assignments = remoteKeys.map((key) => `${key} = ?`).join(', ');
      const values = remoteKeys.map((key) => patch[key]);
      values.push(timestamp, existing.remote_id);
      this.db.prepare(`UPDATE transfers SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    }
    if (associationKeys.length > 0) {
      const assignments = associationKeys.map((key) => `${key} = ?`).join(', ');
      const values = associationKeys.map((key) => (key === 'error' ? (patch[key] ? 1 : 0) : patch[key]));
      values.push(timestamp, id);
      this.db.prepare(`UPDATE transfer_associations SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    }
    return this.findTransferById(id);
  }

  transferSelect(where = '') {
    return `
      SELECT
        a.id,
        a.transfer_id AS remote_id,
        a.profile_id,
        r.putio_transfer_id,
        r.putio_file_id,
        r.save_parent_id,
        r.hash,
        r.name,
        r.source,
        r.source_type,
        a.category,
        a.download_dir,
        a.lifecycle,
        r.putio_status,
        r.percent_done,
        r.completion_percent,
        COALESCE(a.total_size, r.total_size) AS total_size,
        a.downloaded_ever,
        r.uploaded_ever,
        a.download_speed,
        r.upload_speed,
        a.eta,
        a.error,
        a.error_string,
        a.retry_count,
        a.removed_at,
        a.created_at,
        a.updated_at
      FROM transfer_associations a
      JOIN transfers r ON r.id = a.transfer_id
      ${where}
    `;
  }

  findRemoteTransferById(id) {
    return this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
  }

  findRemoteTransferByHash(hash) {
    return this.db.prepare('SELECT * FROM transfers WHERE lower(hash) = lower(?)').get(normalizeHash(hash));
  }

  findRemoteTransferByPutioId(putioTransferId) {
    return this.db.prepare('SELECT * FROM transfers WHERE putio_transfer_id = ?').get(putioTransferId);
  }

  findTransferAssociation(remoteId, profileId) {
    const row = this.db.prepare(this.transferSelect(`
      WHERE a.transfer_id = ? AND a.profile_id IS ?
      ORDER BY a.id ASC
      LIMIT 1
    `)).get(remoteId, profileId);
    return normalizeTransferRow(row);
  }

  findTransferById(id) {
    const row = this.db.prepare(this.transferSelect('WHERE a.id = ?')).get(id);
    return normalizeTransferRow(row);
  }

  findTransferByHash(hash, { profileId } = {}) {
    const params = [normalizeHash(hash)];
    let where = 'WHERE lower(r.hash) = lower(?)';
    if (profileId != null) {
      where += ' AND a.profile_id = ?';
      params.push(profileId);
    }
    const row = this.db.prepare(this.transferSelect(`${where} ORDER BY a.id ASC LIMIT 1`)).get(...params);
    return normalizeTransferRow(row);
  }

  findTransferByPutioId(putioTransferId, { profileId } = {}) {
    const params = [putioTransferId];
    let where = 'WHERE r.putio_transfer_id = ?';
    if (profileId != null) {
      where += ' AND a.profile_id = ?';
      params.push(profileId);
    }
    const row = this.db.prepare(this.transferSelect(`${where} ORDER BY a.id ASC LIMIT 1`)).get(...params);
    return normalizeTransferRow(row);
  }

  findTransfer(identifier, { profileId } = {}) {
    if (identifier == null) return undefined;
    if (typeof identifier === 'number') {
      const row = this.findTransferById(identifier);
      return profileId == null || row?.profile_id === profileId ? row : undefined;
    }
    const value = String(identifier);
    if (/^\d+$/.test(value)) {
      const row = this.findTransferById(Number(value));
      if (row && (profileId == null || row.profile_id === profileId)) return row;
      return this.findTransferByHash(value, { profileId });
    }
    return this.findTransferByHash(value, { profileId });
  }

  listActiveTransfers({ profileId } = {}) {
    const params = [];
    let where = 'a.removed_at IS NULL';
    if (profileId != null) {
      where += ' AND a.profile_id = ?';
      params.push(profileId);
    }
    return this.db.prepare(this.transferSelect(`
      WHERE ${where}
      ORDER BY a.id ASC
    `)).all(...params).map(normalizeTransferRow);
  }

  listTransfersForRemote(remoteId, { includeRemoved = true } = {}) {
    const where = includeRemoved
      ? 'WHERE a.transfer_id = ?'
      : 'WHERE a.transfer_id = ? AND a.removed_at IS NULL';
    return this.db.prepare(this.transferSelect(`${where} ORDER BY a.id ASC`))
      .all(remoteId)
      .map(normalizeTransferRow);
  }

  hasOtherActiveAssociations(transfer) {
    const row = this.db.prepare(`
      SELECT 1
      FROM transfer_associations
      WHERE transfer_id = ? AND id != ? AND removed_at IS NULL
      LIMIT 1
    `).get(transfer.remote_id, transfer.id);
    return Boolean(row);
  }

  allActiveAssociationsProcessed(remoteId) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN lifecycle = 'processed' THEN 1 ELSE 0 END) AS processed
      FROM transfer_associations
      WHERE transfer_id = ? AND removed_at IS NULL
    `).get(remoteId);
    return Number(row.total) > 0 && Number(row.total) === Number(row.processed);
  }

  markTransferRemoved(id) {
    this.db.prepare(`
      UPDATE transfer_associations
      SET removed_at = ?, lifecycle = 'removed', updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), id);
  }

  deleteTransfer(id) {
    this.db.prepare('DELETE FROM transfer_associations WHERE id = ?').run(id);
  }

  deleteRemoteTransferIfOrphaned(remoteId) {
    const result = this.db.prepare(`
      DELETE FROM transfers
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM transfer_associations WHERE transfer_id = transfers.id
        )
    `).run(remoteId);
    return result.changes > 0;
  }

  deleteRemoteTransferRecord(remoteId) {
    this.db.prepare('DELETE FROM transfers WHERE id = ?').run(remoteId);
  }

  deleteTransferFile(id) {
    this.db.prepare('DELETE FROM association_files WHERE id = ?').run(id);
  }

  // A file deleted from the dashboard but kept on put.io is tombstoned (status='deleted')
  // so the downloader does not re-fetch it. Once its transfer is 'processed' the download
  // path never revisits it (see pollOnce / prepareTransfer), so the tombstone is dead weight
  // and is hard-deleted here to keep the table from accumulating rows over time.
  purgeDeletedFilesForProcessedTransfers() {
    const result = this.db.prepare(`
      DELETE FROM association_files
      WHERE status = 'deleted'
        AND transfer_id IN (
          SELECT id FROM transfer_associations
          WHERE lifecycle = 'processed' AND removed_at IS NULL
        )
    `).run();
    return result.changes;
  }

  listRemovedTransfers() {
    return this.db.prepare(this.transferSelect('WHERE a.removed_at IS NOT NULL ORDER BY a.id ASC'))
      .all()
      .map(normalizeTransferRow);
  }

  upsertTransferFile(input) {
    const timestamp = nowIso();
    const existing = this.findTransferFileByPutioId(input.putio_file_id, input.transfer_id);
    if (!existing) {
      const result = this.db.prepare(`
        INSERT INTO association_files (
          transfer_id, putio_file_id, relative_path, size, downloaded_bytes, download_speed,
          status, attempts, error_string, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.transfer_id,
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
      return this.findTransferFileById(Number(result.lastInsertRowid));
    }

    this.db.prepare(`
      UPDATE association_files
      SET transfer_id = ?, relative_path = ?, size = ?,
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
      input.transfer_id,
      input.relative_path,
      input.size ?? existing.size,
      input.downloaded_bytes ?? existing.downloaded_bytes,
      input.download_speed ?? existing.download_speed ?? 0,
      input.status ?? existing.status,
      timestamp,
      existing.id,
    );
    return this.findTransferFileById(existing.id);
  }

  findTransferFileById(id) {
    const row = this.db.prepare('SELECT * FROM association_files WHERE id = ?').get(id);
    return normalizeFileRow(row);
  }

  findTransferFileByPutioId(putioFileId, transferId) {
    const row = transferId == null
      ? this.db.prepare('SELECT * FROM association_files WHERE putio_file_id = ? ORDER BY id ASC LIMIT 1').get(putioFileId)
      : this.db.prepare('SELECT * FROM association_files WHERE putio_file_id = ? AND transfer_id = ?').get(putioFileId, transferId);
    return normalizeFileRow(row);
  }

  listFilesForTransfer(transferId) {
    return this.db.prepare(`
      SELECT * FROM association_files
      WHERE transfer_id = ?
        AND status != 'deleted'
      ORDER BY relative_path ASC
    `).all(transferId).map(normalizeFileRow);
  }

  listPendingFiles(limit = 100) {
    return this.db.prepare(`
      SELECT tf.*, t.category, t.name AS transfer_name, t.hash AS transfer_hash
      FROM association_files tf
      JOIN transfer_associations a ON a.id = tf.transfer_id
      JOIN transfers t ON t.id = a.transfer_id
      WHERE tf.status IN ('pending', 'failed')
        AND a.removed_at IS NULL
      ORDER BY tf.id ASC
      LIMIT ?
    `).all(limit).map(normalizeFileRow);
  }

  updateTransferFile(id, patch) {
    const existing = this.findTransferFileById(id);
    if (!existing) return undefined;
    if (existing.status === 'deleted' && patch.status !== 'deleted') return existing;

    const allowed = ['downloaded_bytes', 'download_speed', 'status', 'attempts', 'error_string'];
    const keys = allowed.filter((key) => Object.hasOwn(patch, key));
    if (keys.length === 0) return this.findTransferFileById(id);
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => patch[key]);
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE association_files SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findTransferFileById(id);
  }

  markTransferFileDeleted(id) {
    return this.updateTransferFile(id, {
      downloaded_bytes: 0,
      download_speed: 0,
      status: 'deleted',
      error_string: '',
    });
  }

  getTransferFileStats(transferId) {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_files,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
        COALESCE(SUM(size), 0) AS total_size,
        COALESCE(SUM(downloaded_bytes), 0) AS downloaded_size
      FROM association_files
      WHERE transfer_id = ?
        AND status != 'deleted'
    `).get(transferId);
  }
}
