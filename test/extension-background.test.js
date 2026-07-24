import assert from 'node:assert/strict';
import test from 'node:test';

// background.js is an MV3 module worker: it registers chrome.* listeners at
// import time and exports nothing. To exercise it under node we install a stub
// `chrome` global first, then import a cache-busted URL so every test gets a
// worker with fresh module state (the menu queue in particular).

const WORKER_URL = new URL('../extension/background.js', import.meta.url);
let workerLoad = 0;

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rejections are reported a turn after they go unhandled, so settle first.
async function settle(ms = 60) {
  await wait(ms);
}

function createChromeStub({ sync = {}, syncSequence, local = {}, delays = {}, sendMessage } = {}) {
  const log = [];
  const notifications = [];
  const listeners = {};
  const values = syncSequence ?? [sync];
  let getCall = 0;

  const register = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });

  const chrome = {
    runtime: {
      id: 'putiorr-extension-id',
      onMessage: register('message'),
      onInstalled: register('installed'),
      onStartup: register('startup'),
      openOptionsPage: () => log.push('openOptionsPage'),
    },
    storage: {
      sync: {
        get: async (defaults) => {
          const index = Math.min(getCall++, values.length - 1);
          await wait(delays.get?.[index] ?? 0);
          return { ...defaults, ...values[index] };
        },
      },
      local: { get: async (defaults) => ({ ...defaults, ...local }) },
      onChanged: register('storage'),
    },
    contextMenus: {
      onClicked: register('menu'),
      create: (item) => log.push(`create:${item.id}`),
      removeAll: async () => {
        log.push('removeAll');
        await wait(delays.removeAll ?? 0);
      },
    },
    notifications: { create: (item) => notifications.push(item) },
    tabs: {
      sendMessage: sendMessage ?? (async () => ({ ok: false, error: 'no content script stub' })),
    },
  };

  return { chrome, log, notifications, listeners };
}

async function loadWorker(options = {}) {
  const harness = createChromeStub(options);
  globalThis.chrome = harness.chrome;
  globalThis.fetch = options.fetch ?? (async () => {
    throw new Error('fetch not stubbed');
  });

  const url = new URL(WORKER_URL);
  url.search = `?load=${++workerLoad}`;
  await import(url.href);
  return harness;
}

// Splits the create-call log into one segment per rebuild pass. A rebuild that
// interleaves with another shows up as a segment holding duplicate menu ids.
function menuSegments(log) {
  const segments = [];
  for (const entry of log) {
    if (entry === 'removeAll') {
      segments.push([]);
      continue;
    }
    if (segments.length) segments.at(-1).push(entry);
  }
  return segments;
}

test('menu rebuilds are serialized so interleaved triggers cannot leave ghost entries', async () => {
  // The first pass reads storage slowly; without a queue its create calls would
  // land after the second pass had already run removeAll.
  const harness = await loadWorker({
    syncSequence: [
      { profiles: [{ id: 4, name: 'Movies' }] },
      { profiles: [{ id: 7, name: 'TV' }] },
    ],
    delays: { get: [30, 0] },
  });

  harness.listeners.storage({ profiles: {} }, 'sync');
  harness.listeners.storage({ profiles: {} }, 'sync');
  await settle(120);

  const segments = menuSegments(harness.log);
  assert.equal(segments.length, 2, 'each trigger should run exactly one rebuild pass');
  for (const segment of segments) {
    assert.equal(new Set(segment).size, segment.length, `duplicate menu ids in a pass: ${segment}`);
  }
  // The queue must converge on the newest profile list, not the slow first read.
  assert.deepEqual(segments.at(-1), ['create:putiorr-root', 'create:putiorr-profile-7']);
  assert.deepEqual(unhandled, []);
});

