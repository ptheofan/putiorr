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
  assert.equal(isMagnetLink('https://x.example/file.torrent'), false);
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

test('resolveProfileId prefers explicit pick, then site rule, then default', () => {
  const rules = [{ domains: ['x.example'], profileId: 3 }];
  assert.equal(resolveProfileId({ explicitProfileId: 9, rules, hostname: 'x.example', defaultProfileId: 1 }), 9);
  assert.equal(resolveProfileId({ rules, hostname: 'x.example', defaultProfileId: 1 }), 3);
  assert.equal(resolveProfileId({ rules, hostname: 'other.example', defaultProfileId: 1 }), 1);
  assert.equal(resolveProfileId({ rules, hostname: 'other.example' }), undefined);
});
