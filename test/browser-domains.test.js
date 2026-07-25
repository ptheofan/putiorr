import assert from 'node:assert/strict';
import test from 'node:test';

import { matchProfileByHost, normalizeBrowserDomains } from '../src/transfer/browser-domains.js';

// These cases are the extension's proven ones (test/extension-options.test.js
// parseRuleDomains, test/extension-resolve.test.js matchSiteRuleProfileId),
// re-pointed at the server module that now owns the behaviour. They are kept
// concrete on purpose: the whole point of the port is that a browser site
// configured in putiorr matches exactly what it matched in the extension.

test('normalizeBrowserDomains returns the domains that will actually be stored', () => {
  assert.deepEqual(normalizeBrowserDomains('https://x.example/dl, bücher.example'), {
    domains: ['x.example', 'xn--bcher-kva.example'],
    errors: [],
    warnings: [],
  });
  assert.deepEqual(normalizeBrowserDomains('  X.Example:8080 , .z.example. ').domains, ['x.example', 'z.example']);
  assert.deepEqual(normalizeBrowserDomains('x.example, x.example, X.EXAMPLE').domains, ['x.example']);
});

test('normalizeBrowserDomains treats empty input as no sites rather than an error', () => {
  for (const input of ['', ' , ,', undefined, null, []]) {
    assert.deepEqual(normalizeBrowserDomains(input), { domains: [], errors: [], warnings: [] }, String(input));
  }
});

test('normalizeBrowserDomains accepts an array as well as a comma-separated string', () => {
  assert.deepEqual(normalizeBrowserDomains(['https://x.example/dl', ' bücher.example ']), {
    domains: ['x.example', 'xn--bcher-kva.example'],
    errors: [],
    warnings: [],
  });
  // A stored array can only come from putiorr itself, but a hand-written API
  // call can put anything in it: a non-string is reported, not coerced into
  // some hostname the URL parser happens to produce from it.
  assert.deepEqual(normalizeBrowserDomains([5]).domains, []);
  assert.equal(normalizeBrowserDomains([5]).errors.length, 1);
  assert.deepEqual(normalizeBrowserDomains([null, undefined, '', 'x.example']), {
    domains: ['x.example'],
    errors: [],
    warnings: [],
  });
});

test('normalizeBrowserDomains reports a scalar that is not text instead of parsing it as a host', () => {
  // The URL parser turns "5" into "0.0.0.5" and "true" into a single label, so
  // coercing a stray scalar would store a site the caller never named. A bare
  // scalar is reported exactly as one inside an array is.
  for (const input of [5, true, {}]) {
    const result = normalizeBrowserDomains(input);
    assert.deepEqual(result.domains, [], String(input));
    assert.equal(result.errors.length, 1, String(input));
  }
});

test('normalizeBrowserDomains rejects a wildcard and names the entry that replaces it', () => {
  const wildcard = normalizeBrowserDomains('*.x.example');
  assert.deepEqual(wildcard.domains, []);
  assert.deepEqual(wildcard.errors, [
    'Write "x.example" instead of "*.x.example": a browser site already matches its subdomains',
  ]);
  assert.match(normalizeBrowserDomains('*x.example').errors[0], /Write "x\.example"/);
  assert.match(normalizeBrowserDomains('*').errors[0], /is not a domain/);
});

test('normalizeBrowserDomains warns about a single label instead of matching a whole TLD in silence', () => {
  const result = normalizeBrowserDomains('com, example');
  assert.deepEqual(result.domains, ['com', 'example']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    '"com" also matches every site ending in ".com"',
    '"example" also matches every site ending in ".example"',
  ]);
});

test('normalizeBrowserDomains refuses domains that could never match a hostname', () => {
  // normalizeDomain happily returns these: the URL host parser has no opinion
  // on "*", empty labels or a leading "-", so without a shape check they would
  // save clean and then silently match nothing for the rest of the profile's
  // life.
  for (const entry of ['x.*.example', 'x..example', 'x.example*', '-.example', 'x.example-', '.']) {
    const result = normalizeBrowserDomains(entry);
    assert.deepEqual(result.domains, [], entry);
    assert.equal(result.errors.length, 1, entry);
    assert.match(result.errors[0], new RegExp(entry.replace(/[.*\-\\]/g, '\\$&')), entry);
  }
});

test('normalizeBrowserDomains accepts the underscore hostnames home LANs actually use', () => {
  // Invalid in public DNS, but the URL parser keeps the underscore, so a page
  // served from "media_server.lan" really does match a site spelled that way:
  // refusing it here would be a false rejection on exactly putiorr's audience.
  // The two halves are asserted together so they cannot drift.
  const result = normalizeBrowserDomains('media_server.lan, _svc.x.example');
  assert.deepEqual(result, { domains: ['media_server.lan', '_svc.x.example'], errors: [], warnings: [] });

  const profiles = [{ id: 3, browser_domains: result.domains }];
  assert.equal(matchProfileByHost(profiles, 'media_server.lan')?.id, 3);
  assert.equal(matchProfileByHost(profiles, 'files.media_server.lan')?.id, 3);
  assert.equal(matchProfileByHost(profiles, new URL('http://media_server.lan:9091/dl').hostname)?.id, 3);
  assert.equal(matchProfileByHost(profiles, 'media_server.example'), undefined);

  // A trailing hyphen is still an unmatchable label.
  assert.deepEqual(normalizeBrowserDomains('media_server-.lan').domains, []);
});

