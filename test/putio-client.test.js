import assert from 'node:assert/strict';
import test from 'node:test';
import { PutioClient, normalizeTransfer } from '../src/putio/client.js';

function jsonResponse(body = {}, init = {}) {
  return new Response(JSON.stringify(body), init);
}

function createFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return jsonResponse(next.body, { status: next.status ?? 200, statusText: next.statusText });
  };
  return { calls, fetchImpl };
}

test('PutioClient request sends auth, query params, and surfaces API errors', async () => {
  const ok = createFetch([{ body: { ok: true } }]);
  const client = new PutioClient({
    token: 'token',
    baseUrl: 'https://putio.example.test///',
    fetchImpl: ok.fetchImpl,
  });

  assert.deepEqual(await client.request('/files/list', {
    headers: { 'x-test': 'yes' },
    query: { parent_id: 0, ignored: undefined },
  }), { ok: true });

  assert.equal(ok.calls[0].url, 'https://putio.example.test/files/list?parent_id=0');
  assert.equal(ok.calls[0].options.headers.get('Authorization'), 'Bearer token');
  assert.equal(ok.calls[0].options.headers.get('x-test'), 'yes');

  const failed = createFetch([{
    status: 429,
    statusText: 'Too Many Requests',
    body: { error_message: 'slow down' },
  }]);
  const failingClient = new PutioClient({ token: 'token', fetchImpl: failed.fetchImpl });
  await assert.rejects(
    () => failingClient.request('/transfers/list'),
    (error) => {
      assert.equal(error.status, 429);
      assert.deepEqual(error.body, { error_message: 'slow down' });
      assert.match(error.message, /slow down/);
      return true;
    },
  );

  assert.throws(() => new PutioClient(), /token is required/);
  assert.throws(() => new PutioClient({ token: 'token', fetchImpl: null }), /fetch implementation is required/);
});

test('PutioClient normalizes transfer and file endpoints', async () => {
  const { calls, fetchImpl } = createFetch([
    { body: { account: { username: 'me' } } },
    { body: { files: [{ id: '11', name: 'putiorr', file_type: 'FOLDER' }] } },
    { body: { files: [] } },
    { body: { file: { id: '12', name: 'created', content_type: 'application/x-directory' } } },
    { body: { transfer: { id: '20', file_name: 'Movie', info_hash: 'abc', percent_done: '40' } } },
    { body: { upload: { transfer: { id: '21', name: 'Torrent' } } } },
    { body: { transfers: [{ id: '22', magnet_uri: 'magnet:?xt=1' }, null] } },
    { body: { transfers: [{ id: '23', errorMessage: 'retrying' }] } },
    { body: {} },
    { body: { files: [{ id: '30', name: 'file.mkv', size: '7', parent_id: '0' }, null] } },
    { body: { file: { id: '31', name: 'single.mkv', size: 4 } } },
    { body: { file: { id: '40', name: 'folder', is_dir: true } } },
    { body: { files: [
      { id: '41', name: 'season', isDir: true },
      { id: '42', name: 'root.mkv', size: 1 },
    ] } },
    { body: { files: [{ id: '43', name: 'nested.mkv', size: 2 }] } },
    { body: { download_url: 'https://download.example.test/file' } },
    { body: {} },
  ]);
  const client = new PutioClient({ token: 'token', fetchImpl });

  assert.deepEqual(await client.getAccountInfo(), { username: 'me' });
  assert.equal(await client.ensureFolder('putiorr'), 11);
  assert.equal(await client.ensureFolder('created'), 12);
  assert.equal((await client.addTransfer('magnet:?xt=1', 12)).hash, 'abc');
  assert.equal((await client.uploadTorrent(Buffer.from('torrent'), 'file.torrent', 12)).name, 'Torrent');
  assert.equal((await client.listTransfers())[0].magnetUri, 'magnet:?xt=1');
  assert.equal((await client.retryTransfer(22)).id, 23);
  await client.deleteTransfer(23);
  assert.deepEqual(await client.listFiles(0), [{
    id: 30,
    name: 'file.mkv',
    size: 7,
    parentId: 0,
    contentType: '',
    fileType: '',
    isDir: false,
  }]);
  assert.equal((await client.getFile(31)).relativePath, undefined);
  assert.deepEqual(await client.listTransferFiles(40), [
    {
      id: 43,
      name: 'nested.mkv',
      size: 2,
      parentId: null,
      contentType: '',
      fileType: '',
      isDir: false,
      relativePath: 'season/nested.mkv',
    },
    {
      id: 42,
      name: 'root.mkv',
      size: 1,
      parentId: null,
      contentType: '',
      fileType: '',
      isDir: false,
      relativePath: 'root.mkv',
    },
  ]);
  assert.equal(await client.getDownloadUrl(43), 'https://download.example.test/file');
  await client.deleteFile(43);

  assert.equal(calls.at(-1).url, 'https://api.put.io/v2/files/delete');
});

