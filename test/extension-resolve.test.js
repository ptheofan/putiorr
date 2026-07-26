import assert from 'node:assert/strict';
import test from 'node:test';
import { isMagnetLink, isTorrentLink, magnetFromLink, sanitizeProfiles } from '../extension/lib/resolve.js';

// The link the project owner clicked, which the extension used to let through:
// an https "send to put.io" handler whose query carries the magnet, written
// with the inner magnet's own "&dn=" and "&tr=" left unencoded.
const HANDLER_URL = 'https://put.io/default/magnet?url=magnet:?xt=urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F90123456789ABCD'
  + '&dn=Little.Chicks.5.1994.1080p.BluRay.x264-GROUP'
  + '&tr=udp%3A%2F%2Fz.mercax.com%3A53%2Fannounce'
  + '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'
  + '&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce'
  + '&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce';

test('isMagnetLink detects magnet URIs only', () => {
  assert.equal(isMagnetLink('magnet:?xt=urn:btih:abc'), true);
  assert.equal(isMagnetLink('MAGNET:?xt=urn:btih:abc'), true);
  assert.equal(isMagnetLink('https://x.example/file.torrent'), false);
  // Still false, and still worth pinning: the predicate answers "is this href a
  // magnet URI", and a substring must never make it say yes. Pulling the magnet
  // *out* of such a href is magnetFromLink's job, below.
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

test('magnetFromLink keeps the display name and every tracker of a wrapped magnet', () => {
  // The whole point of the fix. Reading the "url" parameter is the obvious
  // route and it is the wrong one: the inner magnet's "&dn=" and "&tr=" are
  // not percent-encoded, so the *outer* URL parser claims them as its own
  // top-level parameters and the value of "url" is the infohash alone.
  assert.equal(
    new URL(HANDLER_URL).searchParams.get('url'),
    'magnet:?xt=urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F90123456789ABCD',
    'the naive extraction really does lose everything after the infohash',
  );

  const magnet = magnetFromLink(HANDLER_URL);
  assert.equal(magnet, HANDLER_URL.slice(HANDLER_URL.indexOf('magnet:?')));

  const params = new URLSearchParams(magnet.slice(magnet.indexOf('?') + 1));
  assert.equal(params.get('xt'), 'urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F90123456789ABCD');
  assert.equal(params.get('dn'), 'Little.Chicks.5.1994.1080p.BluRay.x264-GROUP');
  assert.deepEqual(params.getAll('tr'), [
    'udp://z.mercax.com:53/announce',
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://exodus.desync.com:6969/announce',
  ]);
  // The trim below must never reach this link: every key in it is a magnet key,
  // so the magnet runs to the end of the href exactly as before.
  assert.equal(magnet, HANDLER_URL.slice(HANDLER_URL.indexOf('magnet:?')));
  assert.equal(params.getAll('tr').length, 4);
});

test('magnetFromLink stops the magnet at the handler URL\'s own parameters', () => {
  // The raw-substring rule over-reaches on purpose — it runs to the end of the
  // href — so a handler that puts its own parameters after the magnet used to
  // have them swallowed into it. A session token or a signed callback is a
  // normal thing to find there, and it would have gone into putiorr's database,
  // into its logs, and on to put.io.
  const href = 'https://site.example/send?url=magnet:?xt=urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F9012345'
    + '&dn=Thing&callback=/done&token=SECRET123';

  const magnet = magnetFromLink(href);
  assert.equal(magnet, 'magnet:?xt=urn:btih:86B9AFE1C4D0F2A3B5C6D7E8F9012345&dn=Thing');
  assert.equal(magnet.includes('SECRET123'), false, 'the handler\'s token must not reach put.io');
  assert.equal(magnet.includes('callback'), false);
});

test('magnetFromLink keeps every key a magnet is allowed to carry', () => {
  // Getting this list wrong truncates real data, so it is spelled out: the
  // magnet URI scheme's own keys, BEP 53's "so", the "ws" webseed clients
  // added, and libtorrent's experimental "x." namespace. Any of them may be
  // numbered ("xt.1", "tr.2") to carry more than one value.
  const magnet = 'magnet:?xt.1=urn:btih:abc&xt.2=urn:btmh:1220caf1&dn=Name&xl=1024'
    + '&tr=udp://a.example:80/announce&tr.2=udp://b.example:80/announce'
    + '&ws=https://c.example/file&xs=https://d.example/meta&as=https://e.example/file'
    + '&kt=key+words&mt=https://f.example/list&so=0-2&x.pe=1.2.3.4:51413';
  assert.equal(magnetFromLink(`https://site.example/send?url=${magnet}`), magnet);
});

test('magnetFromLink never trims a genuine magnet href', () => {
  // A magnet: href is what the site author wrote, in full and on purpose. The
  // trim exists only to undo the raw scan's deliberate over-reach; applying it
  // here would silently drop data handed to us correctly.
  const magnet = 'magnet:?xt=urn:btih:abc&dn=Thing&sf=Season%201&token=keepme';
  assert.equal(magnetFromLink(magnet), magnet);
});

test('magnetFromLink does not trim a magnet the site encoded into one parameter', () => {
  // Nothing over-reached here: the parameter's value is the whole magnet and
  // the site said so by encoding it, so an unfamiliar key inside is the site's
  // to keep, not ours to cut.
  const inner = 'magnet:?xt=urn:btih:abc&dn=Thing&sf=Season 1';
  assert.equal(magnetFromLink(`https://x.example/dl?m=${encodeURIComponent(inner)}&token=SECRET`), inner);
});

test('magnetFromLink trims a fragment-embedded magnet the same way', () => {
  // A magnet living in the fragment is captured like any other...
  assert.equal(
    magnetFromLink('https://x.example/page#magnet:?xt=urn:btih:abc&dn=Thing'),
    'magnet:?xt=urn:btih:abc&dn=Thing',
  );
  // ...and a fragment *after* a wrapped magnet is the outer URL's, not the
  // magnet's. Left glued on it would ride along inside the last value, which is
  // the same leak by another route.
  assert.equal(
    magnetFromLink('https://x.example/go?url=magnet:?xt=urn:btih:abc&dn=Thing#session=SECRET'),
    'magnet:?xt=urn:btih:abc&dn=Thing',
  );
});

test('magnetFromLink refuses a link whose magnet is trimmed down to nothing', () => {
  // The handler's own parameters come first here, so the trim cuts before the
  // "xt" and what is left names no swarm. Validating after the trim rather than
  // before is what keeps that from being captured as a magnet with no topic.
  assert.equal(magnetFromLink('https://x.example/go?url=magnet:?token=SECRET&xt=urn:btih:abc'), '');
});

test('magnetFromLink reads a properly encoded inner magnet out of the query', () => {
  // The other half of the world: sites that do encode the magnet they wrap.
  // The raw scan finds nothing here, because the href holds "magnet%3A%3F".
  const inner = 'magnet:?xt=urn:btih:abcdef1234567890&dn=Encoded Release&tr=udp://t.example:80/announce';
  const href = `https://x.example/download.php?id=7&magnet=${encodeURIComponent(inner)}`;
  assert.equal(href.toLowerCase().includes('magnet:?'), false, 'this case must exercise the parameter path');
  assert.equal(magnetFromLink(href), inner);
});

test('magnetFromLink returns a real magnet href unchanged', () => {
  assert.equal(magnetFromLink('magnet:?xt=urn:btih:abc&dn=Example'), 'magnet:?xt=urn:btih:abc&dn=Example');
  assert.equal(magnetFromLink('MAGNET:?xt=urn:btih:abc'), 'MAGNET:?xt=urn:btih:abc');
  // A bare magnet is passed through without validation on purpose: the click
  // handler already treated every magnet: href as a magnet, and narrowing that
  // now would stop capturing links that work today.
  assert.equal(magnetFromLink('magnet:xxx.torrent'), 'magnet:xxx.torrent');
});

test('magnetFromLink finds an upper-case magnet inside a handler URL', () => {
  const href = 'https://x.example/go?url=MAGNET:?xt=urn:btih:abc&dn=Shouty';
  assert.equal(magnetFromLink(href), 'MAGNET:?xt=urn:btih:abc&dn=Shouty');
});

test('magnetFromLink accepts BitTorrent v2 and numbered topics, and nothing else', () => {
  assert.equal(
    magnetFromLink('https://x.example/go?url=magnet:?xt=urn:btmh:1220caf1'),
    'magnet:?xt=urn:btmh:1220caf1',
  );
  // A dual v1/v2 magnet numbers its topics; "xt" alone would miss both.
  assert.equal(
    magnetFromLink('https://x.example/go?url=magnet:?xt.1=urn:btih:abc&xt.2=urn:btmh:1220caf1'),
    'magnet:?xt.1=urn:btih:abc&xt.2=urn:btmh:1220caf1',
  );
  // ed2k is a magnet URI, but not one put.io can take as a torrent.
  assert.equal(magnetFromLink('https://x.example/go?url=magnet:?xt=urn:ed2k:abc'), '');
});

test('magnetFromLink ignores links that merely mention a magnet', () => {
  assert.equal(magnetFromLink('https://x.example/browse?id=5'), '');
  assert.equal(magnetFromLink('https://x.example/wiki/magnet?about=magnet:?foo=bar'), '');
  assert.equal(magnetFromLink('https://x.example/help/magnet-links'), '');
  assert.equal(magnetFromLink(undefined), '');
  assert.equal(magnetFromLink('http://'), '');
});

test('magnetFromLink survives a malformed percent sequence instead of throwing', () => {
  // A lone "%" makes decodeURIComponent throw. It has to be survivable in both
  // places the decoder runs: validating a magnet found by the raw scan, and
  // decoding an unrelated parameter while looking for an encoded one.
  assert.equal(
    magnetFromLink('https://x.example/go?url=magnet:?xt=urn:btih:abc&dn=100%discount'),
    'magnet:?xt=urn:btih:abc&dn=100%discount',
  );
  assert.equal(magnetFromLink('https://x.example/go?ref=100%discount'), '');
  assert.equal(magnetFromLink('https://x.example/go?xt=urn%3Abtih%3Aabc&dn=%'), '');
});

test('magnetFromLink claims a handler URL whose path ends in .torrent', () => {
  // Which is why the click handler asks magnetFromLink before isTorrentLink:
  // fetching this path would download the handler's HTML, not a torrent.
  const href = 'https://x.example/dl/file.torrent?url=magnet:?xt=urn:btih:abc&dn=Wrapped';
  assert.equal(isTorrentLink(href), true, 'the input must be claimed by both to discriminate');
  assert.equal(magnetFromLink(href), 'magnet:?xt=urn:btih:abc&dn=Wrapped');
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
