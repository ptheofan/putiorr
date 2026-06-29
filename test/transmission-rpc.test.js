import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';
import { TRANSMISSION_STATUS } from '../src/transmission/progress.js';
import { TransmissionRpcServer } from '../src/transmission/server.js';
import { CURRENT_VERSION, parseSemver } from '../src/version.js';

class FakePutio {
  constructor() {
    this.deletedFiles = [];
    this.deletedTransfers = [];
    this.transfers = [];
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
    return this.transfers;
  }

  async deleteFile(id) {
    this.deletedFiles.push(id);
  }

  async deleteTransfer(id) {
    this.deletedTransfers.push(id);
  }
}

async function createHarness(env = {}, serverOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-rpc-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_LISTEN_HOST: '127.0.0.1',
    PUTIORR_LISTEN_PORT: '0',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    PUTIORR_PUTIO_APP_ID: '12345',
    ...env,
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const putio = new FakePutio();
  const service = new TransferService({
    config,
    store,
    putioFactory: () => putio,
  });
  const rpcServer = new TransmissionRpcServer({ config, service, ...serverOptions });
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  const url = `http://127.0.0.1:${port}/transmission/rpc`;
  return { config, store, putio, service, rpcServer, url };
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

test('failed RPC surfaces the real error in the Transmission result field', async (t) => {
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
        // A non-magnet URL is rejected by addTorrent; the reason must reach the client.
        filename: 'https://example.com/example.torrent',
        'download-dir': harness.config.targetDir,
      },
    }),
  });

  // Transmission convention: HTTP 200, with the human-readable reason in `result`.
  assert.equal(addResponse.status, 200);
  const addBody = await addResponse.json();
  assert.notEqual(addBody.result, 'success');
  assert.notEqual(addBody.result, 'error');
  assert.match(addBody.result, /requires a magnet link or base64 metainfo/);
});

