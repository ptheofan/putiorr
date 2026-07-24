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

const VALID_TORRENT_BASE64 = Buffer.from('d8:announce0:e').toString('base64');

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
  return { config, store, putio, rpcServer, base: `http://127.0.0.1:${port}` };
}

function closeHarness(harness) {
  return async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  };
}

async function postGrab(harness, payload, { grabHeader = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (grabHeader) headers['X-Putiorr-Grab'] = '1';
  const response = await fetch(`${harness.base}/api/grab`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('grab with a magnet link adds a put.io transfer for the profile', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
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

test('grab accepts a magnet link with an upper-case scheme', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'MAGNET:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(harness.putio.added.length, 1);
  assert.equal(harness.putio.added[0].source, 'magnet:?xt=urn:btih:abcdef1234567890');
});

test('grab with base64 torrent metainfo uploads the torrent file', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64: VALID_TORRENT_BASE64,
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(harness.putio.uploads.length, 1);
  assert.equal(harness.putio.uploads[0].name, 'Example.Release.torrent');
});

test('grab prefers the torrent metainfo when both a magnet and metainfo are sent', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    torrentBase64: VALID_TORRENT_BASE64,
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 200);
  assert.equal(harness.putio.uploads.length, 1);
  assert.equal(harness.putio.added.length, 0);
});

test('grab without the anti-CSRF header returns 403 and adds nothing', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  }, { grabHeader: false });

  assert.equal(status, 403);
  assert.equal(body.error, 'grab requires the X-Putiorr-Grab header');
  assert.equal(harness.putio.added.length, 0);
  assert.equal(harness.putio.uploads.length, 0);
});

test('grab with an unknown profile returns 404', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const { status, body } = await postGrab(harness, {
    profileId: 9999,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 404);
  assert.equal(body.error, 'Profile not found');
});

test('grab without a profileId returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const { status, body } = await postGrab(harness, {
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'profileId is required');
});

test('grab for a disabled profile returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const disabled = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'sonarr',
    downloadAt: path.join(harness.config.targetDir, 'sonarr-root'),
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });
  harness.store.updateProfile(disabled.id, { enabled: false });

  const { status, body } = await postGrab(harness, {
    profileId: disabled.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /is disabled/);
  assert.equal(harness.putio.added.length, 0);
});

test('grab without a magnet or torrent returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, { profileId: profile.id });

  assert.equal(status, 400);
  assert.match(body.error, /magnet link or torrentBase64/);
});

test('grab with a non-magnet string returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'https://tracker.example/not-a-magnet',
  });

  assert.equal(status, 400);
});

test('grab rejects metainfo that is not a bencoded torrent', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64: Buffer.from('<html>login</html>').toString('base64'),
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'torrentBase64 is not a valid .torrent file');
  assert.equal(harness.putio.uploads.length, 0);
});

test('grab rejects metainfo that is not valid base64', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64: 'not base64 at all!!',
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'torrentBase64 is not a valid .torrent file');
  assert.equal(harness.putio.uploads.length, 0);
});
