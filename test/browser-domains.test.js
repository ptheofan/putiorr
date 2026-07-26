import assert from 'node:assert/strict';
import test from 'node:test';

import { matchProfileByHost, normalizeBrowserDomains } from '../src/transfer/browser-domains.js';

// A browser site is either a host, which matches that host and nothing else, or
// "*." in front of one, which matches that host and every subdomain of it. The
// wildcard covering the apex as well is deliberate: claiming a whole tracker is
// the common case, and needing two entries for it would be a trap.
//
// These cases are the specification of that rule. They are kept concrete on
// purpose: everything else in putiorr that talks about browser sites — the
// profile form, the claim endpoint, the extension popup — is downstream of
// exactly what is asserted here.

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

test('normalizeBrowserDomains keeps a leading wildcard, normalizing the base under it', () => {
  // The star is not part of the host, so everything the plain form rewrites is
  // rewritten under it too, and the entry is stored with the star put back.
  assert.deepEqual(normalizeBrowserDomains('*.x.example'), {
    domains: ['*.x.example'],
    errors: [],
    warnings: [],
  });
  assert.deepEqual(normalizeBrowserDomains(' *.HTTPS://X.Example:8080/dl ').domains, ['*.x.example']);
  assert.deepEqual(normalizeBrowserDomains('*.bücher.example').domains, ['*.xn--bcher-kva.example']);
  // The wildcard and the plain form are different entries: one profile may hold
  // both, and neither absorbs the other.
  assert.deepEqual(normalizeBrowserDomains('x.example, *.x.example').domains, ['x.example', '*.x.example']);
  assert.deepEqual(normalizeBrowserDomains('*.x.example, *.X.Example').domains, ['*.x.example']);
});

test('normalizeBrowserDomains refuses a star anywhere but the front', () => {
  // A star elsewhere is not a narrower wildcard putiorr declined to implement,
  // it is a shape the matcher has no meaning for at all. Saying so names the
  // one position that works rather than leaving the user to guess.
  for (const entry of ['dl.*.example.com', 'example.*', '*', '*x.example', '**.x.example', '*.*.x.example']) {
    const result = normalizeBrowserDomains(entry);
    assert.deepEqual(result.domains, [], entry);
    assert.equal(result.errors.length, 1, entry);
    assert.match(result.errors[0], /a wildcard is only a leading "\*\."/, entry);
    assert.match(result.errors[0], new RegExp(entry.replace(/[.*\-\\]/g, '\\$&')), entry);
  }
});

test('normalizeBrowserDomains refuses a wildcard whose base could never match', () => {
  // "*." in front does not make an unmatchable host matchable: the base goes
  // through the same shape check the plain form does.
  for (const entry of ['*.x..example', '*.-.example', '*.x.example-', '*.']) {
    const result = normalizeBrowserDomains(entry);
    assert.deepEqual(result.domains, [], entry);
    assert.equal(result.errors.length, 1, entry);
    assert.match(result.errors[0], new RegExp(entry.replace(/[.*\-\\]/g, '\\$&')), entry);
  }
});

test('normalizeBrowserDomains warns about a wildcard broad enough to be a whole suffix', () => {
  // putiorr carries no public-suffix list and must not bundle one, so it cannot
  // tell "*.com" from "*.example". What it can see is that the base is a single
  // label, which is what every public suffix a home user would type looks like
  // — and which is also what a LAN name looks like, so this is advice and not a
  // refusal.
  const result = normalizeBrowserDomains('*.com, *.lan');
  assert.deepEqual(result.domains, ['*.com', '*.lan']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    '"*.com" matches com and every site ending in ".com"',
    '"*.lan" matches lan and every site ending in ".lan"',
  ]);
});

test('normalizeBrowserDomains does not warn about a plain single label, which now matches only itself', () => {
  // The old warning belonged to the old rule, where "com" matched every site
  // ending in ".com". A plain entry is exact now, so "nas" claims the host
  // "nas" and nothing else, and warning about it would be false.
  assert.deepEqual(normalizeBrowserDomains('com, nas'), {
    domains: ['com', 'nas'],
    errors: [],
    warnings: [],
  });
  // A bracketed literal has no labels to be a suffix of, so it never warns
  // under either form.
  assert.deepEqual(normalizeBrowserDomains('[::ffff:127.0.0.1], *.[::1]').warnings, []);
});

