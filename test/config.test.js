import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('loadConfig reads .env when requested and lets explicit env win', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-env-'));
  await writeFile(path.join(root, '.env'), [
    'PUTIORR_LISTEN_HOST=127.0.0.1',
    'PUTIORR_LISTEN_PORT=17010',
    'PUTIORR_TARGET_DIR=./from-env-file',
    'PUTIORR_PUTIO_APP_ID=env-file-app',
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
  assert.equal(config.slowSpeedThresholdBytesPerSecond, 1048576);
  assert.equal(config.slowSpeedDurationSeconds, 90);
  assert.equal(config.slowSpeedGraceSeconds, 15);
  assert.equal(config.slowSpeedMinSizeBytes, 52428800);
});
