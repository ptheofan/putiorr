import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

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
  const { local_path: _localPath, download_at: _downloadAt, ...rest } = row;
  return {
    ...rest,
    download_at: downloadAt,
    downloadAt,
    enabled: toBool(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function profileDownloadAt(input) {
  return input.download_at ?? input.downloadAt ?? input.local_path ?? input.localPath;
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

      CREATE TABLE IF NOT EXISTS profiles (
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
    this.ensureColumn('transfers', 'profile_id', 'INTEGER REFERENCES profiles(id) ON DELETE SET NULL');
    this.migrateMagnetTransferHashes();
  }

  getColumns(table) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all();
  }

  ensureColumn(table, column, definition) {
    const columns = this.getColumns(table);
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    if (this.listProfiles({ includeDisabled: true }).length === 0) {
      const seedProfiles = Array.isArray(config.seedProfiles) && config.seedProfiles.length > 0
        ? config.seedProfiles
        : [{
            name: config.defaultProfileName,
            type: config.defaultProfileType,
            slug: 'default',
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
          enabled: profile.enabled !== false,
        });
      }
    }
  }

  createDefaultProfile(config) {
    return this.createProfile({
        name: config.defaultProfileName,
        type: config.defaultProfileType,
        slug: 'default',
        putio_folder_name: config.putioFolder,
        downloadAt: config.targetDir,
        rpc_path: config.defaultRpcPath,
        enabled: true,
    });
  }

  createProfile(input) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO profiles (
        name, type, slug, putio_folder_name, putio_folder_id,
        download_at, rpc_path, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      input.type ?? 'custom',
      input.slug,
      input.putio_folder_name,
      input.putio_folder_id ?? null,
      profileDownloadAt(input),
      input.rpc_path,
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
    const allowed = [
      'name',
      'type',
      'slug',
      'putio_folder_name',
      'putio_folder_id',
      'download_at',
      'rpc_path',
      'enabled',
    ];
    const keys = allowed.filter((key) => Object.hasOwn(normalizedPatch, key));
    if (keys.length === 0) return existing;
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => (key === 'enabled' ? (normalizedPatch[key] ? 1 : 0) : normalizedPatch[key]));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE profiles SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findProfileById(id);
  }

  deleteProfile(id) {
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
    const existing = this.findTransferByHash(hash)
      ?? (input.putio_transfer_id ? this.findTransferByPutioId(input.putio_transfer_id) : undefined);

    if (!existing) {
      const stmt = this.db.prepare(`
        INSERT INTO transfers (
          profile_id, putio_transfer_id, putio_file_id, save_parent_id, hash, name, source,
          source_type, category, download_dir, lifecycle, putio_status,
          percent_done, total_size, downloaded_ever, uploaded_ever,
          download_speed, upload_speed, eta, error, error_string,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          lifecycle = ?, putio_status = ?, percent_done = ?, total_size = ?,
          downloaded_ever = ?, uploaded_ever = ?, download_speed = ?,
          upload_speed = ?, eta = ?, error = ?, error_string = ?,
          removed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(
      merged.profile_id,
      merged.putio_transfer_id,
      merged.putio_file_id,
      merged.save_parent_id,
      merged.name,
      merged.source,
      merged.source_type,
      merged.category,
      merged.download_dir,
      merged.lifecycle,
      merged.putio_status,
      merged.percent_done,
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

  updateTransfer(id, patch) {
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
    const values = keys.map((key) => (key === 'error' ? (patch[key] ? 1 : 0) : patch[key]));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE transfers SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findTransferById(id);
  }

  findTransferById(id) {
    const row = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    return normalizeTransferRow(row);
  }

  findTransferByHash(hash) {
    const row = this.db.prepare('SELECT * FROM transfers WHERE lower(hash) = lower(?)').get(normalizeHash(hash));
    return normalizeTransferRow(row);
  }

  findTransferByPutioId(putioTransferId) {
    const row = this.db.prepare('SELECT * FROM transfers WHERE putio_transfer_id = ?').get(putioTransferId);
    return normalizeTransferRow(row);
  }

  findTransfer(identifier) {
    if (identifier == null) return undefined;
    if (typeof identifier === 'number') return this.findTransferById(identifier);
    const value = String(identifier);
    if (/^\d+$/.test(value)) {
      return this.findTransferById(Number(value)) ?? this.findTransferByHash(value);
    }
    return this.findTransferByHash(value);
  }

  listActiveTransfers({ profileId } = {}) {
    const params = [];
    let where = 'removed_at IS NULL';
    if (profileId != null) {
      where += ' AND profile_id = ?';
      params.push(profileId);
    }
    return this.db.prepare(`
      SELECT * FROM transfers
      WHERE ${where}
      ORDER BY id ASC
    `).all(...params).map(normalizeTransferRow);
  }

  markTransferRemoved(id) {
    this.db.prepare(`
      UPDATE transfers
      SET removed_at = ?, lifecycle = 'removed', updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), id);
  }

  deleteTransfer(id) {
    this.db.prepare('DELETE FROM transfers WHERE id = ?').run(id);
  }

  upsertTransferFile(input) {
    const timestamp = nowIso();
    const existing = this.findTransferFileByPutioId(input.putio_file_id);
    if (!existing) {
      const result = this.db.prepare(`
        INSERT INTO transfer_files (
          transfer_id, putio_file_id, relative_path, size, downloaded_bytes,
          status, attempts, error_string, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.transfer_id,
        input.putio_file_id,
        input.relative_path,
        input.size ?? 0,
        input.downloaded_bytes ?? 0,
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
            WHEN status = 'complete' THEN downloaded_bytes
            ELSE ?
          END,
          status = CASE
            WHEN status = 'complete' THEN status
            ELSE ?
          END,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.transfer_id,
      input.relative_path,
      input.size ?? existing.size,
      input.downloaded_bytes ?? existing.downloaded_bytes,
      input.status ?? existing.status,
      timestamp,
      existing.id,
    );
    return this.findTransferFileById(existing.id);
  }

  findTransferFileById(id) {
    const row = this.db.prepare('SELECT * FROM transfer_files WHERE id = ?').get(id);
    return normalizeFileRow(row);
  }

  findTransferFileByPutioId(putioFileId) {
    const row = this.db.prepare('SELECT * FROM transfer_files WHERE putio_file_id = ?').get(putioFileId);
    return normalizeFileRow(row);
  }

  listFilesForTransfer(transferId) {
    return this.db.prepare(`
      SELECT * FROM transfer_files
      WHERE transfer_id = ?
      ORDER BY relative_path ASC
    `).all(transferId).map(normalizeFileRow);
  }

  listPendingFiles(limit = 100) {
    return this.db.prepare(`
      SELECT tf.*, t.category, t.name AS transfer_name, t.hash AS transfer_hash
      FROM transfer_files tf
      JOIN transfers t ON t.id = tf.transfer_id
      WHERE tf.status IN ('pending', 'failed')
        AND t.removed_at IS NULL
      ORDER BY tf.id ASC
      LIMIT ?
    `).all(limit).map(normalizeFileRow);
  }

  updateTransferFile(id, patch) {
    const allowed = ['downloaded_bytes', 'status', 'attempts', 'error_string'];
    const keys = allowed.filter((key) => Object.hasOwn(patch, key));
    if (keys.length === 0) return this.findTransferFileById(id);
    const assignments = keys.map((key) => `${key} = ?`).join(', ');
    const values = keys.map((key) => patch[key]);
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE transfer_files SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.findTransferFileById(id);
  }

  getTransferFileStats(transferId) {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS total_files,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed_files,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
        COALESCE(SUM(size), 0) AS total_size,
        COALESCE(SUM(downloaded_bytes), 0) AS downloaded_size
      FROM transfer_files
      WHERE transfer_id = ?
    `).get(transferId);
  }
}
