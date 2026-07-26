import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';
import { TransmissionRpcServer } from '../src/transmission/server.js';

class FakePutio {
  constructor() {
    this.added = [];
    this.uploads = [];
  }

  async ensureFolder() {
    return 42;
  }

  async addTransfer(source, folderId) {
    this.added.push({ source, folderId });
    return {
      id: 77,
      name: 'Example.Release',
      hash: 'abcdef1234567890',
      status: 'IN_QUEUE',
      percentDone: 0,
      size: 1000,
      downloaded: 0,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      estimatedTime: -1,
      fileId: 88,
      saveParentId: folderId,
      magnetUri: source,
    };
  }

  async uploadTorrent(data, name, folderId) {
    this.uploads.push({ size: data.length, name, folderId });
    return {
      id: 78,
      name: name.replace(/\.torrent$/i, ''),
      hash: 'fedcba0987654321',
      status: 'IN_QUEUE',
      percentDone: 0,
      size: 2000,
      downloaded: 0,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      estimatedTime: -1,
      fileId: 89,
      saveParentId: folderId,
    };
  }

  async listTransfers() {
    return [];
  }
}

const VALID_TORRENT_BASE64 = Buffer.from('d8:announce0:e').toString('base64');

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-grab-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_LISTEN_HOST: '127.0.0.1',
    PUTIORR_LISTEN_PORT: '0',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    PUTIORR_PUTIO_APP_ID: '12345',
    // Only Putiorr Grab profiles serve browser grabs, so the profile the store
    // seeds is one: every grab here would otherwise be refused for its preset.
    PUTIORR_DEFAULT_PROFILE_TYPE: 'grab',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const putio = new FakePutio();
  const service = new TransferService({ config, store, putioFactory: () => putio });
  const rpcServer = new TransmissionRpcServer({ config, service });
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  return { config, store, putio, rpcServer, base: `http://127.0.0.1:${port}` };
}

function closeHarness(harness) {
  return async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  };
}

async function postGrab(harness, payload, { grabHeader = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (grabHeader) headers['X-Putiorr-Grab'] = '1';
  const response = await fetch(`${harness.base}/api/grab`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

// logger is a module singleton, so the warning can be observed by swapping the
// one method and putting it back afterwards.
function captureWarnings(t) {
  const warnings = [];
  const original = logger.warn;
  logger.warn = (message, meta) => warnings.push({ message, meta });
  t.after(() => { logger.warn = original; });
  return warnings;
}

test('a grab into a profile that keeps completed transfers warns exactly once', async (t) => {
  // A browser grab has no *arr app to import it and signal completion, so
  // without auto-remove the transfer sits in the list forever. The warning is
  // the only place a user is told; repeating it on every grab would bury it.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const warnings = captureWarnings(t);
  const profile = harness.store.listProfiles()[0];
  harness.store.updateProfile(profile.id, { auto_remove_completed: false });

  const first = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(first.status, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /enable auto-remove on the profile for browser grabs/);
  assert.equal(warnings[0].meta.profile, profile.slug);

  const second = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:0123456789abcdef',
  });

  assert.equal(second.status, 200);
  assert.equal(warnings.length, 1, 'the same profile must not warn again');
});

test('a grab into a profile with auto-remove never warns', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const warnings = captureWarnings(t);
  const profile = harness.store.listProfiles()[0];
  harness.store.updateProfile(profile.id, { auto_remove_completed: true });

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.deepEqual(warnings, []);
});

test('grab with a magnet link adds a put.io transfer for the profile', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    sourceUrl: 'https://tracker.example/release/1',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // The extension names the profile in its success notification from this,
  // rather than from what it guessed before sending.
  assert.deepEqual(body.profile, { id: profile.id, name: profile.name });
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(typeof body.transfer.id, 'number');
  assert.equal(harness.putio.added.length, 1);
  assert.equal(harness.putio.added[0].folderId, 42);
});

test('grab accepts a magnet link with an upper-case scheme', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'MAGNET:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(harness.putio.added.length, 1);
  assert.equal(harness.putio.added[0].source, 'magnet:?xt=urn:btih:abcdef1234567890');
});

test('grab with base64 torrent metainfo uploads the torrent file', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64: VALID_TORRENT_BASE64,
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(harness.putio.uploads.length, 1);
  assert.equal(harness.putio.uploads[0].name, 'Example.Release.torrent');
});

test('grab prefers the torrent metainfo when both a magnet and metainfo are sent', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    torrentBase64: VALID_TORRENT_BASE64,
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 200);
  assert.equal(harness.putio.uploads.length, 1);
  assert.equal(harness.putio.added.length, 0);
});

test('grab without the anti-CSRF header returns 403 and adds nothing', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  }, { grabHeader: false });

  assert.equal(status, 403);
  assert.equal(body.error, 'grab requires the X-Putiorr-Grab header');
  assert.equal(harness.putio.added.length, 0);
  assert.equal(harness.putio.uploads.length, 0);
});

test('grab with an unknown profile returns 404', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const { status, body } = await postGrab(harness, {
    profileId: 9999,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 404);
  assert.equal(body.error, 'Profile not found');
});

test('grab with an unusable profileId returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  // Sending a profileId means the caller picked one explicitly, so a value that
  // is not an id is its own mistake — not a cue to start resolving by site.
  const { status, body } = await postGrab(harness, {
    profileId: 'not-an-id',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'profileId must be a positive integer');
});

