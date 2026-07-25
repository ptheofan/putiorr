import assert from 'node:assert/strict';
import test from 'node:test';
import { isMagnetLink, isTorrentLink, sanitizeProfiles } from '../extension/lib/resolve.js';

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

test('sanitizeProfiles returns an empty list for anything that is not an array', () => {
  assert.deepEqual(sanitizeProfiles(undefined), []);
  assert.deepEqual(sanitizeProfiles(null), []);
  assert.deepEqual(sanitizeProfiles('corrupt'), []);
  assert.deepEqual(sanitizeProfiles(5), []);
  assert.deepEqual(sanitizeProfiles({ id: 3, name: 'X' }), []);
  assert.deepEqual(sanitizeProfiles([]), []);
});

test('sanitizeProfiles drops malformed elements without throwing', () => {
  assert.deepEqual(sanitizeProfiles([null]), []);
  assert.deepEqual(sanitizeProfiles([undefined, 5, 'x', []]), []);
  assert.deepEqual(sanitizeProfiles([{ name: 'no id' }]), []);
});

test('sanitizeProfiles coerces stored string ids to numbers', () => {
  // Storage round-trips can turn ids into strings; handleGrab compares ids with
  // === when labelling a notification, so the coercion has to happen here.
  assert.deepEqual(sanitizeProfiles([{ id: '3', name: 'X' }]), [{ id: 3, name: 'X' }]);
});

test('sanitizeProfiles falls back to a generated name when the stored name is unusable', () => {
  assert.deepEqual(sanitizeProfiles([{ id: 3 }]), [{ id: 3, name: 'profile #3' }]);
  assert.deepEqual(sanitizeProfiles([{ id: 3, name: '' }]), [{ id: 3, name: 'profile #3' }]);
  assert.deepEqual(sanitizeProfiles([{ id: 3, name: '   ' }]), [{ id: 3, name: 'profile #3' }]);
  assert.deepEqual(sanitizeProfiles([{ id: 3, name: null }]), [{ id: 3, name: 'profile #3' }]);
  assert.deepEqual(sanitizeProfiles([{ id: 3, name: 7 }]), [{ id: 3, name: '7' }]);
});

test('sanitizeProfiles keeps valid entries alongside invalid ones', () => {
  const profiles = [
    { id: 0, name: 'zero' },
    { id: -2, name: 'negative' },
    { id: 1.5, name: 'fractional' },
    { id: 'abc', name: 'not numeric' },
    null,
    { id: 4, name: 'Movies' },
    { id: '7', name: 'TV' },
  ];
  assert.deepEqual(sanitizeProfiles(profiles), [
    { id: 4, name: 'Movies' },
    { id: 7, name: 'TV' },
  ]);
});

test('sanitizeProfiles returns fresh objects rather than the stored references', () => {
  const stored = [{ id: 3, name: 'X', extra: 'dropped' }];
  const [sanitized] = sanitizeProfiles(stored);
  assert.notEqual(sanitized, stored[0]);
  assert.deepEqual(sanitized, { id: 3, name: 'X' });
});
