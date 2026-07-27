#!/usr/bin/env node
// Builds the Chrome Web Store upload for the browser extension:
// dist/putiorr-grab-<extension version>.zip.
//
// The version on the archive is extension/manifest.json's, not package.json's.
// The extension and putiorr ship on separate schedules — a putiorr release that
// does not touch the extension must not bump what the Web Store sees as a new
// version — so the two numbers are deliberately independent and nothing here
// reads package.json.
//
// The store rejects an archive whose manifest.json sits inside a folder, so the
// archive is built from inside extension/ and every path is stored relative to
// it. Everything the archive claims is verified by reading the archive back
// afterwards; see verifyArchive below for why that is not a formality.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.join(repoRoot, 'extension');
const distDir = path.join(repoRoot, 'dist');

// .DS_Store and __MACOSX are macOS packaging debris. They are not rejected by
// the store, but they are shipped to every user and they show up in the review
// diff as files nobody wrote. README.md is the contributor's document: it is
// the repository's, not the extension's, and the store lists no use for it.
const EXCLUDES = ['*.DS_Store', '__MACOSX/*', '*/__MACOSX/*', 'README.md'];

function fail(message) {
  console.error(`package-extension: ${message}`);
  process.exit(1);
}

// Every path the manifest points at, in the spelling the archive must contain.
// A manifest entry that names a missing file installs as an extension whose
// service worker or options page is simply absent, and Chrome reports that at
// load time on the user's machine rather than here.
function referencedPaths(manifest) {
  const paths = new Set(['manifest.json']);

  const add = (value) => {
    if (typeof value === 'string' && value && !value.includes('*')) paths.add(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);

  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) add(file);
    for (const file of script.css ?? []) add(file);
  }

  for (const entry of manifest.web_accessible_resources ?? []) {
    // MV2 listed bare strings here, MV3 lists objects with a resources array.
    if (typeof entry === 'string') add(entry);
    else for (const resource of entry.resources ?? []) add(resource);
  }

  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) add(icon);

  return [...paths];
}

// The archive's own file list, read out of its central directory.
//
// Reading it back rather than trusting the file list handed to zip is the whole
// point of the check: an exclude pattern that matches more than it was meant to
// removes a file silently, and zip reports success either way. Parsing it here
// instead of shelling out to unzip also keeps the script to one external tool,
// and a central directory that cannot be parsed is itself a broken archive.
function archiveEntries(zipPath) {
  const buffer = readFileSync(zipPath);
  const EOCD_SIGNATURE = 0x06054b50;
  const CENTRAL_SIGNATURE = 0x02014b50;

  // The end-of-central-directory record is last, but a trailing comment of up
  // to 64 KiB may follow it, so it has to be searched for from the back.
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) fail(`${zipPath} has no end-of-central-directory record; the archive is not a zip`);

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  // Both fields saturate when the real value lives in a zip64 record. An
  // extension archive that large is a bug worth stopping on, not one to parse.
  if (count === 0xffff || cursor === 0xffffffff) fail(`${zipPath} uses zip64; this script cannot verify it`);

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail(`${zipPath} has a damaged central directory at entry ${index + 1}`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    entries.push(buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function verifyArchive(zipPath, manifest) {
  const entries = archiveEntries(zipPath);
  const files = new Set(entries.filter((entry) => !entry.endsWith('/')));

  const problems = [];

  // The store's rejection, and the one that costs a round trip through review:
  // it looks for manifest.json at the root and nowhere else.
  if (!files.has('manifest.json')) {
    problems.push('manifest.json is not at the root of the archive');
  }

  for (const reference of referencedPaths(manifest)) {
    if (!files.has(reference)) problems.push(`the manifest references ${reference}, which is not in the archive`);
  }

  for (const entry of entries) {
    if (entry.split('/').includes('__MACOSX') || entry.endsWith('.DS_Store')) {
      problems.push(`${entry} should have been excluded`);
    }
    if (entry === 'README.md') problems.push('README.md should have been excluded');
  }

  if (problems.length) {
    for (const problem of problems) console.error(`package-extension: ${problem}`);
    fail(`${path.relative(repoRoot, zipPath)} is not a valid upload`);
  }

  return files.size;
}

function main() {
  if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
    fail(`no manifest at ${path.relative(repoRoot, path.join(extensionDir, 'manifest.json'))}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  } catch (error) {
    fail(`extension/manifest.json is not valid JSON: ${error.message}`);
  }

  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) {
    fail(`extension/manifest.json has no usable version (got ${JSON.stringify(version)})`);
  }

  mkdirSync(distDir, { recursive: true });
  const zipPath = path.join(distDir, `putiorr-grab-${version}.zip`);
  // zip adds to an archive that already exists rather than replacing it, so a
  // rebuild after a file was deleted would keep shipping the deleted file.
  rmSync(zipPath, { force: true });

  // -X drops the uid/gid and extended attributes zip would otherwise store:
  // they are this machine's, they differ between the developer's laptop and
  // CI, and they make two builds of the same source produce different bytes.
  const result = spawnSync('zip', ['-X', '-r', zipPath, '.', '-x', ...EXCLUDES], {
    cwd: extensionDir,
    encoding: 'utf8',
  });

  if (result.error?.code === 'ENOENT') fail('the zip command is not installed');
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || '');
    fail(`zip exited with ${result.status}`);
  }

  const fileCount = verifyArchive(zipPath, manifest);
  const size = statSync(zipPath).size;
  console.log(`Packaged ${manifest.name} ${version}: ${path.relative(repoRoot, zipPath)} (${fileCount} files, ${size} bytes).`);
}

main();
