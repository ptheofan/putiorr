import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { matchProfileByHost, normalizeBrowserDomains } from '../src/transfer/browser-domains.js';
import { encodeCredentials } from '../extension/lib/auth.js';
import { hostFromTabUrl, routingForHost, storableSite } from '../extension/lib/sites.js';

// The toolbar popup answers one question — who handles the site in this tab —
// and offers one edit: claim it for a grab profile. The answer is putiorr's at
// grab time, so the popup's copy of the rules is pinned against the server's
// module here rather than trusted to stay in step by inspection.

test('a tab URL yields the host a profile could claim, or nothing at all', () => {
  assert.equal(hostFromTabUrl('https://www.x.example/path?q=1#frag'), 'www.x.example');
  assert.equal(hostFromTabUrl('http://X.Example.:8080/'), 'x.example');
  assert.equal(hostFromTabUrl('https://[::1]:8443/'), '[::1]');
});

test('a page with no site to claim is not answered with an invented one', () => {
  // Every one of these is a real tab the toolbar icon can be clicked on. A
  // profile matches a URL hostname, and none of these has one worth storing.
  for (const url of [
    'chrome://extensions',
    'about:blank',
    'file:///tmp/page.html',
    'data:text/html,x',
    'chrome-extension://abcdef/popup.html',
    '',
    undefined,
    null,
    'not a url',
  ]) {
    assert.equal(hostFromTabUrl(url), '', String(url));
  }
});

