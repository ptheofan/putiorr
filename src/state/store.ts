import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  DEFAULT_DOWNLOAD_POLICY,
  DOWNLOAD_POLICY_COLUMNS,
  DOWNLOAD_POLICY_SETTING_KEYS,
  downloadPolicyInput,
  normalizeDownloadPolicy,
} from '../download/policy.ts';
import type {
  AppConfig,
  DbPatch,
  DbScalar,
  DownloadPolicy,
  DownloadPolicyInput,
  DownloadProfile,
  DownloadProfileInput,
  Profile,
  ProfileInput,
  RemovedTransfer,
  Transfer,
  TransferFile,
  TransferFileInput,
  TransferFileStats,
  TransferInput,
} from '../types.ts';

type DbRow = Record<string, DbScalar>;

function nowIso(): string {
  return new Date().toISOString();
}

function toBool(value: DbScalar): boolean {
  return value === 1 || value === true;
}

function text(value: DbScalar, fallback = ''): string {
  return value == null ? fallback : String(value);
}

function numberValue(value: DbScalar, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: DbScalar): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sqlValue(value: DbScalar): string | number | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeHash(value: DbScalar): string {
  return String(value ?? '').trim().toLowerCase();
}

function magnetInfoHash(source: DbScalar): string {
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

function normalizeTransferRow(row?: DbRow): Transfer | undefined {
  if (!row) return undefined;
  return {
    id: numberValue(row.id),
    profile_id: optionalNumber(row.profile_id),
    putio_transfer_id: optionalNumber(row.putio_transfer_id),
    putio_file_id: optionalNumber(row.putio_file_id),
    save_parent_id: optionalNumber(row.save_parent_id),
    hash: text(row.hash),
    name: text(row.name),
    source: text(row.source),
    source_type: text(row.source_type, 'unknown'),
    category: text(row.category),
    download_dir: text(row.download_dir),
    lifecycle: text(row.lifecycle, 'remote'),
    putio_status: text(row.putio_status, 'UNKNOWN'),
    percent_done: numberValue(row.percent_done),
    completion_percent: numberValue(row.completion_percent),
    total_size: numberValue(row.total_size),
    downloaded_ever: numberValue(row.downloaded_ever),
    uploaded_ever: numberValue(row.uploaded_ever),
    download_speed: numberValue(row.download_speed),
    upload_speed: numberValue(row.upload_speed),
    eta: numberValue(row.eta, -1),
    error: toBool(row.error),
    error_string: text(row.error_string),
    retry_count: numberValue(row.retry_count),
    removed_at: row.removed_at == null ? null : String(row.removed_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function normalizeFileRow(row?: DbRow): TransferFile | undefined {
  if (!row) return undefined;
  return {
    id: numberValue(row.id),
    transfer_id: numberValue(row.transfer_id),
    putio_file_id: numberValue(row.putio_file_id),
    relative_path: text(row.relative_path),
    size: numberValue(row.size),
    downloaded_bytes: numberValue(row.downloaded_bytes),
    download_speed: numberValue(row.download_speed),
    status: text(row.status, 'pending'),
    attempts: numberValue(row.attempts),
    error_string: text(row.error_string),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
    ...(row.category !== undefined ? { category: text(row.category) } : {}),
    ...(row.transfer_name !== undefined ? { transfer_name: text(row.transfer_name) } : {}),
    ...(row.transfer_hash !== undefined ? { transfer_hash: text(row.transfer_hash) } : {}),
  };
}

function normalizeProfileRow(row?: DbRow): Profile | undefined {
  if (!row) return undefined;
  const downloadAt = row.download_at ?? row.local_path;
  const clientUseSsl = row.client_use_ssl;
  return {
    id: numberValue(row.id),
    name: text(row.name),
    type: text(row.type, 'custom'),
    slug: text(row.slug),
    download_profile_id: optionalNumber(row.download_profile_id),
    downloadProfileId: optionalNumber(row.download_profile_id),
    putio_folder_name: text(row.putio_folder_name),
    putio_folder_id: optionalNumber(row.putio_folder_id),
    download_at: text(downloadAt),
    downloadAt: text(downloadAt),
    rpc_path: text(row.rpc_path),
    client_use_ssl: toBool(clientUseSsl),
    client_host: text(row.client_host, 'putiorr'),
    clientHost: text(row.client_host, 'putiorr'),
    client_port: text(row.client_port, '9091'),
    clientPort: text(row.client_port, '9091'),
    clientUseSsl: toBool(clientUseSsl),
    enabled: toBool(row.enabled),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function normalizeDownloadProfileRow(row?: DbRow): DownloadProfile | undefined {
  if (!row) return undefined;
  const policy = normalizeDownloadPolicy(downloadPolicyInput(row));
  return {
    id: numberValue(row.id),
    name: text(row.name),
    slug: text(row.slug),
    slow_speed_threshold_bytes_per_second: policy.slowSpeedThresholdBytesPerSecond,
    slow_speed_duration_seconds: policy.slowSpeedDurationSeconds,
    slow_speed_grace_seconds: policy.slowSpeedGraceSeconds,
    slow_speed_min_size_bytes: policy.slowSpeedMinSizeBytes,
    slowSpeedThresholdBytesPerSecond: policy.slowSpeedThresholdBytesPerSecond,
    slowSpeedDurationSeconds: policy.slowSpeedDurationSeconds,
    slowSpeedGraceSeconds: policy.slowSpeedGraceSeconds,
    slowSpeedMinSizeBytes: policy.slowSpeedMinSizeBytes,
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

function profileDownloadAt(input: ProfileInput): string | undefined {
  return input.download_at ?? input.downloadAt ?? input.local_path ?? input.localPath;
}

function profileDownloadProfileId(input: ProfileInput): DbScalar {
  if (input.download_profile_id !== undefined) return input.download_profile_id;
  if (input.downloadProfileId !== undefined) return input.downloadProfileId;
  return undefined;
}

function profileClientHost(input: ProfileInput): string | undefined {
  return input.client_host ?? input.clientHost;
}

function profileClientPort(input: ProfileInput): string | undefined {
  return input.client_port ?? input.clientPort;
}

function profileClientUseSsl(input: ProfileInput): DbScalar {
  return input.client_use_ssl ?? input.clientUseSsl;
}

function normalizeOptionalId(value: DbScalar): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function downloadProfilePolicyFromConfigAndSettings(store: StateStore, config: AppConfig): DownloadPolicy {
  const input: DownloadPolicyInput = {};
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    const value = store.getSetting(key);
    if (value !== undefined) input[property as keyof DownloadPolicy] = value;
  }
  return normalizeDownloadPolicy(input, {
    slowSpeedThresholdBytesPerSecond: config.slowSpeedThresholdBytesPerSecond,
    slowSpeedDurationSeconds: config.slowSpeedDurationSeconds,
    slowSpeedGraceSeconds: config.slowSpeedGraceSeconds,
    slowSpeedMinSizeBytes: config.slowSpeedMinSizeBytes,
  });
}

function downloadProfilePolicyPatch(
  input: DownloadPolicyInput,
  fallback: DownloadPolicy = DEFAULT_DOWNLOAD_POLICY,
): DownloadPolicy {
  return normalizeDownloadPolicy(downloadPolicyInput(input), fallback);
}

export class StateStore {
  filePath: string;
  db: DatabaseSync;

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

  close(): void {
    this.db.close();
  }

  migrate(): void {
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
    `);
    this.migrateProfileDownloadAt();
    this.ensureColumn('profiles', 'download_profile_id', 'INTEGER REFERENCES download_profiles(id) ON DELETE SET NULL');
    this.ensureColumn('profiles', 'client_host', "TEXT NOT NULL DEFAULT 'putiorr'");
    this.ensureColumn('profiles', 'client_port', "TEXT NOT NULL DEFAULT '9091'");
    this.ensureColumn('profiles', 'client_use_ssl', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('transfers', 'profile_id', 'INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
    this.ensureColumn('transfers', 'completion_percent', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('transfer_files', 'download_speed', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateMagnetTransferHashes();
  }

  getColumns(table: string): DbRow[] {
    return this.db.prepare(`PRAGMA table_info(${table})`).all() as DbRow[];
  }

  ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.getColumns(table);
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  migrateProfileDownloadAt(): void {
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

  migrateMagnetTransferHashes(): void {
    const rows = this.db.prepare(`
      SELECT id, hash, source
      FROM transfers
      WHERE source LIKE 'magnet:%'
    `).all() as DbRow[];
    for (const row of rows) {
      const nextHash = magnetInfoHash(row.source);
      if (!nextHash || nextHash === normalizeHash(row.hash)) continue;
      const conflict = this.db.prepare(`
        SELECT id
        FROM transfers
        WHERE lower(hash) = lower(?) AND id != ?
      `).get(nextHash, numberValue(row.id)) as DbRow | undefined;
      if (conflict) continue;
      this.db.prepare('UPDATE transfers SET hash = ?, updated_at = ? WHERE id = ?')
        .run(nextHash, nowIso(), numberValue(row.id));
    }
  }

  setSetting(key: string, value: DbScalar): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), nowIso());
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as DbRow | undefined;
    return row?.value == null ? undefined : String(row.value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  seedFromConfig(config: AppConfig): void {
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
          slug: profile.slug ?? text(profile.name, 'profile').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          type: profile.type ?? 'custom',
          download_profile_id: profileDownloadProfileId(profile) ?? defaultDownloadProfile.id,
          enabled: profile.enabled !== false,
        });
      }
    }
    this.assignMissingProfileDownloadProfiles(defaultDownloadProfile.id);
  }

  createDefaultProfile(config: AppConfig): Profile | undefined {
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

  ensureDefaultDownloadProfile(config: AppConfig): DownloadProfile {
    const existing = this.findDefaultDownloadProfile();
    if (existing) return existing;
    const created = this.createDownloadProfile({
      name: 'Default',
      slug: 'default',
      ...downloadProfilePolicyFromConfigAndSettings(this, config),
    });
    if (!created) throw new Error('Could not create default download profile');
    return created;
  }

  assignMissingProfileDownloadProfiles(downloadProfileId: number): void {
    this.db.prepare(`
      UPDATE profiles
      SET download_profile_id = ?, updated_at = ?
      WHERE download_profile_id IS NULL
    `).run(downloadProfileId, nowIso());
  }

  createDownloadProfile(input: DownloadProfileInput): DownloadProfile | undefined {
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
      input.name ?? '',
      input.slug ?? '',
      policy.slowSpeedThresholdBytesPerSecond,
      policy.slowSpeedDurationSeconds,
      policy.slowSpeedGraceSeconds,
      policy.slowSpeedMinSizeBytes,
      timestamp,
      timestamp,
    );
    return this.findDownloadProfileById(Number(result.lastInsertRowid));
  }

  updateDownloadProfile(id: number, patch: DownloadProfileInput): DownloadProfile | undefined {
    const existing = this.findDownloadProfileById(id);
    if (!existing) return undefined;
    const normalizedPatch: DbPatch = {};
    if (patch.name !== undefined) normalizedPatch.name = patch.name;
    if (patch.slug !== undefined) normalizedPatch.slug = patch.slug;
    const currentPolicy = normalizeDownloadPolicy(downloadPolicyInput(existing));
    const nextPolicy = downloadProfilePolicyPatch(patch, currentPolicy);
    for (const [property, column] of Object.entries(DOWNLOAD_POLICY_COLUMNS)) {
      const key = property as keyof DownloadPolicy;
      if (Object.hasOwn(patch, property) || Object.hasOwn(patch, column)) {
        normalizedPatch[column] = nextPolicy[key];
      }
    }

    const allowed = [
      'name',
      'slug',
      'slow_speed_threshold_bytes_per_second',
      'slow_speed_duration_seconds',
      'slow_speed_grace_seconds',
      'slow_speed_min_size_bytes',
    ] as const;
    const keys = allowed.filter((key) => Object.hasOwn(normalizedPatch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => sqlValue(normalizedPatch[key]));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE download_profiles SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findDownloadProfileById(id);
  }

  deleteDownloadProfile(id: number): void {
    this.db.prepare('DELETE FROM download_profiles WHERE id = ?').run(id);
  }

  findDownloadProfileById(id: number | null): DownloadProfile | undefined {
    if (id == null) return undefined;
    const row = this.db.prepare('SELECT * FROM download_profiles WHERE id = ?').get(id) as DbRow | undefined;
    return normalizeDownloadProfileRow(row);
  }

  findDownloadProfileBySlug(slug: string): DownloadProfile | undefined {
    const row = this.db.prepare('SELECT * FROM download_profiles WHERE slug = ?').get(slug) as DbRow | undefined;
    return normalizeDownloadProfileRow(row);
  }

  findDefaultDownloadProfile(): DownloadProfile | undefined {
    return this.findDownloadProfileBySlug('default') ?? this.listDownloadProfiles()[0];
  }

  listDownloadProfiles(): DownloadProfile[] {
    return (this.db.prepare('SELECT * FROM download_profiles ORDER BY id ASC').all() as DbRow[])
      .map(normalizeDownloadProfileRow)
      .filter((profile) => profile !== undefined);
  }

  createProfile(input: ProfileInput): Profile | undefined {
    const timestamp = nowIso();
    const downloadProfileId = profileDownloadProfileId(input);
    const result = this.db.prepare(`
      INSERT INTO profiles (
        name, type, slug, download_profile_id, putio_folder_name, putio_folder_id,
        download_at, rpc_path, client_host, client_port, client_use_ssl, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name ?? '',
      input.type ?? 'custom',
      input.slug ?? '',
      downloadProfileId == null ? null : normalizeOptionalId(downloadProfileId),
      input.putio_folder_name ?? '',
      sqlValue(input.putio_folder_id ?? null),
      profileDownloadAt(input) ?? '',
      input.rpc_path ?? '',
      profileClientHost(input) ?? 'putiorr',
      profileClientPort(input) ?? '9091',
      profileClientUseSsl(input) ? 1 : 0,
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
    return this.findProfileById(Number(result.lastInsertRowid));
  }

  updateProfile(id: number, patch: ProfileInput): Profile | undefined {
    const existing = this.findProfileById(id);
    if (!existing) return undefined;
    const normalizedPatch: DbPatch = { ...patch };
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
    const allowed = [
      'name',
      'type',
      'slug',
      'download_profile_id',
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
      key === 'enabled' || key === 'client_use_ssl' ? (normalizedPatch[key] ? 1 : 0) : sqlValue(normalizedPatch[key])
    ));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE profiles SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findProfileById(id);
  }

  deleteProfile(id: number): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }

  findProfileById(id: number | null): Profile | undefined {
    if (id == null) return undefined;
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as DbRow | undefined;
    return normalizeProfileRow(row);
  }

  findProfileBySlug(slug: string): Profile | undefined {
    const row = this.db.prepare('SELECT * FROM profiles WHERE slug = ?').get(slug) as DbRow | undefined;
    return normalizeProfileRow(row);
  }

  findProfileByRpcPath(rpcPath: string): Profile | undefined {
    const row = this.db.prepare('SELECT * FROM profiles WHERE rpc_path = ? AND enabled = 1').get(rpcPath) as DbRow | undefined;
    return normalizeProfileRow(row);
  }

  listProfiles({ includeDisabled = false }: { includeDisabled?: boolean } = {}): Profile[] {
    const sql = includeDisabled
      ? 'SELECT * FROM profiles ORDER BY id ASC'
      : 'SELECT * FROM profiles WHERE enabled = 1 ORDER BY id ASC';
    return (this.db.prepare(sql).all() as DbRow[]).map(normalizeProfileRow).filter((profile) => profile !== undefined);
  }

  transaction<T>(fn: () => T): T {
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

  createOrUpdateTransfer(input: TransferInput): Transfer | undefined {
    const timestamp = nowIso();
    const hash = normalizeHash(input.hash);
    if (!hash) throw new Error('transfer hash is required');
    const existing = this.findTransferByHash(hash)
      ?? (input.putio_transfer_id ? this.findTransferByPutioId(input.putio_transfer_id) : undefined);

    if (!existing) {
      const stmt = this.db.prepare(`
        INSERT INTO transfers (
          profile_id, putio_transfer_id, putio_file_id, save_parent_id, hash, name, source,
          source_type, category, download_dir, lifecycle, putio_status,
          percent_done, completion_percent, total_size, downloaded_ever, uploaded_ever,
          download_speed, upload_speed, eta, error, error_string,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
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
      return this.findTransferById(Number(result.lastInsertRowid));
    }

    const merged = {
      putio_transfer_id: input.putio_transfer_id ?? existing.putio_transfer_id,
      profile_id: input.profile_id ?? existing.profile_id,
      putio_file_id: input.putio_file_id ?? existing.putio_file_id,
      save_parent_id: input.save_parent_id ?? existing.save_parent_id,
      name: input.name ?? existing.name,
      source: input.source ?? existing.source,
      source_type: input.source_type ?? existing.source_type,
      category: input.category ?? existing.category,
      download_dir: input.download_dir ?? existing.download_dir,
      lifecycle: input.lifecycle ?? existing.lifecycle,
      putio_status: input.putio_status ?? existing.putio_status,
      percent_done: input.percent_done ?? existing.percent_done,
      completion_percent: input.completion_percent ?? existing.completion_percent,
      total_size: input.total_size ?? input.size ?? existing.total_size,
      downloaded_ever: input.downloaded_ever ?? existing.downloaded_ever,
      uploaded_ever: input.uploaded_ever ?? existing.uploaded_ever,
      download_speed: input.download_speed ?? existing.download_speed,
      upload_speed: input.upload_speed ?? existing.upload_speed,
      eta: input.eta ?? existing.eta,
      error: input.error ?? existing.error,
      error_string: input.error_string ?? existing.error_string,
    };

    this.db.prepare(`
      UPDATE transfers
      SET profile_id = ?, putio_transfer_id = ?, putio_file_id = ?, save_parent_id = ?,
          name = ?, source = ?, source_type = ?, category = ?, download_dir = ?,
          lifecycle = ?, putio_status = ?, percent_done = ?, completion_percent = ?, total_size = ?,
          downloaded_ever = ?, uploaded_ever = ?, download_speed = ?,
          upload_speed = ?, eta = ?, error = ?, error_string = ?,
          removed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      merged.profile_id ?? null,
      merged.putio_transfer_id ?? null,
      merged.putio_file_id ?? null,
      merged.save_parent_id ?? null,
      merged.name,
      merged.source,
      merged.source_type,
      merged.category,
      merged.download_dir,
      merged.lifecycle,
      merged.putio_status,
      merged.percent_done,
      merged.completion_percent,
      merged.total_size,
      merged.downloaded_ever,
      merged.uploaded_ever,
      merged.download_speed,
      merged.upload_speed,
      merged.eta,
      merged.error ? 1 : 0,
      merged.error_string,
      timestamp,
      existing.id,
    );
    return this.findTransferById(existing.id);
  }

  updateTransfer(id: number, patch: TransferInput): Transfer | undefined {
    const existing = this.findTransferById(id);
    if (!existing) return undefined;
    const allowed = [
      'putio_transfer_id',
      'profile_id',
      'putio_file_id',
      'save_parent_id',
      'name',
      'category',
      'download_dir',
      'lifecycle',
      'putio_status',
      'percent_done',
      'completion_percent',
      'total_size',
      'downloaded_ever',
      'uploaded_ever',
      'download_speed',
      'upload_speed',
      'eta',
      'error',
      'error_string',
      'retry_count',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(patch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const patchValues = patch as DbPatch;
    const values = keys.map((key) => (key === 'error' ? (patchValues[key] ? 1 : 0) : sqlValue(patchValues[key])));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE transfers SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findTransferById(id);
  }

  findTransferById(id: number | null): Transfer | undefined {
    if (id == null) return undefined;
    const row = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id) as DbRow | undefined;
    return normalizeTransferRow(row);
  }

  findTransferByHash(hash: DbScalar): Transfer | undefined {
    const row = this.db.prepare('SELECT * FROM transfers WHERE lower(hash) = lower(?)')
      .get(normalizeHash(hash)) as DbRow | undefined;
    return normalizeTransferRow(row);
  }

  findTransferByPutioId(putioTransferId: number): Transfer | undefined {
    const row = this.db.prepare('SELECT * FROM transfers WHERE putio_transfer_id = ?').get(putioTransferId) as DbRow | undefined;
    return normalizeTransferRow(row);
  }

  findTransfer(identifier: number | string | null | undefined): Transfer | undefined {
    if (identifier == null) return undefined;
    if (typeof identifier === 'number') return this.findTransferById(identifier);
    const value = String(identifier);
    if (/^\d+$/.test(value)) {
      return this.findTransferById(Number(value)) ?? this.findTransferByHash(value);
    }
    return this.findTransferByHash(value);
  }

  listActiveTransfers({ profileId }: { profileId?: number | null } = {}): Transfer[] {
    const params: number[] = [];
    let where = 'removed_at IS NULL';
    if (profileId != null) {
      where += ' AND profile_id = ?';
      params.push(profileId);
    }
    return (this.db.prepare(`
      SELECT * FROM transfers
      WHERE ${where}
      ORDER BY id ASC
    `).all(...params) as DbRow[]).map(normalizeTransferRow).filter((transfer) => transfer !== undefined);
  }

  markTransferRemoved(id: number): void {
    this.db.prepare(`
      UPDATE transfers
      SET removed_at = ?, lifecycle = 'removed', updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), id);
  }

  deleteTransfer(id: number): void {
    this.db.prepare('DELETE FROM transfers WHERE id = ?').run(id);
  }

  deleteTransferFile(id: number): void {
    this.db.prepare('DELETE FROM transfer_files WHERE id = ?').run(id);
  }

  // A file deleted from the dashboard but kept on put.io is tombstoned (status='deleted')
  // so the downloader does not re-fetch it. Once its transfer is 'processed' the download
  // path never revisits it (see pollOnce / prepareTransfer), so the tombstone is dead weight
  // and is hard-deleted here to keep the table from accumulating rows over time.
  purgeDeletedFilesForProcessedTransfers(): number {
    const result = this.db.prepare(`
      DELETE FROM transfer_files
      WHERE status = 'deleted'
        AND transfer_id IN (
          SELECT id FROM transfers
          WHERE lifecycle = 'processed' AND removed_at IS NULL
        )
    `).run();
    return Number(result.changes);
  }

  listRemovedTransfers(): RemovedTransfer[] {
    return (this.db.prepare(`
      SELECT id, putio_transfer_id, hash
      FROM transfers
      WHERE removed_at IS NOT NULL
    `).all() as DbRow[]).map((row) => ({
      id: numberValue(row.id),
      putio_transfer_id: optionalNumber(row.putio_transfer_id),
      hash: text(row.hash),
    }));
  }

  upsertTransferFile(input: TransferFileInput): TransferFile | undefined {
    const timestamp = nowIso();
    const existing = this.findTransferFileByPutioId(input.putio_file_id);
    if (!existing) {
      const result = this.db.prepare(`
        INSERT INTO transfer_files (
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
      UPDATE transfer_files
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

  findTransferFileById(id: number): TransferFile | undefined {
    const row = this.db.prepare('SELECT * FROM transfer_files WHERE id = ?').get(id) as DbRow | undefined;
    return normalizeFileRow(row);
  }

  findTransferFileByPutioId(putioFileId: number): TransferFile | undefined {
    const row = this.db.prepare('SELECT * FROM transfer_files WHERE putio_file_id = ?').get(putioFileId) as DbRow | undefined;
    return normalizeFileRow(row);
  }

  listFilesForTransfer(transferId: number): TransferFile[] {
    return (this.db.prepare(`
      SELECT * FROM transfer_files
      WHERE transfer_id = ?
        AND status != 'deleted'
      ORDER BY relative_path ASC
    `).all(transferId) as DbRow[]).map(normalizeFileRow).filter((file) => file !== undefined);
  }

  listPendingFiles(limit = 100): TransferFile[] {
    return (this.db.prepare(`
      SELECT tf.*, t.category, t.name AS transfer_name, t.hash AS transfer_hash
      FROM transfer_files tf
      JOIN transfers t ON t.id = tf.transfer_id
      WHERE tf.status IN ('pending', 'failed')
        AND t.removed_at IS NULL
      ORDER BY tf.id ASC
      LIMIT ?
    `).all(limit) as DbRow[]).map(normalizeFileRow).filter((file) => file !== undefined);
  }

  updateTransferFile(id: number, patch: Partial<TransferFile>): TransferFile | undefined {
    const existing = this.findTransferFileById(id);
    if (!existing) return undefined;
    if (existing.status === 'deleted' && patch.status !== 'deleted') return existing;

    const allowed: Array<keyof TransferFile> = ['downloaded_bytes', 'download_speed', 'status', 'attempts', 'error_string'];
    const keys = allowed.filter((key) => Object.hasOwn(patch, key));
    if (keys.length === 0) return this.findTransferFileById(id);
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => sqlValue(patch[key] as DbScalar));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE transfer_files SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findTransferFileById(id);
  }

  markTransferFileDeleted(id: number): TransferFile | undefined {
    return this.updateTransferFile(id, {
      downloaded_bytes: 0,
      download_speed: 0,
      status: 'deleted',
      error_string: '',
    });
  }

  getTransferFileStats(transferId: number): TransferFileStats {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_files,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
        COALESCE(SUM(size), 0) AS total_size,
        COALESCE(SUM(downloaded_bytes), 0) AS downloaded_size
      FROM transfer_files
      WHERE transfer_id = ?
        AND status != 'deleted'
    `).get(transferId) as DbRow;
    return {
      total_files: numberValue(row.total_files),
      completed_files: numberValue(row.completed_files),
      failed_files: numberValue(row.failed_files),
      total_size: numberValue(row.total_size),
      downloaded_size: numberValue(row.downloaded_size),
    };
  }
}
