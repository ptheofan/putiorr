import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSemver, parseSemver, VersionChecker } from '../src/version.js';

test('parseSemver accepts release tags and normalizes versions', () => {
  assert.deepEqual(parseSemver('v1.2.3'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
    version: '1.2.3',
  });
  assert.equal(parseSemver('1.2.3+build.4')?.version, '1.2.3');
  assert.equal(parseSemver('latest'), undefined);
});

test('compareSemver orders major minor and patch versions', () => {
  assert.equal(compareSemver('1.2.4', '1.2.3'), 1);
  assert.equal(compareSemver('1.3.0', '1.2.9'), 1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.2', '1.2.3'), -1);
  assert.equal(compareSemver('bad', '1.2.3'), 0);
  assert.equal(compareSemver({ version: '1.2.3' }, { version: '1.2.4' }), -1);
});

test('VersionChecker reports newer GitHub release and caches the result', async () => {
  let calls = 0;
  const checker = new VersionChecker({
    currentVersion: '1.0.2',
    now: () => 1_000,
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        tag_name: 'v1.0.3',
        html_url: 'https://github.com/ptheofan/putiorr/releases/tag/v1.0.3',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const first = await checker.check();
  const second = await checker.check();

  assert.equal(calls, 1);
  assert.equal(first.status, 'ok');
  assert.equal(first.currentVersion, '1.0.2');
  assert.equal(first.latestVersion, '1.0.3');
  assert.equal(first.latestTag, 'v1.0.3');
  assert.equal(first.updateAvailable, true);
  assert.equal(first.releaseUrl, 'https://github.com/ptheofan/putiorr/releases/tag/v1.0.3');
  assert.deepEqual(second, first);
});

test('VersionChecker hides update state when release lookup fails', async () => {
  const checker = new VersionChecker({
    currentVersion: '1.0.2',
    fetch: async () => {
      throw new Error('offline');
    },
  });

  const result = await checker.check();

  assert.equal(result.status, 'error');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, 'offline');
});

test('VersionChecker reports unsupported, HTTP, bad tag, and timeout errors', async () => {
  assert.equal((await new VersionChecker({ fetch: null }).check()).error, 'Version check is not supported by this runtime.');

  const http = await new VersionChecker({
    fetch: async () => new Response('{}', { status: 500 }),
  }).check();
  assert.equal(http.error, 'GitHub returned HTTP 500');

  const badTag = await new VersionChecker({
    fetch: async () => new Response(JSON.stringify({ tag_name: 'latest' })),
  }).check();
  assert.equal(badTag.error, 'Latest release tag is not semver.');

  const timeout = await new VersionChecker({
    timeoutMs: 1,
    fetch: async (_url, { signal }) => {
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  }).check();
  assert.equal(timeout.error, 'Version check timed out.');
});
