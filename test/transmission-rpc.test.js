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
    this.deletedFiles = [];
    this.deletedTransfers = [];
  }

  async ensureFolder() {
    return 42;
  }

  async addTransfer(source, folderId) {
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

  async uploadTorrent() {
    throw new Error('not used');
  }

  async listTransfers() {
    return [];
  }

  async deleteFile(id) {
    this.deletedFiles.push(id);
  }

  async deleteTransfer(id) {
    this.deletedTransfers.push(id);
  }
}

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-rpc-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_LISTEN_HOST: '127.0.0.1',
    PUTIORR_LISTEN_PORT: '0',
    PUTIORR_PUTIO_TOKEN: 'test-token',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const putio = new FakePutio();
  const service = new TransferService({
    config,
    store,
    putioFactory: () => putio,
  });
  const rpcServer = new TransmissionRpcServer({ config, service });
  rpcServer.oauth = {
    async start() {
      return {
        code: 'ABCD',
        qrCodeUrl: 'https://example.test/qr',
        linkUrl: 'https://put.io/link',
      };
    },
    async poll(code) {
      if (code !== 'ABCD') return { status: 'WAITING', oauthToken: '' };
      return { status: 'OK', oauthToken: 'oauth-token-from-putio' };
    },
  };
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  const url = `http://127.0.0.1:${port}/transmission/rpc`;
  return { config, store, putio, rpcServer, url };
}

function waitForWebSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
}

function nextWebSocketJson(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for websocket message'));
    }, 3_000);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };

    const onError = () => {
      cleanup();
      reject(new Error('websocket error'));
    };

    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

function collectWebSocketJson(socket, durationMs = 250) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timeout = setTimeout(() => {
      cleanup();
      resolve(messages);
    }, durationMs);

    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };

    const onError = () => {
      cleanup();
      reject(new Error('websocket error'));
    };

    const onMessage = (event) => {
      messages.push(JSON.parse(String(event.data)));
    };

    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

test('Transmission RPC handshake and session-get', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const conflict = await fetch(harness.url, { method: 'POST' });
  assert.equal(conflict.status, 409);
  const sessionId = conflict.headers.get('x-transmission-session-id');
  assert.ok(sessionId);

  const response = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method: 'session-get', tag: 1 }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, 'success');
  assert.equal(body.tag, 1);
  assert.equal(body.arguments['download-dir'], harness.config.targetDir);
});

test('torrent-add persists category and torrent-get returns Transmission shape', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const first = await fetch(harness.url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');

  const addResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-add',
      arguments: {
        filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
        'download-dir': path.join(harness.config.targetDir, 'tv'),
      },
    }),
  });
  assert.equal(addResponse.status, 200);
  const addBody = await addResponse.json();
  assert.equal(addBody.result, 'success');
  assert.equal(addBody.arguments['torrent-added'].hashString, 'abcdef');

  const getResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-get',
      arguments: { fields: ['id', 'hashString', 'name', 'downloadDir', 'percentDone'] },
    }),
  });
  const getBody = await getResponse.json();
  assert.equal(getBody.result, 'success');
  assert.equal(getBody.arguments.torrents.length, 1);
  assert.deepEqual(getBody.arguments.torrents[0], {
    id: 1,
    hashString: 'abcdef',
    name: 'Example.Release',
    downloadDir: path.join(harness.config.targetDir, 'tv'),
    percentDone: 0,
  });
});

test('torrent-remove deletes remote resources and hides transfer', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const first = await fetch(harness.url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');

  await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-add',
      arguments: { filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release' },
    }),
  });

  const removeResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-remove',
      arguments: { ids: ['ABCDEF'] },
    }),
  });
  assert.equal(removeResponse.status, 200);
  assert.deepEqual(harness.putio.deletedFiles, [88]);
  assert.deepEqual(harness.putio.deletedTransfers, [77]);

  const getResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method: 'torrent-get', arguments: {} }),
  });
  const getBody = await getResponse.json();
  assert.deepEqual(getBody.arguments.torrents, []);
});

