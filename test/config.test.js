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
  ].join('\n'));

  const config = loadConfig({
    PUTIORR_LISTEN_PORT: '17020',
  }, root, { loadEnvFile: true });

  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.listenPort, 17020);
  assert.equal(config.targetDir, path.join(root, 'from-env-file'));
  assert.equal(config.putioAppId, 'env-file-app');
});
