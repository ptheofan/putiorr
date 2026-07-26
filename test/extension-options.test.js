import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeCredentials } from '../extension/lib/auth.js';
import { SYNC_DEFAULTS, validateBaseUrl } from '../extension/lib/settings.js';

// options.js is a page script: it wires up listeners at import time and exports
// nothing. The pure halves (URL validation, credential encoding) are tested
// directly; the wiring is exercised through a small stub DOM in the style of
// test/extension-content.test.js, with a cache-busted import per test so each
// one gets fresh module state.

const OPTIONS_URL = new URL('../extension/options.js', import.meta.url);
const OPTIONS_HTML = new URL('../extension/options.html', import.meta.url);
const OPTIONS_CSS = new URL('../extension/options.css', import.meta.url);
const FIELD_IDS = [
  'baseUrl',
  'username',
  'password',
  'status',
  'autoCapture',
  'profileList',
  'legacyNotice',
  'legacyRules',
  'dismissLegacy',
  'loadProfiles',
  'save',
];

let optionsLoad = 0;

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(ms = 20) {
  await wait(ms);
}

test('validateBaseUrl accepts a root URL and normalizes the trailing slash away', () => {
  assert.deepEqual(validateBaseUrl('http://nas:9091'), { ok: true, baseUrl: 'http://nas:9091' });
  assert.deepEqual(validateBaseUrl('  http://nas:9091/  '), { ok: true, baseUrl: 'http://nas:9091' });
  assert.deepEqual(validateBaseUrl('HTTPS://NAS.Example/'), { ok: true, baseUrl: 'https://nas.example' });
  assert.deepEqual(validateBaseUrl('http://192.168.1.9:9091'), { ok: true, baseUrl: 'http://192.168.1.9:9091' });
});

test('validateBaseUrl rejects a path instead of truncating it', () => {
  // putiorr is not subpath-deployable: /api/grab resolves against the origin, so
  // storing "https://nas/putiorr" would send every grab to "https://nas".
  const result = validateBaseUrl('https://nas/putiorr');
  assert.equal(result.ok, false);
  assert.match(result.error, /root of the host/);
  assert.match(result.error, /\/putiorr/);
  assert.equal(validateBaseUrl('http://nas:9091/?x=1').ok, false);
  assert.equal(validateBaseUrl('http://nas:9091/#frag').ok, false);
});

test('validateBaseUrl tells a scheme-less host what to write instead', () => {
  // "192.168.1.9:9091" has no parseable scheme; "nas:9091" parses as scheme
  // "nas" with an opaque path. Both are the same user mistake.
  for (const raw of ['192.168.1.9:9091', 'nas:9091', 'nas.example']) {
    const result = validateBaseUrl(raw);
    assert.equal(result.ok, false, raw);
    assert.equal(result.error, `"${raw}" has no scheme: write http://${raw} instead`);
  }
});

