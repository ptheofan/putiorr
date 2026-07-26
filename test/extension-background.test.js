import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function onlyRequested(defaults, stored) {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, stored?.[key] ?? value]),
  );
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
          return onlyRequested(defaults, values[index]);
        },
      },
      // chrome.storage.get answers the keys it was asked for and no others, so
      // a key the worker stopped defaulting is a key it can no longer see.
      local: { get: async (defaults) => onlyRequested(defaults, local) },
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
    notifications: {
      // chrome.notifications.create takes an optional leading id; the worker
      // passes one only for the notification that is meant to be clickable.
      create: (...args) => notifications.push(args.length > 1 ? { id: args[0], ...args[1] } : args[0]),
      onClicked: register('notificationClicked'),
    },
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

test('the menu is built from the cached list alone, so it inherits its filter', async () => {
  // The options page loads /api/profiles?type=grab, so the cache holds Putiorr
  // Grab profiles only. The worker must have no profile source of its own: an
  // unfiltered fetch here would put an *arr profile back in the right-click
  // menu, and picking it is exactly what putiorr now refuses.
  let fetched = 0;
  const harness = await loadWorker({
    sync: { profiles: [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }] },
    fetch: async () => {
      fetched += 1;
      throw new Error('the worker must not load profiles of its own');
    },
  });

  harness.listeners.storage({ profiles: {} }, 'sync');
  await settle();

  assert.deepEqual(
    menuSegments(harness.log).at(-1),
    ['create:putiorr-root', 'create:putiorr-profile-4', 'create:putiorr-profile-7'],
  );
  assert.equal(fetched, 0, 'building the menu must not talk to putiorr');
  assert.doesNotMatch(readFileSync(WORKER_URL, 'utf8'), /\/api\/profiles/);
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

test('a captured grab hands putiorr the page host and nothing else to route by', async () => {
  // The worker no longer knows which profile claims a site, nor which one takes
  // the sites nobody claims: putiorr holds both, and the host is all it needs.
  let body;
  const harness = await loadWorker({
    sync: {
      baseUrl: 'http://putiorr.test',
      profiles: [{ id: 2, name: 'Movies' }],
    },
    fetch: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, profile: { id: 2, name: 'Movies' }, transfer: { name: 'Example' } }) };
    },
  });

  await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.x.example/page' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.deepEqual(body, {
    pageHost: 'tracker.x.example',
    magnet: 'magnet:?xt=urn:btih:abc',
    sourceUrl: 'https://tracker.x.example/page',
  });
  assert.equal('profileId' in body, false, 'a captured click names no profile');
});

test('an explicit menu pick is sent as profileId, and it is the only id there is', async () => {
  let body;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'TV' }] },
    fetch: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, profile: { id: 3, name: 'TV' }, transfer: {} }) };
    },
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.x.example/page' },
  );
  await settle();

  assert.equal(body.profileId, 3);
  assert.equal(body.pageHost, 'tracker.x.example');
  // The setting that used to ride along here lives on the putiorr profile now,
  // so there is nothing left for the worker to second-guess the pick with.
  assert.equal('defaultProfileId' in body, false);
});

test('an unparseable page URL is omitted rather than sent as junk', async () => {
  let body;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [] },
    fetch: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, transfer: {} }) };
    },
  });

  await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'not a url' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.deepEqual(Object.keys(body).sort(), ['magnet', 'sourceUrl']);
});

test('the success notification names the profile putiorr actually used', async () => {
  // The site match happens on the server, so the cached pick can be the wrong
  // answer: only the response knows where the transfer landed.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 2, name: 'Movies' }] },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, profile: { id: 9, name: 'Books' }, transfer: { name: 'Example' } }),
    }),
  });

  await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.x.example/page' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.equal(harness.notifications[0].title, 'Sent to putiorr → Books');
  assert.equal(harness.notifications[0].message, 'Example');
});

test('the response outranks the cached name even for an explicit pick', async () => {
  // The cache is a fallback, never a preference: it is whatever the last Save
  // stored, and putiorr has just told us what that profile is called now.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'TV' }] },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, profile: { id: 3, name: 'TV shows' }, transfer: {} }),
    }),
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.x.example/page' },
  );
  await settle();

  assert.equal(harness.notifications[0].title, 'Sent to putiorr → TV shows');
});

