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
// site match → the extension's default → refusal.
function createSiteProfile(harness, slug, browserDomains, { enabled = true, type = 'grab' } = {}) {
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
  // An unset options-page <select> submits '', and a cleared cached pick is
  // null; neither is the user naming a profile, so both resolve by site.
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

test('a page host on a subdomain still matches the site the profile claims', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const site = createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'tracker.x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.equal(body.profile.id, site.id);
});

test('a page host no profile claims falls back to the extension default', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const fallback = harness.store.listProfiles()[0];
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    defaultProfileId: fallback.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 200);
  assert.deepEqual(body.profile, { id: fallback.id, name: fallback.name });
});

test('a grab with nothing to resolve is refused with the fix in the message', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'browser', ['x.example']);

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'No profile matches this site and no default profile is configured');
  assert.equal(harness.putio.added.length, 0);
});

test('a defaultProfileId that is not an id is refused as itself', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  createSiteProfile(harness, 'browser', ['x.example']);

  // "no default profile is configured" would describe a request the caller did
  // not make and hide the typo that caused this one.
  for (const defaultProfileId of ['abc', -1, 1.5]) {
    const { status, body } = await postGrab(harness, {
      pageHost: 'notx.example',
      defaultProfileId,
      magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    });
    assert.equal(status, 400, String(defaultProfileId));
    assert.equal(body.error, 'defaultProfileId must be a positive integer', String(defaultProfileId));
  }

  // 0, '' and null are how a caller spells "I have no default", not a bad id.
  for (const defaultProfileId of [0, '0', '', null]) {
    const { body } = await postGrab(harness, {
      pageHost: 'notx.example',
      defaultProfileId,
      magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    });
    assert.equal(
      body.error,
      'No profile matches this site and no default profile is configured',
      String(defaultProfileId),
    );
  }
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
  assert.equal(body.error, 'No profile matches this site and no default profile is configured');
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

test('a default pointing at a non-grab profile is refused by naming the preset', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const arr = createSiteProfile(harness, 'sonarr', [], { type: 'sonarr' });

  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    defaultProfileId: arr.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 400);
  assert.match(body.error, /SONARR/);
  assert.match(body.error, /Putiorr Grab/);
  assert.equal(harness.putio.added.length, 0);
});

test('a disabled profile still claims its browser sites, and the grab is refused by name', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const fallback = harness.store.listProfiles()[0];
  // Disabled means the profile accepts no new work, not that it stopped
  // claiming its sites. Dropping it out of the match instead sent the grab to
  // the caller's default profile, so switching a profile off silently moved
  // its sites' downloads into another profile's folder.
  const off = createSiteProfile(harness, 'browser', ['x.example'], { enabled: false });

  const refused = await postGrab(harness, {
    pageHost: 'x.example',
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /is disabled and accepts no new downloads/);
  assert.match(refused.body.error, new RegExp(off.name));
  assert.equal(harness.putio.added.length, 0);

  // A configured default does not rescue it either: the site match already
  // named an owner, and the default is only consulted when nothing does.
  const stillRefused = await postGrab(harness, {
    pageHost: 'x.example',
    defaultProfileId: fallback.id,
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

test('a defaultProfileId that no longer exists is a 404, not a silent grab', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  // The extension caches the default profile id; deleting that profile in
  // putiorr has to surface, not quietly route the grab somewhere else.
  const { status, body } = await postGrab(harness, {
    pageHost: 'notx.example',
    defaultProfileId: 9999,
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

  const created = await postProfile(harness, { browserDomains: '*.x.example' });

  assert.equal(created.status, 400);
  assert.match(created.body.error, /\*\.x\.example/);
  assert.equal(harness.store.findProfileBySlug('browser'), undefined);
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
  const two = await postProfile(harness, { browserDomains: '*.x.example, x..example' });
  assert.equal(two.status, 400);
  assert.equal(two.body.error.split('\n').length, 2);
  assert.match(two.body.error, /\*\.x\.example/);
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

test('a browser site that matches more than the user meant is saved with a warning', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, { browserDomains: 'com, x.example' });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.browser_domains, ['com', 'x.example']);
  assert.deepEqual(created.body.browser_domain_warnings, [
    '"com" also matches every site ending in ".com"',
  ]);
  // The warning is advice about the input, not part of the profile.
  assert.equal('browser_domain_warnings' in harness.store.findProfileById(created.body.id), false);

  const response = await fetch(`${harness.base}/api/profiles/${created.body.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ browserDomains: 'example' }),
  });
  const updated = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(updated.browser_domain_warnings, [
    '"example" also matches every site ending in ".example"',
  ]);
});

test('a profile whose browser sites are all unambiguous carries no warning key', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const created = await postProfile(harness, { browserDomains: 'x.example' });

  assert.equal(created.status, 201);
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