test('normalizeBrowserDomains keeps IP literals, which are legitimate browser sites', () => {
  assert.deepEqual(normalizeBrowserDomains('192.168.1.9').domains, ['192.168.1.9']);
  assert.deepEqual(normalizeBrowserDomains('[::1]'), { domains: ['[::1]'], errors: [], warnings: [] });
  // A bracketed literal has no labels, so the single-label warning must not fire.
  assert.deepEqual(normalizeBrowserDomains('[::ffff:127.0.0.1]').warnings, []);
});

test('normalizeBrowserDomains reports a domain it cannot normalize rather than dropping it', () => {
  const result = normalizeBrowserDomains('//, x.example');
  assert.deepEqual(result.domains, ['x.example']);
  assert.deepEqual(result.errors, ['"//" is not a domain putiorr can match']);
});

test('matchProfileByHost returns the first matching profile, suffix-matching subdomains', () => {
  const profiles = [
    { id: 3, browser_domains: ['x.example', 'z.example'] },
    { id: 4, browser_domains: ['y.example'] },
  ];
  assert.equal(matchProfileByHost(profiles, 'x.example')?.id, 3);
  assert.equal(matchProfileByHost(profiles, 'tracker.z.example')?.id, 3);
  assert.equal(matchProfileByHost(profiles, 'y.example')?.id, 4);
  assert.equal(matchProfileByHost(profiles, 'other.example'), undefined);
  assert.equal(matchProfileByHost(profiles, 'notx.example'), undefined);
  assert.equal(matchProfileByHost([], 'x.example'), undefined);
  assert.equal(matchProfileByHost(undefined, 'x.example'), undefined);
});

test('matchProfileByHost returns the profile itself, in array order', () => {
  const first = { id: 7, name: 'A', browser_domains: ['x.example'] };
  const second = { id: 2, name: 'B', browser_domains: ['x.example'] };
  assert.equal(matchProfileByHost([first, second], 'x.example'), first);
  assert.equal(matchProfileByHost([second, first], 'x.example'), second);
});

test('matchProfileByHost tolerates malformed stored rows without throwing', () => {
  assert.equal(matchProfileByHost({}, 'x.example'), undefined);
  assert.equal(matchProfileByHost(5, 'x.example'), undefined);
  assert.equal(matchProfileByHost('profiles', 'x.example'), undefined);
  assert.equal(matchProfileByHost([null], 'x.example'), undefined);
  assert.equal(matchProfileByHost([5], 'x.example'), undefined);
  assert.equal(matchProfileByHost([{ id: 3 }], 'x.example'), undefined);
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: 5 }], 'x.example'), undefined);
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: 'x.example' }], 'x.example'), undefined);
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: [null, ''] }], 'x.example'), undefined);
  // A malformed row must not stop a later valid one from matching.
  assert.equal(matchProfileByHost([null, { id: 7, browser_domains: ['x.example'] }], 'x.example')?.id, 7);
});

test('matchProfileByHost reads either key style, as store rows carry both', () => {
  assert.equal(matchProfileByHost([{ id: 3, browserDomains: ['x.example'] }], 'sub.x.example')?.id, 3);
});

test('matchProfileByHost normalizes stored domains and the page host', () => {
  const unicode = [{ id: 3, browser_domains: ['bücher.example'] }];
  assert.equal(matchProfileByHost(unicode, 'xn--bcher-kva.example')?.id, 3);
  assert.equal(matchProfileByHost(unicode, 'sub.xn--bcher-kva.example')?.id, 3);

  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['https://x.example/path'] }], 'x.example')?.id, 3);
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['x.example:8080'] }], 'x.example')?.id, 3);

  const leadingDot = [{ id: 3, browser_domains: ['.x.example'] }];
  assert.equal(matchProfileByHost(leadingDot, 'x.example')?.id, 3);
  assert.equal(matchProfileByHost(leadingDot, 'sub.x.example')?.id, 3);

  const plain = [{ id: 3, browser_domains: ['x.example'] }];
  assert.equal(matchProfileByHost(plain, 'x.example.')?.id, 3);
  assert.equal(matchProfileByHost(plain, 'X.Example')?.id, 3);
  assert.equal(matchProfileByHost(plain, '  x.example  ')?.id, 3);
  assert.equal(matchProfileByHost(plain, ''), undefined);
  assert.equal(matchProfileByHost(plain, undefined), undefined);
  // Unparseable domains and hostnames are skipped rather than throwing.
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['//'] }], 'x.example'), undefined);
  assert.equal(matchProfileByHost(plain, '//'), undefined);
});