test('a putiorr too old to name the profile still reports the grab as sent', async () => {
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 2, name: 'Movies' }] },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, transfer: { name: 'Example' } }) }),
  });

  await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.x.example/page' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  // Naming the extension's default here would be a guess: with no explicit pick
  // the server resolved this by site, and its answer is the only truth.
  assert.equal(harness.notifications[0].title, 'Sent to putiorr');
});

test('a grab with nothing to route it is refused by putiorr, in putiorr\'s own words', async () => {
  // The worker cannot know whether the site matches a profile, so it asks
  // instead of inventing a local refusal — and it relays the answer verbatim.
  // The fix is a checkbox on a putiorr profile, which putiorr's sentence names
  // exactly; rewriting it here would put a second copy of that sentence on a
  // surface that ships and updates on Chrome's schedule, free to drift.
  let called = false;
  const refusal = 'No Putiorr Grab profile claims tracker.x.example and none is set to take'
    + ' everything else; tick "Take grabs from any site no other profile claims" on a profile in putiorr';
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [] },
    fetch: async () => {
      called = true;
      return { ok: false, status: 400, json: async () => ({ error: refusal }) };
    },
  });

  const response = await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.x.example/page' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.equal(called, true, 'the grab must reach putiorr');
  assert.equal(harness.notifications[0].message, refusal);
  // No click target: the options page cannot fix this, and a notification that
  // opens the wrong page is worse than one that opens nothing.
  assert.equal(harness.notifications[0].id, undefined);
  assert.deepEqual(response, { ok: false, error: refusal });
});

test('a 400 about the link itself is not rewritten as a missing profile', async () => {
  // A fresh install sends no ids at all, so every 400 it gets back would match
  // a status-only test — including the ones that have nothing to do with
  // profiles, whose real message is the only clue the user has.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [] },
    fetch: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'torrentBase64 is not a valid .torrent file' }),
    }),
  });

  await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', torrentBase64: 'bm90IGEgdG9ycmVudA==', filename: 'x.torrent', pageUrl: 'https://tracker.x.example/page' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.equal(harness.notifications[0].message, 'torrentBase64 is not a valid .torrent file');
  assert.equal(harness.notifications[0].id, undefined);
});

test('a menu profile deleted in putiorr is named as a stale menu, not as a bare 404', async () => {
  // The right-click menu is built from the last Save, so a profile deleted in
  // putiorr sits there until the next load. "Profile not found" alone would
  // leave the user hunting a profile on a page that has no idea it is gone —
  // and an explicit pick is now the only id a grab can carry at all.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 4, name: 'Movies' }] },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Profile not found' }) }),
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-4', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.x.example/page' },
  );
  await settle();

  assert.match(harness.notifications[0].message, /no longer has the profile you picked \(#4\)/);
  assert.match(harness.notifications[0].message, /load profiles again in the options/);
  // Reloading the list is what fixes it, so the notification has to reach the
  // page that does the reloading.
  assert.equal(harness.notifications[0].id, 'putiorr-configure');

  harness.listeners.notificationClicked('putiorr-configure');
  assert.ok(harness.log.includes('openOptionsPage'));
});

test('a 404 that is not a missing profile keeps its own wording', async () => {
  // Every unrouted path answers 404 too, so a putiorr too old to have
  // /api/grab lands here. Blaming the cached menu would send the user to reload
  // a list that is fine and hide the only clue they had.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 4, name: 'Movies' }] },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not Found' }) }),
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-4', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.x.example/page' },
  );
  await settle();

  assert.equal(harness.notifications[0].message, 'Not Found');
  assert.equal(harness.notifications[0].id, undefined);
});

test('a captured click that draws a 404 is relayed rather than blamed on the menu', async () => {
  // No pick was made, so there is no cached id to be stale: whatever putiorr
  // means by this 404, the worker has nothing to add.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 4, name: 'Movies' }] },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Profile not found' }) }),
  });

  const response = await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.x.example/page' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.equal(harness.notifications[0].message, 'Profile not found');
  assert.equal(harness.notifications[0].id, undefined);
  assert.deepEqual(response, { ok: false, error: 'Profile not found' });
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

