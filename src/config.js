import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function boolFromEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function intFromEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolvePath(value, cwd = process.cwd()) {
  return path.resolve(cwd, value);
}

function jsonFromEnv(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON in PUTIORR_PROFILES_JSON: ${error.message}`);
  }
}

function parseDotEnv(contents) {
  const parsed = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadDotEnv(cwd) {
  try {
    return parseDotEnv(readFileSync(path.join(cwd, '.env'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export function loadConfig(env = process.env, cwd = process.cwd(), options = {}) {
  const shouldLoadEnvFile = options.loadEnvFile ?? env === process.env;
  const sourceEnv = shouldLoadEnvFile ? { ...loadDotEnv(cwd), ...env } : env;

  const targetDir = resolvePath(sourceEnv.PUTIORR_TARGET_DIR ?? './downloads', cwd);
  const statePath = resolvePath(sourceEnv.PUTIORR_STATE_PATH ?? './data/putiorr.sqlite', cwd);

  return {
    appName: 'putiorr',
    targetDir,
    statePath,
    listenHost: sourceEnv.PUTIORR_LISTEN_HOST ?? '0.0.0.0',
    listenPort: intFromEnv(sourceEnv.PUTIORR_LISTEN_PORT, 9091),
    putioToken: sourceEnv.PUTIORR_PUTIO_TOKEN ?? '',
    putioAppId: sourceEnv.PUTIORR_PUTIO_APP_ID ?? '3270',
    putioFolder: (sourceEnv.PUTIORR_PUTIO_FOLDER ?? 'putiorr').toLowerCase(),
    defaultProfileName: sourceEnv.PUTIORR_DEFAULT_PROFILE_NAME ?? 'Custom',
    defaultProfileType: sourceEnv.PUTIORR_DEFAULT_PROFILE_TYPE ?? 'custom',
    defaultRpcPath: sourceEnv.PUTIORR_DEFAULT_RPC_PATH ?? '/transmission/rpc',
    seedProfiles: jsonFromEnv(sourceEnv.PUTIORR_PROFILES_JSON, []),
    workers: Math.max(1, intFromEnv(sourceEnv.PUTIORR_WORKERS, 4)),
    pollIntervalMs: Math.max(5_000, intFromEnv(sourceEnv.PUTIORR_POLL_INTERVAL_MS, 30_000)),
    slowSpeedThresholdBytesPerSecond: Math.max(
      0,
      intFromEnv(sourceEnv.PUTIORR_SLOW_SPEED_THRESHOLD_BYTES_PER_SECOND, 0),
    ),
    slowSpeedDurationSeconds: Math.max(
      0,
      intFromEnv(sourceEnv.PUTIORR_SLOW_SPEED_DURATION_SECONDS, 120),
    ),
    slowSpeedGraceSeconds: Math.max(
      0,
      intFromEnv(sourceEnv.PUTIORR_SLOW_SPEED_GRACE_SECONDS, 30),
    ),
    slowSpeedMinSizeBytes: Math.max(
      0,
      intFromEnv(sourceEnv.PUTIORR_SLOW_SPEED_MIN_SIZE_BYTES, 100 * 1024 * 1024),
    ),
    cleanupRemoteFiles: boolFromEnv(sourceEnv.PUTIORR_CLEANUP_REMOTE_FILES, true),
    rpcUsername: sourceEnv.PUTIORR_RPC_USERNAME ?? '',
    rpcPassword: sourceEnv.PUTIORR_RPC_PASSWORD ?? '',
    refreshOnRpc: boolFromEnv(sourceEnv.PUTIORR_REFRESH_ON_RPC, false),
    liveReload: boolFromEnv(sourceEnv.PUTIORR_LIVE_RELOAD, sourceEnv.NODE_ENV !== 'production'),
  };
}

export function ensureRuntimeDirs(config) {
  mkdirSync(config.targetDir, { recursive: true });
  mkdirSync(path.dirname(config.statePath), { recursive: true });
}
