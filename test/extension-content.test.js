import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// content.js is an IIFE injected into pages: it registers a document click
// listener plus a chrome.runtime message listener and exports nothing. To
// exercise it under node we install stub `chrome`/`document`/`window` globals
// first, then import a cache-busted URL so every test gets fresh module state.
// The dynamic import of lib/resolve.js is pointed at the real file, so the
// magnet-before-torrent ordering these tests pin is the production one.

const CONTENT_URL = new URL('../extension/content.js', import.meta.url);
const RESOLVE_URL = new URL('../extension/lib/resolve.js', import.meta.url);
const TORRENT_URL = new URL('../extension/lib/torrent.js', import.meta.url);
const MANIFEST_URL = new URL('../extension/manifest.json', import.meta.url);
const PAGE_URL = 'https://tracker.test/browse/page';
// The https "send to put.io" link the project owner clicked, magnet and all.
const HANDLER_URL = 'https://put.io/default/magnet?url=magnet:?xt=urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F90123456789ABCD'
  + '&dn=Little.Chicks.5.1994.1080p.BluRay.x264-GROUP'
  + '&tr=udp%3A%2F%2Fz.mercax.com%3A53%2Fannounce'
  + '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'
  + '&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce'
  + '&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce';

let contentLoad = 0;

// Captured before the harness swaps in a recording setTimeout below: the toast
// lifetimes are 6s and 20s, and real timers for those would hold the test
// process open long after the assertions are done.
const realSetTimeout = globalThis.setTimeout;

