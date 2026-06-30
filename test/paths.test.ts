import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
  deleteLocalData,
  deleteLocalFileData,
  extractCategory,
  fileExistsWithSize,
  normalizeRelativePath,
  resolveInside,
} from '../src/download/paths.ts';

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

test('deleteLocalData deletes only the requested transfer path', async () => {
  const targetDir = await mkdtemp(path.join(tmpdir(), 'putiorr-paths-'));
  await mkdir(path.join(targetDir, 'transfer-a'), { recursive: true });
  await mkdir(path.join(targetDir, 'transfer-b'), { recursive: true });
  await writeFile(path.join(targetDir, 'transfer-a', 'file.mkv'), 'a');
  await writeFile(path.join(targetDir, 'transfer-b', 'file.mkv'), 'b');

  await deleteLocalData(targetDir, 'transfer-a');

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

  await deleteLocalFileData(targetDir, 'transfer', path.join('season', 'episode.mkv'));

  await assert.rejects(stat(path.join(transferDir, 'season')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(transferDir, 'keep.mkv'), 'utf8'), 'keep');
});