test('profile-specific RPC path uses that profile download directory', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'sonarr',
    downloadAt: path.join(harness.config.targetDir, 'sonarr-root'),
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });

  const url = harness.url.replace('/transmission/rpc', sonarr.rpc_path);
  const first = await fetch(url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');

  const sessionResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method: 'session-get' }),
  });
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.arguments['download-dir'], sonarr.downloadAt);

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-add',
      arguments: {
        filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
        'download-dir': path.join(sonarr.downloadAt, 'season-1'),
      },
    }),
  });

  const row = harness.store.findTransferByHash('ABCDEF');
  assert.equal(row.profile_id, sonarr.id);
  assert.equal(row.category, 'season-1');
});

test('torrent-get reports weighted progress consistently for Sonarr', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 99,
    putio_file_id: 199,
    save_parent_id: 42,
    hash: 'weightedhash',
    name: 'Weighted.Release',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 1000,
    downloaded_ever: 500,
    download_speed: 10,
    eta: 25,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Episode.One.mkv',
    size: 400,
    downloaded_bytes: 400,
    status: 'complete',
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 201,
    relative_path: 'Episode.Two.mkv',
    size: 600,
    downloaded_bytes: 200,
    status: 'downloading',
  });

  const first = await fetch(harness.url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');
  const response = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-get',
      arguments: {
        fields: [
          'id',
          'percentDone',
          'leftUntilDone',
          'downloadedEver',
          'totalSize',
          'files',
          'fileStats',
        ],
      },
    }),
  });
  const body = await response.json();

  assert.equal(body.result, 'success');
  assert.deepEqual(body.arguments.torrents, [{
    id: transfer.id,
    percentDone: 0.8,
    leftUntilDone: 200,
    downloadedEver: 800,
    totalSize: 1000,
    files: [
      { bytesCompleted: 400, length: 400, name: 'Episode.One.mkv' },
      { bytesCompleted: 400, length: 600, name: 'Episode.Two.mkv' },
    ],
    fileStats: [
      { bytesCompleted: 400, wanted: true, priority: 0 },
      { bytesCompleted: 400, wanted: true, priority: 0 },
    ],
  }]);
});

test('generic RPC endpoint returns active transfers across profiles', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'sonarr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });
  harness.store.createOrUpdateTransfer({
    profile_id: sonarr.id,
    putio_transfer_id: 99,
    putio_file_id: 199,
    save_parent_id: 42,
    hash: 'sonarrhash',
    name: 'Sonarr.Release',
    category: 'sonarr',
    download_dir: path.join(harness.config.targetDir, 'sonarr'),
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
  });

  const first = await fetch(harness.url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');
  const getResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-get',
      arguments: { fields: ['id', 'hashString', 'name', 'downloadDir'] },
    }),
  });

  const getBody = await getResponse.json();
  assert.equal(getBody.result, 'success');
  assert.deepEqual(getBody.arguments.torrents, [{
    id: 1,
    hashString: 'sonarrhash',
    name: 'Sonarr.Release',
    downloadDir: path.join(harness.config.targetDir, 'sonarr'),
  }]);
});

test('generic RPC endpoint routes torrent-add to a profile matching the category', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'sonarr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });

  const first = await fetch(harness.url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');
  const addResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-add',
      arguments: {
        filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
        'download-dir': path.join(harness.config.targetDir, 'sonarr'),
      },
    }),
  });

  assert.equal(addResponse.status, 200);
  const row = harness.store.findTransferByHash('ABCDEF');
  assert.equal(row.profile_id, sonarr.id);
  assert.equal(row.category, 'sonarr');
});

