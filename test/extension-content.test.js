import assert from 'node:assert/strict';
import test from 'node:test';

// content.js is an IIFE injected into pages: it registers a document click
// listener plus a chrome.runtime message listener and exports nothing. To
// exercise it under node we install stub `chrome`/`document`/`window` globals
// first, then import a cache-busted URL so every test gets fresh module state.
// The dynamic import of lib/resolve.js is pointed at the real file, so the
// magnet-before-torrent ordering these tests pin is the production one.

const CONTENT_URL = new URL('../extension/content.js', import.meta.url);
const RESOLVE_URL = new URL('../extension/lib/resolve.js', import.meta.url);
const PAGE_URL = 'https://tracker.test/browse/page';

let contentLoad = 0;

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(ms = 20) {
  await wait(ms);
}

// Minimal stand-ins for the DOM bits content.js touches. `Element` has to be a
// global because the click handler gates on `event.target instanceof Element`.
class FakeElement {
  closest() {
    return null;
  }
}

class FakeAnchor extends FakeElement {
  constructor(href, dispatch) {
    super();
    this.href = href;
    this.clicks = 0;
    this.dispatch = dispatch;
  }

  closest(selector) {
    return selector === 'a[href]' ? this : null;
  }

  // Mirrors HTMLElement.click(): a fresh event that travels the same listener.
  click() {
    this.clicks += 1;
    this.dispatch(this);
  }
}

function createHarness({ sync = {}, fetch: fetchStub, sendMessage } = {}) {
  const sent = [];
  const warnings = [];
  const listeners = {};
  const events = [];

  const dispatch = (anchor, overrides = {}) => {
    const event = {
      button: 0,
      defaultPrevented: false,
      target: anchor,
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...overrides,
    };
    events.push(event);
    listeners.click(event);
    return event;
  };

  const chrome = {
    runtime: {
      id: 'putiorr-extension-id',
      getURL: (path) => new URL(`../extension/${path}`, import.meta.url).href,
      sendMessage: sendMessage ?? (async (message) => {
        sent.push(message);
        return { ok: true };
      }),
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
    },
    storage: {
      sync: { get: async (defaults) => ({ ...defaults, ...sync }) },
      onChanged: { addListener: (fn) => { listeners.storage = fn; } },
    },
  };

  const anchor = (href) => new FakeAnchor(href, (target) => dispatch(target));

  globalThis.chrome = chrome;
  globalThis.Element = FakeElement;
  globalThis.window = { location: { href: PAGE_URL } };
  globalThis.document = {
    addEventListener: (type, fn) => {
      if (type === 'click') listeners.click = fn;
    },
  };
  globalThis.fetch = fetchStub ?? (async () => {
    throw new Error('fetch not stubbed');
  });
  // The fallback paths are supposed to warn; capturing keeps the expected
  // noise out of the suite output and makes it assertable.
  globalThis.console = { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) };

  return { sent, warnings, listeners, events, anchor, dispatch };
}

function torrentResponse(bytes, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function loadContent(options = {}) {
  const harness = createHarness(options);
  const url = new URL(CONTENT_URL);
  url.search = `?load=${++contentLoad}`;
  await import(url.href);
  // The helpers arrive through a dynamic import; capture is off until they do.
  await settle();
  return harness;
}

test('the dynamic import target is a real module exposing the link predicates', async () => {
  const module = await import(RESOLVE_URL.href);
  assert.equal(typeof module.isMagnetLink, 'function');
  assert.equal(typeof module.isTorrentLink, 'function');
});

test('a magnet click is captured and forwarded without touching the network', async () => {
  const harness = await loadContent();

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc&dn=Example');
  const event = harness.dispatch(anchor);
  await settle();

  assert.equal(event.prevented, true, 'the browser must not also handle the magnet');
  assert.equal(event.stopped, true);
  assert.deepEqual(harness.sent, [{
    kind: 'grab',
    magnet: 'magnet:?xt=urn:btih:abc&dn=Example',
    pageUrl: PAGE_URL,
  }]);
  assert.equal(anchor.clicks, 0, 'a captured magnet must not fall through to a download');
});

test('a magnet whose payload ends in .torrent is still sent as a magnet', async () => {
  // resolve.js documents that isMagnetLink has to be asked first, because
  // isTorrentLink would otherwise claim a magnet URI whose payload ends in
  // ".torrent". Only an *opaque* payload discriminates: a magnet written the
  // usual `magnet:?xt=...` way has an empty URL pathname, so isTorrentLink
  // says false for it whatever the query string holds, and a test built on
  // one would pass under either ordering.
  const href = 'magnet:xxx.torrent';
  const resolve = await import(RESOLVE_URL.href);
  assert.equal(resolve.isMagnetLink(href), true);
  assert.equal(resolve.isTorrentLink(href), true, 'the input must be claimed by both predicates to discriminate');

  const harness = await loadContent();
  harness.dispatch(harness.anchor(href));
  await settle();

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].magnet, href);
  assert.equal(harness.sent[0].torrentBase64, undefined, 'no page fetch should have been attempted');
});