test('what the popup would store is the host itself, normalized as putiorr stores it', () => {
  // The exact host, never a guess at the registrable domain: an extension
  // carries no public-suffix list, so "www.x.co.uk" could only be shortened by
  // a rule that also shortens "x.co.uk" to "co.uk" and claims a whole TLD.
  assert.equal(storableSite('www.x.example'), 'www.x.example');
  assert.equal(storableSite('X.Example.'), 'x.example');
  assert.equal(storableSite('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(storableSite('media_server.lan'), 'media_server.lan');
  assert.equal(storableSite('[::1]'), '[::1]');
});

test('a host putiorr could never match is refused before the request is made', () => {
  for (const value of ['*.x.example', 'x..example', '-x.example', '', '   ', undefined, null]) {
    assert.equal(storableSite(value), '', String(value));
  }
});

test('the popup stores exactly what putiorr would normalize it to', () => {
  // The popup names the site it is about to store before the click, so what it
  // shows and what the server keeps have to be the same string.
  for (const host of ['www.x.example', 'X.Example.', 'bücher.example', 'media_server.lan']) {
    assert.deepEqual(normalizeBrowserDomains(host).domains, [storableSite(host)], host);
  }
});

const claiming = (id, domains, extra = {}) => ({
  id,
  name: `profile ${id}`,
  enabled: true,
  browser_domains: domains,
  ...extra,
});

test('a profile that lists the host is named, along with the site it listed', () => {
  const profiles = [claiming(1, ['z.example']), claiming(2, ['x.example'])];

  assert.deepEqual(routingForHost(profiles, 'x.example'), {
    kind: 'claimed',
    profile: profiles[1],
    domain: 'x.example',
    viaSubdomain: false,
    disabled: false,
  });
});

test('a subdomain match says which listed site it matched and that it is one', () => {
  // "dl.x.example is handled by X" with no further explanation reads like a
  // site nobody typed: the popup has to be able to say why.
  const profiles = [claiming(1, ['x.example'])];

  assert.deepEqual(routingForHost(profiles, 'dl.x.example'), {
    kind: 'claimed',
    profile: profiles[0],
    domain: 'x.example',
    viaSubdomain: true,
    disabled: false,
  });
});

test('the profile that claims the host is the first one, in the order given', () => {
  // The server resolves against profiles in creation order and stops at the
  // first match, so a site listed twice is not an error and the popup must
  // name the same winner rather than the last one it happened to see.
  const profiles = [claiming(1, ['x.example']), claiming(2, ['x.example'])];

  assert.equal(routingForHost(profiles, 'x.example').profile.id, 1);
});

test('a site nobody lists is handled by the catch-all profile', () => {
  const profiles = [claiming(1, ['z.example']), claiming(2, [], { browser_catch_all: true })];

  assert.deepEqual(routingForHost(profiles, 'x.example'), {
    kind: 'catch-all',
    profile: profiles[1],
    disabled: false,
  });
});

test('the catch-all is a fallback, not a wildcard, here as well as on the server', () => {
  const profiles = [claiming(1, [], { browser_catch_all: true }), claiming(2, ['x.example'])];

  assert.equal(routingForHost(profiles, 'x.example').kind, 'claimed');
  assert.equal(routingForHost(profiles, 'x.example').profile.id, 2);
});

test('a site nobody claims and nobody catches is reported as handled by nobody', () => {
  assert.deepEqual(routingForHost([claiming(1, ['z.example'])], 'x.example'), { kind: 'unclaimed' });
});

test('a disabled profile still claims its sites, and the popup says it is off', () => {
  // putiorr refuses such a grab by name rather than passing it to the next
  // profile, so a popup that quietly skipped it would name the wrong profile.
  const profiles = [claiming(1, ['x.example'], { enabled: false })];

  const routing = routingForHost(profiles, 'x.example');
  assert.equal(routing.kind, 'claimed');
  assert.equal(routing.disabled, true);
  assert.equal(routingForHost([claiming(1, [], { enabled: false, browser_catch_all: true })], 'x.example').disabled, true);
});

test('a tab with no host is not routed anywhere', () => {
  const profiles = [claiming(1, [], { browser_catch_all: true })];

  assert.deepEqual(routingForHost(profiles, ''), { kind: 'none' });
  assert.deepEqual(routingForHost(profiles, undefined), { kind: 'none' });
});

test('profile rows putiorr could not have written do not take the popup down', () => {
  // The rows come off the network. A throw here would leave the popup blank
  // with no explanation, which is worse than any answer it could give.
  assert.deepEqual(routingForHost(undefined, 'x.example'), { kind: 'unclaimed' });
  assert.deepEqual(routingForHost('nonsense', 'x.example'), { kind: 'unclaimed' });
  assert.deepEqual(
    routingForHost([undefined, { id: 1 }, { id: 2, browser_domains: 'x.example' }], 'x.example'),
    { kind: 'unclaimed' },
  );
  // Both key styles come back from /api/profiles, and either one is the mapping.
  assert.equal(routingForHost([{ id: 3, browserDomains: ['x.example'] }], 'x.example').kind, 'claimed');
  assert.equal(routingForHost([{ id: 3, browserCatchAll: true }], 'x.example').kind, 'catch-all');
});

test('the popup matches a host exactly as putiorr does', () => {
  // Two implementations of one rule: the extension cannot import src/, so the
  // pairing is asserted instead of assumed. A case answered differently here
  // is a popup naming a profile that would not have received the grab.
  const profiles = [
    claiming(1, ['x.example', 'bücher.example']),
    claiming(2, ['z.example', 'lan']),
    claiming(3, ['[::1]', 'media_server.lan']),
  ];
  const hosts = [
    'x.example',
    'dl.x.example',
    'deep.dl.x.example',
    'notx.example',
    'xx.example',
    'z.example.com',
    'xn--bcher-kva.example',
    'dl.xn--bcher-kva.example',
    'nas.lan',
    'lan',
    'media_server.lan',
    '[::1]',
    'X.EXAMPLE',
    'x.example.',
    '',
    'not a host',
  ];

  for (const host of hosts) {
    const routing = routingForHost(profiles, host);
    const server = matchProfileByHost(profiles, host);
    assert.equal(
      routing.kind === 'claimed' ? routing.profile : undefined,
      server,
      host,
    );
  }
});

// --- the popup page ---------------------------------------------------------
//
// popup.js is a page script: it wires up listeners at import time and exports
// nothing, so it is exercised through the same kind of stub DOM as
// test/extension-options.test.js, with a cache-busted import per test.

const POPUP_URL = new URL('../extension/popup.js', import.meta.url);
const POPUP_HTML = new URL('../extension/popup.html', import.meta.url);
const POPUP_CSS = new URL('../extension/popup.css', import.meta.url);
const OPTIONS_CSS = new URL('../extension/options.css', import.meta.url);
const MANIFEST = new URL('../extension/manifest.json', import.meta.url);
const POPUP_IDS = [
  'host',
  'routing',
  'picker',
  'profileChoices',
  'storeNote',
  'claim',
  'openOptions',
  'openDashboard',
  'status',
];

let popupLoad = 0;

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

class PopupNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parent = undefined;
    this.textContent = '';
    this.className = '';
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

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  click() {
    for (const fn of this.listeners.click ?? []) fn();
  }
}

class PopupInput extends PopupNode {
  constructor(tagName) {
    super(tagName);
    this.type = '';
    this.name = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }
}

function popupElement(tagName) {
  return tagName === 'input' ? new PopupInput(tagName) : new PopupNode(tagName);
}

function createPopupHarness({
  sync = {},
  local = {},
  tabs = [{ url: 'https://x.example/page' }],
  fetch: fetchStub,
} = {}) {
  const fields = {};
  for (const id of POPUP_IDS) fields[id] = popupElement('div');
  const opened = [];
  const requests = [];

  globalThis.document = { getElementById: (id) => fields[id], createElement: popupElement };
  globalThis.chrome = {
    runtime: { openOptionsPage: () => opened.push('options') },
    tabs: {
      query: async () => tabs,
      create: async ({ url }) => opened.push(url),
    },
    storage: {
      sync: {
        get: async (defaults) => Object.fromEntries(
          Object.entries(defaults).map(([key, value]) => [key, sync[key] ?? value]),
        ),
      },
      local: {
        get: async (defaults) => Object.fromEntries(
          Object.entries(defaults).map(([key, value]) => [key, local[key] ?? value]),
        ),
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (!fetchStub) throw new TypeError('fetch failed');
    return fetchStub(String(url), options);
  };

  // Each choice is a <label> holding a radio and the profile's name.
  const choices = () => fields.profileChoices.children.map((label) => ({
    name: label.children.at(-1)?.textContent,
    input: label.children.find((child) => child.tagName === 'input'),
  }));

  return {
    fields,
    opened,
    requests,
    choices,
    pick: (name) => {
      for (const choice of choices()) choice.input.checked = choice.name === name;
    },
    status: () => fields.status.textContent,
    tone: () => fields.status.className,
    routing: () => fields.routing.textContent,
    pickerShown: () => fields.picker.hidden === false,
  };
}

async function loadPopup(options = {}) {
  const harness = createPopupHarness(options);
  const url = new URL(POPUP_URL);
  url.search = `?load=${++popupLoad}`;
  await import(url.href);
  await settle();
  return harness;
}

const grabProfile = (id, name, extra = {}) => ({
  id,
  name,
  enabled: true,
  browser_domains: [],
  browser_catch_all: false,
  ...extra,
});

const answering = (rows, { status = 200 } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => rows,
});

test('the popup builds no markup from data', () => {
  // Profile names come from putiorr; interpolating one into HTML would make a
  // profile called "<img onerror=…>" executable inside the popup.
  assert.doesNotMatch(readFileSync(POPUP_URL, 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('clicking the toolbar icon opens the popup at all', () => {
  // Without an action entry the icon is a dead button: nothing happens, and
  // there is no error anywhere to explain why.
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(manifest.permissions.includes('tabs') || manifest.host_permissions.includes('<all_urls>'));
});

test('the popup names the site of the page in the current tab', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    tabs: [{ url: 'https://dl.x.example/torrents.php?id=7' }],
    fetch: answering([grabProfile(4, 'Movies')]),
  });

  assert.equal(harness.fields.host.textContent, 'dl.x.example');
});

test('with no putiorr URL the popup says so and offers the options, without asking putiorr', async () => {
  const harness = await loadPopup({ sync: {}, tabs: [{ url: 'https://x.example/' }] });

  assert.match(harness.status(), /putiorr URL/);
  assert.equal(harness.tone(), 'error');
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.pickerShown(), false);

  harness.fields.openOptions.click();
  assert.deepEqual(harness.opened, ['options']);
});

test('a tab with no site to claim is refused with the reason, not an empty picker', async () => {
  for (const url of ['chrome://extensions', 'about:blank', 'file:///tmp/page.html']) {
    const harness = await loadPopup({ sync: { baseUrl: 'http://nas:9091' }, tabs: [{ url }] });

    assert.equal(harness.pickerShown(), false, url);
    assert.match(harness.status(), /no site to claim/, url);
    // Nothing was asked of putiorr: there is no host to ask about.
    assert.equal(harness.requests.length, 0, url);
  }
});

test('a window with no tab at all is refused the same way', async () => {
  const harness = await loadPopup({ sync: { baseUrl: 'http://nas:9091' }, tabs: [] });

  assert.equal(harness.pickerShown(), false);
  assert.match(harness.status(), /no site to claim/);
});

test('the popup asks putiorr only for the profiles that can take a grab', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    local: { username: 'user', password: 'pässwörd' },
    fetch: answering([grabProfile(4, 'Movies')]),
  });

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].url, 'http://nas:9091/api/profiles?type=grab');
  assert.equal(
    harness.requests[0].options.headers.Authorization,
    `Basic ${encodeCredentials('user', 'pässwörd')}`,
  );
});

