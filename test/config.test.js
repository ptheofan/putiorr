import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureRuntimeDirs, loadConfig } from '../src/config.js';

test('loadConfig defaults to hosted put.io OAuth relay', () => {
  const config = loadConfig({}, process.cwd(), { loadEnvFile: false });

  assert.equal(config.putioAppId, '9354');
  assert.equal(config.putioOAuthRelayUrl, 'https://ptheofan.github.io/putiorr/putio-oauth-relay.html');
});

test('loadConfig reads .env when requested and lets explicit env win', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-env-'));
  await writeFile(path.join(root, '.env'), [
    'PUTIORR_LISTEN_HOST=127.0.0.1',
    'PUTIORR_LISTEN_PORT=17010',
    'PUTIORR_TARGET_DIR=./from-env-file',
    'PUTIORR_PUTIO_APP_ID=env-file-app',
    'PUTIORR_PUBLIC_URL=https://putiorr.example.test/',
    'PUTIORR_PUTIO_OAUTH_RELAY_URL=https://example.github.io/putiorr/putio-oauth-relay.html/',
    'PUTIORR_SLOW_SPEED_THRESHOLD_BYTES_PER_SECOND=1048576',
    'PUTIORR_SLOW_SPEED_DURATION_SECONDS=90',
    'PUTIORR_SLOW_SPEED_GRACE_SECONDS=15',
    'PUTIORR_SLOW_SPEED_MIN_SIZE_BYTES=52428800',
  ].join('\n'));

  const config = loadConfig({
    PUTIORR_LISTEN_PORT: '17020',
  }, root, { loadEnvFile: true });

  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.listenPort, 17020);
  assert.equal(config.targetDir, path.join(root, 'from-env-file'));
  assert.equal(config.putioAppId, 'env-file-app');
  assert.equal(config.publicUrl, 'https://putiorr.example.test');
  assert.equal(config.putioOAuthRelayUrl, 'https://example.github.io/putiorr/putio-oauth-relay.html');
  assert.equal(config.slowSpeedThresholdBytesPerSecond, 1048576);
  assert.equal(config.slowSpeedDurationSeconds, 90);
  assert.equal(config.slowSpeedGraceSeconds, 15);
  assert.equal(config.slowSpeedMinSizeBytes, 52428800);
});

test('loadConfig parses booleans, JSON, and clamps invalid numbers', () => {
  const config = loadConfig({
    PUTIORR_PROFILES_JSON: '[{"name":"Movies"}]',
    PUTIORR_WORKERS: '-4',
    PUTIORR_POLL_INTERVAL_MS: '100',
    PUTIORR_CLEANUP_REMOTE_FILES: 'off',
    PUTIORR_REFRESH_ON_RPC: 'yes',
    PUTIORR_LIVE_RELOAD: '',
    NODE_ENV: 'production',
  }, process.cwd(), { loadEnvFile: false });

  assert.deepEqual(config.seedProfiles, [{ name: 'Movies' }]);
  assert.equal(config.workers, 1);
  assert.equal(config.pollIntervalMs, 5_000);
  assert.equal(config.cleanupRemoteFiles, false);
  assert.equal(config.refreshOnRpc, true);
  assert.equal(config.liveReload, false);

  assert.throws(
    () => loadConfig({ PUTIORR_PROFILES_JSON: '{' }, process.cwd(), { loadEnvFile: false }),
    /Invalid JSON/,
  );
});

test('ensureRuntimeDirs creates download and state directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-runtime-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: path.join(root, 'data', 'state.sqlite'),
  }, root, { loadEnvFile: false });

  ensureRuntimeDirs(config);

  assert.equal(path.isAbsolute(config.targetDir), true);
});