test('normalizeBrowserDomains refuses domains that could never match a hostname', () => {
  // normalizeDomain happily returns these: the URL host parser has no opinion
  // on empty labels or a leading "-", so without a shape check they would save
  // clean and then silently match nothing for the rest of the profile's life.
  for (const entry of ['x..example', '-.example', 'x.example-', '.']) {
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
  const result = normalizeBrowserDomains('media_server.lan, *._svc.x.example');
  assert.deepEqual(result, { domains: ['media_server.lan', '*._svc.x.example'], errors: [], warnings: [] });

  const profiles = [{ id: 3, browser_domains: result.domains }];
  assert.equal(matchProfileByHost(profiles, 'media_server.lan')?.profile.id, 3);
  assert.equal(matchProfileByHost(profiles, new URL('http://media_server.lan:9091/dl').hostname)?.profile.id, 3);
  assert.equal(matchProfileByHost(profiles, 'a._svc.x.example')?.profile.id, 3);
  // The plain entry is exact, so a subdomain of it is not its business.
  assert.equal(matchProfileByHost(profiles, 'files.media_server.lan'), undefined);
  assert.equal(matchProfileByHost(profiles, 'media_server.example'), undefined);

  // A trailing hyphen is still an unmatchable label.
  assert.deepEqual(normalizeBrowserDomains('media_server-.lan').domains, []);
});

test('normalizeBrowserDomains keeps IP literals, which are legitimate browser sites', () => {
  assert.deepEqual(normalizeBrowserDomains('192.168.1.9').domains, ['192.168.1.9']);
  assert.deepEqual(normalizeBrowserDomains('[::1]'), { domains: ['[::1]'], errors: [], warnings: [] });
});

test('normalizeBrowserDomains reports a domain it cannot normalize rather than dropping it', () => {
  const result = normalizeBrowserDomains('//, x.example');
  assert.deepEqual(result.domains, ['x.example']);
  assert.deepEqual(result.errors, ['"//" is not a domain putiorr can match']);
});

test('a plain browser site matches that host and no subdomain of it', () => {
  const profiles = [
    { id: 3, browser_domains: ['x.example', 'z.example'] },
    { id: 4, browser_domains: ['y.example'] },
  ];
  assert.equal(matchProfileByHost(profiles, 'x.example')?.profile.id, 3);
  assert.equal(matchProfileByHost(profiles, 'y.example')?.profile.id, 4);
  assert.equal(matchProfileByHost(profiles, 'tracker.z.example'), undefined);
  assert.equal(matchProfileByHost(profiles, 'other.example'), undefined);
  assert.equal(matchProfileByHost(profiles, 'notx.example'), undefined);
  assert.equal(matchProfileByHost([], 'x.example'), undefined);
  assert.equal(matchProfileByHost(undefined, 'x.example'), undefined);
});

test('a wildcard browser site matches the apex and every subdomain under it', () => {
  // The apex is included on purpose: "*.x.example" is how a user claims the
  // whole of x.example, and making them list the apex separately would be a
  // trap they only find out about from a grab going somewhere else.
  const profiles = [{ id: 3, browser_domains: ['*.x.example'] }];
  assert.equal(matchProfileByHost(profiles, 'x.example')?.profile.id, 3);
  assert.equal(matchProfileByHost(profiles, 'dl.x.example')?.profile.id, 3);
  assert.equal(matchProfileByHost(profiles, 'a.b.c.x.example')?.profile.id, 3);
  assert.equal(matchProfileByHost(profiles, 'notx.example'), undefined);
  assert.equal(matchProfileByHost(profiles, 'example'), undefined);
  assert.equal(matchProfileByHost(profiles, 'x.example.com'), undefined);
});

test('matchProfileByHost says which entry matched, and whether it was a wildcard', () => {
  // Callers surface the entry: the claim endpoint names it in a refusal and the
  // popup names it in the sentence it shows, and neither can recompute it
  // without a second copy of this rule.
  const profiles = [{ id: 3, browser_domains: ['x.example', '*.z.example'] }];
  assert.deepEqual(matchProfileByHost(profiles, 'x.example'), {
    profile: profiles[0],
    domain: 'x.example',
    wildcard: false,
  });
  assert.deepEqual(matchProfileByHost(profiles, 'dl.z.example'), {
    profile: profiles[0],
    domain: '*.z.example',
    wildcard: true,
  });
  assert.deepEqual(matchProfileByHost(profiles, 'z.example'), {
    profile: profiles[0],
    domain: '*.z.example',
    wildcard: true,
  });
});

test('an exact entry beats a wildcard that also covers the host, whatever the order', () => {
  // This is what makes an overlap safe rather than a conflict: one profile takes
  // dl.x.example by name, another takes the rest of the domain.
  const exact = { id: 7, browser_domains: ['dl.x.example'] };
  const wide = { id: 2, browser_domains: ['*.x.example'] };

  assert.equal(matchProfileByHost([exact, wide], 'dl.x.example')?.profile.id, 7);
  assert.equal(matchProfileByHost([wide, exact], 'dl.x.example')?.profile.id, 7);
  // Everything else under the domain still goes to the wildcard.
  assert.equal(matchProfileByHost([wide, exact], 'x.example')?.profile.id, 2);
  assert.equal(matchProfileByHost([wide, exact], 'other.x.example')?.profile.id, 2);
});

test('the longest wildcard base wins, whatever the order', () => {
  const narrow = { id: 7, browser_domains: ['*.dl.x.example'] };
  const wide = { id: 2, browser_domains: ['*.x.example'] };

  assert.equal(matchProfileByHost([narrow, wide], 'a.dl.x.example')?.profile.id, 7);
  assert.equal(matchProfileByHost([wide, narrow], 'a.dl.x.example')?.profile.id, 7);
  assert.equal(matchProfileByHost([wide, narrow], 'dl.x.example')?.profile.id, 7);
  assert.equal(matchProfileByHost([wide, narrow], 'other.x.example')?.profile.id, 2);
});

test('matchProfileByHost returns the profile itself, in array order', () => {
  const first = { id: 7, name: 'A', browser_domains: ['x.example'] };
  const second = { id: 2, name: 'B', browser_domains: ['x.example'] };
  assert.equal(matchProfileByHost([first, second], 'x.example').profile, first);
  assert.equal(matchProfileByHost([second, first], 'x.example').profile, second);

  // Two equally specific wildcards resolve the same way: the store refuses to
  // hold the same entry twice, but a row written before that rule existed must
  // still answer every grab identically rather than by whichever it saw last.
  const wideFirst = { id: 7, browser_domains: ['*.x.example'] };
  const wideSecond = { id: 2, browser_domains: ['*.x.example'] };
  assert.equal(matchProfileByHost([wideFirst, wideSecond], 'dl.x.example').profile, wideFirst);
  assert.equal(matchProfileByHost([wideSecond, wideFirst], 'dl.x.example').profile, wideSecond);
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
  // A row written before wildcards existed can hold a star in a position that
  // is now refused. It matches nothing rather than throwing.
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['x.*.example'] }], 'x.y.example'), undefined);
  // A malformed row must not stop a later valid one from matching.
  assert.equal(matchProfileByHost([null, { id: 7, browser_domains: ['x.example'] }], 'x.example')?.profile.id, 7);
});