test('dashboard manual start calls the download manager', async (t) => {
  const started = [];
  const harness = await createHarness({}, {
    downloadManager: {
      async startTransferDownload(id) {
        started.push(id);
        return { ok: true, transferId: id, files: 1 };
      },
    },
  });
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'manualstarthash',
    name: 'Manual.Start',
    lifecycle: 'remote',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 5,
  });

  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/start`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(started, [transfer.id]);
  assert.equal(body.ok, true);
  assert.equal(body.transferId, transfer.id);
  assert.ok(Array.isArray(body.downloads));
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
  const transfer = harness.store.findTransferByHash('ABCDEF');

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
  assert.equal(harness.store.findTransferById(transfer.id), undefined);

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

test('torrent-remove with delete-local-data deletes local staging files', async (t) => {
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
      arguments: {
        filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
        'download-dir': path.join(harness.config.targetDir, 'radarr'),
      },
    }),
  });

  const stagedPath = path.join(harness.config.targetDir, 'radarr', 'Example.Release');
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(stagedPath, 'Example.Release.mkv'), 'movie');

  const removeResponse = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-remove',
      arguments: {
        ids: ['ABCDEF'],
        'delete-local-data': true,
      },
    }),
  });

  assert.equal(removeResponse.status, 200);
  await assert.rejects(() => stat(stagedPath), { code: 'ENOENT' });
});

test('dashboard bucket delete can leave put.io data and tombstone the download', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(profile.id, { putio_folder_id: 42 });
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'bucketdeletehash',
    name: 'Bucket.Delete',
    category: 'radarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 5,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Bucket.Delete.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });

  const stagedPath = path.join(profile.download_at, 'radarr', 'Bucket.Delete');
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(stagedPath, 'Bucket.Delete.mkv'), 'movie');

  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/delete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteRemote: false, deleteLocal: true }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bucketDeleted, true);
  assert.deepEqual(harness.putio.deletedFiles, []);
  assert.deepEqual(harness.putio.deletedTransfers, []);
  await assert.rejects(() => stat(stagedPath), { code: 'ENOENT' });
  assert.ok(harness.store.findTransferById(transfer.id).removed_at);

  harness.putio.transfers = [{
    id: 77,
    name: 'Bucket.Delete',
    hash: 'bucketdeletehash',
    status: 'COMPLETED',
    percentDone: 100,
    size: 5,
    downloaded: 5,
    uploaded: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    estimatedTime: -1,
    fileId: 88,
    saveParentId: 42,
  }];
  await harness.service.refreshRemoteTransfers();
  assert.deepEqual(harness.store.listActiveTransfers(), []);
});

test('dashboard file delete removes one file locally and optionally from put.io', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'filedeletehash',
    name: 'File.Delete',
    category: 'sonarr',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 11,
  });
  const firstFile = harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Episode.One.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  const secondFile = harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 201,
    relative_path: 'Episode.Two.mkv',
    size: 6,
    downloaded_bytes: 6,
    status: 'complete',
  });

  const stagedPath = path.join(profile.download_at, 'sonarr', 'File.Delete');
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(stagedPath, 'Episode.One.mkv'), 'one');
  await writeFile(path.join(stagedPath, 'Episode.Two.mkv'), 'two');

  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/files/delete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [firstFile.id], deleteRemote: true, deleteLocal: true }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bucketDeleted, false);
  assert.deepEqual(harness.putio.deletedFiles, [200]);
  assert.deepEqual(harness.putio.deletedTransfers, []);
  await assert.rejects(() => stat(path.join(stagedPath, 'Episode.One.mkv')), { code: 'ENOENT' });
  await stat(path.join(stagedPath, 'Episode.Two.mkv'));
  // deleted from put.io -> the file row is physically removed, not tombstoned
  assert.equal(harness.store.findTransferFileById(firstFile.id), undefined);
  assert.deepEqual(
    harness.store.listFilesForTransfer(transfer.id).map((file) => file.id),
    [secondFile.id],
  );
});

test('dashboard deleting all selected files deletes the whole bucket', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'allfilesdeletehash',
    name: 'All.Files.Delete',
    category: 'lidarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 11,
  });
  const firstFile = harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Disc.One.flac',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  const secondFile = harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 201,
    relative_path: 'Disc.Two.flac',
    size: 6,
    downloaded_bytes: 6,
    status: 'complete',
  });

  const stagedPath = path.join(profile.download_at, 'lidarr', 'All.Files.Delete');
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(stagedPath, 'Disc.One.flac'), 'one');
  await writeFile(path.join(stagedPath, 'Disc.Two.flac'), 'two');

  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/files/delete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [firstFile.id, secondFile.id], deleteRemote: true, deleteLocal: true }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bucketDeleted, true);
  assert.deepEqual(harness.putio.deletedFiles, [88]);
  assert.deepEqual(harness.putio.deletedTransfers, [77]);
  await assert.rejects(() => stat(stagedPath), { code: 'ENOENT' });
  // deleted from put.io -> the transfer row is physically removed, not tombstoned
  assert.equal(harness.store.findTransferById(transfer.id), undefined);
});

test('dashboard bucket delete keeps local files when deleteLocal is omitted', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(profile.id, { putio_folder_id: 42 });
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'keeplocalhash',
    name: 'Keep.Local',
    category: 'radarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 5,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Keep.Local.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });

  const stagedPath = path.join(profile.download_at, 'radarr', 'Keep.Local');
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(stagedPath, 'Keep.Local.mkv'), 'movie');

  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/delete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteRemote: true }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bucketDeleted, true);
  assert.deepEqual(harness.putio.deletedTransfers, [77]);
  // deleteLocal omitted -> downloaded files stay on disk
  await stat(path.join(stagedPath, 'Keep.Local.mkv'));
  // deleted from put.io -> the transfer row is physically removed, not tombstoned
  assert.equal(harness.store.findTransferById(transfer.id), undefined);
});

test('dashboard file delete keeps local files when deleteLocal is omitted', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'keepfilehash',
    name: 'Keep.File',
    category: 'sonarr',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 11,
  });
  const firstFile = harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Episode.One.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 201,
    relative_path: 'Episode.Two.mkv',
    size: 6,
    downloaded_bytes: 6,
    status: 'complete',
  });

  const stagedPath = path.join(profile.download_at, 'sonarr', 'Keep.File');
  await mkdir(stagedPath, { recursive: true });
  await writeFile(path.join(stagedPath, 'Episode.One.mkv'), 'one');
  await writeFile(path.join(stagedPath, 'Episode.Two.mkv'), 'two');

  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/files/delete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [firstFile.id], deleteRemote: true }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.bucketDeleted, false);
  assert.deepEqual(harness.putio.deletedFiles, [200]);
  // deleteLocal omitted -> the downloaded file stays on disk even though its row is gone
  await stat(path.join(stagedPath, 'Episode.One.mkv'));
  await stat(path.join(stagedPath, 'Episode.Two.mkv'));
  // deleted from put.io -> the file row is physically removed, not tombstoned
  assert.equal(harness.store.findTransferFileById(firstFile.id), undefined);
});

test('tombstoned transfer kept on put.io is physically pruned once put.io drops it', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(profile.id, { putio_folder_id: 42 });
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'prunehash',
    name: 'Prune.Me',
    category: 'radarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 5,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Prune.Me.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });

  // Delete from the dashboard but keep it on put.io -> tombstone, not hard-delete.
  const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/delete`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleteRemote: false }),
  });
  assert.equal(response.status, 200);
  assert.ok(harness.store.findTransferById(transfer.id).removed_at);

  // While put.io still lists it, the tombstone must survive (no resurrection, no prune).
  harness.putio.transfers = [{
    id: 77,
    name: 'Prune.Me',
    hash: 'prunehash',
    status: 'COMPLETED',
    percentDone: 100,
    size: 5,
    saveParentId: 42,
    fileId: 88,
  }];
  await harness.service.refreshRemoteTransfers();
  assert.ok(harness.store.findTransferById(transfer.id)?.removed_at, 'tombstone kept while still on put.io');
  assert.deepEqual(harness.store.listActiveTransfers(), []);

  // Once put.io no longer lists it, the next poll hard-deletes the tombstone (files cascade).
  harness.putio.transfers = [];
  await harness.service.refreshRemoteTransfers();
  assert.equal(harness.store.findTransferById(transfer.id), undefined);
  assert.deepEqual(harness.store.listFilesForTransfer(transfer.id), []);
});