test('grab for a disabled profile returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const disabled = harness.store.createProfile({
    name: 'Grabs',
    type: 'grab',
    slug: 'grabs',
    putio_folder_name: 'grabs',
    downloadAt: path.join(harness.config.targetDir, 'grabs-root'),
    rpc_path: null,
    enabled: true,
  });
  harness.store.updateProfile(disabled.id, { enabled: false });

  const { status, body } = await postGrab(harness, {
    profileId: disabled.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /is disabled/);
  assert.equal(harness.putio.added.length, 0);
});

test('grab without a magnet or torrent returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, { profileId: profile.id });

  assert.equal(status, 400);
  assert.match(body.error, /magnet link or torrentBase64/);
});

test('grab with a non-magnet string returns 400', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'https://tracker.example/not-a-magnet',
  });

  assert.equal(status, 400);
});

test('grab rejects metainfo that is not a bencoded torrent', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64: Buffer.from('<html>login</html>').toString('base64'),
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'torrentBase64 is not a valid .torrent file');
  assert.equal(harness.putio.uploads.length, 0);
});

test('grab rejects metainfo that is not valid base64', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64: 'not base64 at all!!',
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'torrentBase64 is not a valid .torrent file');
  assert.equal(harness.putio.uploads.length, 0);
});

// Which profile a browser grab lands in is decided here rather than in the
// extension, so these cases are the whole resolution order: explicit pick →
// site match → the catch-all grab profile → refusal.
function createSiteProfile(
  harness,
  slug,
  browserDomains,
  { enabled = true, type = 'grab', catchAll = false } = {},
) {
  return harness.store.createProfile({
    name: slug.toUpperCase(),
    type,
    slug,
    putio_folder_name: slug,
    downloadAt: path.join(harness.config.targetDir, slug),
    // A grab profile holds no RPC path at all — nothing connects to one over
    // Transmission, and the derived /grab/<slug>/rpc that used to satisfy
    // NOT NULL UNIQUE was a live endpoint an *arr could add into. Fixtures that
    // give one a path describe a database no wizard and no seed can produce.
    rpc_path: type === 'grab' ? null : `/${slug}/transmission/rpc`,
    browser_domains: browserDomains,
    browser_catch_all: catchAll,
    enabled,
  });
}

test('a grab without a profileId lands in the profile that claims the page host', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const site = createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.deepEqual(body.profile, { id: site.id, name: site.name });
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(harness.putio.added.length, 1);
  // Naming the profile in the response is not the same as routing to it: the
  // transfer itself has to be owned by the profile that claimed the site.
  assert.equal(harness.store.findDownloadByPutioTransferId(77).profile_id, site.id);
});

test('an empty or null profileId is a caller with no pick, not a bad one', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  // '' and null are how a caller spells "I made no pick" — a hand-written
  // request built from an empty field, or a cleared one. Neither is the user
  // naming a profile, so both resolve by site.
  const site = createSiteProfile(harness, 'browser', ['x.example']);

  for (const profileId of ['', null]) {
    const { status, body } = await postGrab(harness, {
      profileId,
      pageHost: 'x.example',
      magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    });

    assert.equal(status, 200, `profileId ${JSON.stringify(profileId)} must resolve by site`);
    assert.equal(body.profile.id, site.id);
  }
});

test('a wildcard site takes the whole domain, apex included', async (t) => {
  // A plain entry is exact now, so this is the one entry that claims a tracker
  // whole — and it has to cover x.example itself, or the user would need two.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const site = createSiteProfile(harness, 'browser', ['*.x.example']);

  for (const pageHost of ['tracker.x.example', 'x.example', 'a.b.x.example']) {
    const { status, body } = await postGrab(harness, {
      pageHost,
      magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    });
    assert.equal(status, 200, pageHost);
    assert.equal(body.profile.id, site.id, pageHost);
  }
});

test('a plain site claims that host alone, and a subdomain of it goes unclaimed', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'tracker.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /^No Putiorr Grab profile claims tracker\.x\.example/);
});

