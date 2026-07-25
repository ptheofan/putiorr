import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encodeCredentials } from '../extension/lib/auth.js';
import { parseRuleDomains, validateBaseUrl } from '../extension/lib/settings.js';

// options.js is a page script: it wires up listeners at import time and exports
// nothing. The pure halves (URL and domain validation, credential encoding) are
// tested directly; the wiring is exercised through a small stub DOM in the
// style of test/extension-content.test.js, with a cache-busted import per test
// so each one gets fresh module state.

const OPTIONS_URL = new URL('../extension/options.js', import.meta.url);
const OPTIONS_HTML = new URL('../extension/options.html', import.meta.url);
const FIELD_IDS = ['baseUrl', 'username', 'password', 'status', 'defaultProfile', 'autoCapture', 'rules', 'loadProfiles', 'addRule', 'save'];

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

test('parseRuleDomains returns the domains that will actually be stored', () => {
  assert.deepEqual(parseRuleDomains('https://x.example/dl, bücher.example'), {
    domains: ['x.example', 'xn--bcher-kva.example'],
    errors: [],
    warnings: [],
  });
  assert.deepEqual(parseRuleDomains('  X.Example:8080 , .z.example. ').domains, ['x.example', 'z.example']);
  assert.deepEqual(parseRuleDomains('x.example, x.example, X.EXAMPLE').domains, ['x.example']);
  assert.deepEqual(parseRuleDomains('').domains, []);
  assert.deepEqual(parseRuleDomains(undefined).domains, []);
  assert.deepEqual(parseRuleDomains(' , ,').domains, []);
});

test('parseRuleDomains rejects a wildcard and names the rule that replaces it', () => {
  const wildcard = parseRuleDomains('*.x.example');
  assert.deepEqual(wildcard.domains, []);
  assert.deepEqual(wildcard.errors, [
    'Write "x.example" instead of "*.x.example": a rule domain already matches its subdomains',
  ]);
  assert.match(parseRuleDomains('*x.example').errors[0], /Write "x\.example"/);
  assert.match(parseRuleDomains('*').errors[0], /is not a domain/);
});

test('parseRuleDomains warns about a single label instead of matching a whole TLD in silence', () => {
  const result = parseRuleDomains('com, example');
  assert.deepEqual(result.domains, ['com', 'example']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    '"com" also matches every site ending in ".com"',
    '"example" also matches every site ending in ".example"',
  ]);
});

test('parseRuleDomains reports a domain it cannot normalize rather than dropping it', () => {
  // normalizeDomain returns '' here, which the plan's version silently skipped.
  const result = parseRuleDomains('//, x.example');
  assert.deepEqual(result.domains, ['x.example']);
  assert.deepEqual(result.errors, ['"//" is not a domain putiorr can match']);
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

// A <select> only holds a value one of its options carries; assigning anything
// else leaves nothing selected, which is what clears a vanished profile.
class FakeSelect extends FakeNode {
  constructor() {
    super('select');
    this.selected = '';
  }

  get value() {
    return this.selected;
  }

  set value(next) {
    this.selected = this.children.some((option) => option.value === String(next)) ? String(next) : '';
  }
}

function createElement(tagName) {
  if (tagName === 'select') return new FakeSelect();
  if (tagName === 'input' || tagName === 'option') return new FakeInput(tagName);
  return new FakeNode(tagName);
}

function createHarness({ sync = {}, local = {}, fetch: fetchStub } = {}) {
  const fields = {};
  for (const id of FIELD_IDS) fields[id] = createElement(id === 'defaultProfile' ? 'select' : 'input');
  const stored = { sync: { ...sync }, local: { ...local } };
  const writes = [];

  globalThis.document = {
    getElementById: (id) => fields[id],
    createElement,
  };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...stored.sync }),
        set: async (values) => {
          writes.push({ area: 'sync', values });
          Object.assign(stored.sync, values);
        },
      },
      local: {
        get: async (defaults) => ({ ...defaults, ...stored.local }),
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

  const ruleRows = () => fields.rules.children;
  const cellInput = (row, index) => row.children[index].children[0];

  return {
    fields,
    stored,
    writes,
    ruleRows,
    domainsOf: (index) => cellInput(ruleRows()[index], 0).value,
    setDomains: (index, value) => { cellInput(ruleRows()[index], 0).value = value; },
    selectOf: (index) => cellInput(ruleRows()[index], 1),
    removeButtonOf: (index) => cellInput(ruleRows()[index], 2),
    status: () => fields.status.textContent,
    lastSync: () => writes.filter((write) => write.area === 'sync').at(-1)?.values,
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

test('stored settings are restored into the form, rules included', async () => {
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      defaultProfileId: 4,
      autoCapture: false,
      rules: [{ domains: ['x.example', 'z.example'], profileId: 7 }],
      profiles: [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }],
    },
    local: { username: 'user', password: 'secret' },
  });

  assert.equal(harness.fields.baseUrl.value, 'http://nas:9091');
  assert.equal(harness.fields.username.value, 'user');
  assert.equal(harness.fields.password.value, 'secret');
  assert.equal(harness.fields.autoCapture.checked, false);
  assert.equal(harness.fields.defaultProfile.value, '4');
  assert.equal(harness.ruleRows().length, 1);
  assert.equal(harness.domainsOf(0), 'x.example, z.example');
  assert.equal(harness.selectOf(0).value, '7');
  // The placeholder plus one option per profile, labelled by name only.
  assert.deepEqual(
    harness.fields.defaultProfile.children.map((option) => [option.value, option.textContent]),
    [['', 'No default profile'], ['4', 'Movies'], ['7', 'TV']],
  );
});

