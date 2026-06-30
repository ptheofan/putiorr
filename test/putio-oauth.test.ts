import assert from 'node:assert/strict';
import test from 'node:test';
import { PutioOAuthClient } from '../src/putio/oauth.ts';

function createFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status ?? 200,
      statusText: next.statusText,
    });
  };
  return { calls, fetchImpl };
}

test('PutioOAuthClient validates redirect OAuth input and builds auth URL', () => {
  assert.throws(() => new PutioOAuthClient(), /app id/);
  assert.throws(() => new PutioOAuthClient({ appId: 'app', fetchImpl: null }), /fetch implementation/);

  const client = new PutioOAuthClient({
    appId: 'app',
    authorizeUrl: 'https://putio.example.test/auth',
    fetchImpl: async () => new Response('{}'),
  });

  assert.throws(() => client.startRedirect({ state: 'state' }), /redirect URI/);
  assert.throws(() => client.startRedirect({ redirectUri: 'https://example.test/callback' }), /state/);

  const result = client.startRedirect({
    redirectUri: 'https://example.test/callback',
    state: 'state',
  });

  const url = new URL(result.authUrl);
  assert.equal(url.searchParams.get('client_id'), 'app');
  assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/callback');
  assert.equal(url.searchParams.get('state'), 'state');
  assert.equal(result.putioRedirectUri, 'https://example.test/callback');
});

test('PutioOAuthClient starts, polls, and reports API errors', async () => {
  const { calls, fetchImpl } = createFetch([
    { body: { code: 'abc', qrCodeUrl: 'https://qr.example.test' } },
    { body: { status: 'OK', oauth_token: 'token' } },
    { status: 400, body: { error: 'expired' } },
  ]);
  const client = new PutioOAuthClient({
    appId: 'app',
    baseUrl: 'https://putio.example.test/oob///',
    fetchImpl,
  });

  assert.deepEqual(await client.start(), {
    code: 'abc',
    qrCodeUrl: 'https://qr.example.test',
    linkUrl: 'https://put.io/link',
  });
  assert.equal(calls[0], 'https://putio.example.test/oob/code?app_id=app');

  assert.deepEqual(await client.poll('abc'), {
    status: 'OK',
    oauthToken: 'token',
  });
  await assert.rejects(() => client.poll(''), /OAuth code/);
  await assert.rejects(() => client.request(new URL('https://putio.example.test/fail')), /expired/);
});