test('web API exposes settings and profile CRUD', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const settings = await fetch(harness.url.replace('/transmission/rpc', '/api/settings'));
  assert.equal(settings.status, 200);
  const settingsBody = await settings.json();
  assert.equal(settingsBody.tokenConfigured, true);
  assert.equal(settingsBody.downloadPolicy.slowSpeedThresholdBytesPerSecond, 0);

  const settingsUpdate = await fetch(harness.url.replace('/transmission/rpc', '/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      downloadPolicy: {
        slowSpeedThresholdBytesPerSecond: 2048,
        slowSpeedDurationSeconds: 45,
        slowSpeedGraceSeconds: 10,
        slowSpeedMinSizeBytes: 1048576,
      },
    }),
  });
  assert.equal(settingsUpdate.status, 200);
  assert.deepEqual((await settingsUpdate.json()).downloadPolicy, {
    slowSpeedThresholdBytesPerSecond: 2048,
    slowSpeedDurationSeconds: 45,
    slowSpeedGraceSeconds: 10,
    slowSpeedMinSizeBytes: 1048576,
  });

  const create = await fetch(harness.url.replace('/transmission/rpc', '/api/profiles'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Radarr',
      type: 'radarr',
      slug: 'radarr',
      putio_folder_name: 'radarr',
      downloadAt: path.join(harness.config.targetDir, 'movies'),
      rpc_path: '/radarr/transmission/rpc',
      enabled: true,
    }),
  });
  assert.equal(create.status, 201);
  const profile = await create.json();
  assert.equal(profile.name, 'Radarr');
  assert.equal(profile.downloadAt, path.join(harness.config.targetDir, 'movies'));
  assert.equal(Object.hasOwn(profile, 'local_path'), false);

  const update = await fetch(harness.url.replace('/transmission/rpc', `/api/profiles/${profile.id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).enabled, false);
});

test('web API starts and completes put.io OAuth flow', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  harness.store.deleteSetting('putio_token');

  const startResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(startResponse.status, 200);
  const startBody = await startResponse.json();
  assert.equal(startBody.code, 'ABCD');
  assert.equal(startBody.linkUrl, 'https://put.io/link');

  const pollResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/poll'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ABCD' }),
  });
  assert.equal(pollResponse.status, 200);
  const pollBody = await pollResponse.json();
  assert.equal(pollBody.status, 'OK');
  assert.equal(pollBody.tokenConfigured, true);
  assert.equal(harness.store.getSetting('putio_token'), 'oauth-token-from-putio');
});

test('websocket streams only targeted download updates', async (t) => {
  const harness = await createHarness();
  const socket = new WebSocket(harness.url.replace('http://', 'ws://').replace('/transmission/rpc', '/api/ws'));
  t.after(async () => {
    socket.close();
    await harness.rpcServer.stop();
    harness.store.close();
  });

  await waitForWebSocketOpen(socket);
  const initial = await nextWebSocketJson(socket);
  assert.equal(initial.type, 'downloads');
  assert.equal(initial.reason, 'connect');
  assert.deepEqual(initial.downloads, []);
  assert.equal(Object.hasOwn(initial, 'settings'), false);
  assert.equal(Object.hasOwn(initial, 'profiles'), false);

  socket.send(JSON.stringify({ type: 'refresh' }));
  const refreshed = await nextWebSocketJson(socket, (message) => message.reason === 'refresh');
  assert.equal(refreshed.type, 'downloads');
  assert.deepEqual(refreshed.downloads, []);
  assert.equal(Object.hasOwn(refreshed, 'settings'), false);
  assert.equal(Object.hasOwn(refreshed, 'profiles'), false);

  const profile = harness.store.findProfileBySlug('default');
  const update = await fetch(harness.url.replace('/transmission/rpc', `/api/profiles/${profile.id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Default Updated' }),
  });
  assert.equal(update.status, 200);

  const pushed = await collectWebSocketJson(socket);
  for (const message of pushed) {
    assert.equal(message.type, 'downloads');
    assert.equal(Object.hasOwn(message, 'settings'), false);
    assert.equal(Object.hasOwn(message, 'profiles'), false);
    assert.notEqual(message.reason, 'profiles');
  }
});

test('web UI includes development live reload hook', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const webUrl = harness.url.replace('/transmission/rpc', '/');
  const page = await fetch(webUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /__putiorr\/livereload/);

  const controller = new AbortController();
  const stream = await fetch(harness.url.replace('/transmission/rpc', '/__putiorr/livereload'), {
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  assert.match(Buffer.from(value).toString('utf8'), /event: ready/);
});