test('an exact site beats a wildcard on another profile, which keeps the rest', async (t) => {
  // The overlap the wildcard rule is for: one profile takes one host by name,
  // another takes everything else under the domain. Both are legitimate, and
  // precedence rather than a refusal is what makes them so.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const wide = createSiteProfile(harness, 'browser', ['*.x.example']);
  const exact = createSiteProfile(harness, 'downloads', ['dl.x.example']);

  const named = await postGrab(harness, {
    pageHost: 'dl.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(named.status, 200);
  assert.equal(named.body.profile.id, exact.id);

  // Resolution only, on a second harness: the stub put.io accepts one transfer
  // per harness, and what is being asserted here is which profile answers.
  const second = await createHarness();
  t.after(closeHarness(second));
  createSiteProfile(second, 'browser', ['*.x.example']);
  createSiteProfile(second, 'downloads', ['dl.x.example']);

  const rest = await postGrab(second, {
    pageHost: 'other.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(rest.status, 200);
  assert.equal(rest.body.profile.name, wide.name);
});

test('a page host no profile claims goes to the catch-all grab profile', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const catchAll = createSiteProfile(harness, 'everything', [], { catchAll: true });
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.deepEqual(body.profile, { id: catchAll.id, name: catchAll.name });
  // Naming it in the response is not the same as routing to it.
  assert.equal(harness.store.findDownloadByPutioTransferId(77).profile_id, catchAll.id);
});

test('a grab with no page host at all still lands in the catch-all profile', async (t) => {
  // The extension omits pageHost when the page URL will not parse. That is a
  // grab no site could ever have claimed, which is exactly the case the
  // catch-all exists for.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const catchAll = createSiteProfile(harness, 'everything', [], { catchAll: true });

  const { status, body } = await postGrab(harness, {
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.profile.id, catchAll.id);
});

test('the catch-all is a fallback, not a wildcard: a listed site still wins', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  // Created first, so it also wins on id order if anything ever resolved by
  // that: the site match runs before the catch-all is even consulted.
  const catchAll = createSiteProfile(harness, 'everything', [], { catchAll: true });
  const site = createSiteProfile(harness, 'browser', ['*.x.example']);
  assert.ok(catchAll.id < site.id);

  const { status, body } = await postGrab(harness, {
    pageHost: 'tracker.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.profile.id, site.id);
});

test('an explicit pick still wins over the catch-all profile', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const picked = harness.store.listProfiles()[0];
  createSiteProfile(harness, 'everything', [], { catchAll: true });

  const { status, body } = await postGrab(harness, {
    profileId: picked.id,
    pageHost: 'notx.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.profile.id, picked.id);
});

test('a disabled catch-all profile is refused by name rather than skipped', async (t) => {
  // Same rule as a disabled site match: disabling means the profile accepts no
  // new work, not that it released the role. Falling past it would put the
  // transfer in whatever folder the next candidate happened to have.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const off = createSiteProfile(harness, 'everything', [], { catchAll: true, enabled: false });

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /is disabled and accepts no new downloads/);
  assert.match(body.error, new RegExp(off.name));
  assert.equal(harness.putio.added.length, 0);
});

test('the catch-all flag on an *arr profile routes nothing', async (t) => {
  // Only Putiorr Grab profiles serve grabs, so the flag elsewhere claims
  // nothing — and the refusal has to be the one that names the fix, not one
  // that names a preset the user never aimed at.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'sonarr', [], { type: 'sonarr', catchAll: true });

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /^No Putiorr Grab profile claims notx\.example/);
  assert.equal(harness.putio.added.length, 0);
});

test('a grab with nothing to resolve is refused with the fix in the message', async (t) => {
  // This refusal is the only thing between the user and a lost grab, so it
  // names the site that went unclaimed and the exact checkbox that fixes it.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.equal(
    body.error,
    'No Putiorr Grab profile claims notx.example and none is set to take everything else;'
    + ' tick "Take grabs from any site no other profile claims" on a profile in putiorr',
  );
  assert.equal(harness.putio.added.length, 0);

  // With no page host there was no site to claim, so the sentence drops the
  // half it cannot state rather than inventing a hostname.
  const hostless = await postGrab(harness, { magnet: 'magnet:?xt=urn:btih:abcdef1234567890' });
  assert.equal(hostless.status, 400);
  assert.equal(
    hostless.body.error,
    'No Putiorr Grab profile is set to take grabs from a site it does not list;'
    + ' tick "Take grabs from any site no other profile claims" on a profile in putiorr',
  );
  assert.equal(harness.putio.added.length, 0);
});

test('the refused page host cannot grow the message without bound', async (t) => {
  // pageHost is attacker-influenced and unbounded, and this message is
  // rendered in a Chrome notification.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const { status, body } = await postGrab(harness, {
    pageHost: `${'a'.repeat(400)}.example`,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /^No Putiorr Grab profile claims a{253} and none/);
});

test('defaultProfileId is not a field putiorr reads any more', async (t) => {
  // The setting moved onto the profile, so an extension still sending its old
  // cached default must not route a grab by it — silently landing the transfer
  // in a folder putiorr was never asked for.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const stale = harness.store.listProfiles()[0];
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    defaultProfileId: stale.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /^No Putiorr Grab profile claims notx\.example/);
  assert.equal(harness.putio.added.length, 0);
});

test('a grab profile claims the site even when an *arr profile listed it first', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  // Created first, so it wins on id order — the preset is what decides, not
  // which profile happened to list the site earliest.
  const arr = createSiteProfile(harness, 'sonarr', ['x.example'], { type: 'sonarr' });
  const grab = createSiteProfile(harness, 'browser', ['x.example']);
  assert.ok(arr.id < grab.id, 'the *arr profile must be the older one for this to prove anything');

  const { status, body } = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.deepEqual(body.profile, { id: grab.id, name: grab.name });
  assert.equal(harness.store.findDownloadByPutioTransferId(77).profile_id, grab.id);
});

test('an *arr profile that lists the site does not claim a grab on its own', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  // browser_domains on a non-grab profile simply stops being consulted, so the
  // grab has nothing to resolve to rather than landing in an *arr profile.
  createSiteProfile(harness, 'sonarr', ['x.example'], { type: 'sonarr' });

  const { status, body } = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /^No Putiorr Grab profile claims x\.example/);
  assert.equal(harness.putio.added.length, 0);
});

test('an explicit pick of a non-grab profile is refused by naming the preset', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const arr = createSiteProfile(harness, 'sonarr', [], { type: 'sonarr' });

  const { status, body } = await postGrab(harness, {
    profileId: arr.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  // The message has to say which profile and what to change, because the pick
  // came from a right-click menu the user cannot edit.
  assert.match(body.error, /SONARR/);
  assert.match(body.error, /Putiorr Grab/);
  assert.equal(harness.putio.added.length, 0);
});

test('a disabled profile still claims its browser sites, and the grab is refused by name', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  // Disabled means the profile accepts no new work, not that it stopped
  // claiming its sites. Dropping it out of the match instead sent the grab on
  // to the next candidate, so switching a profile off silently moved its
  // sites' downloads into another profile's folder.
  const off = createSiteProfile(harness, 'browser', ['x.example'], { enabled: false });

  const refused = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /is disabled and accepts no new downloads/);
  assert.match(refused.body.error, new RegExp(off.name));
  assert.equal(harness.putio.added.length, 0);

  // A catch-all profile does not rescue it either: the site match already
  // named an owner, and the catch-all is only consulted when nothing does.
  createSiteProfile(harness, 'everything', [], { catchAll: true });
  const stillRefused = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(stillRefused.status, 400);
  assert.match(stillRefused.body.error, /is disabled and accepts no new downloads/);
  assert.equal(harness.putio.added.length, 0);
});