test('tombstoned files under a processed transfer are physically purged; active ones are kept', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');

  // Processed transfer: a deleted-but-kept file should be hard-deleted by the sweep.
  const processed = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'processedhash',
    name: 'Processed',
    category: 'radarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 11,
  });
  const keptFile = harness.store.upsertTransferFile({
    transfer_id: processed.id,
    putio_file_id: 200,
    relative_path: 'Kept.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  const deletedFile = harness.store.upsertTransferFile({
    transfer_id: processed.id,
    putio_file_id: 201,
    relative_path: 'Deleted.mkv',
    size: 6,
    downloaded_bytes: 6,
    status: 'complete',
  });
  harness.store.markTransferFileDeleted(deletedFile.id);

  // Still-downloading transfer: its tombstone must survive (could still re-download).
  const downloading = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 78,
    putio_file_id: 89,
    save_parent_id: 42,
    hash: 'downloadinghash',
    name: 'Downloading',
    category: 'radarr',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 50,
    total_size: 6,
  });
  const downloadingDeleted = harness.store.upsertTransferFile({
    transfer_id: downloading.id,
    putio_file_id: 202,
    relative_path: 'StillThere.mkv',
    size: 6,
    downloaded_bytes: 3,
    status: 'pending',
  });
  harness.store.markTransferFileDeleted(downloadingDeleted.id);

  const purged = harness.store.purgeDeletedFilesForProcessedTransfers();

  assert.equal(purged, 1);
  assert.equal(harness.store.findTransferFileById(deletedFile.id), undefined);
  assert.ok(harness.store.findTransferFileById(keptFile.id));
  // Tombstone under a non-processed transfer is left intact.
  assert.equal(harness.store.findTransferFileById(downloadingDeleted.id)?.status, 'deleted');
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