function wait(ms = 0) {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
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

// Stand-in for the nodes lib/toast.js builds. `broken` is shared with the
// harness so a test can take the DOM away mid-grab, which is the one failure
// that must never reach the click handler's fallback.
class FakeNode {
  constructor(tag, state) {
    this.tagName = String(tag).toUpperCase();
    this.state = state;
    this.id = '';
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.classes = new Set();
    this.listeners = {};
    this.isConnected = false;
    this.shadow = null;
    this.text = '';
  }

  get classList() {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
    };
  }

  set textContent(value) {
    if (this.state.broken) throw new Error('the page took the DOM away');
    this.text = String(value);
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text;
  }

  connect(state) {
    this.isConnected = state;
    for (const child of this.children) child.connect(state);
    this.shadow?.connect(state);
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    child.connect(this.isConnected);
    return child;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
    this.connect(false);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  attachShadow({ mode }) {
    this.shadow = new FakeNode('#shadow-root', this.state);
    this.shadow.mode = mode;
    this.shadow.connect(this.isConnected);
    return this.shadow;
  }
}

function findByClass(node, name) {
  if (node.classes.has(name)) return node;
  for (const child of node.children) {
    const hit = findByClass(child, name);
    if (hit) return hit;
  }
  return null;
}

function createHarness({ sync = {}, fetch: fetchStub, workerFetch, sendMessage, broken = false } = {}) {
  const sent = [];
  const warnings = [];
  const listeners = {};
  const events = [];
  const workerFetches = [];
  // What the service worker answers when the page asks it to fetch a .torrent
  // the page could not. It answers rather than throwing, refusals included, so
  // the default is a worker that could not get the file either — which leaves
  // every test written before the rescue existed with the fallback it was
  // written for.
  const rescue = workerFetch ?? (async () => ({ ok: false, error: 'the extension could not fetch it either' }));

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
        if (message?.kind === 'fetch-torrent') {
          workerFetches.push(message.url);
          return rescue(message.url);
        }
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

  const dom = { broken };
  const documentElement = new FakeNode('html', dom);
  documentElement.isConnected = true;

  globalThis.chrome = chrome;
  globalThis.Element = FakeElement;
  globalThis.window = { location: { href: PAGE_URL } };
  globalThis.document = {
    documentElement,
    createElement: (tag) => {
      if (dom.broken) throw new Error('the page replaced document.createElement');
      return new FakeNode(tag, dom);
    },
    addEventListener: (type, fn) => {
      if (type === 'click') listeners.click = fn;
    },
  };
  globalThis.fetch = fetchStub ?? (async () => {
    throw new Error('fetch not stubbed');
  });
  // The toast lifetimes are 6s and 20s; recording them instead of scheduling
  // them keeps the suite from waiting on either, and makes them assertable.
  const timers = [];
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  globalThis.clearTimeout = (id) => {
    if (timers[id - 1]) timers[id - 1].cleared = true;
  };
  // The fallback paths are supposed to warn; capturing keeps the expected
  // noise out of the suite output and makes it assertable.
  globalThis.console = { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) };

  // What the page actually shows. The feedback lives in a closed shadow root,
  // which the stand-in keeps reachable so the tests can read it.
  const toasts = () => {
    const host = documentElement.children.find((node) => node.id === 'putiorr-grab-feedback');
    const stack = host?.shadow ? findByClass(host.shadow, 'stack') : null;
    return (stack?.children ?? []).map((toast) => ({
      tone: [...toast.classes].find((name) => name !== 'toast'),
      title: findByClass(toast, 'title').textContent,
      detail: findByClass(toast, 'detail').textContent,
    }));
  };

  // The lifetime each visible toast is holding, newest last.
  const lifetimes = () => timers.filter((timer) => !timer.cleared).map((timer) => timer.ms);

  return {
    sent,
    warnings,
    listeners,
    events,
    workerFetches,
    anchor,
    dispatch,
    toasts,
    lifetimes,
    breakRendering: () => { dom.broken = true; },
  };
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

test('the dynamic import target is a real module exposing the link helpers', async () => {
  const module = await import(RESOLVE_URL.href);
  assert.equal(typeof module.isMagnetLink, 'function');
  assert.equal(typeof module.isTorrentLink, 'function');
  assert.equal(typeof module.magnetFromLink, 'function');
});

test('the fetch helpers are a real module, and one the page is allowed to import', async () => {
  // The content script reaches them by dynamic import, which only works for a
  // web-accessible resource: leaving it off that list turns capture off on
  // every page, and nothing else in the extension would say so.
  const module = await import(TORRENT_URL.href);
  assert.equal(typeof module.fetchTorrent, 'function');
  assert.equal(typeof module.looksLikeMetainfo, 'function');

  const manifest = JSON.parse(await readFile(MANIFEST_URL, 'utf8'));
  const resources = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(resources.includes('lib/torrent.js'), `lib/torrent.js is not web-accessible: ${resources}`);
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
  // resolve.js documents that magnetFromLink has to be asked first, because
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

test('a magnet wrapped in an http handler link is captured whole', async () => {
  // The link the project owner clicked. The browser followed it and put.io
  // opened its own add-magnet page, because neither predicate claimed an
  // https href whose query happens to carry the magnet.
  const harness = await loadContent();

  const anchor = harness.anchor(HANDLER_URL);
  const event = harness.dispatch(anchor);
  await settle();

  assert.equal(event.prevented, true, 'the browser must not also follow the handler link');
  assert.equal(event.stopped, true);
  assert.equal(harness.sent.length, 1);
  const { magnet } = harness.sent[0];
  assert.deepEqual(harness.sent, [{ kind: 'grab', magnet, pageUrl: PAGE_URL }]);
  // Not just the infohash: reading the "url" parameter would have sent that
  // alone, because the inner "&dn=" and "&tr=" are the outer URL's parameters
  // as far as any URL parser is concerned.
  const params = new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1));
  assert.equal(params.get('xt'), 'urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F90123456789ABCD');
  assert.equal(params.get('dn'), 'Little.Chicks.5.1994.1080p.BluRay.x264-GROUP');
  assert.equal(params.getAll('tr').length, 4);
  assert.equal(anchor.clicks, 0, 'a captured link must not fall through to the handler page');
});

test('a handler link\'s own parameters are not forwarded with the magnet', async () => {
  // End to end, because this is the leak: whatever the click sends is what
  // putiorr stores, logs and hands to put.io.
  const harness = await loadContent();

  harness.dispatch(harness.anchor(
    'https://site.example/send?url=magnet:?xt=urn:btih:abc&dn=Thing&callback=/done&token=SECRET123',
  ));
  await settle();

  assert.deepEqual(harness.sent, [{
    kind: 'grab',
    magnet: 'magnet:?xt=urn:btih:abc&dn=Thing',
    pageUrl: PAGE_URL,
  }]);
});

test('a handler link ending in .torrent is sent as its magnet, not fetched', async () => {
  // magnetFromLink has to be asked before isTorrentLink: this path really is a
  // .torrent one, and fetching it would upload the handler's HTML to put.io.
  const href = 'https://tracker.test/dl/file.torrent?url=magnet:?xt=urn:btih:abc&dn=Wrapped';
  const resolve = await import(RESOLVE_URL.href);
  assert.equal(resolve.isTorrentLink(href), true, 'the input must be claimed by both to discriminate');

  const harness = await loadContent();
  harness.dispatch(harness.anchor(href));
  await settle();

  assert.deepEqual(harness.sent, [{
    kind: 'grab',
    magnet: 'magnet:?xt=urn:btih:abc&dn=Wrapped',
    pageUrl: PAGE_URL,
  }]);
});

test('a wrapped magnet that never reaches the worker falls back to the handler link', async () => {
  // Same contract as a bare magnet: a capture that fails before the worker has
  // the grab replays the click, so the user gets the handler page they would
  // have got without the extension rather than a dead link.
  const harness = await loadContent({
    sendMessage: async () => {
      throw new Error('Extension context invalidated.');
    },
  });

  const anchor = harness.anchor(HANDLER_URL);
  harness.dispatch(anchor);
  await settle();

  assert.equal(anchor.clicks, 1, 'the browser must still get its turn at the link');
  assert.equal(harness.warnings.length, 1);
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

test('a .torrent the page can fetch is never fetched twice', async () => {
  // The page's fetch is the one that carries the tracker's session cookies, so
  // the worker's must stay a rescue: asking it on the common path would trade
  // a working private-tracker grab for a login page.
  const harness = await loadContent({
    fetch: async () => torrentResponse(new Uint8Array([0x64, 0x65])),
  });

  harness.dispatch(harness.anchor('https://tracker.test/dl/1234.torrent'));
  await settle();

  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.workerFetches, [], 'a fetch the page made needs no rescue');
});

test('a .torrent the page is refused by CORS is fetched by the extension instead', async () => {
  // Issue #97, from a real tracker: the .torrent link 302s to a separate
  // download host, the redirect target sends no Access-Control-Allow-Origin,
  // and the page's fetch dies on a file that is perfectly reachable. Before
  // the rescue the click was handed back to the browser, which downloaded the
  // file itself, and nothing ever reached putiorr.
  const bytes = new Uint8Array([0x64, 0x38, 0x3a, 0x61]);
  let attempts = 0;
  const harness = await loadContent({
    // What a page fetch blocked by CORS actually does: it rejects with a
    // TypeError that says nothing about why, exactly as it would for a host
    // that is not there. The content script cannot tell the two apart, which
    // is the whole reason the rescue is worth attempting.
    fetch: async () => {
      attempts += 1;
      throw new TypeError('Failed to fetch');
    },
    sendMessage: async (message) => {
      if (message.kind === 'fetch-torrent') {
        harness.workerFetches.push(message.url);
        return { ok: true, torrentBase64: Buffer.from(bytes).toString('base64'), filename: 'Rescued.torrent' };
      }
      harness.sent.push(message);
      return { ok: true, profileName: 'Movies', transferName: 'Rescued.Release.2024.1080p' };
    },
  });

  const anchor = harness.anchor('https://tracker.test/torrent/1/download/2/name.torrent');
  const event = harness.dispatch(anchor);
  await settle();

  assert.equal(event.prevented, true);
  assert.equal(attempts, 1, 'the page still gets the first attempt');
  assert.deepEqual(harness.workerFetches, ['https://tracker.test/torrent/1/download/2/name.torrent']);
  assert.deepEqual(harness.sent, [{
    kind: 'grab',
    torrentBase64: Buffer.from(bytes).toString('base64'),
    filename: 'Rescued.torrent',
    pageUrl: PAGE_URL,
  }]);
  assert.equal(anchor.clicks, 0, 'a grab that reached putiorr must not also be downloaded by the browser');
  // The acknowledgement has to settle into the answer, not be withdrawn: from
  // the user's side a rescued grab is an ordinary one.
  assert.deepEqual(harness.toasts(), [{
    tone: 'success',
    title: 'Downloading with putiorr using Movies profile',
    detail: 'Rescued.Release.2024.1080p',
  }]);
});

test('a .torrent the extension is refused too still falls back to the browser', async () => {
  // Both attempts spent, so the file really cannot be had by the extension and
  // the browser is the last thing left that might get it.
  const harness = await loadContent({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    workerFetch: async () => ({ ok: false, error: 'that link did not answer with a .torrent file' }),
  });

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  harness.dispatch(anchor);
  await settle();

  assert.equal(harness.workerFetches.length, 1);
  assert.deepEqual(harness.sent, [], 'a grab must not be claimed on a file nobody could fetch');
  assert.equal(anchor.clicks, 1, 'the click must be refired so the user still gets the file');
  assert.deepEqual(harness.toasts(), [], 'the acknowledgement goes with it');
  assert.match(harness.warnings.join('\n'), /did not answer with a \.torrent file/);
});

test('an extension fetch that times out is answered rather than left pending', async () => {
  // The worker holds the same deadline the page does, and reports the abort as
  // a failed fetch. Anything else would leave the acknowledgement on screen
  // for the life of the page, on a click that was swallowed by preventDefault.
  const harness = await loadContent({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    workerFetch: async () => ({ ok: false, error: 'The operation was aborted due to timeout' }),
  });

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  harness.dispatch(anchor);
  await settle();

  assert.equal(harness.workerFetches.length, 1, 'the worker has to have been asked for this to mean anything');
  assert.deepEqual(harness.toasts(), []);
  assert.equal(anchor.clicks, 1);
});

test('an extension that cannot be reached at all still falls back to the browser', async () => {
  // sendMessage rejects outright when an extension reload has orphaned this
  // content script — the rescue is the second message on that click, and it
  // must fail the same way the grab itself does.
  const asked = [];
  const harness = await loadContent({
    fetch: async () => {
      throw new TypeError('Failed to fetch');
    },
    sendMessage: async (message) => {
      asked.push(message.kind);
      throw new Error('Extension context invalidated.');
    },
  });

  const anchor = harness.anchor('https://tracker.test/dl/1234.torrent');
  harness.dispatch(anchor);
  await settle();

  assert.deepEqual(asked, ['fetch-torrent'], 'the rescue is asked for, and its rejection ends the capture');
  assert.equal(anchor.clicks, 1);
  assert.deepEqual(harness.toasts(), []);
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
  // The worker was asked before the browser was: a 403 from the page can be a
  // 200 from an origin the page was not allowed to read.
  assert.deepEqual(harness.workerFetches, ['https://tracker.test/dl/1234.torrent']);
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

test('a captured click says so at once, then names the profile and the release', async () => {
  // The click was swallowed by preventDefault and the round trip to putiorr
  // takes a second or two; without an immediate acknowledgement the page looks
  // exactly like a broken extension, which is what the project owner saw.
  let answer;
  const harness = await loadContent({
    sendMessage: async (message) => {
      harness.sent.push(message);
      return new Promise((resolve) => { answer = resolve; });
    },
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc&dn=Example');
  harness.dispatch(anchor);
  await settle();

  assert.deepEqual(harness.toasts(), [{ tone: 'pending', title: 'Downloading with putiorr…', detail: '' }]);

  answer({ ok: true, profileName: 'Movies', transferName: 'Example.Release.2024.1080p' });
  await settle();

  assert.deepEqual(harness.toasts(), [{
    tone: 'success',
    title: 'Downloading with putiorr using Movies profile',
    detail: 'Example.Release.2024.1080p',
  }]);
  assert.equal(anchor.clicks, 0, 'reporting the grab is not a reason to also download it');
  assert.deepEqual(harness.warnings, []);
});

test('a .torrent click is acknowledged before the tracker has even answered', async () => {
  // The in-page fetch is on the same click, and a private tracker is exactly
  // the kind of server that takes its time about it.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const harness = await loadContent({
    fetch: async () => {
      await pending;
      return torrentResponse(new Uint8Array([0x64, 0x65]));
    },
  });

  harness.dispatch(harness.anchor('https://tracker.test/dl/1234.torrent'));
  await settle();

  assert.deepEqual(harness.toasts().map((toast) => toast.tone), ['pending']);

  release();
  await settle();

  assert.deepEqual(harness.toasts().map((toast) => toast.tone), ['success']);
});

test("a rejected grab shows putiorr's message verbatim, and outstays a success", async () => {
  // That sentence is the entire remediation path, and it is already worded for
  // it. Summarising it here would put a second copy of it on a surface that
  // ships on Chrome's schedule, free to drift from the one putiorr sends.
  const refusal = 'No Putiorr Grab profile claims tracker.test and none is set to take everything else;'
    + ' tick "Take grabs from any site no other profile claims" on a profile in putiorr';
  const harness = await loadContent({
    sendMessage: async (message) => (message.magnet.includes('bad')
      ? { ok: false, error: refusal }
      : { ok: true, profileName: 'Movies', transferName: 'Fine' }),
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:bad');
  harness.dispatch(anchor);
  await settle();

  assert.deepEqual(harness.toasts(), [{ tone: 'failure', title: `Failed — ${refusal}`, detail: '' }]);
  // putiorr had the grab and refused it, so the browser must not be handed the
  // link on top of a reported failure.
  assert.equal(anchor.clicks, 0);
  assert.deepEqual(harness.warnings, []);

  harness.dispatch(harness.anchor('magnet:?xt=urn:btih:good'));
  await settle();

  const [failure, success] = harness.lifetimes();
  assert.ok(failure > success, `a failure must linger longer than a success: ${failure} vs ${success}`);
});

test('grabs in quick succession stack rather than overwrite one another', async () => {
  const harness = await loadContent({
    sendMessage: async (message) => (message.magnet.includes('bad')
      ? { ok: false, error: 'putiorr is unreachable at http://nas:9091' }
      : { ok: true, profileName: 'Movies', transferName: 'One' }),
  });

  harness.dispatch(harness.anchor('magnet:?xt=urn:btih:good'));
  harness.dispatch(harness.anchor('magnet:?xt=urn:btih:bad'));
  await settle();

  assert.deepEqual(harness.toasts(), [
    { tone: 'success', title: 'Downloading with putiorr using Movies profile', detail: 'One' },
    { tone: 'failure', title: 'Failed — putiorr is unreachable at http://nas:9091', detail: '' },
  ]);
});

test('a grab that never reaches the worker takes its acknowledgement with it', async () => {
  // The click is replayed here, so the browser is about to do what it would
  // have done unaided. Leaving the acknowledgement on screen would claim a
  // grab that never happened.
  const harness = await loadContent({
    sendMessage: async () => {
      throw new Error('Extension context invalidated.');
    },
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  harness.dispatch(anchor);
  await settle();

  assert.equal(anchor.clicks, 1, 'the magnet must still reach the OS protocol handler');
  assert.deepEqual(harness.toasts(), []);
});

test('feedback that cannot be drawn at all does not become a second download', async () => {
  // The click handler's catch means "the grab never left the page", and it
  // answers by refiring the click. A toast is decoration; if a throw from it
  // landed there, one successful grab would become two downloads.
  const harness = await loadContent({ broken: true });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  harness.dispatch(anchor);
  await settle();

  assert.equal(harness.sent.length, 1, 'the grab itself still goes through');
  assert.equal(anchor.clicks, 0, 'a failure to draw is not a failure to grab');
  assert.match(harness.warnings.join('\n'), /feedback/);
});

test('feedback that breaks between the click and the answer does not refire either', async () => {
  // The riskier half: the surface built fine, the page tore it down while
  // putiorr was thinking, and the throw lands inside the very try that decides
  // whether to hand the link back to the browser.
  let answer;
  const harness = await loadContent({
    sendMessage: async (message) => {
      harness.sent.push(message);
      return new Promise((resolve) => { answer = resolve; });
    },
  });

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc');
  harness.dispatch(anchor);
  await settle();
  assert.deepEqual(harness.toasts().map((toast) => toast.tone), ['pending']);

  harness.breakRendering();
  answer({ ok: true, profileName: 'Movies', transferName: 'Example' });
  await settle();

  assert.equal(anchor.clicks, 0, 'the grab succeeded; the browser must not download it again');
  assert.equal(harness.sent.length, 1);
  assert.match(harness.warnings.join('\n'), /feedback/);
});

test('a right-click grab is reported on the page it came from', async () => {
  // The menu grab runs entirely in the service worker, so the page only learns
  // about it if the worker says so — and it is the same wait, on the same page.
  const harness = await loadContent();

  const held = harness.listeners.message({ kind: 'grab-feedback', id: 7 }, {}, () => {});
  await settle();

  assert.equal(held, undefined, 'nothing here is async, so the port must not be held');
  assert.deepEqual(harness.toasts().map((toast) => toast.tone), ['pending']);

  harness.listeners.message(
    { kind: 'grab-feedback', id: 7, result: { ok: true, profileName: 'TV', transferName: 'Example.S01E01' } },
    {},
    () => {},
  );
  await settle();

  assert.deepEqual(harness.toasts(), [{
    tone: 'success',
    title: 'Downloading with putiorr using TV profile',
    detail: 'Example.S01E01',
  }]);
});

test('a right-click acknowledgement names the profile the user picked', async () => {
  // The one grab whose profile is known before putiorr answers: the user named
  // it on the menu, so the page says so at once instead of after the round
  // trip. A click has no such name, and must not be given an invented one.
  const harness = await loadContent();

  harness.listeners.message({ kind: 'grab-feedback', id: 4, profileName: 'TV' }, {}, () => {});
  await settle();

  assert.deepEqual(harness.toasts(), [{
    tone: 'pending',
    title: 'Downloading with putiorr using TV profile…',
    detail: '',
  }]);

  harness.listeners.message(
    { kind: 'grab-feedback', id: 4, result: { ok: true, profileName: 'TV', transferName: 'Example.S01E01' } },
    {},
    () => {},
  );
  await settle();

  assert.deepEqual(harness.toasts(), [{
    tone: 'success',
    title: 'Downloading with putiorr using TV profile',
    detail: 'Example.S01E01',
  }]);
});

test('a right-click answer with no acknowledgement waiting still shows up', async () => {
  // The pending message can be lost — a page that navigated between the two,
  // or a worker that answered before the content script had the surface.
  const harness = await loadContent();

  harness.listeners.message(
    { kind: 'grab-feedback', id: 9, result: { ok: false, error: 'Reload the page, then try again' } },
    {},
    () => {},
  );
  await settle();

  assert.deepEqual(harness.toasts(), [{
    tone: 'failure',
    title: 'Failed — Reload the page, then try again',
    detail: '',
  }]);
});

test('unrelated runtime messages release the port instead of swallowing them', async () => {
  const harness = await loadContent();

  let responded = false;
  const held = harness.listeners.message({ kind: 'something-else' }, {}, () => { responded = true; });
  await settle();

  assert.equal(held, undefined, 'another listener must be free to answer this');
  assert.equal(responded, false);
});

// Updating or reloading the extension orphans the content scripts already in
// open tabs: chrome.runtime survives but answers nothing, and sendMessage
// rejects with "Extension context invalidated". That is not a fetch failure and
// the browser fallback is not the remedy — reloading the page is — yet the
// acknowledgement was withdrawn without a word, so the click looked ignored and
// the file simply downloaded. Once the extension is published this happens to
// every open tab on every auto-update, silently.
test('an orphaned content script says to reload the page instead of vanishing', async () => {
  const harness = await loadContent({
    sendMessage: async () => {
      throw new Error('Extension context invalidated.');
    },
  });
  // What Chrome actually leaves behind: the object is there, the id is not.
  globalThis.chrome.runtime.id = undefined;

  const anchor = harness.anchor('magnet:?xt=urn:btih:abc&dn=Example');
  harness.dispatch(anchor);
  await settle();

  const [toast] = harness.toasts();
  assert.equal(toast?.tone, 'failure');
  assert.match(toast?.title ?? '', /reload this page/i);
  assert.equal(anchor.clicks, 1, 'the browser still gets its turn at the link');
});

// Reported: click one link, then click a second before putiorr has answered the
// first. The second is captured and then handed to the browser anyway — a new
// tab and a plain download — even though nothing about it failed.
test('a second .torrent click while the first is still in flight is captured too', async () => {
  const bytes = new Uint8Array([0x64, 0x38, 0x3a, 0x61]);
  const grabs = [];
  const rescued = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const harness = await loadContent({
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async (message) => {
      if (message.kind === 'fetch-torrent') {
        rescued.push(message.url);
        if (rescued.length === 1) await held;
        return { ok: true, torrentBase64: Buffer.from(bytes).toString('base64'), filename: 'R.torrent' };
      }
      grabs.push(message);
      return { ok: true, profileName: 'Movies', transferName: 'Example' };
    },
  });

  const first = harness.anchor('https://tracker.test/dl/first.torrent');
  const second = harness.anchor('https://tracker.test/dl/second.torrent');
  harness.dispatch(first);
  await settle(20);
  harness.dispatch(second);
  await settle(30);

  assert.equal(second.clicks, 0, 'the second click must not be handed to the browser');
  release();
  await settle(30);
  assert.equal(first.clicks, 0, 'nor the first');
  assert.equal(grabs.length, 2, 'both grabs should reach putiorr');
});

// The same race with the wait where the report puts it: putiorr is slow to
// answer the first grab, and the second link is clicked while it hangs.
test('a second .torrent click while putiorr is still answering the first', async () => {
  const bytes = new Uint8Array([0x64, 0x38, 0x3a, 0x61]);
  const grabs = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const harness = await loadContent({
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    sendMessage: async (message) => {
      if (message.kind === 'fetch-torrent') {
        return { ok: true, torrentBase64: Buffer.from(bytes).toString('base64'), filename: 'R.torrent' };
      }
      grabs.push(message);
      if (grabs.length === 1) await held;
      return { ok: true, profileName: 'Movies', transferName: 'Example' };
    },
  });

  const first = harness.anchor('https://tracker.test/dl/first.torrent');
  const second = harness.anchor('https://tracker.test/dl/second.torrent');
  harness.dispatch(first);
  await settle(20);
  harness.dispatch(second);
  await settle(30);

  assert.equal(second.clicks, 0, 'the second click must not be handed to the browser');
  release();
  await settle(30);
  assert.equal(grabs.length, 2, 'both grabs should reach putiorr');
});