test('an explicit profileId wins over the profile that claims the page host', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const picked = harness.store.listProfiles()[0];
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    profileId: picked.id,
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.profile.id, picked.id);
});

test('an explicit profileId that does not exist is a 404 even when the site matches', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    profileId: 9999,
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 404);
  assert.equal(body.error, 'Profile not found');
  assert.equal(harness.putio.added.length, 0);
});

// The extension asks for the profiles it is allowed to use, so the filter is
// the server's job: the extension never learns the type vocabulary.
async function getProfiles(harness, query = '') {
  const response = await fetch(`${harness.base}/api/profiles${query}`);
  return { status: response.status, body: await response.json() };
}

test('GET /api/profiles?type= returns only profiles of that type', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const seeded = harness.store.listProfiles()[0];
  const arr = createSiteProfile(harness, 'sonarr', [], { type: 'sonarr' });
  const grab = createSiteProfile(harness, 'browser', ['x.example']);

  const grabs = await getProfiles(harness, '?type=grab');
  assert.equal(grabs.status, 200);
  assert.deepEqual(grabs.body.map((profile) => profile.id).sort(), [seeded.id, grab.id].sort());

  // The filter is the type the caller asked for, not a hard-coded grab branch.
  const arrs = await getProfiles(harness, '?type=sonarr');
  assert.deepEqual(arrs.body.map((profile) => profile.id), [arr.id]);
});

test('GET /api/profiles without a type is unchanged, disabled profiles and all', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const seeded = harness.store.listProfiles()[0];
  const arr = createSiteProfile(harness, 'sonarr', [], { type: 'sonarr' });
  const disabled = createSiteProfile(harness, 'browser', ['x.example'], { enabled: false });

  const all = await getProfiles(harness);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.map((profile) => profile.id).sort(), [seeded.id, arr.id, disabled.id].sort());

  // An unset <select> submits '', which is a caller with no filter rather than
  // a caller asking for the profiles whose type is the empty string.
  const empty = await getProfiles(harness, '?type=');
  assert.deepEqual(empty.body.map((profile) => profile.id).sort(), all.body.map((profile) => profile.id).sort());
});

test('GET /api/profiles?type= matches the preset however the caller capitalizes it', async (t) => {
  // Presets are stored lowercase wherever they enter putiorr, so the filter
  // that reads them back has to normalize too: ?type=Grab answering [] would
  // read as a putiorr with no grab profiles at all.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const seeded = harness.store.listProfiles()[0];
  const grab = createSiteProfile(harness, 'browser', ['x.example']);

  const grabs = await getProfiles(harness, '?type=%20Grab%20');

  assert.equal(grabs.status, 200);
  assert.deepEqual(grabs.body.map((profile) => profile.id).sort(), [seeded.id, grab.id].sort());
});

test('GET /api/profiles with an unknown type returns an empty list', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await getProfiles(harness, '?type=nosuchtype');

  assert.equal(status, 200);
  assert.deepEqual(body, []);
});

// The profile API is where a browser site is actually typed in, so its
// normalization is asserted end to end rather than only in the pure module:
// what the form sends is a string, what the store keeps is a domain list.
async function postProfile(harness, payload) {
  const response = await fetch(`${harness.base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Browser',
      slug: 'browser',
      putio_folder_name: 'browser',
      downloadAt: path.join(harness.config.targetDir, 'browser'),
      rpc_path: '/browser/transmission/rpc',
      ...payload,
    }),
  });
  return { status: response.status, body: await response.json() };
}

test('creating a profile normalizes the browser sites the form sends', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, { browserDomains: 'x.example, bücher.example' });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.browser_domains, ['x.example', 'xn--bcher-kva.example']);
  assert.deepEqual(created.body.browserDomains, ['x.example', 'xn--bcher-kva.example']);
  assert.deepEqual(
    harness.store.findProfileById(created.body.id).browser_domains,
    ['x.example', 'xn--bcher-kva.example'],
  );
});

test('a browser site that could never match is refused, naming the entry', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  // A star anywhere but the front. The refusal names the one position that
  // works rather than leaving the user to guess at it.
  const created = await postProfile(harness, { browserDomains: 'dl.*.x.example' });

  assert.equal(created.status, 400);
  assert.match(created.body.error, /dl\.\*\.x\.example/);
  assert.match(created.body.error, /a wildcard is only a leading "\*\."/);
  assert.equal(harness.store.findProfileBySlug('browser'), undefined);
});

test('a wildcard browser site is saved with the star kept, base normalized under it', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, { browserDomains: '*.HTTPS://X.Example:8080/dl, x.example' });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.browser_domains, ['*.x.example', 'x.example']);
  assert.deepEqual(harness.store.findProfileById(created.body.id).browser_domains, ['*.x.example', 'x.example']);
});

test('a profile without browser sites keeps none, and an update replaces them', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, {});
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.browser_domains, []);

  const response = await fetch(`${harness.base}/api/profiles/${created.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserDomains: ['Z.Example', 'z.example'] }),
  });
  const updated = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(updated.browser_domains, ['z.example']);
});

