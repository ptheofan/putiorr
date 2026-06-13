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
      RELEASE_TAG: 'v1.0.2',
      ...env,
    },
  });
}

test('release gate passes for current release metadata', () => {
  const result = runGate();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release gate passed for v1\.0\.2/);
});

test('release gate rejects stale release values in README', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'putiorr-release-gate-'));
  const staleReadme = path.join(scratch, 'README.md');
  const current = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  writeFileSync(staleReadme, current.replaceAll('1.0.2', '1.0.0').replaceAll('v1.0.2', 'v1.0.0'));

  const result = runGate({
    RELEASE_GATE_README_MD: staleReadme,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing example release tag|stale release value/);
});