test('corrupt stored settings still produce a usable form', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: null, rules: 'corrupt', profiles: 'corrupt', defaultProfileId: 'abc' },
  });

  assert.equal(harness.fields.baseUrl.value, '');
  assert.equal(harness.ruleRows().length, 0);
  assert.equal(harness.fields.autoCapture.checked, true, 'a missing autoCapture must default to on');
  assert.equal(harness.fields.defaultProfile.value, '');
});

test('a default profile that is no longer stored is reported instead of vanishing', async () => {
  const harness = await loadOptions({ sync: { defaultProfileId: 4, profiles: [{ id: 7, name: 'TV' }] } });

  assert.match(harness.status(), /default profile #4 is not in the stored list/);
  assert.equal(harness.fields.defaultProfile.value, '');
});

test('saving stores the normalized settings and shows the normalization back', async () => {
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      profiles: [{ id: 7, name: 'TV' }],
      rules: [{ domains: ['x.example'], profileId: 7 }],
    },
  });

  harness.fields.baseUrl.value = 'HTTP://NAS:9091/';
  harness.setDomains(0, 'https://x.example/dl, bücher.example, x.example');
  harness.fields.save.click();
  await settle();

  assert.equal(harness.status(), 'Saved\nNo default profile: only site rules and the right-click menu will grab');
  assert.equal(harness.fields.baseUrl.value, 'http://nas:9091');
  assert.equal(harness.domainsOf(0), 'x.example, xn--bcher-kva.example');
  assert.deepEqual(harness.lastSync(), {
    baseUrl: 'http://nas:9091',
    defaultProfileId: 0,
    autoCapture: true,
    rules: [{ domains: ['x.example', 'xn--bcher-kva.example'], profileId: 7 }],
    profiles: [{ id: 7, name: 'TV' }],
  });
  assert.deepEqual(harness.writes.at(-1), { area: 'local', values: { username: '', password: '' } });
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

test('a wildcard rule blocks the save and names its replacement', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }], rules: [{ domains: [], profileId: 7 }] },
  });

  harness.setDomains(0, '*.x.example');
  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /Write "x\.example" instead/);
  assert.deepEqual(harness.writes, []);
  assert.equal(harness.domainsOf(0), '*.x.example', 'a refused value must stay on screen');
});

test('a single-label rule is saved with a warning rather than refused', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }], rules: [{ domains: [], profileId: 7 }] },
  });

  harness.setDomains(0, 'example');
  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /also matches every site ending in "\.example"/);
  assert.deepEqual(harness.lastSync().rules, [{ domains: ['example'], profileId: 7 }]);
});

test('a rule with domains but no profile blocks the save', async () => {
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }] } });

  harness.fields.addRule.click();
  harness.setDomains(0, 'x.example');
  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /Pick a profile for the site rule "x\.example"/);
  assert.deepEqual(harness.writes, []);
});

test('an untouched added row is not an error and is not stored', async () => {
  const harness = await loadOptions({ sync: { baseUrl: 'http://nas:9091', profiles: [{ id: 7, name: 'TV' }] } });

  harness.fields.addRule.click();
  harness.fields.save.click();
  await settle();

  assert.match(harness.status(), /^Saved/);
  assert.deepEqual(harness.lastSync().rules, []);
});

test('removing a row drops it from the saved rules', async () => {
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      profiles: [{ id: 7, name: 'TV' }],
      rules: [{ domains: ['x.example'], profileId: 7 }, { domains: ['z.example'], profileId: 7 }],
    },
  });

  harness.removeButtonOf(0).click();
  harness.fields.save.click();
  await settle();

  assert.equal(harness.ruleRows().length, 1);
  assert.deepEqual(harness.lastSync().rules, [{ domains: ['z.example'], profileId: 7 }]);
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

  assert.equal(request.url, 'http://nas:9091/api/profiles');
  assert.equal(request.init.headers.Authorization, 'Basic dXNlcjpww6Rzc3fDtnJk');
  assert.ok(request.init.signal instanceof AbortSignal, 'the request must carry a deadline');
  assert.match(harness.status(), /^Loaded 2 profile\(s\)/);
  assert.deepEqual(
    harness.fields.defaultProfile.children.map((option) => option.textContent),
    ['No default profile', 'Movies', 'TV'],
  );
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

test('a reload that drops profiles reports the selections it clears', async () => {
  const harness = await loadOptions({
    sync: {
      baseUrl: 'http://nas:9091',
      defaultProfileId: 4,
      profiles: [{ id: 4, name: 'Movies' }, { id: 7, name: 'TV' }],
      rules: [{ domains: ['x.example'], profileId: 7 }],
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => [{ id: 9, name: 'Books', enabled: 1 }] }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.match(harness.status(), /Profile #4 no longer exists/);
  assert.match(harness.status(), /1 site rule\(s\) pointed at a profile that no longer exists/);
  assert.equal(harness.fields.defaultProfile.value, '');
  assert.equal(harness.selectOf(0).value, '');
});

test('a putiorr with no enabled profiles says so instead of reporting success', async () => {
  const harness = await loadOptions({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async () => ({ ok: true, status: 200, json: async () => [{ id: 9, name: 'Off', enabled: 0 }] }),
  });

  harness.fields.loadProfiles.click();
  await settle();

  assert.match(harness.status(), /no enabled profiles/);
  assert.equal(harness.fields.status.className, 'error');
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

  assert.match(harness.status(), /QUOTA_BYTES quota exceeded/);
  assert.equal(harness.fields.status.className, 'error');
});