test('several bad browser sites are listed one per line and capped', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  // The profile wizard renders the error with white-space: pre-line, so a
  // joined-by-space run-on is unreadable exactly when there is most to read.
  const two = await postProfile(harness, { browserDomains: 'x.*.example, x..example' });
  assert.equal(two.status, 400);
  assert.equal(two.body.error.split('\n').length, 2);
  assert.match(two.body.error, /x\.\*\.example/);
  assert.match(two.body.error, /x\.\.example/);

  // A grab request body can hold megabytes of entries; the message must not
  // grow with it.
  const many = await postProfile(harness, {
    browserDomains: Array.from({ length: 9 }, (_, index) => `x${index}..example`).join(','),
  });
  assert.equal(many.status, 400);
  assert.equal(many.body.error.split('\n').length, 6);
  assert.match(many.body.error, /\n…and 4 more$/);
});

test('a wildcard broad enough to be a whole suffix is saved with a warning', async (t) => {
  // putiorr carries no public-suffix list, so it cannot tell "*.com" from
  // "*.example". A single-label base is what it can see, and a LAN name looks
  // the same, so this is advice that accompanies the save rather than a refusal.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, { browserDomains: '*.com, x.example' });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.browser_domains, ['*.com', 'x.example']);
  assert.deepEqual(created.body.browser_domain_warnings, [
    '"*.com" matches com and every site ending in ".com"',
  ]);
  // The warning is advice about the input, not part of the profile.
  assert.equal('browser_domain_warnings' in harness.store.findProfileById(created.body.id), false);

  const response = await fetch(`${harness.base}/api/profiles/${created.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserDomains: '*.example' }),
  });
  const updated = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(updated.browser_domain_warnings, [
    '"*.example" matches example and every site ending in ".example"',
  ]);
});

test('a profile whose browser sites are all unambiguous carries no warning key', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  // A plain single label is one of them now: "com" claims the host "com" and
  // nothing else, so the warning the old suffix rule earned would be false.
  const created = await postProfile(harness, { browserDomains: 'x.example, com' });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.browser_domains, ['x.example', 'com']);
  assert.equal('browser_domain_warnings' in created.body, false);
});

test('a duplicate grab profile name is refused by name, not by a hidden column', async (t) => {
  // The colliding column is `slug`, which the wizard derives from the display
  // name and never shows. A raw "UNIQUE constraint failed: profiles.slug" would
  // name a field that is not on the form, so the refusal names the one that is.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, {
    name: 'Movies Grab',
    slug: 'movies-grab',
    type: 'grab',
    rpc_path: null,
  });
  assert.equal(created.status, 201);

  const duplicate = await postProfile(harness, {
    name: 'Movies Grab',
    slug: 'movies-grab',
    type: 'grab',
    rpc_path: null,
  });

  assert.equal(duplicate.status, 400);
  assert.equal(
    duplicate.body.error,
    'A profile named "Movies Grab" already exists; choose a different display name',
  );
  assert.doesNotMatch(duplicate.body.error, /UNIQUE|constraint|rpc_path/);
});

test('a duplicate *arr endpoint names the path the wizard actually shows', async (t) => {
  // An *arr profile derives its path from the preset rather than the name, and
  // the field is on the form, so the path is what the user has to change.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, {
    name: 'Sonarr',
    slug: 'sonarr',
    type: 'sonarr',
    rpc_path: '/sonarr/transmission/rpc',
  });
  assert.equal(created.status, 201);

  const duplicate = await postProfile(harness, {
    name: 'Sonarr Anime',
    slug: 'sonarr-anime',
    type: 'sonarr',
    rpc_path: '/sonarr/transmission/rpc',
  });

  assert.equal(duplicate.status, 400);
  assert.equal(
    duplicate.body.error,
    'RPC endpoint path /sonarr/transmission/rpc is already used by Sonarr; choose a different path',
  );

  // A name collision on an *arr profile is still a name collision: the slug is
  // what repeats, and the display name is what makes it.
  const sameName = await postProfile(harness, {
    name: 'Sonarr',
    slug: 'sonarr',
    type: 'sonarr',
    rpc_path: '/sonarr-2/transmission/rpc',
  });

  assert.equal(sameName.status, 400);
  assert.equal(
    sameName.body.error,
    'A profile named "Sonarr" already exists; choose a different display name',
  );
});

test('renaming a profile onto another profile name is refused the same way', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const first = await postProfile(harness, { name: 'Movies', slug: 'movies', rpc_path: '/movies/rpc' });
  const second = await postProfile(harness, { name: 'Music', slug: 'music', rpc_path: '/music/rpc' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const response = await fetch(`${harness.base}/api/profiles/${second.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Movies', slug: 'movies' }),
  });

  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error,
    'A profile named "Movies" already exists; choose a different display name',
  );
});

test('a grab profile has no endpoint to collide with', async (t) => {
  // Was: "a conflict names the profile that actually holds the value" — it
  // proved that a grab profile's derived /grab/<slug>/rpc colliding with a
  // Custom profile squatting on that path was reported against the squatter,
  // not against the display name the grab wizard shows. Nothing derives that
  // path any more, so what has to be proved is that the collision is gone:
  // profiles.rpc_path is nullable, a grab profile holds none, and the partial
  // unique index only covers the rows that do.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const squatter = await postProfile(harness, {
    name: 'Legacy Endpoint',
    slug: 'legacy-endpoint',
    type: 'custom',
    rpc_path: '/grab/movies-grab/rpc',
  });
  assert.equal(squatter.status, 201);

  const grab = await postProfile(harness, {
    name: 'Movies Grab',
    slug: 'movies-grab',
    type: 'grab',
    rpc_path: null,
  });

  assert.equal(grab.status, 201);
  assert.equal(grab.body.rpc_path, null);

  // A second one is fine too: any number of rows may hold no path.
  const second = await postProfile(harness, {
    name: 'Books Grab',
    slug: 'books-grab',
    type: 'grab',
    rpc_path: null,
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.rpc_path, null);
});

