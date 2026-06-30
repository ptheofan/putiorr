import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('..', import.meta.url);

function writeExecutable(filePath, body) {
  writeFileSync(filePath, `#!/usr/bin/env node\n${body}`);
  chmodSync(filePath, 0o755);
}

function writeFakeGit(bin) {
  writeExecutable(path.join(bin, 'git'), `
const args = process.argv.slice(2).join(' ');
if (args === 'status --porcelain') process.exit(0);
if (args === 'branch --show-current') { console.log('main'); process.exit(0); }
if (args === 'fetch --tags origin main') process.exit(0);
if (args === 'rev-parse HEAD') { console.log('abc123'); process.exit(0); }
if (args === 'rev-parse origin/main') { console.log('abc123'); process.exit(0); }
console.error('unexpected git ' + args);
process.exit(1);
`);
}

function writeFakePnpm(bin) {
  writeExecutable(path.join(bin, 'pnpm'), `
const args = process.argv.slice(2).join(' ');
if (['release:gate', 'lint', 'test'].includes(args)) process.exit(0);
console.error('unexpected pnpm ' + args);
process.exit(1);
`);
}

function writeFakeGh(bin) {
  writeExecutable(path.join(bin, 'gh'), `
const args = process.argv.slice(2);
const joined = args.join(' ');
if (joined === 'auth status') process.exit(0);
if (joined === 'repo view --json nameWithOwner') {
  console.log(JSON.stringify({ nameWithOwner: 'ptheofan/putiorr' }));
  process.exit(0);
}
if (joined === 'release view v1.1.0 --repo ptheofan/putiorr --json tagName') {
  console.error('release not found');
  process.exit(1);
}
console.error('unexpected gh ' + joined);
process.exit(1);
`);
}

function writePackageJson(filePath, version = '1.1.0') {
  writeFileSync(filePath, `${JSON.stringify({
    name: 'putiorr',
    version,
    type: 'module',
  }, null, 2)}\n`);
}

test('release create dry-run prints guarded gh release command', () => {
  const scratch = path.join(tmpdir(), `putiorr-release-create-${Date.now()}`);
  const bin = path.join(scratch, 'bin');
  const packageJson = path.join(scratch, 'package.json');
  mkdirSync(bin, { recursive: true });
  writePackageJson(packageJson);

  writeFakeGit(bin);
  writeFakeGh(bin);
  writeFakePnpm(bin);

  const result = spawnSync(process.execPath, ['scripts/create-release.ts', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELEASE_CREATE_PACKAGE_JSON: packageJson,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run complete/);
  assert.match(result.stdout, /gh release create v1\.1\.0/);
  assert.match(result.stdout, /--repo ptheofan\/putiorr/);
  assert.match(result.stdout, /--draft/);
  assert.match(result.stdout, /--generate-notes/);
});

test('release create updates package metadata from positional release tag', () => {
  const scratch = path.join(tmpdir(), `putiorr-release-create-${Date.now()}-prepare`);
  const bin = path.join(scratch, 'bin');
  const packageJson = path.join(scratch, 'package.json');
  mkdirSync(bin, { recursive: true });
  writePackageJson(packageJson);

  writeFakeGit(bin);
  writeFakePnpm(bin);

  const result = spawnSync(process.execPath, ['scripts/create-release.ts', 'v1.3.0'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELEASE_CREATE_PACKAGE_JSON: packageJson,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(packageJson, 'utf8')).version, '1.3.0');
  assert.match(result.stdout, /Updated package\.json version 1\.1\.0 -> 1\.3\.0/);
  assert.match(result.stdout, /Release metadata is prepared for v1\.3\.0/);
  assert.doesNotMatch(result.stdout, /gh release create/);
});

test('release create reverts the version bump when a check fails', () => {
  const scratch = path.join(tmpdir(), `putiorr-release-create-${Date.now()}-revert`);
  const bin = path.join(scratch, 'bin');
  const packageJson = path.join(scratch, 'package.json');
  mkdirSync(bin, { recursive: true });
  writePackageJson(packageJson);

  writeFakeGit(bin);
  // Pass the gate and lint, then fail the test step so the script must revert.
  writeExecutable(path.join(bin, 'pnpm'), `
const args = process.argv.slice(2).join(' ');
if (args === 'release:gate' || args === 'lint') process.exit(0);
if (args === 'test') process.exit(1);
console.error('unexpected pnpm ' + args);
process.exit(1);
`);

  const result = spawnSync(process.execPath, ['scripts/create-release.ts', 'v1.3.0'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RELEASE_CREATE_PACKAGE_JSON: packageJson,
    },
  });

  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(readFileSync(packageJson, 'utf8')).version, '1.1.0');
  assert.match(result.stderr, /Reverted package\.json/);
});