test('corrupt stored profiles still produce a usable menu instead of a dead one', async () => {
  const before = unhandled.length;
  const harness = await loadWorker({
    syncSequence: [
      { profiles: 'corrupt' },
      { profiles: [null, { id: 4, name: 'Movies' }] },
    ],
  });

  harness.listeners.installed();
  await settle();
  harness.listeners.storage({ profiles: {} }, 'sync');
  await settle();

  const segments = menuSegments(harness.log);
  // A non-array collapses to "no profiles", which must still offer the escape hatch.
  assert.deepEqual(segments[0], ['create:putiorr-root', 'create:putiorr-configure']);
  // A null element must not take the valid sibling down with it.
  assert.deepEqual(segments[1], ['create:putiorr-root', 'create:putiorr-profile-4']);
  assert.equal(unhandled.length, before, 'menu rebuild must not leave unhandled rejections');
});

test('a magnet menu click on corrupt storage notifies instead of rejecting', async () => {
  const before = unhandled.length;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: 'corrupt' },
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.test/page' },
  );
  await settle();

  assert.equal(unhandled.length, before, 'the click must not produce an unhandled rejection');
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].title, 'putiorr grab failed');
  // fetch is unstubbed here, so the failure is reported as an unreachable server.
  assert.match(harness.notifications[0].message, /unreachable/);
});

test('credentials are sent as UTF-8 basic auth rather than Latin-1', async () => {
  let request;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    local: { username: 'user', password: 'pässwörd' },
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ({ ok: true, transfer: { name: 'Example' } }) };
    },
  });

  const response = await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.test/page', profileId: 3 },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.deepEqual(response, { ok: true });
  assert.equal(request.url, 'http://putiorr.test/api/grab');
  // btoa on the raw string would yield the Latin-1 "dXNlcjpw5HNzd/ZyZA==".
  assert.equal(request.init.headers.Authorization, 'Basic dXNlcjpww6Rzc3fDtnJk');
  assert.equal(request.init.headers['X-Putiorr-Grab'], '1');
  assert.equal(harness.notifications[0].title, 'Sent to putiorr → Movies');
});

test('credentials outside Latin-1 are encodable rather than fatal', async () => {
  let request;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    local: { username: 'user', password: 'pass😀' },
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ({ ok: true, transfer: {} }) };
    },
  });

  const response = await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.test/page', profileId: 3 },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  // A raw btoa would throw a DOMException here and be misreported as unreachable.
  assert.deepEqual(response, { ok: true });
  assert.equal(request.init.headers.Authorization, `Basic ${Buffer.from('user:pass😀', 'utf8').toString('base64')}`);
});

test('grab messages from other extensions are ignored', async () => {
  let fetched = false;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    fetch: async () => {
      fetched = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, transfer: {} }) };
    },
  });

  let responded = false;
  const result = harness.listeners.message(
    { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.test/page', profileId: 3 },
    { id: 'some-other-extension' },
    () => { responded = true; },
  );
  await settle();

  assert.equal(result, undefined, 'the port must not be held open for a foreign sender');
  assert.equal(responded, false);
  assert.equal(fetched, false, 'a foreign extension must not be able to spend the put.io account');
});

test('a malformed base URL is reported as invalid rather than unreachable', async () => {
  const harness = await loadWorker({
    sync: { baseUrl: 'putiorr.test:8080', profiles: [{ id: 3, name: 'Movies' }] },
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.test/page' },
  );
  await settle();

  assert.equal(harness.notifications[0].title, 'putiorr grab failed');
  assert.match(harness.notifications[0].message, /not valid/);
});

test('rejected credentials are reported as a credentials problem', async () => {
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    local: { username: 'user', password: 'wrong' },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.test/page' },
  );
  await settle();

  assert.match(harness.notifications[0].message, /check username and password/);
});

test('a missing content script asks the user to reload rather than quoting Chrome', async () => {
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    sendMessage: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'https://tracker.test/file.torrent' },
    { id: 1, url: 'https://tracker.test/page' },
  );
  await settle();

  assert.equal(harness.notifications[0].title, 'putiorr grab failed');
  assert.equal(harness.notifications[0].message, 'Reload the page, then try again');
});

test('the configure menu entry opens options without touching the network', async () => {
  const harness = await loadWorker({ sync: { profiles: [] } });

  await harness.listeners.menu({ menuItemId: 'putiorr-configure' }, { id: 1, url: 'https://tracker.test/page' });
  await settle();

  assert.ok(harness.log.includes('openOptionsPage'));
  assert.deepEqual(harness.notifications, []);
});