test('validateBaseUrl rejects empty, unparseable, non-http and credential-bearing URLs', () => {
  assert.match(validateBaseUrl('').error, /Enter the putiorr URL/);
  assert.match(validateBaseUrl('   ').error, /Enter the putiorr URL/);
  assert.match(validateBaseUrl(undefined).error, /Enter the putiorr URL/);
  assert.match(validateBaseUrl('http://').error, /not a valid URL/);
  assert.match(validateBaseUrl('ftp://nas').error, /must start with http:\/\/ or https:\/\//);
  // The credentials would be dropped along with everything past the host.
  assert.match(validateBaseUrl('http://user:pass@nas:9091').error, /not in the URL/);
});

test('the scheme hint is only offered to input that a scheme would fix', () => {
  // "write http://http:/nas instead" is worse than no advice at all.
  for (const raw of ['data:text/html,x', '//nas:9091', 'http:/nas', 'nas 9091']) {
    const result = validateBaseUrl(raw);
    assert.equal(result.ok, false, raw);
    assert.doesNotMatch(result.error, /write http:\/\//, raw);
    assert.match(result.error, /is not a full URL|not a valid URL/, raw);
  }
  // A bare host or IP literal, with or without a port, still gets the hint.
  for (const raw of ['nas', 'nas:9091', '192.168.1.9:9091', '[::1]:9091', 'media_server:9091']) {
    assert.equal(validateBaseUrl(raw).error, `"${raw}" has no scheme: write http://${raw} instead`, raw);
  }
});

test('validateBaseUrl drops a fully qualified name\'s root dot like a rule domain does', () => {
  assert.deepEqual(validateBaseUrl('https://nas./'), { ok: true, baseUrl: 'https://nas' });
  assert.deepEqual(validateBaseUrl('http://nas.example.:9091'), { ok: true, baseUrl: 'http://nas.example:9091' });
  assert.deepEqual(validateBaseUrl('http://[::1]:9091'), { ok: true, baseUrl: 'http://[::1]:9091' });
});

test('encodeCredentials encodes UTF-8 bytes rather than Latin-1 code units', () => {
  // btoa on the raw string would yield the Latin-1 "dXNlcjpw5HNzd/ZyZA==".
  assert.equal(encodeCredentials('user', 'pässwörd'), 'dXNlcjpww6Rzc3fDtnJk');
  assert.equal(encodeCredentials('user', 'pass😀'), Buffer.from('user:pass😀', 'utf8').toString('base64'));
  assert.equal(encodeCredentials('', ''), Buffer.from(':', 'utf8').toString('base64'));
});

// --- stub DOM ---------------------------------------------------------------

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parent = undefined;
    this.textContent = '';
    this.listeners = {};
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    const siblings = this.parent?.children;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parent = undefined;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  click() {
    for (const fn of this.listeners.click ?? []) fn();
  }
}

class FakeInput extends FakeNode {
  constructor(tagName) {
    super(tagName);
    this.value = '';
    this.checked = false;
  }
}

function createElement(tagName) {
  if (tagName === 'input') return new FakeInput(tagName);
  return new FakeNode(tagName);
}

function createHarness({ sync = {}, local = {}, fetch: fetchStub } = {}) {
  const fields = {};
  for (const id of FIELD_IDS) fields[id] = createElement('input');
  const stored = { sync: { ...sync }, local: { ...local } };
  const writes = [];

  // chrome.storage.get answers only the keys it was asked for, defaults
  // included. Handing back everything stored would hide a page that forgot to
  // ask for a key — which is exactly how the retired `rules` key is read now.
  const reads = { sync: [], local: [] };
  const read = (area) => async (defaults) => {
    reads[area].push(Object.keys(defaults).sort());
    return Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [key, stored[area][key] ?? value]),
    );
  };

  globalThis.document = {
    getElementById: (id) => fields[id],
    createElement,
  };
  globalThis.chrome = {
    storage: {
      sync: {
        get: read('sync'),
        set: async (values) => {
          writes.push({ area: 'sync', values });
          Object.assign(stored.sync, values);
        },
        remove: async (key) => {
          writes.push({ area: 'sync', removed: key });
          delete stored.sync[key];
        },
      },
      local: {
        get: read('local'),
        set: async (values) => {
          writes.push({ area: 'local', values });
          Object.assign(stored.local, values);
        },
      },
    },
  };
  globalThis.fetch = fetchStub ?? (async () => {
    throw new TypeError('fetch failed');
  });

  const rowText = (row) => row.children.map((cell) => cell.textContent);

  return {
    fields,
    stored,
    writes,
    reads,
    status: () => fields.status.textContent,
    // A real element's className is '' until something sets it.
    tone: () => fields.status.className ?? '',
    lastSync: () => writes.filter((write) => write.area === 'sync' && write.values).at(-1)?.values,
    // Each rendered profile row is [name, sites]; the empty state is a single
    // node with no cells of its own.
    profileRows: () => fields.profileList.children.map(rowText),
    profileListText: () => fields.profileList.children.map((node) => node.textContent).join('\n'),
    legacyShown: () => fields.legacyNotice.hidden === false,
    legacyRules: () => fields.legacyRules.children.map((node) => node.textContent),
  };
}

async function loadOptions(options = {}) {
  const harness = createHarness(options);
  const url = new URL(OPTIONS_URL);
  url.search = `?load=${++optionsLoad}`;
  await import(url.href);
  // restore() is async, so the form is only populated a turn after the import.
  await settle();
  return harness;
}