test('a stalled putiorr is reported as not responding, and the fetch carries a deadline', async () => {
  // A sleeping NAS accepts the connection and then says nothing. Without the
  // deadline this fetch never settles: the menu click reports nothing, and a
  // captured link stays stuck behind the content script's in-flight guard.
  let request;
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    fetch: async (url, init) => {
      request = { url: String(url), init };
      // What AbortSignal.timeout actually produces once it fires.
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    },
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.test/page' },
  );
  await settle();

  assert.ok(request.init.signal instanceof AbortSignal, 'the grab must carry a timeout signal');
  assert.equal(request.init.signal.aborted, false);
  assert.equal(harness.notifications[0].title, 'putiorr grab failed');
  // "unreachable" would send the user hunting the wrong fault: the server is
  // there, it answered the connection and then stalled.
  assert.match(harness.notifications[0].message, /did not respond within 25s/);
});

test('the grab deadline stays under the idle-worker teardown', async () => {
  // Chrome retires an idle MV3 worker at 30s. A request that expires exactly
  // there races the teardown: the timeout error would have nowhere to be
  // reported, and the click would end in silence rather than a notification.
  const source = readFileSync(WORKER_URL, 'utf8');
  const timeout = Number(source.match(/const GRAB_TIMEOUT_MS = (\d+);/)?.[1]);
  assert.ok(timeout > 0 && timeout < 30000, `GRAB_TIMEOUT_MS must sit under 30000, got ${timeout}`);
});

test('a genuinely unreachable putiorr still reads as unreachable', async () => {
  // fetch fails this way when nothing is listening, and it must not be
  // confused with the timeout above.
  const harness = await loadWorker({
    sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] },
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await harness.listeners.menu(
    { menuItemId: 'putiorr-profile-3', linkUrl: 'magnet:?xt=urn:btih:abc' },
    { id: 1, url: 'https://tracker.test/page' },
  );
  await settle();

  assert.match(harness.notifications[0].message, /unreachable/);
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

test('the "not configured" notification is clickable and opens the options', async () => {
  // Without a URL every grab fails here, and the notification is the only thing
  // on screen: if it cannot lead to the options page, the user is at a dead end.
  const harness = await loadWorker({ sync: { baseUrl: '', profiles: [{ id: 3, name: 'Movies' }] } });

  const response = await new Promise((resolve) => {
    harness.listeners.message(
      { kind: 'grab', magnet: 'magnet:?xt=urn:btih:abc', pageUrl: 'https://tracker.test/page', profileId: 3 },
      { id: 'putiorr-extension-id' },
      resolve,
    );
  });

  assert.deepEqual(response, { ok: false, error: 'putiorr is not configured' });
  assert.equal(harness.notifications[0].id, 'putiorr-configure');
  assert.match(harness.notifications[0].message, /options/);

  harness.listeners.notificationClicked('putiorr-configure');
  assert.deepEqual(harness.log.filter((entry) => entry === 'openOptionsPage'), ['openOptionsPage']);
});

test('clicking any other notification does not open the options', async () => {
  const harness = await loadWorker({ sync: { baseUrl: 'http://putiorr.test', profiles: [{ id: 3, name: 'Movies' }] } });

  harness.listeners.notificationClicked('some-other-notification');

  assert.equal(harness.log.includes('openOptionsPage'), false);
});

test('a first install with no URL opens the options page', async () => {
  // Otherwise the first link click is a failure notification, and nothing has
  // told the user the extension needs configuring at all.
  // A constant stored value, not a syncSequence: the install listener and the
  // menu rebuild it queues both read storage, in an order that is theirs to pick.
  const harness = await loadWorker({ sync: { baseUrl: '', profiles: [] } });

  await harness.listeners.installed({ reason: 'install' });
  await settle();

  assert.ok(harness.log.includes('openOptionsPage'));
  assert.ok(harness.log.includes('removeAll'), 'the menu must still be built on install');
});

test('an update, or an install over existing settings, does not steal a tab', async () => {
  for (const details of [{ reason: 'update' }, { reason: 'install' }]) {
    const harness = await loadWorker({ sync: { baseUrl: 'http://putiorr.test', profiles: [] } });

    await harness.listeners.installed(details);
    await settle();

    assert.equal(harness.log.includes('openOptionsPage'), false, details.reason);
  }
});

test('the configure menu entry opens options without touching the network', async () => {
  const harness = await loadWorker({ sync: { profiles: [] } });

  await harness.listeners.menu({ menuItemId: 'putiorr-configure' }, { id: 1, url: 'https://tracker.test/page' });
  await settle();

  assert.ok(harness.log.includes('openOptionsPage'));
  assert.deepEqual(harness.notifications, []);
});