test('an unreachable, stalled, rejecting or non-putiorr server each read as themselves', async () => {
  const cases = [
    [async () => { throw new TypeError('fetch failed'); }, /unreachable at http:\/\/nas:9091/],
    [async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, /did not respond within 15s/],
    [answering({ error: 'nope' }, { status: 401 }), /rejected the credentials/],
    [answering({ error: 'nope' }, { status: 500 }), /responded with 500/],
    [answering({ not: 'a list' }), /did not answer with a profile list/],
  ];

  for (const [fetchStub, expected] of cases) {
    const harness = await loadPopup({ sync: { baseUrl: 'http://nas:9091' }, fetch: fetchStub });

    assert.match(harness.status(), expected);
    assert.equal(harness.tone(), 'error');
    assert.equal(harness.pickerShown(), false);
  }
});

test('a putiorr with no grab profiles names the fix rather than showing an empty picker', async () => {
  const none = await loadPopup({ sync: { baseUrl: 'http://nas:9091' }, fetch: answering([]) });
  assert.match(none.status(), /has no Putiorr Grab profiles; create one there/);
  assert.equal(none.pickerShown(), false);

  const offSwitch = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: answering([grabProfile(4, 'Movies', { enabled: false })]),
  });
  assert.match(offSwitch.status(), /has no enabled Putiorr Grab profiles; enable one there/);
  assert.equal(offSwitch.pickerShown(), false);
});