test('a .torrent click is fetched with page credentials and forwarded byte-exact', async () => {
  // Larger than the 0x8000 chunk the encoder walks in, and full of bytes above
  // 0x7f: a naive fromCharCode spread would throw and a UTF-8 path would mangle.
  const bytes = new Uint8Array(0x8000 + 777);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 200) % 256;

  let request;
  const harness = await loadContent({
    fetch: async (url, init) => {
      request = { url, init };
      return torrentResponse(bytes, { 'content-disposition': 'attachment; filename="Example Release.torrent"' });
    },
  });

  const event = harness.dispatch(harness.anchor('https://tracker.test/dl/1234.torrent?passkey=secret'));
  await settle();

  assert.equal(event.prevented, true);
  assert.equal(request.url, 'https://tracker.test/dl/1234.torrent?passkey=secret');
  // Without credentials a private tracker hands back an HTML login page.
  assert.equal(request.init.credentials, 'include');
  assert.deepEqual(harness.sent, [{
    kind: 'grab',
    torrentBase64: Buffer.from(bytes).toString('base64'),
    filename: 'Example Release.torrent',
    pageUrl: PAGE_URL,
  }]);
});

test('the filename comes from RFC 5987 encoding, then the URL, then a fallback', async () => {
  const bytes = new Uint8Array([0x64, 0x65]);
  let headers = {};
  const harness = await loadContent({ fetch: async () => torrentResponse(bytes, headers) });

  headers = { 'content-disposition': "attachment; filename*=UTF-8''Se%CC%81rie%20S01E01.torrent" };
  harness.dispatch(harness.anchor('https://tracker.test/dl/1.torrent'));
  await settle();
  assert.equal(harness.sent.at(-1).filename, 'Série S01E01.torrent'.normalize('NFD'));

  // A quoted name that is not percent-encoded must survive decodeURIComponent.
  headers = { 'content-disposition': 'attachment; filename="100% Legal.torrent"' };
  harness.dispatch(harness.anchor('https://tracker.test/dl/2.torrent'));
  await settle();
  assert.equal(harness.sent.at(-1).filename, '100% Legal.torrent');

  headers = {};
  harness.dispatch(harness.anchor('https://tracker.test/dl/Example.S01.torrent?x=1'));
  await settle();
  assert.equal(harness.sent.at(-1).filename, 'Example.S01.torrent');
});