test('the catch-all is a field the profile API actually accepts', async (t) => {
  // normalizeProfileInput copies an allow-list of keys, so a column the store
  // understands is still invisible to every HTTP caller until it is listed
  // there — and the wizard is an HTTP caller.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, {
    name: 'Everything',
    slug: 'everything',
    type: 'grab',
    rpc_path: null,
    browserCatchAll: true,
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.browser_catch_all, true);
  assert.equal(harness.store.findCatchAllGrabProfile()?.id, created.body.id);

  // And it can be cleared: false is an answer, not an omission.
  const response = await fetch(`${harness.base}/api/profiles/${created.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserCatchAll: false }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).browser_catch_all, false);
  assert.equal(harness.store.findCatchAllGrabProfile(), undefined);
});

async function putProfile(harness, id, payload) {
  const response = await fetch(`${harness.base}/api/profiles/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('a refused catch-all names its holder in the body, not only in the sentence', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const holder = createSiteProfile(harness, 'movies', [], { catchAll: true });
  const other = createSiteProfile(harness, 'music', []);

  const refused = await putProfile(harness, other.id, { browserCatchAll: true });

  assert.equal(refused.status, 400);
  // Unchanged for every consumer that only ever showed the sentence.
  assert.equal(
    refused.body.error,
    'MOVIES already takes grabs from any site no other profile claims; untick it on that profile first',
  );
  // And a discriminator the wizard can branch on without reading prose, plus
  // the profile it would have to take the role from.
  assert.equal(refused.body.code, 'catch_all_conflict');
  assert.deepEqual(refused.body.catchAllHolder, { id: holder.id, name: 'MOVIES' });
  assert.equal(harness.store.findCatchAllGrabProfile().id, holder.id);
});

test('re-sending the same save with the takeover flag moves the fallback', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const holder = createSiteProfile(harness, 'movies', [], { catchAll: true });
  const other = createSiteProfile(harness, 'music', []);

  // The same payload the refusal came back from, with the intent added: the
  // wizard's save carries the user's other edits, so nothing typed is lost.
  const saved = await putProfile(harness, other.id, {
    name: 'MUSIC & PODCASTS',
    browserCatchAll: true,
    takeOverCatchAll: true,
    takeOverCatchAllFrom: holder.id,
  });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.browser_catch_all, true);
  assert.equal(saved.body.name, 'MUSIC & PODCASTS');
  // A profile the user may not even have on screen just lost the role, so the
  // reply says which one.
  assert.deepEqual(saved.body.catch_all_taken_from, { id: holder.id, name: 'MOVIES' });
  assert.equal(harness.store.findProfileById(holder.id).browser_catch_all, false);
  assert.equal(harness.store.findCatchAllGrabProfile().id, other.id);
});

test('a new profile can take the fallback over as it is created', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const holder = createSiteProfile(harness, 'movies', [], { catchAll: true });

  const created = await postProfile(harness, {
    name: 'Everything',
    slug: 'everything',
    type: 'grab',
    rpc_path: null,
    browserCatchAll: true,
    takeOverCatchAll: true,
    takeOverCatchAllFrom: holder.id,
  });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.catch_all_taken_from, { id: holder.id, name: 'MOVIES' });
  assert.equal(harness.store.findCatchAllGrabProfile().id, created.body.id);
});

test('a takeover is refused again when a different profile took the fallback meanwhile', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const shown = createSiteProfile(harness, 'movies', [], { catchAll: true });
  const other = createSiteProfile(harness, 'music', []);
  const books = createSiteProfile(harness, 'books', []);
  // Between the refusal and the click, somebody else moved the role.
  harness.store.updateProfile(shown.id, { browser_catch_all: false });
  harness.store.updateProfile(books.id, { browser_catch_all: true });

  const refused = await putProfile(harness, other.id, {
    browserCatchAll: true,
    takeOverCatchAll: true,
    takeOverCatchAllFrom: shown.id,
  });

  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /^BOOKS already takes grabs/);
  assert.equal(refused.body.code, 'catch_all_conflict');
  assert.deepEqual(refused.body.catchAllHolder, { id: books.id, name: 'BOOKS' });
  assert.equal(harness.store.findCatchAllGrabProfile().id, books.id);
  assert.equal(harness.store.findProfileById(other.id).browser_catch_all, false);
});

test('the takeover intent is never stored as a profile field', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, {
    name: 'Everything',
    slug: 'everything',
    type: 'grab',
    rpc_path: null,
    browserCatchAll: true,
    takeOverCatchAll: true,
  });

  assert.equal(created.status, 201);
  // Nothing held it, so nothing was taken from anybody, and the intent leaves
  // no trace on the row it was sent with.
  assert.equal(created.body.catch_all_taken_from, undefined);
  assert.equal(created.body.takeOverCatchAll, undefined);
  const stored = harness.store.findProfileById(created.body.id);
  assert.equal(stored.takeOverCatchAll, undefined);
  assert.equal(stored.browser_catch_all, true);
});