test('a site a profile claims is not offered for claiming again', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    tabs: [{ url: 'https://x.example/page' }],
    fetch: answering([
      grabProfile(4, 'Movies', { browser_domains: ['x.example'] }),
      grabProfile(7, 'Books'),
    ]),
  });

  assert.equal(harness.pickerShown(), false);
  assert.match(harness.routing(), /^Movies claims this site/);
  assert.equal(harness.requests.length, 1, 'nothing is written on open');

  // The two ways on from here: fix it where it is set, or read the rest.
  harness.fields.openDashboard.click();
  await settle();
  assert.deepEqual(harness.opened, ['http://nas:9091']);
});

test('a subdomain match says which site was listed and that subdomains match', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    tabs: [{ url: 'https://dl.x.example/page' }],
    fetch: answering([grabProfile(4, 'Movies', { browser_domains: ['x.example'] })]),
  });

  assert.match(harness.routing(), /Movies claims x\.example/);
  assert.match(harness.routing(), /subdomain/);
  assert.equal(harness.pickerShown(), false);
});

test('a profile that is switched off still claims the site, and the popup says both', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: answering([
      grabProfile(4, 'Movies', { browser_domains: ['x.example'], enabled: false }),
      grabProfile(7, 'Books'),
    ]),
  });

  assert.match(harness.routing(), /Movies claims this site/);
  assert.match(harness.routing(), /switched off/);
  // Still not offered to another profile: the claim is what has to change.
  assert.equal(harness.pickerShown(), false);
});