test('options.js builds no markup from data', () => {
  // Profile names come from the server; interpolating them into HTML would make
  // a profile called "<img onerror=…>" executable inside the options page.
  const source = readFileSync(OPTIONS_URL, 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('options.html loads the script as a module so it can import lib/', () => {
  const html = readFileSync(OPTIONS_HTML, 'utf8');
  assert.match(html, /<script type="module" src="options\.js"><\/script>/);
});

test('stored settings are restored into the form', async () => {
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      autoCapture: false,
      profiles: [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }],
    },
    local: { username: 'user', password: 'secret' },
  });

  assert.equal(harness.fields.baseUrl.value, 'http://nas:9091');
  assert.equal(harness.fields.username.value, 'user');
  assert.equal(harness.fields.password.value, 'secret');
  assert.equal(harness.fields.autoCapture.checked, false);
  // The cached names are what the right-click menu is built from, so the card
  // lists them too — and says which part of the row the cache cannot know,
  // rather than implying these profiles route nothing.
  assert.deepEqual(harness.profileRows(), [
    ['Movies', 'routing unknown until you load'],
    ['TV', 'routing unknown until you load'],
  ]);
  assert.equal(harness.legacyShown(), false);
});

test('with nothing cached the profiles card points at the connection test', async () => {
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });

  assert.match(harness.profileListText(), /Test the connection to see/);
  assert.equal(harness.fields.profileList.children.length, 1, 'the empty state is one note, not a row list');
});

test('a load replaces the unknown-sites rows with what putiorr says', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 4, name: 'Movies' }] },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 4, name: 'Movies', enabled: 1, browser_domains: [] }],
    }),
  });

  assert.deepEqual(harness.profileRows(), [['Movies', 'routing unknown until you load']]);

  harness.fields.loadProfiles.click();
  await settle();

  // "no sites" is a fact putiorr just stated; the cache had no such fact.
  assert.deepEqual(harness.profileRows(), [['Movies', 'no sites']]);
});

test('corrupt stored settings still produce a usable form', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: null, rules: 'corrupt', profiles: 'corrupt' },
  });

  assert.equal(harness.fields.baseUrl.value, '');
  assert.equal(harness.fields.autoCapture.checked, true, 'a missing autoCapture must default to on');
  assert.equal(harness.legacyShown(), false, 'a rules key that is not a list has nothing to show');
});

test('saving stores the normalized settings and shows the normalization back', async () => {
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      profiles: [{ id: 7, name: 'TV' }],
      // A retired rules key must not be rewritten by a save that no longer owns it.
      rules: [{ domains: ['x.example'], profileId: 7 }],
    },
  });

  harness.fields.baseUrl.value = 'HTTP://NAS:9091/';
  harness.fields.save.click();
  await settle();

  assert.equal(harness.status(), 'Saved');
  assert.equal(harness.fields.baseUrl.value, 'http://nas:9091');
  assert.deepEqual(harness.lastSync(), {
    baseUrl: 'http://nas:9091',
    autoCapture: true,
    profiles: [{ id: 7, name: 'TV' }],
  });
  assert.deepEqual(harness.stored.sync.rules, [{ domains: ['x.example'], profileId: 7 }], 'only Dismiss removes the legacy key');
  // Credentials first: a lost password cannot be recovered from the screen.
  assert.deepEqual(harness.writes.map(({ area }) => area), ['local', 'sync']);
  assert.deepEqual(harness.writes[0].values, { username: '', password: '' });
});

test('an invalid base URL blocks the save rather than storing a truncated one', async () => {
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });

  harness.fields.baseUrl.value = 'https://nas/putiorr';
  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /root of the host/);
  assert.equal(harness.fields.status.className, 'error');
  assert.deepEqual(harness.writes, [], 'nothing may be stored while the URL is unusable');
});

test('malformed profiles are sanitized before they reach storage', async () => {
  // The service worker sanitizes on read, but a menu built from clean data is
  // the primary defense; the id also has to be a number for the === lookup there.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', profiles: [{ id: '7', name: ' TV ', extra: 'dropped' }, { name: 'no id' }] },
  });

  harness.fields.save.click();
  await settle();

  assert.deepEqual(harness.lastSync().profiles, [{ id: 7, name: 'TV' }]);
});

