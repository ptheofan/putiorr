import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMagnetLink,
  isTorrentLink,
  matchSiteRuleProfileId,
  resolveProfileId,
} from '../extension/lib/resolve.js';

test('isMagnetLink detects magnet URIs only', () => {
  assert.equal(isMagnetLink('magnet:?xt=urn:btih:abc'), true);
  assert.equal(isMagnetLink('MAGNET:?xt=urn:btih:abc'), true);
  assert.equal(isMagnetLink('https://x.example/file.torrent'), false);
  assert.equal(isMagnetLink('https://x.example/?u=magnet:?xt=urn:btih:abc'), false);
  assert.equal(isMagnetLink(undefined), false);
});

test('isTorrentLink matches .torrent paths including query strings', () => {
  assert.equal(isTorrentLink('https://x.example/dl/file.torrent'), true);
  assert.equal(isTorrentLink('https://x.example/dl/file.torrent?passkey=123'), true);
  assert.equal(isTorrentLink('https://x.example/dl/file.TORRENT'), true);
  assert.equal(isTorrentLink('https://x.example/download.php?id=5'), false);
  assert.equal(isTorrentLink('https://x.example/torrents/list'), false);
  assert.equal(isTorrentLink('not a url'), false);
  assert.equal(isTorrentLink('http://'), false);
});

test('matchSiteRuleProfileId returns the first matching rule, suffix-matching subdomains', () => {
  const rules = [
    { domains: ['x.example', 'z.example'], profileId: 3 },
    { domains: ['y.example'], profileId: 4 },
  ];
  assert.equal(matchSiteRuleProfileId(rules, 'x.example'), 3);
  assert.equal(matchSiteRuleProfileId(rules, 'tracker.z.example'), 3);
  assert.equal(matchSiteRuleProfileId(rules, 'y.example'), 4);
  assert.equal(matchSiteRuleProfileId(rules, 'other.example'), undefined);
  assert.equal(matchSiteRuleProfileId(rules, 'notx.example'), undefined);
  assert.equal(matchSiteRuleProfileId([], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId(undefined, 'x.example'), undefined);
});

test('matchSiteRuleProfileId tolerates malformed stored rules without throwing', () => {
  assert.equal(matchSiteRuleProfileId({}, 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId(5, 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId('rules', 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId([null], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId([5], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId([{ profileId: 3 }], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId([{ domains: 5, profileId: 3 }], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId([{ domains: 'x.example', profileId: 3 }], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId([{ domains: [null, ''], profileId: 3 }], 'x.example'), undefined);
  // A malformed rule must not stop a later valid rule from matching.
  assert.equal(matchSiteRuleProfileId([null, { domains: ['x.example'], profileId: 7 }], 'x.example'), 7);
});

test('matchSiteRuleProfileId normalizes rule domains and hostnames', () => {
  const unicode = [{ domains: ['bücher.example'], profileId: 3 }];
  assert.equal(matchSiteRuleProfileId(unicode, 'xn--bcher-kva.example'), 3);
  assert.equal(matchSiteRuleProfileId(unicode, 'sub.xn--bcher-kva.example'), 3);

  assert.equal(matchSiteRuleProfileId([{ domains: ['https://x.example/path'], profileId: 3 }], 'x.example'), 3);
  assert.equal(matchSiteRuleProfileId([{ domains: ['x.example:8080'], profileId: 3 }], 'x.example'), 3);

  const leadingDot = [{ domains: ['.x.example'], profileId: 3 }];
  assert.equal(matchSiteRuleProfileId(leadingDot, 'x.example'), 3);
  assert.equal(matchSiteRuleProfileId(leadingDot, 'sub.x.example'), 3);

  const plain = [{ domains: ['x.example'], profileId: 3 }];
  assert.equal(matchSiteRuleProfileId(plain, 'x.example.'), 3);
  assert.equal(matchSiteRuleProfileId(plain, 'X.Example'), 3);
  assert.equal(matchSiteRuleProfileId(plain, '  x.example  '), 3);
  assert.equal(matchSiteRuleProfileId(plain, ''), undefined);
  assert.equal(matchSiteRuleProfileId(plain, undefined), undefined);
  // Unparseable domains and hostnames are skipped rather than throwing.
  assert.equal(matchSiteRuleProfileId([{ domains: ['//'], profileId: 3 }], 'x.example'), undefined);
  assert.equal(matchSiteRuleProfileId(plain, '//'), undefined);
});

test('resolveProfileId prefers explicit pick, then site rule, then default', () => {
  const rules = [{ domains: ['x.example'], profileId: 3 }];
  assert.equal(resolveProfileId({ explicitProfileId: 9, rules, hostname: 'x.example', defaultProfileId: 1 }), 9);
  assert.equal(resolveProfileId({ rules, hostname: 'x.example', defaultProfileId: 1 }), 3);
  assert.equal(resolveProfileId({ rules, hostname: 'other.example', defaultProfileId: 1 }), 1);
  assert.equal(resolveProfileId({ rules, hostname: 'other.example' }), undefined);
});

test('resolveProfileId coerces stored string ids and rejects non-positive ids', () => {
  const rules = [{ domains: ['x.example'], profileId: '3' }];
  assert.equal(resolveProfileId({ explicitProfileId: '9', hostname: 'x.example', defaultProfileId: 1 }), 9);
  assert.equal(resolveProfileId({ rules, hostname: 'x.example', defaultProfileId: 1 }), 3);
  assert.equal(resolveProfileId({ defaultProfileId: '7' }), 7);
  assert.equal(resolveProfileId({ defaultProfileId: '0' }), undefined);
  assert.equal(resolveProfileId({ explicitProfileId: '0', defaultProfileId: 1 }), 1);
  assert.equal(resolveProfileId({ explicitProfileId: 'abc', defaultProfileId: 1 }), 1);
  assert.equal(resolveProfileId({ explicitProfileId: -2, defaultProfileId: 1 }), 1);
  assert.equal(resolveProfileId({ explicitProfileId: 1.5, defaultProfileId: 1 }), 1);
  assert.equal(resolveProfileId({ defaultProfileId: 'abc' }), undefined);
  assert.equal(resolveProfileId({}), undefined);
});
