import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
  deleteLocalData,
  deleteLocalFileData,
  downloadLocalRoot,
  extractCategory,
  fileExistsWithSize,
  normalizeRelativePath,
  oversizedFolderSegment,
  resolveInside,
} from '../src/download/paths.js';

test('extractCategory returns category relative to target dir', () => {
  assert.equal(extractCategory('/downloads', '/downloads/tv'), 'tv');
  assert.equal(extractCategory('/downloads', '/downloads/media/tv'), path.join('media', 'tv'));
  assert.equal(extractCategory('/downloads', '/downloads'), '');
  assert.equal(extractCategory('/downloads', ''), '');
});

test('extractCategory rejects download dirs outside target dir', () => {
  assert.throws(
    () => extractCategory('/downloads', '/other/tv'),
    /outside target directory/,
  );
});

test('resolveInside rejects path traversal', () => {
  assert.equal(resolveInside('/downloads', 'movie'), path.join('/downloads', 'movie'));
  assert.throws(
    () => resolveInside('/downloads', '..', 'etc', 'passwd'),
    /outside/,
  );
});

test('resolveInside refuses a root that is not absolute', () => {
  // A relative root resolves against process.cwd(), so the containment check
  // passes trivially and every path built from it names something under
  // whatever directory the process happens to be in. Nothing may build a
  // deletion target that way.
  assert.throws(() => resolveInside('downloads', 'movie'), /absolute/);
  assert.throws(() => resolveInside('', 'movie'), /absolute/);
  assert.throws(() => resolveInside(undefined, 'movie'), /absolute/);
});

test('deleting a download folder needs exactly one download to own it', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'putiorr-owner-'));
  const shared = path.join(targetDir, 'Shared.Release');
  await mkdir(shared, { recursive: true });
  await writeFile(path.join(shared, 'file.mkv'), 'irreplaceable');

  // Two downloads staging into one directory is the state the id prefix
  // removes, and the state the old layout could reach — an rm -rf there takes
  // somebody else's files with it.
  await assert.rejects(
    () => deleteLocalData(shared, { ownersOfPath: () => ['download 1', 'download 2'] }),
    /2 downloads/,
  );
  // Nothing claims it: putiorr cannot say these files are its to delete.
  await assert.rejects(() => deleteLocalData(shared, { ownersOfPath: () => [] }), /no download/);
  // No answer at all is not permission either.
  await assert.rejects(() => deleteLocalData(shared), /which download owns/);
  await stat(path.join(shared, 'file.mkv'));

  await deleteLocalData(shared, { ownersOfPath: () => ['download 1'] });
  await assert.rejects(stat(shared), { code: 'ENOENT' });
});

test('a download stages under the put.io name, exactly as put.io named it', () => {
  // The *arr apps resolve a completed download as `downloadDir + name`, and a
  // user opening the staging folder expects the release they grabbed. Nothing
  // is prefixed onto it and nothing is rewritten: a put.io name that reads
  // like a path nests, the way it always has.
  assert.equal(
    downloadLocalRoot({ download_at: '/downloads' }, { id: 3, name: 'Example.Release', category: 'tv' }),
    path.join('/downloads', 'tv', 'Example.Release'),
  );
  assert.equal(
    downloadLocalRoot({ download_at: '/downloads' }, { id: 3, name: 'Season 1/Episode.mkv', category: '' }),
    path.join('/downloads', 'Season 1', 'Episode.mkv'),
  );
});

test('the staging folder is the put.io name byte for byte', () => {
  // The *arr computes the import path as `downloadDir + name` from what
  // torrent-get reports, so anything this rewrites is a folder the *arr cannot
  // find. Trailing spaces are common in torrent metadata and a backslash is an
  // ordinary character in a Linux filename — both used to be rewritten.
  const profile = { download_at: '/downloads' };
  for (const name of [' Leading.Space', 'Trailing.Space ', 'Show\\Windows.Style', 'Odd  Spacing']) {
    assert.equal(
      downloadLocalRoot(profile, { id: 3, name, category: 'tv' }),
      path.join('/downloads', 'tv', name),
      name,
    );
  }
});