test('a failed .torrent fetch falls through to a normal download exactly once', async () => {
  let attempts = 0;
  const harness = await loadContent({
    fetch: async () => {
      attempts += 1;
      return { ok: false, status: 403, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  const event = harness.dispatch(anchor);
  await settle();

  assert.equal(event.prevented, true);
  assert.equal(anchor.clicks, 1, 'the click must be refired so the user still gets the file');
  assert.equal(attempts, 1, 'the refired click must not be captured again');
  assert.deepEqual(harness.sent, []);
  // The refired event has to reach the page untouched, or the browser never
  // downloads it and the fallback is a no-op.
  const refired = harness.events.at(-1);
  assert.equal(refired.prevented, false);
  assert.equal(refired.stopped, false);
  assert.match(harness.warnings.join('\n'), /fetch failed with 403/);
});

test('a second click on a link that already fell back is captured again', async () => {
  // The bypass mark is consumed by the refired click; leaving it behind would
  // make the link permanently uncapturable for the rest of the page's life.
  let attempts = 0;
  const harness = await loadContent({
    fetch: async () => {
      attempts += 1;
      return { ok: false, status: 500, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  harness.dispatch(anchor);
  await settle();
  harness.dispatch(anchor);
  await settle();

  assert.equal(attempts, 2);
  assert.equal(anchor.clicks, 2);
});

test('a magnet that never reaches the worker does not refire into a dead download', async () => {
  const harness = await loadContent({
    sendMessage: async () => {
      throw new Error('Could not establish connection.');
    },
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  harness.dispatch(anchor);
  await settle();

  assert.equal(anchor.clicks, 0, 'there is no browser fallback for a magnet worth firing');
  assert.match(harness.warnings.join('\n'), /Could not establish connection/);
});

test('non-torrent links, non-left buttons and already-handled clicks are left alone', async () => {
  const harness = await loadContent();

  const plain = harness.anchor('https://tracker.test/browse?id=5');
  assert.equal(harness.dispatch(plain).prevented, false);

  const torrent = harness.anchor('https://tracker.test/dl/1234.torrent');
  assert.equal(harness.dispatch(torrent, { button: 1 }).prevented, false, 'middle click opens a tab');
  assert.equal(harness.dispatch(torrent, { defaultPrevented: true }).prevented, false, 'the page already handled it');

  // A click that lands outside any anchor must not throw on closest().
  const bare = new FakeElement();
  assert.equal(harness.dispatch(bare).prevented, false);
  assert.equal(harness.dispatch({ notAnElement: true }).prevented, false);

  await settle();
  assert.deepEqual(harness.sent, []);
});

test('autoCapture off leaves every link to the browser', async () => {
  const harness = await loadContent({ sync: { autoCapture: false } });

  const event = harness.dispatch(harness.anchor('magnet:?xt=urn:btih:abc'));
  await settle();

  assert.equal(event.prevented, false);
  assert.deepEqual(harness.sent, []);
});

test('clearing the autoCapture setting restores the default instead of disabling capture', async () => {
  // storage.onChanged reports a removed key as newValue: undefined. Assigning
  // that straight through would switch capture off with no way back, while a
  // fresh read of storage would report the default of on.
  const harness = await loadContent();

  harness.listeners.storage({ autoCapture: { oldValue: true } }, 'sync');
  const event = harness.dispatch(harness.anchor('magnet:?xt=urn:btih:abc'));
  await settle();

  assert.equal(event.prevented, true);
  assert.equal(harness.sent.length, 1);
});

test('autoCapture changes in other storage areas are ignored', async () => {
  const harness = await loadContent();

  harness.listeners.storage({ autoCapture: { newValue: false } }, 'local');
  const event = harness.dispatch(harness.anchor('magnet:?xt=urn:btih:abc'));
  await settle();

  assert.equal(event.prevented, true);
});

test('the fetch-link request from the service worker holds the port and answers', async () => {
  const bytes = new Uint8Array([0x64, 0x38, 0x3a]);
  const harness = await loadContent({
    fetch: async () => torrentResponse(bytes, { 'content-disposition': 'attachment; filename=From.Menu.torrent' }),
  });

  const response = await new Promise((resolve) => {
    const held = harness.listeners.message(
      { kind: 'fetch-link', url: 'https://tracker.test/dl/9.torrent' },
      { id: 'putiorr-extension-id' },
      resolve,
    );
    assert.equal(held, true, 'the port must stay open for the async fetch');
  });

  assert.deepEqual(response, {
    ok: true,
    torrentBase64: Buffer.from(bytes).toString('base64'),
    filename: 'From.Menu.torrent',
  });
});

test('a failed fetch-link answers with the error rather than hanging the menu click', async () => {
  const harness = await loadContent({
    fetch: async () => {
      throw new Error('network down');
    },
  });

  const response = await new Promise((resolve) => {
    harness.listeners.message({ kind: 'fetch-link', url: 'https://tracker.test/dl/9.torrent' }, {}, resolve);
  });

  assert.deepEqual(response, { ok: false, error: 'network down' });
});

test('unrelated runtime messages release the port instead of swallowing them', async () => {
  const harness = await loadContent();

  let responded = false;
  const held = harness.listeners.message({ kind: 'something-else' }, {}, () => { responded = true; });
  await settle();

  assert.equal(held, undefined, 'another listener must be free to answer this');
  assert.equal(responded, false);
});
