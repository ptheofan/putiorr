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
