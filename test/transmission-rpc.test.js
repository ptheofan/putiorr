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

function magnetInfoHash(source) {
  const match = String(source ?? '').match(/xt=urn:btih:([^&]+)/i);
  return match ? match[1].toLowerCase() : '';
}

class FakePutio {
  constructor() {
    this.deletedFiles = [];
    this.deletedTransfers = [];
    this.transfers = [];
  }

  async ensureFolder() {
    return 42;
  }

  // put.io parses the magnet it is handed, so the hash it reports back is the
  // magnet's own infohash. The fake used to answer with an unrelated string,
  // which only went unnoticed while the stored hash was write-once and taken
  // from the magnet; put.io's report is authoritative now.
  async addTransfer(source, folderId) {
    return {
      id: 77,
      name: 'Example.Release',
      hash: magnetInfoHash(source),
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
  // Every *arr resolves the files as downloadDir + name (Sonarr's
  // TransmissionBase.GetOutputPath), so these two have to join into the folder
  // the files are actually staged into — which is why the name reported here
  // is the put.io name, untouched, and the folder is named for it.
  assert.deepEqual(getBody.arguments.torrents[0], {
    id: 1,
    hashString: 'abcdef',
    name: 'Example.Release',
    downloadDir: path.join(harness.config.targetDir, 'tv'),
    percentDone: 0,
  });
  assert.equal(
    path.join(getBody.arguments.torrents[0].downloadDir, getBody.arguments.torrents[0].name),
    path.join(harness.config.targetDir, 'tv', 'Example.Release'),
  );
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
  const transfer = harness.store.upsertDownload({
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
  const transfer = harness.store.findDownloadByHash('ABCDEF');

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
  assert.equal(harness.store.findDownloadById(transfer.id), undefined);

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
  const transfer = harness.store.upsertDownload({
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
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  assert.ok(harness.store.findDownloadById(transfer.id).removed_at);

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
  assert.deepEqual(harness.store.listActiveDownloads(), []);
});

test('dashboard file delete removes one file locally and optionally from put.io', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.upsertDownload({
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
  const firstFile = harness.store.upsertDownloadFile({
    download_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Episode.One.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  const secondFile = harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  assert.equal(harness.store.findDownloadFileById(firstFile.id), undefined);
  assert.deepEqual(
    harness.store.listFilesForDownload(transfer.id).map((file) => file.id),
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
  const transfer = harness.store.upsertDownload({
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
  const firstFile = harness.store.upsertDownloadFile({
    download_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Disc.One.flac',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  const secondFile = harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  assert.equal(harness.store.findDownloadById(transfer.id), undefined);
});

test('dashboard bucket delete keeps local files when deleteLocal is omitted', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(profile.id, { putio_folder_id: 42 });
  const transfer = harness.store.upsertDownload({
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
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  assert.equal(harness.store.findDownloadById(transfer.id), undefined);
});

test('dashboard can delete multiple selected buckets through mocked put.io', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfers = [1, 2, 3].map((index) => {
    const transfer = harness.store.upsertDownload({
      profile_id: profile.id,
      putio_transfer_id: 770 + index,
      putio_file_id: 880 + index,
      save_parent_id: 42,
      hash: `bulkdeletehash${index}`,
      name: `Bulk.Delete.${index}`,
      category: 'radarr',
      lifecycle: 'remote',
      putio_status: 'DOWNLOADING',
      percent_done: 40,
      total_size: 5,
    });
    harness.store.upsertDownloadFile({
      download_id: transfer.id,
      putio_file_id: 200 + index,
      relative_path: `Bulk.Delete.${index}.mkv`,
      size: 5,
      status: 'pending',
    });
    return transfer;
  });

  for (const transfer of transfers) {
    const response = await fetch(harness.url.replace('/transmission/rpc', `/api/downloads/${transfer.id}/delete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteRemote: true, deleteLocal: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.bucketDeleted, true);
  }

  assert.deepEqual(harness.putio.deletedFiles, [881, 882, 883]);
  assert.deepEqual(harness.putio.deletedTransfers, [771, 772, 773]);
  assert.deepEqual(harness.store.listActiveDownloads(), []);

  const downloadsResponse = await fetch(harness.url.replace('/transmission/rpc', '/api/downloads'));
  assert.equal(downloadsResponse.status, 200);
  // The quarantine is its own array so the dashboard can render it as a
  // separate needs-attention section rather than interleaving it.
  assert.deepEqual(await downloadsResponse.json(), { downloads: [], orphaned: [] });
});

test('dashboard file delete keeps local files when deleteLocal is omitted', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.upsertDownload({
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
  const firstFile = harness.store.upsertDownloadFile({
    download_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Episode.One.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  assert.equal(harness.store.findDownloadFileById(firstFile.id), undefined);
});

test('tombstoned transfer kept on put.io is physically pruned once put.io drops it', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(profile.id, { putio_folder_id: 42 });
  const transfer = harness.store.upsertDownload({
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
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  assert.ok(harness.store.findDownloadById(transfer.id).removed_at);

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
  assert.ok(harness.store.findDownloadById(transfer.id)?.removed_at, 'tombstone kept while still on put.io');
  assert.deepEqual(harness.store.listActiveDownloads(), []);

  // Once put.io no longer lists it, the next poll hard-deletes the tombstone (files cascade).
  harness.putio.transfers = [];
  await harness.service.refreshRemoteTransfers();
  assert.equal(harness.store.findDownloadById(transfer.id), undefined);
  assert.deepEqual(harness.store.listFilesForDownload(transfer.id), []);
});

test('put.io refresh removes remote transfers cancelled upstream', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const cancelled = harness.store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'cancelledremotehash',
    name: 'Cancelled.Remote',
    category: 'radarr',
    lifecycle: 'remote',
    putio_status: 'DOWNLOADING',
    percent_done: 42,
    total_size: 5,
  });
  const downloading = harness.store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 78,
    putio_file_id: 89,
    save_parent_id: 42,
    hash: 'keepdownloadinghash',
    name: 'Keep.Downloading',
    category: 'radarr',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 5,
  });
  const processed = harness.store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 79,
    putio_file_id: 90,
    save_parent_id: 42,
    hash: 'keepprocessedhash',
    name: 'Keep.Processed',
    category: 'radarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 5,
  });

  harness.putio.transfers = [];
  await harness.service.refreshRemoteTransfers();

  assert.equal(harness.store.findDownloadById(cancelled.id), undefined);
  assert.equal(harness.store.findDownloadById(downloading.id)?.lifecycle, 'downloading');
  assert.equal(harness.store.findDownloadById(processed.id)?.lifecycle, 'processed');
});

test('tombstoned files under a processed transfer are physically purged; active ones are kept', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');

  // Processed transfer: a deleted-but-kept file should be hard-deleted by the sweep.
  const processed = harness.store.upsertDownload({
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
  const keptFile = harness.store.upsertDownloadFile({
    download_id: processed.id,
    putio_file_id: 200,
    relative_path: 'Kept.mkv',
    size: 5,
    downloaded_bytes: 5,
    status: 'complete',
  });
  const deletedFile = harness.store.upsertDownloadFile({
    download_id: processed.id,
    putio_file_id: 201,
    relative_path: 'Deleted.mkv',
    size: 6,
    downloaded_bytes: 6,
    status: 'complete',
  });
  harness.store.markDownloadFileDeleted(deletedFile.id);

  // Still-downloading transfer: its tombstone must survive (could still re-download).
  const downloading = harness.store.upsertDownload({
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
  const downloadingDeleted = harness.store.upsertDownloadFile({
    download_id: downloading.id,
    putio_file_id: 202,
    relative_path: 'StillThere.mkv',
    size: 6,
    downloaded_bytes: 3,
    status: 'pending',
  });
  harness.store.markDownloadFileDeleted(downloadingDeleted.id);

  const purged = harness.store.purgeDeletedFilesForProcessedDownloads();

  assert.equal(purged, 1);
  assert.equal(harness.store.findDownloadFileById(deletedFile.id), undefined);
  assert.ok(harness.store.findDownloadFileById(keptFile.id));
  // Tombstone under a non-processed transfer is left intact.
  assert.equal(harness.store.findDownloadFileById(downloadingDeleted.id)?.status, 'deleted');
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

  const row = harness.store.findDownloadByHash('ABCDEF');
  assert.equal(row.profile_id, sonarr.id);
  assert.equal(row.category, 'season-1');
});

test('a torrent upload put.io reports no hash for is stored without one', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  harness.putio.uploadTorrent = async () => ({
    id: 91,
    name: 'Uploaded.Release',
    hash: '',
    status: 'IN_QUEUE',
    fileId: 92,
    saveParentId: 42,
  });

  const added = await harness.service.addTorrent({
    metainfo: Buffer.from('d8:announce0:e').toString('base64'),
    filename: 'upload.torrent',
  });

  // This used to be 20 random bytes: a permanent identity nothing on put.io
  // could ever confirm and no *arr could correlate, and one the store could
  // never correct because the hash was write-once.
  assert.equal(added['torrent-added'].hashString, '');
  const row = harness.store.findDownloadById(added['torrent-added'].id);
  assert.equal(row.hash, '');
  assert.equal(row.putio_transfer_id, 91);
});

test('a refresh that reports a different hash corrects the stored one', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const download = harness.store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 55,
    putio_file_id: 56,
    save_parent_id: 42,
    hash: '',
    name: 'Uploaded.Release',
    lifecycle: 'remote',
  });

  harness.putio.transfers = [{
    id: 55,
    name: 'Uploaded.Release',
    hash: 'REALHASHFROMPUTIO',
    status: 'DOWNLOADING',
    fileId: 56,
    saveParentId: 42,
  }];
  await harness.service.refreshRemoteTransfers();

  // Stored lowercase, the way every hash lookup compares them.
  assert.equal(harness.store.findDownloadById(download.id).hash, 'realhashfromputio');
  assert.equal(harness.store.findDownloadByHash('realhashfromputio').id, download.id);
});

test('torrent-get reports weighted progress consistently for Sonarr', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const profile = harness.store.findProfileBySlug('default');
  const transfer = harness.store.upsertDownload({
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
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
    putio_file_id: 200,
    relative_path: 'Episode.One.mkv',
    size: 400,
    downloaded_bytes: 400,
    status: 'complete',
  });
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
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
  const transfer = harness.store.upsertDownload({
    profile_id: profile.id,
    putio_transfer_id: 99,
    putio_file_id: 199,
    save_parent_id: 42,
    hash: 'processedhash',
    name: 'Processed.Release',
    category: 'radarr',
    lifecycle: 'processed',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 1000,
    downloaded_ever: 1000,
    eta: -1,
  });
  harness.store.upsertDownloadFile({
    download_id: transfer.id,
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

test('RPC listing is scoped to the profile selected by the request path', async (t) => {
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
  const defaultProfile = harness.store.updateProfile(
    harness.store.findProfileBySlug('default').id,
    { rpc_path: '/default/transmission/rpc' },
  );
  harness.store.upsertDownload({
    profile_id: defaultProfile.id,
    putio_transfer_id: 98,
    putio_file_id: 198,
    save_parent_id: 42,
    hash: 'defaulthash',
    name: 'Default.Release',
    category: 'default',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
  });
  harness.store.upsertDownload({
    profile_id: sonarr.id,
    putio_transfer_id: 99,
    putio_file_id: 199,
    save_parent_id: 42,
    hash: 'sonarrhash',
    name: 'Sonarr.Release',
    category: 'sonarr',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
  });

  const defaultUrl = harness.url.replace('/transmission/rpc', defaultProfile.rpc_path);
  const first = await fetch(defaultUrl, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');
  const getResponse = await fetch(defaultUrl, {
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
    hashString: 'defaulthash',
    name: 'Default.Release',
    downloadDir: path.join(harness.config.targetDir, 'default'),
  }]);
});

// An unowned shared endpoint used to answer torrent-get with every profile's
// downloads, each carrying another profile's downloadDir. session-get is the
// connection test *arr apps run, so that one still answers — with the server's
// own target dir, which names no profile and gives nothing away.
test('unowned generic RPC endpoint answers session-get but refuses cross-profile discovery', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const defaultProfile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(defaultProfile.id, { rpc_path: '/default/transmission/rpc' });
  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'sonarr',
    downloadAt: path.join(harness.config.targetDir, 'sonarr'),
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });
  harness.store.upsertDownload({
    profile_id: defaultProfile.id,
    putio_transfer_id: 101,
    putio_file_id: 201,
    hash: 'defaulthash',
    name: 'Default.Release',
    category: 'default',
    lifecycle: 'downloading',
  });
  harness.store.upsertDownload({
    profile_id: sonarr.id,
    putio_transfer_id: 102,
    putio_file_id: 202,
    hash: 'sonarrhash',
    name: 'Sonarr.Release',
    category: 'sonarr',
    lifecycle: 'downloading',
  });
  const first = await fetch(harness.url, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');

  const sessionResponse = await fetch(harness.url, {
    method: 'POST',
    headers: { 'X-Transmission-Session-Id': sessionId },
    body: JSON.stringify({ method: 'session-get' }),
  });
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.result, 'success');
  assert.equal(sessionBody.arguments['download-dir'], harness.config.targetDir);

  const getResponse = await fetch(harness.url, {
    method: 'POST',
    headers: { 'X-Transmission-Session-Id': sessionId },
    body: JSON.stringify({
      method: 'torrent-get',
      arguments: { fields: ['hashString', 'labels'] },
    }),
  });
  const getBody = await getResponse.json();
  assert.match(getBody.result, /shared RPC endpoint .* is ambiguous/);
  assert.equal(getBody.arguments, undefined);

  // Each profile still sees its own downloads on the path it owns.
  for (const [rpcPath, hash] of [['/default/transmission/rpc', 'defaulthash'], [sonarr.rpc_path, 'sonarrhash']]) {
    const scoped = await fetch(harness.url.replace('/transmission/rpc', rpcPath), {
      method: 'POST',
      headers: { 'X-Transmission-Session-Id': sessionId },
      body: JSON.stringify({
        method: 'torrent-get',
        arguments: { fields: ['hashString'] },
      }),
    });
    const scopedBody = await scoped.json();
    assert.equal(scopedBody.result, 'success');
    assert.deepEqual(scopedBody.arguments.torrents.map((torrent) => torrent.hashString), [hash]);
  }
});

// Was: "generic RPC endpoint routes RR request categories without URL Base
// changes" — it asserted that an add on the SHARED endpoint lands in whichever
// profile's slug/type/name matched the first segment of the download-dir, with
// no URL Base configured in the *arr. That is the routing issue #50 lists as a
// non-goal and the audit found to be a guess: it makes the category an
// ownership signal, so renaming a profile silently re-owns its downloads and
// two profiles claiming one category is a hard failure at add time.
//
// What replaces it is the mechanism that was always intended: each profile
// answers on its own RPC path, and the category is only ever the name of the
// staging subdirectory under the owner's folder. The shared endpoint still
// serves a single-profile install, which is what the "no URL Base" convenience
// was really protecting.
test('each RR profile is routed by its own RPC path, with the category naming only the subfolder', async (t) => {
  const scenarios = [
    { name: 'Sonarr', type: 'sonarr', slug: 'sonarr', category: 'sonarr' },
    { name: 'Radarr', type: 'radarr', slug: 'radarr', category: 'radarr' },
    { name: 'Lidarr', type: 'lidarr', slug: 'lidarr', category: 'lidarr' },
    { name: 'Whis', type: 'custom', slug: 'whis', category: 'whis' },
    { name: 'Prowlarr', type: 'prowlarr', slug: 'prowlarr', category: 'prowlarr' },
    // The category no longer has to name the profile at all, which is the whole
    // point: Prowlarr's per-release mapped categories used to need a
    // User-Agent bypass to get through, and now simply name a subfolder.
    { name: 'Prowlarr mapped category', type: 'prowlarr', slug: 'prowlarr', category: 'movies' },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const harness = await createHarness();
      t.after(async () => {
        await harness.rpcServer.stop();
        harness.store.close();
      });

      const defaultProfile = harness.store.findProfileBySlug('default');
      harness.store.updateProfile(defaultProfile.id, { rpc_path: '/default/transmission/rpc' });
      const profile = harness.store.createProfile({
        name: scenario.name,
        type: scenario.type,
        slug: scenario.slug,
        putio_folder_name: scenario.slug,
        downloadAt: harness.config.targetDir,
        rpc_path: `/${scenario.slug}/transmission/rpc`,
        enabled: true,
      });

      const profileUrl = harness.url.replace('/transmission/rpc', profile.rpc_path);
      const first = await fetch(profileUrl, { method: 'POST' });
      const sessionId = first.headers.get('x-transmission-session-id');
      const addResponse = await fetch(profileUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Transmission-Session-Id': sessionId,
        },
        body: JSON.stringify({
          method: 'torrent-add',
          arguments: {
            filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
            'download-dir': path.join(harness.config.targetDir, scenario.category),
          },
        }),
      });

      assert.equal(addResponse.status, 200);
      assert.equal((await addResponse.json()).result, 'success');
      const [row] = harness.store.listActiveDownloads({ profileId: profile.id });
      assert.equal(row.profile_id, profile.id);
      assert.equal(row.category, scenario.category);
      assert.equal(harness.store.listActiveDownloads({ profileId: defaultProfile.id }).length, 0);
    });
  }
});

test('a single-profile install still needs no URL Base change', async (t) => {
  // The shared endpoint keeps working for the setup every fresh install has,
  // which is what the category routing was really buying.
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const only = harness.store.findProfileBySlug('default');

  const added = await sharedRpcAs(harness, 'Sonarr/5.0', 'torrent-add', {
    filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
    'download-dir': path.join(harness.config.targetDir, 'tv'),
  });

  assert.equal(added.result, 'success');
  const row = harness.store.findDownloadById(added.arguments['torrent-added'].id);
  assert.equal(row.profile_id, only.id);
  assert.equal(row.category, 'tv');
});

// Was: "generic RPC endpoint rejects an unknown category and logs request
// context". Its refusal was "No enabled RR profile matches download-dir
// category unknown", which only existed because the category was doing the
// resolving. The refusal is now about the endpoint being ambiguous, which is
// the real problem. The redaction and request-context assertions — the part
// worth keeping — are unchanged.
test('an ambiguous shared endpoint logs the request context with credentials redacted', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const defaultProfile = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(defaultProfile.id, { rpc_path: '/default/transmission/rpc' });
  harness.store.createProfile({
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
  const errorLines = [];
  const originalConsoleError = console.error;
  console.error = (line) => errorLines.push(line);
  let addResponse;
  try {
    addResponse = await fetch(harness.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Transmission-Session-Id': sessionId,
        Authorization: 'Basic c29uYXJyOnNlY3JldA==',
        Cookie: 'session=secret',
        'User-Agent': 'UnknownRR/4.0',
      },
      body: JSON.stringify({
        method: 'torrent-add',
        arguments: {
          filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
          'download-dir': path.join(harness.config.targetDir, 'unknown'),
          labels: ['unknown'],
        },
      }),
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(addResponse.status, 200);
  const body = await addResponse.json();
  assert.match(body.result, /shared RPC endpoint .* is ambiguous/);
  assert.equal(harness.store.findDownloadByHash('ABCDEF'), undefined);
  const errorLog = errorLines.map((line) => JSON.parse(line))
    .find((entry) => entry.message === 'rpc request failed');
  assert.equal(errorLog.meta.requestMethod, 'POST');
  assert.equal(errorLog.meta.requestUrl, '/transmission/rpc');
  assert.equal(errorLog.meta.requestPath, '/transmission/rpc');
  assert.equal(errorLog.meta.requestHeaders.authorization, '[REDACTED]');
  assert.equal(errorLog.meta.requestHeaders.cookie, '[REDACTED]');
  assert.equal(errorLog.meta.requestHeaders['user-agent'], 'UnknownRR/4.0');
  assert.equal(errorLog.meta.requestHeaders['x-transmission-session-id'], sessionId);
  assert.deepEqual(errorLog.meta.requestPayload, {
    method: 'torrent-add',
    arguments: {
      filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
      'download-dir': path.join(harness.config.targetDir, 'unknown'),
      labels: ['unknown'],
    },
  });
  assert.equal(errorLog.meta.matchedProfile, null);
  assert.deepEqual(
    errorLog.meta.enabledProfiles.map((profile) => ({ slug: profile.slug, rpcPath: profile.rpcPath })),
    [
      { slug: 'default', rpcPath: '/default/transmission/rpc' },
      { slug: 'sonarr', rpcPath: '/sonarr/transmission/rpc' },
    ],
  );
});

// Was: "generic RPC endpoint rejects labels that conflict with download-dir
// category". It asserted two refusals, both of which existed only to police the
// inference layer: labels disagreeing with the category, and the category
// disagreeing with the profile the client's User-Agent named. Labels and
// categories select nothing now, so disagreeing with each other cannot be an
// error — the path already said who owns the add. Replaced with the positive
// contract, because "an *arr's labels are ignored" is the part that can regress.
test('labels and download-dir never override the profile the RPC path names', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  for (const slug of ['sonarr', 'radarr']) {
    harness.store.createProfile({
      name: slug[0].toUpperCase() + slug.slice(1),
      type: slug,
      slug,
      putio_folder_name: slug,
      downloadAt: harness.config.targetDir,
      rpc_path: `/${slug}/transmission/rpc`,
      enabled: true,
    });
  }
  const radarr = harness.store.findProfileBySlug('radarr');
  const radarrUrl = harness.url.replace('/transmission/rpc', radarr.rpc_path);

  const first = await fetch(radarrUrl, { method: 'POST' });
  const sessionId = first.headers.get('x-transmission-session-id');
  const response = await fetch(radarrUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
      // Every signal the old code would have resolved on points at Sonarr.
      'User-Agent': 'Sonarr/5.0',
    },
    body: JSON.stringify({
      method: 'torrent-add',
      arguments: {
        filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
        'download-dir': path.join(harness.config.targetDir, 'sonarr'),
        labels: ['sonarr'],
      },
    }),
  });

  assert.equal((await response.json()).result, 'success');
  const [row] = harness.store.listActiveDownloads();
  assert.equal(row.profile_id, radarr.id);
  // The category is kept as the subfolder name, and nothing more.
  assert.equal(row.category, 'sonarr');
  assert.equal(harness.store.listActiveDownloads({ profileId: harness.store.findProfileBySlug('sonarr').id }).length, 0);
});

test('put.io refresh preserves the RPC-selected profile association', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });
  const lidarr = harness.store.createProfile({
    name: 'Lidarr',
    type: 'lidarr',
    slug: 'lidarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/lidarr/transmission/rpc',
    enabled: true,
  });
  harness.store.upsertDownload({
    profile_id: lidarr.id,
    putio_transfer_id: 77,
    hash: 'sharedfolderhash',
    name: 'House.of.the.Dragon',
    category: 'sonarr',
    lifecycle: 'remote',
  });
  harness.putio.transfers = [{
    id: 77,
    name: 'House.of.the.Dragon',
    hash: 'sharedfolderhash',
    status: 'COMPLETED',
    percentDone: 100,
    size: 1_000,
    saveParentId: 42,
  }];

  await harness.service.refreshRemoteTransfers();

  const transfer = harness.store.findDownloadByPutioTransferId(77);
  assert.equal(transfer.profile_id, lidarr.id);
  assert.equal(harness.service.listDownloads()[0].profileName, 'Lidarr');
  assert.notEqual(transfer.profile_id, sonarr.id);
});

// Design rule 3: one put.io transfer belongs to one download item, and rule 1
// gives that item one owner. Two *arr apps grabbing the same release used to
// produce two associations over one transfer, which is exactly the state phase
// 3 removes — so the second profile's add is refused, naming the profile that
// holds it, rather than silently handing profile B a download owned by A.
test('a second profile grabbing an already-owned release is refused by name', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });
  const radarr = harness.store.createProfile({
    name: 'Radarr',
    type: 'radarr',
    slug: 'radarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/radarr/transmission/rpc',
    enabled: true,
  });

  async function rpc(rpcPath, method, args) {
    const url = harness.url.replace('/transmission/rpc', rpcPath);
    const handshake = await fetch(url, { method: 'POST' });
    const sessionId = handshake.headers.get('x-transmission-session-id');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Transmission-Session-Id': sessionId,
      },
      body: JSON.stringify({ method, arguments: args }),
    });
    return response.json();
  }

  const magnet = 'magnet:?xt=urn:btih:abcdef&dn=Shared.Release';
  const sonarrAdd = await rpc(sonarr.rpc_path, 'torrent-add', {
    filename: magnet,
    'download-dir': path.join(harness.config.targetDir, 'sonarr'),
  });
  const sonarrId = sonarrAdd.arguments['torrent-added'].id;
  assert.equal(typeof sonarrId, 'number');

  const radarrAdd = await rpc(radarr.rpc_path, 'torrent-add', {
    filename: magnet,
    'download-dir': path.join(harness.config.targetDir, 'radarr'),
  });
  assert.match(radarrAdd.result, /already belongs to RR profile Sonarr/);
  assert.equal(harness.store.listActiveDownloads({ profileId: radarr.id }).length, 0);

  // The owner re-grabbing its own release is still idempotent.
  const sonarrAgain = await rpc(sonarr.rpc_path, 'torrent-add', {
    filename: magnet,
    'download-dir': path.join(harness.config.targetDir, 'sonarr'),
  });
  assert.equal(sonarrAgain.arguments['torrent-added'].id, sonarrId);
  assert.equal(harness.store.listActiveDownloads({ profileId: sonarr.id }).length, 1);

  const sonarrPath = path.join(
    harness.config.targetDir,
    'sonarr',
    harness.store.findDownloadById(sonarrId).name,
  );
  await mkdir(sonarrPath, { recursive: true });
  await writeFile(path.join(sonarrPath, 'Shared.Release.mkv'), 'movie');

  // Removing it removes the put.io side too: nobody else holds a claim on it.
  const sonarrRemove = await rpc(sonarr.rpc_path, 'torrent-remove', {
    ids: [sonarrAdd.arguments['torrent-added'].hashString],
    'delete-local-data': true,
  });
  assert.equal(sonarrRemove.result, 'success');
  assert.equal(harness.store.findDownloadById(sonarrId), undefined);
  assert.deepEqual(harness.putio.deletedFiles, [88]);
  assert.deepEqual(harness.putio.deletedTransfers, [77]);
  await assert.rejects(() => stat(sonarrPath), { code: 'ENOENT' });
});

// Design rule 3 again, on the ingestion side: put.io's transfer id is the
// download's identity, so an add that comes back without one is an error rather
// than a row with a generated identity that nothing can ever match or prune.
test('an add whose put.io response carries no transfer id is refused', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });

  harness.putio.addTransfer = async () => ({ id: null, name: 'Nameless.Release', status: 'IN_QUEUE' });

  const handshake = await fetch(harness.url, { method: 'POST' });
  const sessionId = handshake.headers.get('x-transmission-session-id');
  const response = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({
      method: 'torrent-add',
      arguments: { filename: 'magnet:?xt=urn:btih:abcdef&dn=Nameless.Release' },
    }),
  });
  const body = await response.json();
  assert.match(body.result, /returned no transfer id/);
  assert.equal(harness.store.listActiveDownloads().length, 0);
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
  // The dashboard's adoption notice reads this; a fresh store has nothing to
  // report, and the field still has to be there rather than undefined.
  assert.deepEqual(settingsBody.adoptionNotices, []);
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

// The shared /transmission/rpc endpoint binds to the one profile that owns it
// only while there is no second profile it could have meant. A Putiorr Grab
// profile is never one of those: no download client can reach it, and the
// wizard tells the user its RPC step does not apply. Counting it broke
// torrent-remove for every single-profile *arr setup that added one.
async function sharedRpc(harness, method, args = {}) {
  const handshake = await fetch(harness.url, { method: 'POST', headers: { 'User-Agent': 'RemoveBot/1.0' } });
  const sessionId = handshake.headers.get('x-transmission-session-id');
  const response = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
      'User-Agent': 'RemoveBot/1.0',
    },
    body: JSON.stringify({ method, arguments: args }),
  });
  return response.json();
}

function createGrabProfile(harness, overrides = {}) {
  return harness.store.createProfile({
    name: 'Movies Grab',
    type: 'grab',
    slug: 'movies-grab',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    // A grab profile holds no Transmission endpoint: nothing connects to one.
    rpc_path: null,
    enabled: true,
    ...overrides,
  });
}

test('a Putiorr Grab profile does not make the shared RPC endpoint ambiguous', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  createGrabProfile(harness);

  // The grab profile is enabled and would be counted by a plain listProfiles().
  assert.equal(harness.store.listProfiles().length, 2);
  assert.equal(harness.service.resolveRpcProfile(undefined).slug, 'default');

  const added = await sharedRpc(harness, 'torrent-add', { filename: 'magnet:?xt=urn:btih:abcdef&dn=Shared.Release' });
  assert.equal(added.result, 'success');

  const removed = await sharedRpc(harness, 'torrent-remove', {
    ids: [added.arguments['torrent-added'].hashString],
  });
  assert.equal(removed.result, 'success');
  assert.equal(harness.store.findDownloadById(added.arguments['torrent-added'].id), undefined);
});

test('a second *arr profile still makes the shared RPC endpoint ambiguous', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  createGrabProfile(harness);
  harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });

  const removed = await sharedRpc(harness, 'torrent-remove', { ids: ['abcdef'] });
  assert.match(removed.result, /shared RPC endpoint .* is ambiguous/);
  assert.throws(() => harness.service.resolveRpcProfile(undefined), /shared RPC endpoint .* is ambiguous/);
});

test('a putiorr with only Putiorr Grab profiles has no *arr profile to resolve', async (t) => {
  // Silently accepting an *arr client into a grab profile would put its
  // downloads somewhere no app imports from.
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const seeded = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(seeded.id, { enabled: false });
  createGrabProfile(harness);

  assert.throws(
    () => harness.service.resolveRpcProfile(undefined),
    /No enabled RR profile is configured/,
  );
});

test('Save & test on a grab profile checks the folder and skips the *arr endpoint probe', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  await mkdir(harness.config.targetDir, { recursive: true });
  // A host no download client could reach: reporting success proves the
  // Transmission probe never ran. Every *arr preset would fail here.
  const profile = createGrabProfile(harness, {
    clientHost: 'unreachable.invalid',
    clientPort: '9',
  });

  const response = await fetch(harness.url.replace('/transmission/rpc', '/api/profiles/test-client-settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.testedRpcPath, false);
  assert.match(body.message, /Shared folder write test passed/);
  // None of these exist for a grab profile, so none of them may be reported.
  assert.doesNotMatch(body.message, /Host|SSL|RPC|endpoint/);
});

test('Save & test on a grab profile still refuses an unusable download folder', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  await mkdir(harness.config.targetDir, { recursive: true });
  const blockedPath = path.join(harness.config.targetDir, 'blocked-grab-file');
  await writeFile(blockedPath, 'not a directory');
  const profile = createGrabProfile(harness, {
    downloadAt: blockedPath,
    clientHost: 'unreachable.invalid',
  });

  const response = await fetch(harness.url.replace('/transmission/rpc', '/api/profiles/test-client-settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Shared download folder is not writable/);
});

test('an *arr add is never routed into a grab profile', async (t) => {
  // Nothing an *arr sends can name a grab profile. This one is called "Movies"
  // and the add asks for a movies/ subfolder, which used to be enough for it to
  // hijack the add and refuse it, pointing the user at an RPC path the grab
  // wizard does not even show.
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const grab = createGrabProfile(harness, { name: 'Movies', slug: 'movies' });

  const added = await sharedRpc(harness, 'torrent-add', {
    filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
    'download-dir': path.join(harness.config.targetDir, 'movies'),
  });

  assert.equal(added.result, 'success');
  const transfer = harness.store.findDownloadById(added.arguments['torrent-added'].id);
  assert.equal(transfer.profile_id, harness.store.findProfileBySlug('default').id);
  assert.equal(harness.store.listActiveDownloads({ profileId: grab.id }).length, 0);

  // The extension names the profile it means, so that path is unaffected — but
  // it is a genuinely different release, and one put.io transfer belongs to one
  // download, so the fake has to answer with a different transfer id.
  const originalAdd = harness.putio.addTransfer.bind(harness.putio);
  harness.putio.addTransfer = async (source, folderId) => ({
    ...(await originalAdd(source, folderId)),
    id: 78,
    fileId: 89,
  });
  const grabbed = await fetch(harness.url.replace('/transmission/rpc', '/api/grab'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Putiorr-Grab': '1' },
    body: JSON.stringify({ profileId: grab.id, magnet: 'magnet:?xt=urn:btih:0123456789abcdef' }),
  });
  assert.equal(grabbed.status, 200);
  assert.equal((await grabbed.json()).profile.name, 'Movies');
  assert.equal(harness.store.listActiveDownloads({ profileId: grab.id }).length, 1);
});

// Was: "the unaddressed add path skips grab profiles when it matches by
// category" — it proved a grab profile could not win the category match on an
// unbound shared endpoint. There is no category match left to win, so what it
// now proves is the surviving half: a grab profile is not an *arr profile, so
// it neither answers the shared endpoint nor counts toward its ambiguity.
test('a grab profile is invisible to the shared endpoint, whatever it is called', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const grab = createGrabProfile(harness, { name: 'Grabsite', slug: 'grabsite' });
  harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });

  const added = await sharedRpc(harness, 'torrent-add', {
    filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
    'download-dir': path.join(harness.config.targetDir, 'grabsite'),
  });

  // Two *arr profiles (the seeded one and Sonarr) make this ambiguous. The
  // grab profile is not the third, and could not have been the answer.
  assert.match(added.result, /shared RPC endpoint .* is ambiguous/);
  assert.doesNotMatch(added.result, /Grabsite/);
  assert.equal(harness.store.listActiveDownloads({ profileId: grab.id }).length, 0);
});


// Phase 1 of the ownership cleanup (#67): the RPC client's own name is not a
// credential. It used to select the profile on the shared endpoint and to veto
// the one the category picked, which made a header anyone on the LAN can set
// the only thing standing between a request and another profile's downloads.
async function sharedRpcAs(harness, userAgent, method, args = {}) {
  const handshake = await fetch(harness.url, { method: 'POST', headers: { 'User-Agent': userAgent } });
  const sessionId = handshake.headers.get('x-transmission-session-id');
  const response = await fetch(harness.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
      'User-Agent': userAgent,
    },
    body: JSON.stringify({ method, arguments: args }),
  });
  return response.json();
}

function createTwoArrProfiles(harness) {
  const sonarr = harness.store.createProfile({
    name: 'Sonarr',
    type: 'sonarr',
    slug: 'sonarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/sonarr/transmission/rpc',
    enabled: true,
  });
  const radarr = harness.store.createProfile({
    name: 'Radarr',
    type: 'radarr',
    slug: 'radarr',
    putio_folder_name: 'putiorr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/radarr/transmission/rpc',
    enabled: true,
  });
  return { sonarr, radarr };
}

test('a spoofed client name cannot remove another profile download on the shared endpoint', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr } = createTwoArrProfiles(harness);
  const transfer = harness.store.upsertDownload({
    profile_id: sonarr.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'spoofablehash',
    name: 'Sonarr.Release',
    category: 'sonarr',
    lifecycle: 'downloading',
  });

  const removed = await sharedRpcAs(harness, 'Sonarr/5.0', 'torrent-remove', { ids: [transfer.id] });

  assert.match(removed.result, /shared RPC endpoint .* is ambiguous/);
  assert.ok(harness.store.findDownloadById(transfer.id));
  assert.deepEqual(harness.putio.deletedTransfers, []);
  assert.deepEqual(harness.putio.deletedFiles, []);
});

test('a spoofed client name cannot add into another profile on the shared endpoint', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr } = createTwoArrProfiles(harness);
  const prowlarr = harness.store.createProfile({
    name: 'Prowlarr',
    type: 'prowlarr',
    slug: 'prowlarr',
    putio_folder_name: 'prowlarr',
    downloadAt: harness.config.targetDir,
    rpc_path: '/prowlarr/transmission/rpc',
    enabled: true,
  });

  // Prowlarr's mapped categories used to bypass every check on the strength of
  // its User-Agent alone, so naming yourself Prowlarr claimed the add outright.
  const added = await sharedRpcAs(harness, 'Prowlarr/2.0', 'torrent-add', {
    filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
    'download-dir': path.join(harness.config.targetDir, 'movies'),
  });

  assert.match(added.result, /shared RPC endpoint .* is ambiguous/);
  assert.equal(harness.store.listActiveDownloads({ profileId: prowlarr.id }).length, 0);
  assert.equal(harness.store.listActiveDownloads({ profileId: sonarr.id }).length, 0);
  assert.equal(harness.store.listActiveDownloads().length, 0);
});

test('an unresolved shared torrent-get refuses instead of listing every profile', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr, radarr } = createTwoArrProfiles(harness);
  harness.store.upsertDownload({
    profile_id: sonarr.id,
    putio_transfer_id: 101,
    hash: 'sonarrhash',
    name: 'Sonarr.Release',
    category: 'sonarr',
    lifecycle: 'downloading',
  });
  harness.store.upsertDownload({
    profile_id: radarr.id,
    putio_transfer_id: 102,
    hash: 'radarrhash',
    name: 'Radarr.Release',
    category: 'radarr',
    lifecycle: 'downloading',
  });

  const listed = await sharedRpcAs(harness, 'Sonarr/5.0', 'torrent-get', {
    fields: ['id', 'hashString', 'downloadDir'],
  });

  assert.match(listed.result, /shared RPC endpoint .* is ambiguous/);
  assert.equal(listed.arguments, undefined);
});

// The endpoint grab profiles used to derive is gone from the database, so a
// profile lookup can no longer refuse it — and serveWeb answers any unknown
// path with index.html and HTTP 200, which an *arr would read as success. The
// refusal is a static route on the shape of the path instead.
test('the retired Putiorr Grab RPC path refuses Transmission traffic', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const grab = createGrabProfile(harness);
  assert.equal(grab.rpc_path, null);
  const grabUrl = harness.url.replace('/transmission/rpc', `/grab/${grab.slug}/rpc`);

  const handshake = await fetch(grabUrl, { method: 'POST' });
  const sessionId = handshake.headers.get('x-transmission-session-id');
  for (const method of ['session-get', 'torrent-add', 'torrent-get', 'torrent-remove']) {
    const response = await fetch(grabUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Transmission-Session-Id': sessionId ?? '',
      },
      body: JSON.stringify({
        method,
        arguments: {
          filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
          ids: ['abcdef'],
        },
      }),
    });
    assert.equal(response.status, 200, method);
    const body = await response.json();
    assert.match(body.result, /browser extension/, method);
    assert.notEqual(body.result, 'success');
  }

  assert.equal(harness.store.listActiveDownloads({ profileId: grab.id }).length, 0);
  assert.equal(harness.store.listActiveDownloads().length, 0);
});

// Phase 2 of the ownership cleanup (#67): the RPC path is the only thing that
// names a profile. The shared endpoint serves exactly one *arr profile or
// refuses, and the refusal has to be actionable because it is now the entire
// user experience of a misconfigured multi-profile setup.
test('an ambiguous shared endpoint refuses torrent-add the same way it refuses get and remove', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  createTwoArrProfiles(harness);

  // The download-dir names a category that matches a profile exactly. That used
  // to be enough to own the add — while torrent-get and torrent-remove on the
  // same connection refused — so an *arr grabbed releases it could then never
  // see, import or remove, and re-grabbed them every RSS cycle.
  const added = await sharedRpcAs(harness, 'Sonarr/5.0', 'torrent-add', {
    filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
    'download-dir': path.join(harness.config.targetDir, 'sonarr'),
    labels: ['sonarr'],
  });

  assert.match(added.result, /ambiguous/);
  assert.equal(harness.store.listActiveDownloads().length, 0);

  for (const method of ['torrent-get', 'torrent-remove']) {
    const response = await sharedRpcAs(harness, 'Sonarr/5.0', method, { ids: ['abcdef'] });
    assert.equal(response.result, added.result, method);
  }
});

test('the ambiguity refusal names the RPC path each profile should use', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  createTwoArrProfiles(harness);

  const refused = await sharedRpcAs(harness, 'Sonarr/5.0', 'torrent-get', {});

  assert.match(refused.result, /Sonarr/);
  assert.match(refused.result, /\/sonarr\/transmission\/rpc/);
  assert.match(refused.result, /Radarr/);
  assert.match(refused.result, /\/radarr\/transmission\/rpc/);
  // The seeded profile still sits on the shared path, so there is no path to
  // hand out for it — say so instead of echoing the path that just failed.
  assert.match(refused.result, /Custom[^;]*own RPC path/);
});

test('torrent-remove refuses an id owned by another profile instead of reporting success', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr, radarr } = createTwoArrProfiles(harness);
  const owned = harness.store.upsertDownload({
    profile_id: sonarr.id,
    putio_transfer_id: 77,
    putio_file_id: 88,
    save_parent_id: 42,
    hash: 'crossprofilehash',
    name: 'Sonarr.Release',
    category: 'sonarr',
    lifecycle: 'downloading',
  });

  const radarrUrl = harness.url.replace('/transmission/rpc', radarr.rpc_path);
  const handshake = await fetch(radarrUrl, { method: 'POST' });
  const sessionId = handshake.headers.get('x-transmission-session-id');
  const response = await fetch(radarrUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method: 'torrent-remove', arguments: { ids: [owned.id] } }),
  });
  const body = await response.json();

  assert.match(body.result, /Sonarr/);
  assert.notEqual(body.result, 'success');
  assert.ok(harness.store.findDownloadById(owned.id));
  assert.deepEqual(harness.putio.deletedTransfers, []);

  // An id that exists nowhere stays a no-op: Transmission clients routinely
  // remove ids they have already forgotten about.
  const unknown = await fetch(radarrUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method: 'torrent-remove', arguments: { ids: [4242] } }),
  });
  assert.equal((await unknown.json()).result, 'success');
});

test('a grab profile parked on the shared path cannot take that endpoint down', async (t) => {
  // The grab refusal keys on the request path matching a grab profile's
  // rpc_path. A grab profile holding '/transmission/rpc' would otherwise refuse
  // every *arr on the box, so the shared path is never a grab path.
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const seeded = harness.store.findProfileBySlug('default');
  harness.store.updateProfile(seeded.id, { rpc_path: '/default/transmission/rpc' });
  createGrabProfile(harness, { rpc_path: '/transmission/rpc' });

  const added = await sharedRpcAs(harness, 'Sonarr/5.0', 'torrent-add', {
    filename: 'magnet:?xt=urn:btih:abcdef&dn=Example.Release',
  });

  assert.equal(added.result, 'success');
  assert.equal(harness.store.findDownloadById(added.arguments['torrent-added'].id).profile_id, seeded.id);
});

// The hash is informational and not unique — put.io can report one infohash for
// more than one transfer — so a hash names a set of downloads rather than one.
// The cross-profile refusal must only fire on something that identifies exactly
// one download, a numeric id, or it starts refusing correctly-configured
// clients.
async function profileRpc(harness, rpcPath, method, args) {
  const url = harness.url.replace('/transmission/rpc', rpcPath);
  const handshake = await fetch(url, { method: 'POST' });
  const sessionId = handshake.headers.get('x-transmission-session-id');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method, arguments: args }),
  });
  return response.json();
}

test('removing the same hash twice stays a no-op when another profile still holds it', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr, radarr } = createTwoArrProfiles(harness);
  const magnet = 'magnet:?xt=urn:btih:abcdef&dn=Shared.Release';

  const sonarrAdd = await profileRpc(harness, sonarr.rpc_path, 'torrent-add', {
    filename: magnet,
    'download-dir': path.join(harness.config.targetDir, 'sonarr'),
  });
  const hash = sonarrAdd.arguments['torrent-added'].hashString;
  // Radarr's own download, carrying the same hash on a different put.io
  // transfer. Rule 3 forbids sharing the transfer; nothing forbids the hash.
  harness.store.upsertDownload({
    profile_id: radarr.id,
    putio_transfer_id: 91,
    hash,
    name: 'Shared.Release',
    category: 'radarr',
    lifecycle: 'downloading',
  });

  const first = await profileRpc(harness, sonarr.rpc_path, 'torrent-remove', { ids: [hash] });
  assert.equal(first.result, 'success');

  // Sonarr's own row is gone; Radarr's survives. A retry, or the next cleanup
  // pass, must not be told to go and use Radarr's endpoint.
  const second = await profileRpc(harness, sonarr.rpc_path, 'torrent-remove', { ids: [hash] });
  assert.equal(second.result, 'success');
  assert.equal(harness.store.listActiveDownloads({ profileId: radarr.id }).length, 1);
});

test('a tombstoned row from another profile does not refuse a remove', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr, radarr } = createTwoArrProfiles(harness);
  const radarrRow = harness.store.upsertDownload({
    profile_id: radarr.id,
    putio_transfer_id: 90,
    putio_file_id: 91,
    hash: 'tombstonedhash',
    name: 'Radarr.Release',
    category: 'radarr',
    lifecycle: 'downloading',
  });
  // Deleted from the dashboard but kept on put.io: the row is a tombstone.
  await harness.service.deleteDownloadBucket(radarrRow.id, { deleteRemote: false, deleteLocal: false });

  const response = await profileRpc(harness, sonarr.rpc_path, 'torrent-remove', { ids: [radarrRow.id] });

  // Nothing live is being addressed, so there is nothing to correct anyone about.
  assert.equal(response.result, 'success');
});

test('the cross-profile refusal names no owner when the row it found has none', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const { sonarr, radarr } = createTwoArrProfiles(harness);
  const orphan = harness.store.upsertDownload({
    profile_id: radarr.id,
    putio_transfer_id: 92,
    hash: 'noownerhash',
    name: 'Orphan.Release',
    lifecycle: 'downloading',
  });
  // downloads.profile_id is NOT NULL now, so this state only exists on a
  // hand-edited database — which is exactly what the "(none)" branch defends
  // against, and it must still not send the user to another profile's endpoint.
  harness.store.db.exec('PRAGMA foreign_keys = OFF');
  harness.store.db.prepare('UPDATE downloads SET profile_id = 999999 WHERE id = ?').run(orphan.id);
  harness.store.db.exec('PRAGMA foreign_keys = ON');

  const response = await profileRpc(harness, sonarr.rpc_path, 'torrent-remove', { ids: [orphan.id] });

  assert.match(response.result, /\(none\)/);
  assert.doesNotMatch(response.result, /; use /);
  assert.ok(harness.store.findDownloadById(orphan.id));
});

// The owner's ruling on phase 3: legacy rows the collapse could not represent
// are quarantined rather than dropped, and the dashboard is where the user
// repairs them. GET /api/downloads keeps them out of the working list so the
// dashboard can render a distinct needs-attention section.
test('the dashboard can reassign and delete a quarantined download', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  const profile = harness.store.findProfileBySlug('default');
  const insert = harness.store.db.prepare(`
    INSERT INTO orphaned_downloads (
      putio_transfer_id, hash, name, category, lifecycle, total_size,
      legacy_download_dir, quarantined_at, reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(4242, 'quarantinedhash', 'Quarantined.Release', 'tv', 'remote', 100, '/downloads/tv/Quarantined.Release', 'now', 'no owner');
  insert.run(null, '', 'Identityless.Release', '', 'remote', 0, '', 'now', 'no put.io transfer id');

  const listed = await (await fetch(harness.url.replace('/transmission/rpc', '/api/downloads'))).json();
  assert.deepEqual(listed.downloads, []);
  assert.equal(listed.orphaned.length, 2);
  assert.equal(listed.orphaned[0].reason, 'no owner');
  assert.equal(listed.orphaned[0].localPath, '/downloads/tv/Quarantined.Release');
  assert.equal(listed.orphaned[0].assignable, true);
  assert.equal(listed.orphaned[1].assignable, false);

  const assigned = await fetch(
    harness.url.replace('/transmission/rpc', `/api/downloads/orphaned/${listed.orphaned[0].id}/assign`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: profile.id }),
    },
  );
  assert.equal(assigned.status, 200);
  const assignedBody = await assigned.json();
  assert.equal(assignedBody.downloads.length, 1);
  assert.equal(assignedBody.downloads[0].profileId, profile.id);
  assert.equal(assignedBody.orphaned.length, 1);
  assert.equal(harness.store.findDownloadByPutioTransferId(4242).profile_id, profile.id);

  // The identityless one is delete-only, and deleting it touches nothing on
  // put.io unless asked.
  const deleted = await fetch(
    harness.url.replace('/transmission/rpc', `/api/downloads/orphaned/${listed.orphaned[1].id}`),
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json()).orphaned, []);
  assert.deepEqual(harness.putio.deletedTransfers, []);
});
