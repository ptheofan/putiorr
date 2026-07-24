import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';
import { TransmissionRpcServer } from '../src/transmission/server.js';

class FakePutio {
  constructor() {
    this.added = [];
    this.uploads = [];
  }

  async ensureFolder() {
    return 42;
  }

  async addTransfer(source, folderId) {
    this.added.push({ source, folderId });
    return {
      id: 77,
      name: 'Example.Release',
      hash: 'abcdef1234567890',
      status: 'IN_QUEUE',
      percentDone: 0,
      size: 1000,
      downloaded: 0,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      estimatedTime: -1,
      fileId: 88,
      saveParentId: folderId,
      magnetUri: source,
    };
  }

  async uploadTorrent(data, name, folderId) {
    this.uploads.push({ size: data.length, name, folderId });
    return {
      id: 78,
      name: name.replace(/\.torrent$/i, ''),
      hash: 'fedcba0987654321',
      status: 'IN_QUEUE',
      percentDone: 0,
      size: 2000,
      downloaded: 0,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      estimatedTime: -1,
      fileId: 89,
      saveParentId: folderId,
    };
  }

  async listTransfers() {
    return [];
  }
}

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-grab-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_LISTEN_HOST: '127.0.0.1',
    PUTIORR_LISTEN_PORT: '0',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    PUTIORR_PUTIO_APP_ID: '12345',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const putio = new FakePutio();
  const service = new TransferService({ config, store, putioFactory: () => putio });
  const rpcServer = new TransmissionRpcServer({ config, service });
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  return { store, putio, rpcServer, base: `http://127.0.0.1:${port}` };
}

async function postGrab(harness, payload) {
  const response = await fetch(`${harness.base}/api/grab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('grab with a magnet link adds a put.io transfer for the profile', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    sourceUrl: 'https://tracker.example/release/1',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(typeof body.transfer.id, 'number');
  assert.equal(harness.putio.added.length, 1);
  assert.equal(harness.putio.added[0].folderId, 42);
});

test('grab with base64 torrent metainfo uploads the torrent file', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];
  const torrentBase64 = Buffer.from('d8:announce0:e').toString('base64');

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64,
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(harness.putio.uploads.length, 1);
  assert.equal(harness.putio.uploads[0].name, 'Example.Release.torrent');
});

test('grab with an unknown profile returns 404', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());

  const { status, body } = await postGrab(harness, {
    profileId: 9999,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 404);
  assert.equal(body.error, 'Profile not found');
});

test('grab without a magnet or torrent returns 400', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, { profileId: profile.id });

  assert.equal(status, 400);
  assert.match(body.error, /magnet link or torrentBase64/);
});

test('grab with a non-magnet string returns 400', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'https://tracker.example/not-a-magnet',
  });

  assert.equal(status, 400);
});