test('a site only the catch-all takes can still be claimed outright', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: answering([
      grabProfile(4, 'Movies'),
      grabProfile(7, 'Everything', { browser_catch_all: true }),
    ]),
  });

  assert.match(harness.routing(), /Everything takes every site no profile claims/);
  assert.equal(harness.pickerShown(), true);
  assert.deepEqual(harness.choices().map((choice) => choice.name), ['Movies', 'Everything']);
});

test('a site nobody claims and nobody catches says the grab would be refused', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: answering([grabProfile(4, 'Movies')]),
  });

  assert.match(harness.routing(), /No profile claims this site/);
  assert.match(harness.routing(), /refused/);
  assert.equal(harness.pickerShown(), true);
});

test('what will be stored is on screen before the click, not after it', async () => {
  // The exact host, including the "www." the user is looking at: nothing here
  // shortens it to a registrable domain, so nothing may imply that it does.
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    tabs: [{ url: 'https://www.x.example/torrents' }],
    fetch: answering([grabProfile(4, 'Movies')]),
  });

  assert.equal(harness.fields.host.textContent, 'www.x.example');
  assert.match(harness.fields.storeNote.textContent, /www\.x\.example/);
  assert.equal(harness.fields.claim.textContent, 'Claim www.x.example');
});

test('claiming posts one site to the picked profile, with the anti-CSRF header', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    local: { username: 'user', password: 'secret' },
    tabs: [{ url: 'https://x.example/page' }],
    fetch: async (url) => (url.includes('browser-sites')
      ? {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          profile: { id: 7, name: 'Books' },
          browser_domains: ['x.example'],
          added: 'x.example',
        }),
      }
      : { ok: true, status: 200, json: async () => [grabProfile(4, 'Movies'), grabProfile(7, 'Books')] }),
  });

  harness.pick('Books');
  harness.fields.claim.click();
  await settle();

  const claim = harness.requests.at(-1);
  assert.equal(claim.url, 'http://nas:9091/api/profiles/7/browser-sites');
  assert.equal(claim.options.method, 'POST');
  assert.equal(claim.options.headers['X-Putiorr-Grab'], '1');
  assert.equal(claim.options.headers.Authorization, `Basic ${encodeCredentials('user', 'secret')}`);
  assert.deepEqual(JSON.parse(claim.options.body), { host: 'x.example' });

  assert.match(harness.status(), /Books now claims x\.example/);
  assert.equal(harness.tone(), 'ok');
  // The question the popup opened with is answered; offering the claim again
  // would offer to do what was just done.
  assert.equal(harness.pickerShown(), false);
  assert.match(harness.routing(), /Books claims this site/);
});