test('normalizeTransfer keeps Put.io status details', () => {
  const transfer = normalizeTransfer({
    id: 22,
    status: 'DOWNLOADING',
    status_message: 'Waiting for torrent details from the network...',
    peers_sending_to_us: 2,
    availability: 11,
  });

  assert.equal(transfer.statusMessage, 'Waiting for torrent details from the network...');
  assert.equal(transfer.peers, 2);
  assert.equal(transfer.availability, 11);
});

test('PutioClient handles folder creation and transfer edge cases', async () => {
  const missingFolder = createFetch([
    { body: { files: [] } },
    { body: { file: { name: 'missing-id' } } },
  ]);
  await assert.rejects(
    () => new PutioClient({ token: 'token', fetchImpl: missingFolder.fetchImpl }).ensureFolder('missing-id'),
    /folder id/,
  );

  const singleFile = createFetch([{ body: { file: { id: 5, name: 'movie.mkv', size: 1 } } }]);
  assert.deepEqual(
    await new PutioClient({ token: 'token', fetchImpl: singleFile.fetchImpl }).listTransferFiles(5),
    [{
      id: 5,
      name: 'movie.mkv',
      size: 1,
      parentId: null,
      contentType: '',
      fileType: '',
      isDir: false,
      relativePath: 'movie.mkv',
    }],
  );

  const noFile = createFetch([{ body: {} }]);
  assert.deepEqual(
    await new PutioClient({ token: 'token', fetchImpl: noFile.fetchImpl }).listTransferFiles(0),
    [{
      id: null,
      name: '',
      size: 0,
      parentId: null,
      contentType: '',
      fileType: '',
      isDir: false,
      relativePath: '',
    }],
  );

  assert.equal(normalizeTransfer(undefined), undefined);
  assert.equal(normalizeTransfer({ downloaded: '', estimatedTime: undefined }).estimatedTime, -1);
});

test('normalizeTransfer reads the put.io peer and speed field names', () => {
  const transfer = normalizeTransfer({
    id: 20,
    name: 'Example',
    status: 'DOWNLOADING',
    peers_connected: 9,
    peers_sending_to_us: 3,
    peers_getting_from_us: 2,
    down_speed: 1048576,
    up_speed: 4096,
    availability: 99,
  });

  assert.equal(transfer.peers, 3);
  assert.equal(transfer.downloadSpeed, 1048576);
  assert.equal(transfer.uploadSpeed, 4096);
  assert.equal(transfer.availability, 99);
});

test('normalizeTransfer defaults put.io peer and speed fields to zero when absent', () => {
  const transfer = normalizeTransfer({ id: 21, name: 'Example' });

  assert.equal(transfer.peers, 0);
  assert.equal(transfer.downloadSpeed, 0);
  assert.equal(transfer.uploadSpeed, 0);
});

// put.io's /files/list is paginated: it answers with a cursor, and the rest of
// the folder only arrives from /files/list/continue. putiorr used to take the
// first page as the whole folder — and since a download's file rows are now
// reconciled against exactly this list, a truncated page would delete the rows
// for every file it did not mention and finalise the download early.
test('PutioClient follows the cursor until put.io stops handing one out', async () => {
  const { calls, fetchImpl } = createFetch([
    { body: { files: [{ id: '1', name: 'a.mkv', size: 1 }], cursor: 'page-2' } },
    { body: { files: [{ id: '2', name: 'b.mkv', size: 2 }], cursor: 'page-3' } },
    { body: { files: [{ id: '3', name: 'c.mkv', size: 3 }], cursor: '' } },
  ]);
  const client = new PutioClient({ token: 'token', fetchImpl });

  assert.deepEqual((await client.listFiles(7)).map((file) => file.id), [1, 2, 3]);
  assert.match(calls[0].url, /parent_id=7/);
  assert.match(calls[0].url, /per_page=1000/);
  assert.equal(calls[1].url, 'https://api.put.io/v2/files/list/continue');
  assert.deepEqual(JSON.parse(calls[1].options.body), { cursor: 'page-2' });
  assert.deepEqual(JSON.parse(calls[2].options.body), { cursor: 'page-3' });
});

test('PutioClient refuses a cursor that never ends rather than looping forever', async () => {
  const pages = Array.from({ length: 2_000 }, () => ({ body: { files: [], cursor: 'again' } }));
  const { fetchImpl } = createFetch(pages);
  const client = new PutioClient({ token: 'token', fetchImpl });

  await assert.rejects(() => client.listFiles(0), /too many pages/);
});
