import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { deleteLocalData, extractCategory, resolveInside } from '../src/download/paths.js';

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
