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
// global because the anchor lookup gates on `node instanceof Element`.
class FakeElement {
  closest() {
    return null;
  }

  matches() {
    return false;
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

  matches(selector) {
    return selector === 'a[href]';
  }

  // Mirrors HTMLElement.click(): a fresh event that travels the same listener.
  // Crucially it is synthetic, so isTrusted is false exactly as in a browser.
  click() {
    this.clicks += 1;
    this.dispatch(this, { isTrusted: false });
  }
}

function createHarness({ sync = {}, fetch: fetchStub, sendMessage } = {}) {
  const sent = [];
  const warnings = [];
  const listeners = {};
  const events = [];

  // `path` stands in for composedPath(): the browser hands the listener the
  // full chain from the innermost node outwards, crossing open shadow roots.
  const dispatch = (target, { path, ...overrides } = {}) => {
    const composed = path ?? target?.path ?? [target];
    const event = {
      button: 0,
      defaultPrevented: false,
      isTrusted: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target,
      prevented: false,
      stopped: false,
      composedPath: () => composed,
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

  const anchor = (href) => new FakeAnchor(href, (target, overrides) => dispatch(target, overrides));

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
  // A tracker that stalls instead of answering must not strand the click: the
  // abort turns into a rejection, which the fallback below can act on.
  assert.ok(request.init.signal instanceof AbortSignal, 'the fetch must carry a timeout signal');
  assert.equal(request.init.signal.aborted, false);
  assert.deepEqual(harness.sent, [{
    kind: 'grab',
    torrentBase64: Buffer.from(bytes).toString('base64'),
    filename: 'Example Release.torrent',
    pageUrl: PAGE_URL,
  }]);
});

test('content-disposition filenames follow RFC 6266', async () => {
  const bytes = new Uint8Array([0x64, 0x65]);
  let headers = {};
  const harness = await loadContent({ fetch: async () => torrentResponse(bytes, headers) });
  let counter = 0;
  let fallback;

  // Each case gets its own anchor URL so the basename fallback is distinguishable
  // and the in-flight guard never sees a repeat. `fallback` names what the URL
  // alone would yield, so the header-ignored cases can assert it without
  // hard-coding a position in this list.
  const filenameFor = async (disposition) => {
    headers = disposition === undefined ? {} : { 'content-disposition': disposition };
    counter += 1;
    fallback = `Fallback.${counter}.torrent`;
    harness.dispatch(harness.anchor(`https://tracker.test/dl/${fallback}?x=1`));
    await settle();
    return harness.sent.at(-1).filename;
  };

  assert.equal(
    await filenameFor("attachment; filename*=UTF-8''Se%CC%81rie%20S01E01.torrent"),
    'Série S01E01.torrent'.normalize('NFD'),
  );

  // RFC 6266: a server sends both exactly when the real name is non-ASCII, and
  // the plain one is its mangled fallback. Picking it would be the wrong name.
  assert.equal(
    await filenameFor("attachment; filename=\"Serie.torrent\"; filename*=UTF-8''Se%CC%81rie.torrent"),
    'Série.torrent'.normalize('NFD'),
  );

  // Quoting an ext-value is not legal, but servers do it and the closing quote
  // must not end up glued to the name.
  assert.equal(
    await filenameFor("attachment; filename*=\"UTF-8''quoted%20ext.torrent\""),
    'quoted ext.torrent',
  );

  // A quoted value may contain the ";" that otherwise ends the parameter.
  assert.equal(await filenameFor('attachment; filename="semi;colon.torrent"'), 'semi;colon.torrent');

  // Whitespace is legal around the "=" of a header parameter.
  assert.equal(await filenameFor('attachment; filename = spaced.torrent'), 'spaced.torrent');

  // Percent escapes are literal in a plain filename; decoding would forge a path.
  assert.equal(await filenameFor('attachment; filename=a%2Fb.torrent'), 'a%2Fb.torrent');

  // Which is also why an unencoded "%" has to survive untouched.
  assert.equal(await filenameFor('attachment; filename="100% Legal.torrent"'), '100% Legal.torrent');

  // A different parameter that merely ends in "filename" is not this one.
  assert.equal(await filenameFor('attachment; x-filename=weird.torrent'), fallback);

  assert.equal(await filenameFor(undefined), fallback);
});

test('a grabbed file is always named as a torrent, whatever the server calls it', async () => {
  // The right-click path exists for trackers whose download URL is a script, and
  // put.io takes the upload name at face value: without this, the first thing
  // putiorr ever hands put.io from a browser grab is a file called "download.php".
  const bytes = new Uint8Array([0x64, 0x65]);
  let headers = {};
  const harness = await loadContent({ fetch: async () => torrentResponse(bytes, headers) });

  // Driven through fetch-link, the route the right-click menu uses: a
  // "download.php" URL is not a .torrent path, so click capture never sees it.
  const filenameFor = async (url, disposition) => {
    headers = disposition === undefined ? {} : { 'content-disposition': disposition };
    const response = await new Promise((resolve) => {
      harness.listeners.message({ kind: 'fetch-link', url }, { id: 'putiorr-extension-id' }, resolve);
    });
    assert.equal(response.ok, true, url);
    return response.filename;
  };

  // The URL basename, which is what a "download.php?id=…" grab falls back to.
  assert.equal(await filenameFor('https://tracker.test/download.php?id=123'), 'download.php.torrent');
  // A disposition can name the script just as well as the URL can.
  assert.equal(await filenameFor('https://tracker.test/dl/1.torrent', 'attachment; filename=get.php'), 'get.php.torrent');
  assert.equal(
    await filenameFor('https://tracker.test/dl/2.torrent', "attachment; filename*=UTF-8''Se%CC%81rie"),
    'Série.torrent'.normalize('NFD'),
  );
  // An existing suffix is never doubled, in either case.
  assert.equal(await filenameFor('https://tracker.test/dl/3.TORRENT'), '3.TORRENT');
  assert.equal(await filenameFor('https://tracker.test/dl/4.torrent', 'attachment; filename=Real.torrent'), 'Real.torrent');
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

test('a magnet that never reaches the worker falls back to the OS handler', async () => {
  // An extension reload orphans this content script, and every later magnet
  // click would be a silent no-op: preventDefault has run and sendMessage has
  // nothing to talk to. Refiring hands the magnet to the protocol handler,
  // which is what would have happened without the extension installed.
  const harness = await loadContent({
    sendMessage: async () => {
      throw new Error('Extension context invalidated.');
    },
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  harness.dispatch(anchor);
  await settle();

  assert.equal(anchor.clicks, 1, 'the magnet must still reach the OS protocol handler');
  const refired = harness.events.at(-1);
  assert.equal(refired.prevented, false, 'the fallback click must not be swallowed in turn');
  assert.match(harness.warnings.join('\n'), /Extension context invalidated/);
});

test('a grab that putiorr itself rejects does not also fall back to the browser', async () => {
  // The service worker resolves with ok:false and has already shown the user a
  // notification. Refiring here would download the .torrent behind their back
  // or fire the magnet handler on top of a reported failure.
  const harness = await loadContent({
    sendMessage: async () => ({ ok: false, error: 'putiorr rejected the credentials' }),
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  harness.dispatch(anchor);
  await settle();

  assert.equal(anchor.clicks, 0, 'a reported failure is not a reason to fall back');
  assert.deepEqual(harness.warnings, []);
});

test('non-torrent links, non-left buttons and already-handled clicks are left alone', async () => {
  const harness = await loadContent();

  const plain = harness.anchor('https://tracker.test/browse?id=5');
  assert.equal(harness.dispatch(plain).prevented, false);

  const torrent = harness.anchor('https://tracker.test/dl/1234.torrent');
  assert.equal(harness.dispatch(torrent, { button: 1 }).prevented, false, 'middle click opens a tab');
  assert.equal(harness.dispatch(torrent, { defaultPrevented: true }).prevented, false, 'the page already handled it');

  // A click that lands outside any anchor must not throw on the lookup.
  const bare = new FakeElement();
  assert.equal(harness.dispatch(bare).prevented, false);
  assert.equal(harness.dispatch({ notAnElement: true }).prevented, false);

  await settle();
  assert.deepEqual(harness.sent, []);
});

test('a click the page synthesized cannot drive a grab', async () => {
  // Any page can plant a magnet anchor and call click() on it. Acting on that
  // would let a site push transfers onto the user's put.io account unprompted.
  const harness = await loadContent();

  const anchor = harness.anchor('magnet:?xt=urn:btih:evil');
  const event = harness.dispatch(anchor, { isTrusted: false });
  await settle();

  assert.equal(event.prevented, false, 'the page keeps whatever behaviour it already had');
  assert.deepEqual(harness.sent, []);
});

test('a modified click is left to the browser', async () => {
  // Alt+click is Chrome's "download to disk"; honouring modifiers also gives
  // the user a way to bypass capture for one link without opening options.
  const harness = await loadContent();

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    const event = harness.dispatch(anchor, { [modifier]: true });
    assert.equal(event.prevented, false, `${modifier} must not be captured`);
  }

  await settle();
  assert.deepEqual(harness.sent, []);
});

test('a link inside an open shadow root is still found', async () => {
  // The document-level listener sees the event retargeted to the shadow host,
  // whose closest() cannot reach across the boundary; composedPath still can.
  const harness = await loadContent();

  const anchor = harness.anchor('magnet:?xt=urn:btih:shadow');
  const inner = new FakeElement();
  const host = new FakeElement();
  const event = harness.dispatch(host, { path: [inner, anchor, host] });
  await settle();

  assert.equal(event.prevented, true);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].magnet, 'magnet:?xt=urn:btih:shadow');
});

test('an event without composedPath still resolves the anchor', async () => {
  const harness = await loadContent();

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  const event = harness.dispatch(anchor, { composedPath: undefined });
  await settle();

  assert.equal(event.prevented, true);
  assert.equal(harness.sent.length, 1);
});

test('a second click while a capture is pending does not double-grab', async () => {
  // Trackers are slow enough to invite an impatient second click, and a double
  // click is one event pair. Letting the second through to the browser would
  // download the very file the pending capture is fetching.
  let release;
  let attempts = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const bytes = new Uint8Array([0x64, 0x65]);
  const harness = await loadContent({
    fetch: async () => {
      attempts += 1;
      await pending;
      return torrentResponse(bytes);
    },
  });

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  harness.dispatch(anchor);
  const second = harness.dispatch(anchor);
  assert.equal(second.prevented, true, 'the duplicate must not reach the browser either');

  release();
  await settle();

  assert.equal(attempts, 1, 'only one fetch may be in flight for an anchor');
  assert.equal(harness.sent.length, 1);

  // Once it settles the anchor is clickable again.
  harness.dispatch(anchor);
  await settle();
  assert.equal(attempts, 2);
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