test('test connection loads enabled profiles over UTF-8 basic auth', async () => {
  let request;
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    local: { username: 'user', password: 'pässwörd' },
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 4, name: 'Movies', enabled: 1 },
          { id: 7, name: 'TV', enabled: true },
          { id: 9, name: 'Disabled', enabled: 0 },
        ],
      };
    },
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.equal(request.url, 'http://nas:9091/api/profiles?type=grab');
  assert.equal(request.init.headers.Authorization, 'Basic dXNlcjpww6Rzc3fDtnJk');
  assert.ok(request.init.signal instanceof AbortSignal, 'the request must carry a deadline');
  assert.match(harness.status(), /^Loaded 2 profile\(s\)/);
  assert.deepEqual(harness.profileRows().map(([name]) => name), ['Movies', 'TV']);
});

test('only Putiorr Grab profiles are asked for, listed, offered and cached', async () => {
  // putiorr does the filtering: an *arr profile can never reach the card, the
  // default select, or — through the stored cache — the worker's context menu.
  // The extension therefore never has to know the preset vocabulary itself.
  let request;
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async (url) => {
      request = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          { id: 4, name: 'Movies', enabled: 1, type: 'grab', browser_domains: ['x.example'] },
          { id: 7, name: 'TV', enabled: 1, type: 'grab', browser_domains: [] },
        ],
      };
    },
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.equal(new URL(request).searchParams.get('type'), 'grab');
  assert.deepEqual(harness.profileRows(), [['Movies', 'x.example'], ['TV', 'no sites']]);

  harness.fields.save.click();
  await settle();

  // The worker builds its menu from exactly this list and nothing else.
  assert.deepEqual(harness.lastSync().profiles, [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }]);
});

test('loaded profiles are listed with the sites putiorr routes to them', async () => {
  // The mapping lives on the putiorr profile now, so the only honest thing the
  // options page can do is show what putiorr just said.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 4, name: 'Movies', enabled: 1, browser_domains: ['x.example', 'z.example'] },
        // /api/profiles answers in both key styles; either one is the mapping.
        { id: 7, name: 'TV', enabled: 1, browserDomains: ['tv.example'] },
        { id: 8, name: 'Books', enabled: 1, browser_domains: [] },
        { id: 9, name: 'Off', enabled: 0, browser_domains: ['off.example'] },
      ],
    }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.deepEqual(harness.profileRows(), [
    ['Movies', 'x.example, z.example'],
    ['TV', 'tv.example'],
    ['Books', 'no sites'],
  ]);
});

test('the card marks the profile that takes the sites nobody listed', async () => {
  // "Where does a grab from an unlisted site go?" is the question the Default
  // profile dropdown used to answer. The setting moved to putiorr, so the card
  // has to keep answering it — read on every load, never cached, exactly like
  // the sites, because it is stale the moment someone edits a profile there.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 4, name: 'Movies', enabled: 1, browser_domains: ['x.example'], browser_catch_all: true },
        // Both key styles, as /api/profiles answers with both.
        { id: 7, name: 'TV', enabled: 1, browser_domains: [], browserCatchAll: true },
        { id: 8, name: 'Books', enabled: 1, browser_domains: ['b.example'] },
      ],
    }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.deepEqual(harness.profileRows(), [
    ['Movies', 'x.example, and any site no other profile claims'],
    ['TV', 'any site no other profile claims'],
    ['Books', 'b.example'],
  ]);
  // A putiorr that answered has nothing missing, so no warning rides along.
  assert.doesNotMatch(harness.status(), /unlisted sites/);

  // And it is not stored: a reload says it does not know rather than repeating
  // an answer putiorr may have changed since.
  harness.fields.save.click();
  await settle();
  assert.deepEqual(Object.keys(harness.lastSync().profiles[0]).sort(), ['id', 'name']);
});

test('a profile list with unusable site data is shown rather than dropped', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 4, name: 'Movies', enabled: 1, browser_domains: 'corrupt' },
        { id: 7, name: 'TV', enabled: 1, browser_domains: [null, ' x.example ', ''] },
      ],
    }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.deepEqual(harness.profileRows(), [['Movies', 'no sites'], ['TV', 'x.example']]);
});