test('matchProfileByHost reads either key style, as store rows carry both', () => {
  assert.equal(matchProfileByHost([{ id: 3, browserDomains: ['*.x.example'] }], 'sub.x.example')?.profile.id, 3);
});

test('matchProfileByHost normalizes stored domains and the page host', () => {
  const unicode = [{ id: 3, browser_domains: ['bücher.example', '*.bücher.test'] }];
  assert.equal(matchProfileByHost(unicode, 'xn--bcher-kva.example')?.profile.id, 3);
  assert.equal(matchProfileByHost(unicode, 'sub.xn--bcher-kva.test')?.profile.id, 3);

  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['https://x.example/path'] }], 'x.example')?.profile.id, 3);
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['x.example:8080'] }], 'x.example')?.profile.id, 3);

  const leadingDot = [{ id: 3, browser_domains: ['.x.example', '*..z.example'] }];
  assert.equal(matchProfileByHost(leadingDot, 'x.example')?.profile.id, 3);
  assert.equal(matchProfileByHost(leadingDot, 'sub.z.example')?.profile.id, 3);

  const plain = [{ id: 3, browser_domains: ['x.example'] }];
  assert.equal(matchProfileByHost(plain, 'x.example.')?.profile.id, 3);
  assert.equal(matchProfileByHost(plain, 'X.Example')?.profile.id, 3);
  assert.equal(matchProfileByHost(plain, '  x.example  ')?.profile.id, 3);
  assert.equal(matchProfileByHost(plain, ''), undefined);
  assert.equal(matchProfileByHost(plain, undefined), undefined);
  // Unparseable domains and hostnames are skipped rather than throwing.
  assert.equal(matchProfileByHost([{ id: 3, browser_domains: ['//'] }], 'x.example'), undefined);
  assert.equal(matchProfileByHost(plain, '//'), undefined);
});
