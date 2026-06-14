import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';

const root = new URL('..', import.meta.url);
const currentVersion = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
const currentTag = `v${currentVersion}`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runGate(env = {}) {
  return spawnSync(process.execPath, ['scripts/release-gate.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_TAG: currentTag,
      RELEASE_GATE_LATEST_RELEASE_TAG: currentTag,
      ...env,
    },
  });
}

test('release gate passes for current release metadata', () => {
  const result = runGate();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Release gate passed for ${escapeRegExp(currentTag)}`));
});

test('release gate does not require README version examples', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'putiorr-release-gate-'));
  const genericReadme = path.join(scratch, 'README.md');

  writeFileSync(genericReadme, '# putiorr\n\nRelease documentation intentionally avoids concrete versions.\n');

  const result = runGate({
    RELEASE_GATE_README_MD: genericReadme,
  });

  assert.equal(result.status, 0, result.stderr);
});

test('release gate rejects package versions older than latest release', () => {
  const newerTag = `v${semver.inc(currentVersion, 'minor')}`;

  const result = runGate({
    RELEASE_GATE_LATEST_RELEASE_TAG: newerTag,
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    new RegExp(`package\\.json version ${escapeRegExp(currentVersion)} is older than latest GitHub release ${escapeRegExp(newerTag)}`),
  );
});
