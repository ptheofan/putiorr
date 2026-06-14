import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);

function runGate(env = {}) {
  return spawnSync(process.execPath, ['scripts/release-gate.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_TAG: 'v1.1.0',
      RELEASE_GATE_LATEST_RELEASE_TAG: 'v1.1.0',
      ...env,
    },
  });
}

test('release gate passes for current release metadata', () => {
  const result = runGate();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release gate passed for v1\.1\.0/);
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
  const scratch = mkdtempSync(path.join(tmpdir(), 'putiorr-release-gate-'));
  const stalePackage = path.join(scratch, 'package.json');
  const current = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

  writeFileSync(stalePackage, current.replace('"version": "1.1.0"', '"version": "1.0.2"'));

  const result = runGate({
    RELEASE_GATE_PACKAGE_JSON: stalePackage,
    RELEASE_TAG: 'v1.0.2',
    RELEASE_GATE_LATEST_RELEASE_TAG: 'v1.1.0',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json version 1\.0\.2 is older than latest GitHub release v1\.1\.0/);
});