test('a browser site another grab profile already lists is refused through the API', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'movies', ['x.example', '*.z.example']);

  const clash = await postProfile(harness, { type: 'grab', rpc_path: null, browserDomains: 'y.example, x.example' });

  assert.equal(clash.status, 400);
  assert.equal(
    clash.body.error,
    'MOVIES already claims x.example; remove the site there first if it should belong to this profile',
  );
  // A refusal is a refusal, not a partial save.
  assert.equal(harness.store.findProfileBySlug('browser'), undefined);

  // Overlapping coverage is not a conflict: precedence already resolves it.
  const overlapping = await postProfile(harness, {
    type: 'grab',
    rpc_path: null,
    browserDomains: '*.x.example, dl.z.example',
  });
  assert.equal(overlapping.status, 201);
  assert.deepEqual(overlapping.body.browser_domains, ['*.x.example', 'dl.z.example']);

  // The same rule on the update path, and a profile re-saving its own sites is
  // not in conflict with itself.
  const response = await fetch(`${harness.base}/api/profiles/${overlapping.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserDomains: '*.x.example, *.z.example' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /MOVIES already claims \*\.z\.example/);
  assert.deepEqual(
    harness.store.findProfileById(overlapping.body.id).browser_domains,
    ['*.x.example', 'dl.z.example'],
  );
});

test('a second catch-all is refused through the API, naming the profile that holds it', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const first = await postProfile(harness, {
    name: 'Everything', slug: 'everything', type: 'grab', rpc_path: null, browserCatchAll: true,
  });
  assert.equal(first.status, 201);

  const second = await postProfile(harness, {
    name: 'Also Everything', slug: 'also-everything', type: 'grab', rpc_path: null, browserCatchAll: true,
  });

  assert.equal(second.status, 400);
  assert.equal(
    second.body.error,
    'Everything already takes grabs from any site no other profile claims; untick it on that profile first',
  );
  // The refusal is a refusal, not a partial save.
  assert.equal(harness.store.findProfileBySlug('also-everything'), undefined);
});

// The toolbar popup claims one site for one profile. It appends through the
// server rather than reading the list, adding to it and writing it back: two
// popups open in two windows would each write the list they had read, and the
// later save would drop the other's site with no sign that it ever existed.
async function claimSite(harness, profileId, payload, { grabHeader = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (grabHeader) headers['X-Putiorr-Grab'] = '1';
  const response = await fetch(`${harness.base}/api/profiles/${profileId}/browser-sites`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('claiming a site appends it and answers with the whole resulting list', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', ['z.example']);

  const { status, body } = await claimSite(harness, profile.id, { host: 'x.example' });

  assert.equal(status, 200);
  assert.deepEqual(body.profile, { id: profile.id, name: profile.name });
  assert.equal(body.added, 'x.example');
  assert.deepEqual(body.browser_domains, ['z.example', 'x.example']);
  assert.deepEqual(body.browserDomains, ['z.example', 'x.example']);
  assert.deepEqual(harness.store.findProfileById(profile.id).browser_domains, ['z.example', 'x.example']);
});

test('a claimed site routes the very next grab from it', async (t) => {
  // The whole point of the popup: the claim is not a note, it is the routing.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  assert.equal((await claimSite(harness, profile.id, { host: 'x.example' })).status, 200);
  const grab = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(grab.status, 200);
  assert.deepEqual(grab.body.profile, { id: profile.id, name: profile.name });
});

test('a claimed site is normalized the way the profile form normalizes one', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  const { status, body } = await claimSite(harness, profile.id, { host: 'BÜCHER.Example.' });

  assert.equal(status, 200);
  assert.equal(body.added, 'xn--bcher-kva.example');
  assert.deepEqual(body.browser_domains, ['xn--bcher-kva.example']);
});

test('claiming the same site twice adds it once', async (t) => {
  // Two clicks on a popup whose page has not caught up, or the same site
  // claimed from two windows. Neither is an error, and neither may duplicate.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  assert.equal((await claimSite(harness, profile.id, { host: 'x.example' })).body.added, 'x.example');
  const { status, body } = await claimSite(harness, profile.id, { host: 'x.example' });

  assert.equal(status, 200);
  assert.equal(body.added, null);
  assert.deepEqual(body.browser_domains, ['x.example']);
});

test('a site this profile already covers by wildcard is not listed a second time', async (t) => {
  // "dl.x.example" under a profile that already lists "*.x.example" would be a
  // row that changes nothing: the wildcard already routes it there.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', ['*.x.example']);

  const { status, body } = await claimSite(harness, profile.id, { host: 'dl.x.example' });

  assert.equal(status, 200);
  assert.equal(body.added, null);
  assert.deepEqual(body.browser_domains, ['*.x.example']);
});

test('a site another profile claims is refused, naming that profile', async (t) => {
  // Refuse rather than move: the same principle the rest of the grab paths
  // follow. A move is two profiles changing at once, from a popup that shows
  // one of them, and the dashboard is where that edit can be seen whole.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const owner = createSiteProfile(harness, 'movies', ['x.example']);
  const other = createSiteProfile(harness, 'books', []);

  const { status, body } = await claimSite(harness, other.id, { host: 'x.example' });

  assert.equal(status, 409);
  assert.equal(
    body.error,
    'MOVIES already claims x.example; remove the site there first if it should belong to another profile',
  );
  assert.deepEqual(harness.store.findProfileById(other.id).browser_domains, []);
  assert.deepEqual(harness.store.findProfileById(owner.id).browser_domains, ['x.example']);
});

test('a host another profile only covers by wildcard can still be claimed by name', async (t) => {
  // Not a conflict: an exact entry beats a wildcard, so this is the user saying
  // "this one host goes here, the rest of the domain stays where it is". A
  // refusal would refuse the useful case along with the ambiguous one.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const wide = createSiteProfile(harness, 'movies', ['*.x.example']);
  const other = createSiteProfile(harness, 'books', []);

  const { status, body } = await claimSite(harness, other.id, { host: 'dl.x.example' });

  assert.equal(status, 200);
  assert.equal(body.added, 'dl.x.example');
  assert.deepEqual(harness.store.findProfileById(other.id).browser_domains, ['dl.x.example']);
  assert.deepEqual(harness.store.findProfileById(wide.id).browser_domains, ['*.x.example']);

  // And the grab that follows goes to the profile that named the host.
  const grab = await postGrab(harness, {
    pageHost: 'dl.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(grab.status, 200);
  assert.equal(grab.body.profile.id, other.id);
});

test('a wildcard can be claimed, and takes the whole domain from then on', async (t) => {
  // The popup's field is editable so a user can type the entry they mean
  // rather than the host they happen to be on.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  const { status, body } = await claimSite(harness, profile.id, { host: '*.X.Example' });

  assert.equal(status, 200);
  assert.equal(body.added, '*.x.example');
  assert.deepEqual(body.browser_domains, ['*.x.example']);

  const grab = await postGrab(harness, {
    pageHost: 'dl.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(grab.status, 200);
  assert.equal(grab.body.profile.id, profile.id);
});

test('the very same entry on another profile is refused, naming that profile', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'movies', ['*.x.example']);
  const other = createSiteProfile(harness, 'books', []);

  const { status, body } = await claimSite(harness, other.id, { host: '*.x.example' });

  assert.equal(status, 409);
  assert.equal(
    body.error,
    'MOVIES already claims *.x.example; remove the site there first if it should belong to another profile',
  );
  assert.deepEqual(harness.store.findProfileById(other.id).browser_domains, []);
});

test('a disabled profile holds its claim against a new one', async (t) => {
  // It still claims its sites for a grab, so it still claims them here: a
  // second profile listing the same site would change nothing about where the
  // grab goes, and the refusal is what points at the profile to fix.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'movies', ['x.example'], { enabled: false });
  const other = createSiteProfile(harness, 'books', []);

  const { status, body } = await claimSite(harness, other.id, { host: 'x.example' });

  assert.equal(status, 409);
  assert.match(body.error, /^MOVIES already claims x\.example;/);
});

test('a site only the catch-all was taking can still be claimed outright', async (t) => {
  // The catch-all takes what nobody claimed; that is not a claim, and listing
  // the site is exactly how a user takes it off the catch-all.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'everything', [], { catchAll: true });
  const other = createSiteProfile(harness, 'books', []);

  const { status, body } = await claimSite(harness, other.id, { host: 'x.example' });

  assert.equal(status, 200);
  assert.deepEqual(body.browser_domains, ['x.example']);
});

test('claiming a site for a profile that is not a Putiorr Grab profile is refused by name', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const sonarr = createSiteProfile(harness, 'sonarr', [], { type: 'sonarr' });

  const { status, body } = await claimSite(harness, sonarr.id, { host: 'x.example' });

  assert.equal(status, 400);
  assert.equal(body.error, 'SONARR is not a Putiorr Grab profile; set its App preset to Putiorr Grab in putiorr');
  assert.deepEqual(harness.store.findProfileById(sonarr.id).browser_domains, []);
});

test('claiming a site for a profile putiorr does not have is a 404', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const { status, body } = await claimSite(harness, 987654, { host: 'x.example' });

  assert.equal(status, 404);
  assert.equal(body.error, 'Profile not found');
});

test('claiming a site without the anti-CSRF header returns 403 and stores nothing', async (t) => {
  // A browser-facing write reachable from any page the user visits, exactly
  // like /api/grab: without the header a cross-site "simple" request could
  // hand the attacker's own site to a profile and route later grabs to it.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  const { status, body } = await claimSite(harness, profile.id, { host: 'x.example' }, { grabHeader: false });

  assert.equal(status, 403);
  assert.equal(body.error, 'claiming a site requires the X-Putiorr-Grab header');
  assert.deepEqual(harness.store.findProfileById(profile.id).browser_domains, []);
});

test('a host putiorr could never match is refused, naming the entry', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  const badStar = await claimSite(harness, profile.id, { host: 'dl.*.x.example' });
  assert.equal(badStar.status, 400);
  assert.match(badStar.body.error, /dl\.\*\.x\.example/);

  const missing = await claimSite(harness, profile.id, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'host is required');

  const blank = await claimSite(harness, profile.id, { host: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error, 'host is required');

  assert.deepEqual(harness.store.findProfileById(profile.id).browser_domains, []);
});

test('only one site is claimed per request, whatever the caller sends', async (t) => {
  // The popup is about the page in the current tab. A comma-separated list
  // would be the profile form's job, and would make "what will be stored" —
  // which the popup states before the click — a different thing after it.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  const { status, body } = await claimSite(harness, profile.id, { host: 'x.example, z.example' });

  assert.equal(status, 400);
  assert.match(body.error, /one site/);
  assert.deepEqual(harness.store.findProfileById(profile.id).browser_domains, []);
});

test('a claimed site that matches more than the user meant carries the warning along', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = createSiteProfile(harness, 'browser', []);

  const { status, body } = await claimSite(harness, profile.id, { host: '*.lan' });

  assert.equal(status, 200);
  assert.deepEqual(body.browser_domains, ['*.lan']);
  assert.deepEqual(body.browser_domain_warnings, ['"*.lan" matches lan and every site ending in ".lan"']);
  // The warning is advice about what was just sent, not profile data.
  assert.equal('browser_domain_warnings' in harness.store.findProfileById(profile.id), false);
});