test('processed torrents report seed goal reached for Radarr cleanup', async (t) => {
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
    hash: 'processedhash',
    name: 'Processed.Release',
    category: 'radarr',
    download_dir: path.join(harness.config.targetDir, 'radarr'),
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 1000,
    downloaded_ever: 1000,
    eta: -1,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Processed.Release.mkv',
    size: 1000,
    downloaded_bytes: 1000,
    status: 'complete',
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
          'status',
          'leftUntilDone',
          'isFinished',
          'secondsSeeding',
          'seedIdleLimit',
          'seedIdleMode',
          'seedRatioLimit',
          'seedRatioMode',
          'labels',
        ],
      },
    }),
  });
  const body = await response.json();

  assert.equal(body.result, 'success');
  assert.deepEqual(body.arguments.torrents, [{
    id: transfer.id,
    status: TRANSMISSION_STATUS.seed,
    leftUntilDone: 0,
    isFinished: true,
    secondsSeeding: 1,
    seedIdleLimit: 0,
    seedIdleMode: 1,
    seedRatioLimit: 0,
    seedRatioMode: 1,
    labels: ['radarr'],
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
  assert.equal(typeof settingsBody.defaultDownloadProfileId, 'number');
  assert.equal(settingsBody.downloadPolicy.slowSpeedThresholdBytesPerSecond, 0);
  assert.equal(settingsBody.putioOAuth.appId, '12345');
  assert.equal(settingsBody.putioOAuth.defaultAppId, '12345');
  assert.equal(settingsBody.putioOAuth.appIdOverridden, false);
  assert.equal(settingsBody.putioOAuth.relayUrl, 'https://ptheofan.github.io/putiorr/putio-oauth-relay.html');
  assert.equal(settingsBody.putioOAuth.defaultRelayUrl, 'https://ptheofan.github.io/putiorr/putio-oauth-relay.html');
  assert.equal(settingsBody.putioOAuth.relayUrlOverridden, false);
  assert.equal(settingsBody.putioOAuth.redirectUri, harness.url.replace('/transmission/rpc', '/api/oauth/callback'));
  assert.equal(settingsBody.putioOAuth.requiresCustomApp, false);

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

  const downloadProfiles = await fetch(harness.url.replace('/transmission/rpc', '/api/download-profiles'));
  assert.equal(downloadProfiles.status, 200);
  const [defaultDownloadProfile] = await downloadProfiles.json();
  assert.equal(defaultDownloadProfile.slug, 'default');
  assert.equal(defaultDownloadProfile.slowSpeedThresholdBytesPerSecond, 2048);

  const createDownloadProfile = await fetch(harness.url.replace('/transmission/rpc', '/api/download-profiles'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Movies',
      slug: 'movies',
      slowSpeedThresholdBytesPerSecond: 4096,
      slowSpeedDurationSeconds: 120,
      slowSpeedGraceSeconds: 20,
      slowSpeedMinSizeBytes: 10,
    }),
  });
  assert.equal(createDownloadProfile.status, 201);
  const movieDownloadProfile = await createDownloadProfile.json();
  assert.equal(movieDownloadProfile.name, 'Movies');
  assert.equal(movieDownloadProfile.slowSpeedThresholdBytesPerSecond, 4096);

  const create = await fetch(harness.url.replace('/transmission/rpc', '/api/profiles'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Radarr',
      type: 'radarr',
      slug: 'radarr',
      downloadProfileId: movieDownloadProfile.id,
      putio_folder_name: 'radarr',
      downloadAt: path.join(harness.config.targetDir, 'movies'),
      rpc_path: '/radarr/transmission/rpc',
      clientHost: '127.0.0.1',
      clientPort: new URL(harness.url).port,
      clientUseSsl: false,
      enabled: true,
    }),
  });
  assert.equal(create.status, 201);
  const profile = await create.json();
  assert.equal(profile.name, 'Radarr');
  assert.equal(profile.downloadAt, path.join(harness.config.targetDir, 'movies'));
  assert.equal(profile.download_profile_id, movieDownloadProfile.id);
  assert.equal(profile.client_host, '127.0.0.1');
  assert.equal(profile.client_port, new URL(harness.url).port);
  assert.equal(profile.client_use_ssl, false);
  assert.equal(Object.hasOwn(profile, 'local_path'), false);

  const testClientSettings = await fetch(harness.url.replace('/transmission/rpc', '/api/profiles/test-client-settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  assert.equal(testClientSettings.status, 200);
  const testClientSettingsBody = await testClientSettings.json();
  assert.equal(testClientSettingsBody.ok, true);
  assert.equal(testClientSettingsBody.testedRpcPath, true);
  assert.match(testClientSettingsBody.message, /shared folder write tests passed/);

  const update = await fetch(harness.url.replace('/transmission/rpc', `/api/profiles/${profile.id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_host: 'putiorr',
      client_port: '9091',
      client_use_ssl: false,
      enabled: false,
    }),
  });
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.client_host, 'putiorr');
  assert.equal(updated.client_port, '9091');
  assert.equal(updated.client_use_ssl, false);
  assert.equal(updated.enabled, false);
});

test('web API profile client settings test rejects an unusable download folder', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  await mkdir(harness.config.targetDir, { recursive: true });
  const blockedPath = path.join(harness.config.targetDir, 'blocked-file');
  await writeFile(blockedPath, 'not a directory');
  const profile = harness.store.createProfile({
    name: 'Blocked',
    type: 'custom',
    slug: 'blocked',
    putio_folder_name: 'blocked',
    downloadAt: blockedPath,
    rpc_path: '/blocked/transmission/rpc',
    clientHost: '127.0.0.1',
    clientPort: new URL(harness.url).port,
    enabled: true,
  });

  const response = await fetch(harness.url.replace('/transmission/rpc', '/api/profiles/test-client-settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Shared download folder is not writable/);
});

test('web API stores and resets put.io OAuth setting overrides', async (t) => {
  const harness = await createHarness({
    PUTIORR_PUTIO_TOKEN: '',
  });
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const relayUrl = 'https://example.github.io/putiorr/custom-relay.html/';
  const update = await fetch(harness.url.replace('/transmission/rpc', '/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      putioOAuth: {
        appId: '7777',
        relayUrl,
      },
    }),
  });
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.putioOAuth.appId, '7777');
  assert.equal(updated.putioOAuth.defaultAppId, '12345');
  assert.equal(updated.putioOAuth.appIdOverridden, true);
  assert.equal(updated.putioOAuth.relayUrl, 'https://example.github.io/putiorr/custom-relay.html');
  assert.equal(updated.putioOAuth.defaultRelayUrl, 'https://ptheofan.github.io/putiorr/putio-oauth-relay.html');
  assert.equal(updated.putioOAuth.relayUrlOverridden, true);
  assert.equal(updated.putioOAuth.overridesConfigured, true);
  assert.equal(updated.putioOAuth.mode, 'hosted-relay');

  const startResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(startResponse.status, 200);
  const startBody = await startResponse.json();
  const authUrl = new URL(startBody.authUrl);
  assert.equal(authUrl.searchParams.get('client_id'), '7777');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://example.github.io/putiorr/custom-relay.html');

  const selfHostedUpdate = await fetch(harness.url.replace('/transmission/rpc', '/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      putioOAuth: {
        appId: '7777',
        relayUrl: '',
      },
    }),
  });
  assert.equal(selfHostedUpdate.status, 200);
  const selfHosted = await selfHostedUpdate.json();
  assert.equal(selfHosted.putioOAuth.mode, 'self-hosted');
  assert.equal(selfHosted.putioOAuth.putioRedirectUri, selfHosted.putioOAuth.redirectUri);

  const reset = await fetch(harness.url.replace('/transmission/rpc', '/api/settings'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      putioOAuth: {
        reset: true,
      },
    }),
  });
  assert.equal(reset.status, 200);
  const resetBody = await reset.json();
  assert.equal(resetBody.putioOAuth.appId, '12345');
  assert.equal(resetBody.putioOAuth.relayUrl, 'https://ptheofan.github.io/putiorr/putio-oauth-relay.html');
  assert.equal(resetBody.putioOAuth.overridesConfigured, false);
});

test('web API exposes fresh version update status', async (t) => {
  let versionFetches = 0;
  const current = parseSemver(CURRENT_VERSION);
  assert.ok(current);
  const latestVersion = `${current.major}.${current.minor}.${current.patch + 1}`;
  const latestTag = `v${latestVersion}`;
  const releaseUrl = `https://github.com/ptheofan/putiorr/releases/tag/${latestTag}`;
  const harness = await createHarness({}, {
    fetch: async () => {
      versionFetches += 1;
      return new Response(JSON.stringify({
        tag_name: latestTag,
        html_url: releaseUrl,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const firstResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/version'));
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.currentVersion, CURRENT_VERSION);
  assert.equal(firstBody.latestVersion, latestVersion);
  assert.equal(firstBody.updateAvailable, true);
  assert.equal(firstBody.releaseUrl, releaseUrl);

  const secondResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/version'));
  assert.equal(secondResponse.status, 200);
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.currentVersion, CURRENT_VERSION);
  assert.equal(secondBody.latestVersion, latestVersion);
  assert.equal(secondBody.updateAvailable, true);
  assert.equal(secondBody.releaseUrl, releaseUrl);
  assert.equal(versionFetches, 2);
});

test('web API starts and completes put.io OAuth flow', async (t) => {
  const harness = await createHarness({
    PUTIORR_PUTIO_OAUTH_RELAY_URL: '',
  });
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
  assert.equal(startBody.mode, 'redirect');
  assert.equal(startBody.redirectUri, harness.url.replace('/transmission/rpc', '/api/oauth/callback'));
  assert.equal(startBody.putioRedirectUri, startBody.redirectUri);
  const authUrl = new URL(startBody.authUrl);
  assert.equal(authUrl.origin + authUrl.pathname, 'https://api.put.io/v2/oauth2/authenticate');
  assert.equal(authUrl.searchParams.get('client_id'), harness.config.putioAppId);
  assert.equal(authUrl.searchParams.get('response_type'), 'token');
  assert.equal(authUrl.searchParams.get('redirect_uri'), startBody.redirectUri);
  const state = authUrl.searchParams.get('state');
  assert.ok(state);

  const callbackResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/callback'));
  assert.equal(callbackResponse.status, 200);
  assert.match(await callbackResponse.text(), /Completing authorization/);

  const completeResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/complete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, oauthToken: 'oauth-token-from-putio' }),
  });
  assert.equal(completeResponse.status, 200);
  const completeBody = await completeResponse.json();
  assert.equal(completeBody.tokenConfigured, true);
  assert.equal(harness.store.getSetting('putio_token'), 'oauth-token-from-putio');
});

test('web API starts put.io OAuth through hosted relay when configured', async (t) => {
  const relayUrl = 'https://example.github.io/putiorr/putio-oauth-relay.html';
  const harness = await createHarness({
    PUTIORR_PUTIO_OAUTH_RELAY_URL: relayUrl,
    PUTIORR_PUTIO_TOKEN: '',
  });
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const startResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(startResponse.status, 200);
  const startBody = await startResponse.json();
  assert.equal(startBody.redirectUri, harness.url.replace('/transmission/rpc', '/api/oauth/callback'));
  assert.equal(startBody.putioRedirectUri, relayUrl);
  const authUrl = new URL(startBody.authUrl);
  assert.equal(authUrl.searchParams.get('redirect_uri'), relayUrl);
  const state = authUrl.searchParams.get('state');
  const relayState = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  assert.equal(relayState.v, 1);
  assert.equal(relayState.callbackUrl, startBody.redirectUri);

  const completeResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/complete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, oauthToken: 'relay-token-from-putio' }),
  });
  assert.equal(completeResponse.status, 200);
  assert.equal((await completeResponse.json()).tokenConfigured, true);
  assert.equal(harness.store.getSetting('putio_token'), 'relay-token-from-putio');
});

test('web API rejects redirect OAuth with put.io Swagger app id', async (t) => {
  const harness = await createHarness({
    PUTIORR_PUTIO_APP_ID: '3270',
    PUTIORR_PUTIO_TOKEN: '',
  });
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const settingsResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/settings'));
  assert.equal(settingsResponse.status, 200);
  const settingsBody = await settingsResponse.json();
  assert.equal(settingsBody.putioOAuth.requiresCustomApp, true);
  assert.equal(settingsBody.putioOAuth.redirectUri, harness.url.replace('/transmission/rpc', '/api/oauth/callback'));

  const startResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/oauth/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(startResponse.status, 400);
  const body = await startResponse.json();
  assert.match(body.error, /Swagger test API/);
  assert.match(body.error, /PUTIORR_PUTIO_APP_ID/);
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