test('test connection refuses to fetch an unusable URL', async () => {
  let fetched = false;
  const harness = await loadOptions({
    sync: { baseUrl: 'nas:9091' },
    fetch: async () => {
      fetched = true;
      throw new Error('unreachable');
    },
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.equal(fetched, false);
  assert.match(harness.status(), /has no scheme: write http:\/\/nas:9091/);
});

test('rejected credentials read as a credentials problem, not a dead server', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.equal(harness.status(), 'putiorr rejected the credentials; check username and password');
  assert.equal(harness.fields.status.className, 'error');
});

test('an unreachable, stalled or non-putiorr server each read as themselves', async () => {
  const cases = [
    [() => { throw new TypeError('fetch failed'); }, /unreachable at http:\/\/nas:9091/],
    [() => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }, /did not respond within 15s/],
    [() => ({ ok: false, status: 500, json: async () => ({}) }), /responded with 500/],
    [() => ({ ok: true, status: 200, json: async () => ({ not: 'a list' }) }), /did not answer with a profile list/],
  ];

  for (const [respond, expected] of cases) {
    const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' }, fetch: async () => respond() });
    harness.fields.loadProfiles.click();
    await settle();
    assert.match(harness.status(), expected);
  }
});

test('a load with nothing taking the unlisted sites says so before a click does', async () => {
  // Without one, every grab from a site no profile lists is refused — and the
  // user first hears about it on a link click, far from this page.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 9, name: 'Books', enabled: 1, browser_domains: ['x.example'] }],
    }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.match(harness.status(), /^Loaded 1 profile\(s\)/);
  assert.match(harness.status(), /No profile takes grabs from unlisted sites/);
});

test('a putiorr whose grab profiles are all disabled says which fix applies', async () => {
  // The list is already filtered to the Putiorr Grab preset by putiorr, so a
  // row here is a grab profile that exists and is switched off. Telling the
  // user to create one would send them to build a duplicate.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({ ok: true, status: 200, json: async () => [{ id: 9, name: 'Off', enabled: 0 }] }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.equal(harness.status(), 'putiorr at http://nas:9091 has no enabled Putiorr Grab profiles; enable one there');
  assert.equal(harness.fields.status.className, 'error');
});

test('grab profiles this page cannot read are not reported as missing', async () => {
  // sanitizeProfiles drops a row without a usable id, which can empty the list
  // even though putiorr answered with enabled grab profiles. "Create one with
  // the Putiorr Grab preset" would be advice for a profile that already exists.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 0, name: 'Movies', enabled: true }, { name: 'TV', enabled: true }],
    }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.equal(
    harness.status(),
    'putiorr at http://nas:9091 answered with Putiorr Grab profiles this page could not read; check that the URL points at putiorr',
  );
  assert.equal(harness.fields.status.className, 'error');
  assert.doesNotMatch(harness.status(), /create one/);
});

test('a putiorr with no grab profiles at all names the preset that fixes it', async () => {
  // Nothing came back for ?type=grab: the *arr profiles this putiorr may well
  // have are invisible here on purpose, so "no profiles" would read as a broken
  // URL. The preset is the only thing that turns this into a working setup.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.match(harness.status(), /has no Putiorr Grab profiles/);
  assert.match(harness.status(), /Putiorr Grab preset/);
  assert.equal(harness.fields.status.className, 'error');
});

test('an empty profile list must not quietly wipe a working configuration', async () => {
  // A putiorr that is up but has no grab profiles (or a URL pointing at the
  // wrong host) answers with []. Applying that would clear the profile list
  // and the default selection, and the next Save would commit the loss under a
  // green "Saved" — taking the worker's context menu down with it.
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      profiles: [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }],
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => [] }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.match(harness.status(), /no Putiorr Grab profiles/);
  assert.deepEqual(harness.profileRows().map(([name]) => name), ['Movies', 'TV'], 'the cached list must survive');

  harness.fields.save.click();
  await settle();

  assert.deepEqual(harness.lastSync().profiles, [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }]);
});

test('a storage write that fails is reported rather than lost', async () => {
  // storage.sync enforces its own quota; a rejection escaping the click listener
  // would leave the page looking as if the save had worked.
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });
  chrome.storage.sync.set = async () => {
    throw new Error('QUOTA_BYTES quota exceeded');
  };

  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /settings were not: QUOTA_BYTES quota exceeded/);
  assert.doesNotMatch(harness.status(), /^Saved/);
  assert.equal(harness.fields.status.className, 'error');
  // Credentials are written first, so this failure did not take them with it.
  assert.deepEqual(harness.writes.at(-1).area, 'local');
});