test('a claim putiorr refuses is shown as putiorr worded it', async () => {
  // The refusal names the profile that already holds the site, which this
  // popup cannot know better than putiorr does; rewording it would be a second
  // copy free to drift from the one that decides.
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async (url) => (url.includes('browser-sites')
      ? {
        ok: false,
        status: 409,
        json: async () => ({ error: 'Movies already claims x.example; remove the site there first' }),
      }
      : { ok: true, status: 200, json: async () => [grabProfile(7, 'Books')] }),
  });

  harness.fields.claim.click();
  await settle();

  assert.equal(harness.status(), 'Movies already claims x.example; remove the site there first');
  assert.equal(harness.tone(), 'error');
});

test('a claim that never reaches putiorr reads as a dead server, not a refusal', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async (url) => {
      if (url.includes('browser-sites')) throw new TypeError('fetch failed');
      return { ok: true, status: 200, json: async () => [grabProfile(7, 'Books')] };
    },
  });

  harness.fields.claim.click();
  await settle();

  assert.match(harness.status(), /unreachable at http:\/\/nas:9091/);
  assert.equal(harness.tone(), 'error');
});

test('an impatient second click does not send a second claim', async () => {
  let resolveClaim;
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async (url) => {
      if (!url.includes('browser-sites')) {
        return { ok: true, status: 200, json: async () => [grabProfile(7, 'Books')] };
      }
      await new Promise((resolve) => { resolveClaim = resolve; });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, profile: { id: 7, name: 'Books' }, browser_domains: ['x.example'], added: 'x.example' }),
      };
    },
  });

  harness.fields.claim.click();
  harness.fields.claim.click();
  await settle();
  assert.equal(harness.fields.claim.disabled, true);
  resolveClaim();
  await settle();

  assert.equal(harness.requests.filter((request) => request.url.includes('browser-sites')).length, 1);
});

test('a site putiorr already had is reported as such rather than as a fresh claim', async () => {
  const harness = await loadPopup({
    sync: { baseUrl: 'http://nas:9091' },
    fetch: async (url) => (url.includes('browser-sites')
      ? {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          profile: { id: 7, name: 'Books' },
          browser_domains: ['x.example'],
          added: null,
        }),
      }
      : { ok: true, status: 200, json: async () => [grabProfile(7, 'Books')] }),
  });

  harness.fields.claim.click();
  await settle();

  assert.match(harness.status(), /Books already claims x\.example/);
  assert.equal(harness.tone(), 'ok');
});

test('popup.html carries every element the page wires up, and no dashboard widgets', async () => {
  const html = readFileSync(POPUP_HTML, 'utf8');
  for (const id of POPUP_IDS) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<script type="module" src="popup\.js"><\/script>/);
  assert.match(html, /<span id="status" aria-live="polite">/);
  assert.match(html, /id="picker"[^>]*hidden/);
  // Web Awesome is a dashboard runtime dependency the extension does not ship,
  // and the popup is styled by stylesheets like every other page here.
  assert.doesNotMatch(html, /<wa-/);
  assert.doesNotMatch(html, /<style|style="/);
  assert.doesNotMatch(readFileSync(POPUP_URL, 'utf8'), /\.style\./);
  assert.match(html, /<link rel="stylesheet" href="options\.css">/);
  assert.match(html, /<link rel="stylesheet" href="popup\.css">/);
});

test('the popup stylesheet borrows the tokens rather than keeping a second copy', () => {
  // A second :root block would be a copy free to drift from the one the
  // options page uses, and the popup would slowly stop looking like putiorr.
  const popupCss = readFileSync(POPUP_CSS, 'utf8');
  const optionsCss = readFileSync(OPTIONS_CSS, 'utf8');
  assert.doesNotMatch(popupCss, /:root\s*\{/);
  assert.match(popupCss, /options\.css/);

  const defined = new Set();
  for (const [, block] of optionsCss.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name] of block.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(name);
  }
  const used = [...popupCss.matchAll(/var\((--[a-z0-9-]+)/g)].map(([, name]) => name);
  assert.ok(used.length > 0, 'the popup must be themed by the token set');
  assert.deepEqual(used.filter((name) => !defined.has(name)), [], 'used but never defined');
});
