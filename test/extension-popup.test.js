import assert from 'node:assert/strict';
import test from 'node:test';
import { matchProfileByHost, normalizeBrowserDomains } from '../src/transfer/browser-domains.js';
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