test('a failed credentials write names the credentials and claims nothing', async () => {
  // Settings can be retyped from what is still on screen; a password that
  // silently failed to store cannot, so it is written first and reported by name.
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });
  chrome.storage.local.set = async () => {
    throw new Error('storage is not available');
  };

  harness.fields.password.value = 'secret';
  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /username and password could not be stored: storage is not available/);
  assert.doesNotMatch(harness.status(), /^Saved/);
  assert.deepEqual(harness.writes, [], 'the settings must not be stored past a lost password');
});

test('the keys written to storage.sync are exactly the ones the worker reads', async () => {
  // Both sides now share one SYNC_DEFAULTS, so this guards the remaining gap:
  // that save() writes every key the worker defaults, and no other.
  const expected = ['autoCapture', 'baseUrl', 'profiles'];
  assert.deepEqual(Object.keys(SYNC_DEFAULTS).sort(), expected);

  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });
  harness.fields.save.click();
  await settle();
  assert.deepEqual(Object.keys(harness.lastSync()).sort(), expected);

  // A local copy reintroduced on either side would drift silently.
  for (const file of ['background.js', 'options.js']) {
    const source = readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    assert.match(source, /import \{[^}]*SYNC_DEFAULTS[^}]*\} from '\.\/lib\/settings\.js'/, file);
    assert.doesNotMatch(source, /const SYNC_DEFAULTS/, file);
  }
});

test('the save note names what is actually able to grab', async () => {
  // "the right-click menu will grab" is a lie with no profiles stored: the menu
  // offers just "Configure…", so nothing at all can grab yet.
  const empty = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });
  empty.fields.save.click();
  await settle();
  assert.equal(empty.status(), 'Saved\nNo profiles loaded: nothing can grab until you load profiles and Save');

  // With profiles cached there is nothing left for this page to warn about:
  // where each grab lands is putiorr's answer, and it is on the card above.
  const loaded = await loadOptions({ sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }] } });
  loaded.fields.save.click();
  await settle();
  assert.equal(loaded.status(), 'Saved');
});

test('old site rules are shown once, read-only, with what replaces them', async () => {
  // Nothing is pushed to putiorr on the user's behalf: the rules are shown so
  // the mapping can be recreated there, and then dropped for good.
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      profiles: [{ id: 7, name: 'TV' }],
      rules: [
        { domains: ['x.example', 'z.example'], profileId: 7 },
        // A profile the cached list no longer knows still has to be readable.
        { domains: ['y.example'], profileId: 4 },
      ],
    },
  });

  assert.equal(harness.legacyShown(), true);
  assert.deepEqual(harness.legacyRules(), ['x.example, z.example → TV', 'y.example → #4']);

  harness.fields.dismissLegacy.click();
  await settle();

  assert.equal(harness.legacyShown(), false);
  assert.equal('rules' in harness.stored.sync, false, 'Dismiss must remove the key, not just hide it');
  assert.deepEqual(harness.legacyRules(), []);
});

test('an empty rules array is not worth a notice', async () => {
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091', rules: [] } });

  assert.equal(harness.legacyShown(), false);
});

test('the retired key is read with the settings, not in front of them', async () => {
  // The notice is optional and cosmetic; the form is not. Awaiting a second
  // read for it would let its failure leave every field empty — which looks
  // like a first run and would overwrite the stored settings on the next Save.
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }] },
  });

  assert.deepEqual(harness.reads.sync, [['autoCapture', 'baseUrl', 'profiles', 'rules']]);
  // Storage that never held the key still produces a populated form.
  assert.equal(harness.fields.baseUrl.value, 'http://nas:9091');
  assert.deepEqual(harness.profileRows().map(([name]) => name), ['TV']);
  assert.equal(harness.legacyShown(), false);
});

test('a storage read that fails leaves the form empty but says so', async () => {
  // The one case where the fields cannot be populated has to be unmistakable:
  // a silent empty form is the state that overwrites real settings on Save.
  const harness = createHarness({ sync: { baseUrl: 'http://nas:9091' } });
  chrome.storage.sync.get = async () => {
    throw new Error('storage is not available');
  };
  const url = new URL(OPTIONS_URL);
  url.search = `?load=${++optionsLoad}`;
  await import(url.href);
  await settle();

  assert.match(harness.status(), /Could not read the stored settings: storage is not available/);
  assert.equal(harness.tone(), 'error');
});

