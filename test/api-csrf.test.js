import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';
import { TransmissionRpcServer } from '../src/transmission/server.js';

class FakePutio {
  async listTransfers() {
    return [];
  }

  async ensureFolder() {
    return 42;
  }
}

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-csrf-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_LISTEN_HOST: '127.0.0.1',
    PUTIORR_LISTEN_PORT: '0',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    PUTIORR_PUTIO_APP_ID: '12345',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const service = new TransferService({ config, store, putioFactory: () => new FakePutio() });
  const rpcServer = new TransmissionRpcServer({ config, service });
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  return { config, store, service, rpcServer, base: `http://127.0.0.1:${port}` };
}

function closeHarness(harness) {
  return async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  };
}

// Sec-Fetch-Site is set by the browser, never by the page, so a test only has
// to send the value a browser would have sent for the shape it is standing in
// for. An absent header is the non-browser caller: curl, a shell script, a
// systemd timer.
function request(harness, requestPath, { method = 'POST', site, grabHeader = false, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (site !== undefined) headers['Sec-Fetch-Site'] = site;
  if (grabHeader) headers['X-Putiorr-Grab'] = '1';
  return fetch(`${harness.base}${requestPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('a non-GET /api request with no Sec-Fetch-Site header is allowed', async (t) => {
  // Every user automating putiorr with curl or a script is this request. The
  // header is missing because the caller is not a browser, and only a browser
  // can mount the attack the guard exists for.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('a non-GET /api request from the dashboard itself is allowed', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll', { site: 'same-origin' });

  assert.equal(response.status, 200);
});

test('a non-GET /api request from a direct navigation is allowed', async (t) => {
  // `none` is a user-initiated request with no initiating document, and it is
  // also what some Chrome versions label an extension-initiated fetch.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll', { site: 'none' });

  assert.equal(response.status, 200);
});

test('a non-GET /api request from another site is refused', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll', { site: 'cross-site' });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.match(body.error, /another site started it/i);
  // The refusal says what was refused and why, and nothing about what is
  // behind the endpoint: an attacker page cannot read the reply anyway, and a
  // reply that described the route would be worth reading if it ever could.
  assert.equal(Object.keys(body).length, 1);
});

test('a non-GET /api request from a sibling subdomain is refused', async (t) => {
  // `same-site` is a different origin that happens to share a registrable
  // domain — another app on the same reverse proxy, or a subdomain an
  // attacker got hold of. It is not the dashboard, which is same-origin.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll', { site: 'same-site' });

  assert.equal(response.status, 403);
});

test('the Sec-Fetch-Site value is matched regardless of case', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll', { site: 'Cross-Site' });

  assert.equal(response.status, 403);
});

test('a cross-site non-GET /api request carrying X-Putiorr-Grab is allowed', async (t) => {
  // The browser extension's shape. Its host permissions exempt it from CORS,
  // so it can set the header where an attacker page cannot, and this exemption
  // is what keeps it working if Chrome ever labels its fetches cross-site.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/poll', { site: 'cross-site', grabHeader: true });

  assert.equal(response.status, 200);
});

test('a cross-site GET /api request is unaffected', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/profiles', { method: 'GET', site: 'cross-site' });

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(await response.json()));
});

test('a cross-site request never reaches the Transmission RPC endpoint guard', async (t) => {
  // The *arr apps live on /transmission/rpc and some of them are not browsers
  // at all. The guard sits behind the RPC branch, so no value of the header
  // can change what an *arr sees: this request is answered by the session-id
  // handshake exactly as it was before the guard existed.
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/transmission/rpc', {
    site: 'cross-site',
    body: { method: 'session-get' },
  });

  assert.equal(response.status, 409);
  assert.ok(response.headers.get('x-transmission-session-id'));

  const sessionId = response.headers.get('x-transmission-session-id');
  const accepted = await fetch(`${harness.base}/transmission/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'cross-site',
      'X-Transmission-Session-Id': sessionId,
    },
    body: JSON.stringify({ method: 'session-get' }),
  });

  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).result, 'success');
});

test('a cross-site profile delete changes nothing', async (t) => {
  // The guard is on the route, not on the handler, so the refusal happens
  // before the body is read and before anything is written.
  const harness = await createHarness();
  t.after(closeHarness(harness));
  const profile = harness.store.listProfiles()[0];

  const response = await request(harness, `/api/profiles/${profile.id}`, {
    method: 'DELETE',
    site: 'cross-site',
  });

  assert.equal(response.status, 403);
  assert.ok(harness.store.listProfiles().some((row) => row.id === profile.id));
});

test('a cross-site settings write changes nothing', async (t) => {
  const harness = await createHarness();
  t.after(closeHarness(harness));

  const response = await request(harness, '/api/settings', {
    method: 'PUT',
    site: 'cross-site',
    body: { putioToken: 'stolen' },
  });

  assert.equal(response.status, 403);
  assert.equal(harness.store.getSetting('putio_token'), 'test-token');
});