test('a put.io name too long for the filesystem is refused, not truncated', () => {
  // Truncating would produce a folder that no longer matches the name
  // torrent-get reports, which breaks the import silently. Byte length, not
  // character count: 120 CJK characters are 360 bytes.
  assert.equal(oversizedFolderSegment('Ordinary.Release.Name'), '');
  assert.equal(oversizedFolderSegment('x'.repeat(255)), '');
  assert.equal(oversizedFolderSegment('x'.repeat(256)).length, 256);
  assert.equal(oversizedFolderSegment('日'.repeat(120)).length, 120);
  // Only the segment that does not fit is the problem; the path may be long.
  assert.equal(oversizedFolderSegment(`${'a'.repeat(200)}/${'b'.repeat(200)}`), '');
});

test('a name that cannot name a folder resolves to nothing at all', () => {
  // Every caller of this either writes into the answer or deletes it, and the
  // category directory holds every other download of that profile.
  const profile = { download_at: '/downloads' };
  assert.equal(downloadLocalRoot(profile, { id: 3, name: '', category: 'tv' }), undefined);
  assert.equal(downloadLocalRoot(profile, { id: 3, name: '.', category: 'tv' }), undefined);
  assert.equal(downloadLocalRoot(profile, { id: 3, name: '/', category: 'tv' }), undefined);
  assert.equal(downloadLocalRoot(profile, { id: 3, name: './.', category: 'tv' }), undefined);
  // A name made of spaces is odd, but it is a folder, and it is the folder the
  // *arr will compute from the same name. Only names that spell no segment at
  // all resolve to nothing.
  assert.equal(
    downloadLocalRoot(profile, { id: 3, name: '  ', category: 'tv' }),
    path.join('/downloads', 'tv', '  '),
  );
  // Escaping the category directory is refused rather than rewritten into
  // something that stages somewhere else without saying so.
  assert.throws(() => downloadLocalRoot(profile, { id: 3, name: '..', category: 'tv' }), /outside/);
  assert.throws(() => downloadLocalRoot(profile, { id: 3, name: '../elsewhere', category: 'tv' }), /outside/);
});

test('deleteLocalData deletes only the requested transfer path', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'putiorr-paths-'));
  await mkdir(path.join(targetDir, 'transfer-a'), { recursive: true });
  await mkdir(path.join(targetDir, 'transfer-b'), { recursive: true });
  await writeFile(path.join(targetDir, 'transfer-a', 'file.mkv'), 'a');
  await writeFile(path.join(targetDir, 'transfer-b', 'file.mkv'), 'b');

  await deleteLocalData(path.join(targetDir, 'transfer-a'), { ownersOfPath: () => ['download 1'] });

  await assert.rejects(stat(path.join(targetDir, 'transfer-a')), { code: 'ENOENT' });
  const sibling = await stat(path.join(targetDir, 'transfer-b', 'file.mkv'));
  assert.equal(sibling.isFile(), true);
});

test('file helpers normalize paths and remove selected files', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'putiorr-path-files-'));
  const transferDir = path.join(targetDir, 'transfer');
  await mkdir(path.join(transferDir, 'season'), { recursive: true });
  await writeFile(path.join(transferDir, 'season', 'episode.mkv'), 'episode');
  await writeFile(path.join(transferDir, 'season', 'episode.mkv.part'), 'partial');
  await writeFile(path.join(transferDir, 'keep.mkv'), 'keep');

  assert.equal(normalizeRelativePath('/season\\episode.mkv'), path.join('season', 'episode.mkv'));
  assert.equal(await fileExistsWithSize(path.join(transferDir, 'keep.mkv'), 4), true);
  assert.equal(await fileExistsWithSize(path.join(transferDir, 'missing.mkv'), 4), false);

  await deleteLocalFileData(transferDir, path.join('season', 'episode.mkv'), {
    ownersOfPath: () => ['download 1'],
  });

  await assert.rejects(stat(path.join(transferDir, 'season')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(transferDir, 'keep.mkv'), 'utf8'), 'keep');
});