test('progress, success and refusal do not all read the same', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }] },
    fetch: async () => ({ ok: true, status: 200, json: async () => [{ id: 7, name: 'TV', enabled: 1 }] }),
  });

  assert.equal(harness.tone(), '', 'a clean restore says nothing at all');

  harness.fields.save.click();
  await settle();
  assert.equal(harness.status(), 'Saved');
  assert.equal(harness.tone(), 'ok');

  harness.fields.loadProfiles.click();
  assert.equal(harness.status(), 'Contacting putiorr…');
  assert.equal(harness.tone(), '', 'a request in flight is not good news yet');
  await settle();
  assert.match(harness.status(), /^Loaded 1 profile\(s\)/);
  assert.equal(harness.tone(), 'ok');

  harness.fields.baseUrl.value = 'https://nas/putiorr';
  harness.fields.save.click();
  await settle();
  assert.equal(harness.tone(), 'error');
});

test('a dismiss that cannot remove the key says so instead of hiding the notice', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', rules: [{ domains: ['x.example'], profileId: 7 }] },
  });
  chrome.storage.sync.remove = async () => {
    throw new Error('storage is not available');
  };

  harness.fields.dismissLegacy.click();
  await settle();

  assert.match(harness.status(), /The old site rules could not be removed: storage is not available/);
  assert.equal(harness.legacyShown(), true, 'a notice hidden without the key would come back on reload');
});

test('the status line is scrolled into view so a refused save is visible', async () => {
  // #status sits at the top of the page and Save at the bottom.
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091' } });
  const scrolls = [];
  harness.fields.status.scrollIntoView = (options) => scrolls.push(options);

  harness.fields.baseUrl.value = 'https://nas/putiorr';
  harness.fields.save.click();
  await settle();

  assert.deepEqual(scrolls, [{ block: 'nearest' }]);
});

test('options.html marks the status line as a live region', () => {
  assert.match(readFileSync(OPTIONS_HTML, 'utf8'), /<span id="status" aria-live="polite">/);
});

test('options.html carries every element the page wires up', () => {
  // getElementById returning null would break the page at import time, before
  // any of the stub-DOM tests above ever run against the real markup.
  const html = readFileSync(OPTIONS_HTML, 'utf8');
  for (const id of FIELD_IDS) assert.match(html, new RegExp(`id="${id}"`), id);
  // The notice is markup that must start hidden: it is only for storage that
  // still holds the retired key.
  assert.match(html, /id="legacyNotice"[^>]*hidden/);
  // The dashboard's Web Awesome elements are a runtime dependency the
  // extension deliberately does not ship: plain controls only.
  assert.doesNotMatch(html, /<wa-/);
});

test('the options page is styled by a stylesheet rather than inline rules', () => {
  // Static markup only in options.html, and no style attribute anywhere: the
  // page renders profile names and domains from the server.
  const html = readFileSync(OPTIONS_HTML, 'utf8');
  assert.match(html, /<link rel="stylesheet" href="options\.css">/);
  assert.doesNotMatch(html, /<style|style="/);
  assert.doesNotMatch(readFileSync(OPTIONS_URL, 'utf8'), /\.style\./);
});

test('the extension stylesheet carries its own tokens and both themes', () => {
  // The extension cannot reach src/web at runtime, so the dashboard's tokens
  // are copied in; without the dark half the page is a white sheet in a dark
  // browser. The copy has to name where it came from or it silently rots.
  const css = readFileSync(OPTIONS_CSS, 'utf8');
  assert.match(css, /src\/web\/styles/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /--accent:/);
  // Web Awesome is a dashboard runtime dependency; the extension ships none.
  assert.doesNotMatch(css, /wa-[a-z]+::part|<wa-/);
});

test('every token the stylesheet uses is one it also defines', () => {
  // The tokens are a hand-picked copy of the dashboard's: one left behind
  // renders as nothing at all (an unresolved var() falls back to the initial
  // value), and one copied but never used is dead weight pretending to be
  // theming. Both directions are checked so the copy cannot drift either way.
  const css = readFileSync(OPTIONS_CSS, 'utf8');
  const defined = new Set();
  for (const [, block] of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name] of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(name);
  }
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name));

  assert.ok(defined.size > 0, 'the stylesheet must carry its own :root tokens');
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [], 'used but never defined');
  assert.deepEqual([...defined].filter((name) => !used.has(name)), [], 'defined but never used');
});
