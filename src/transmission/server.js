import crypto from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadPolicyFromStore, saveDownloadPolicyToStore } from '../download/policy.js';
import { logger } from '../logger.js';
import { PutioOAuthClient } from '../putio/oauth.js';
import { matchProfileByHost, normalizeBrowserDomains } from '../transfer/browser-domains.js';
import { VersionChecker } from '../version.js';
// The dashboard writes this preset into the profiles this server then routes
// on, so the two must spell it identically; constants.js is plain data with no
// imports of its own, which is why the server can read the same file the
// browser is served. WEB_DIR below already points at that directory.
import { GRAB_PROFILE_TYPE, SHARED_RPC_PATH } from '../web/constants.js';

const SESSION_HEADER = 'X-Transmission-Session-Id';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PUTIO_SWAGGER_APP_ID = '3270';
const OAUTH_APP_ID_SETTING = 'putio_oauth_app_id';
const OAUTH_RELAY_URL_SETTING = 'putio_oauth_relay_url';
const CLIENT_SETTINGS_TEST_TIMEOUT_MS = 5_000;
// Both of the profiles table's UNIQUE columns are derived from what the wizard
// shows, so a collision is reported in terms of the field to change.
const UNIQUE_PROFILE_COLUMN = /UNIQUE constraint failed: profiles\.(\w+)/;
// The shape of the endpoint grab profiles used to derive, kept as a static
// route so an *arr still pointed at it gets a sentence rather than the SPA.
const GRAB_RPC_PATH_PATTERN = /^\/grab\/[^/]+\/rpc$/;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function jsonResponse(res, status, body, sessionId) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(SESSION_HEADER, sessionId);
  res.end(JSON.stringify(body));
}

function htmlResponse(res, status, body, sessionId) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(SESSION_HEADER, sessionId);
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isTorrentMetainfoBase64(value) {
  const data = Buffer.from(value, 'base64');
  // Buffer.from ignores invalid base64 characters, so round-trip to reject anything that is not
  // base64, then require a bencoded dictionary so login pages never reach put.io as a torrent.
  if (data.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return false;
  return data.length > 0 && data[0] === 0x64;
}

// A profile the caller named — its explicit pick or its cached default — is
// refused when it is not a Putiorr Grab profile, and the refusal says which
// profile and what to change: the pick comes from a right-click menu the user
// cannot edit. Returns the refusal to send, or undefined when the profile may
// serve grabs.
function refuseNonGrabProfile(profile) {
  if (profile.type === GRAB_PROFILE_TYPE) return undefined;
  return {
    ok: false,
    status: 400,
    error: `${profile.name} is not a Putiorr Grab profile; set its App preset to Putiorr Grab in putiorr`,
  };
}

// SQLite answers a duplicate with the column its index is on, which the wizard
// shows under the form as-is. The *arr presets show the endpoint path, so
// there the path is what has to change; a grab profile holds no path at all,
// so the only thing it can collide on is the slug its display name makes.
// Anything that is not a uniqueness failure is passed through untouched.
export function profileConflictError(error, input = {}, store) {
  const column = UNIQUE_PROFILE_COLUMN.exec(error?.message ?? '')?.[1];
  if (!column) return error;
  // Named after the profile that actually holds the value, never after the one
  // being written: "a profile named X already exists" about the name the user
  // just typed sends them looking for a profile that does not exist. A disabled
  // profile is named here like any other — it still holds its path, which is
  // exactly why the save was refused.
  const owner = column === 'slug'
    ? store?.findProfileBySlug(input.slug)
    : store?.findProfileByRpcPath(input.rpc_path);
  const ownerName = String(owner?.name ?? '').trim();
  // No type check: a grab profile holds no rpc_path at all now, so a
  // uniqueness failure on that column can only come from a profile whose
  // wizard shows the field.
  if (column === 'rpc_path') {
    return new Error(ownerName
      ? `RPC endpoint path ${input.rpc_path} is already used by ${ownerName}; choose a different path`
      : `RPC endpoint path ${input.rpc_path} is already used by another profile; choose a different path`);
  }
  return new Error(ownerName
    ? `A profile named "${ownerName}" already exists; choose a different display name`
    : 'Another profile already uses this display name; choose a different one');
}

function writeProfile(store, input, write) {
  try {
    return write();
  } catch (error) {
    throw profileConflictError(error, input, store);
  }
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requestHeadersForLog(headers) {
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token']);
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, sensitive.has(name) ? '[REDACTED]' : value]),
  );
}

function websocketAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest('base64');
}

function websocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return String(value ?? '').split(',')[0].trim();
}

function normalizeOAuthAppId(value) {
  return String(value ?? '').trim();
}

function normalizeOAuthRelayUrl(value) {
  const relayUrl = String(value ?? '').trim().replace(/\/+$/, '');
  if (!relayUrl) return '';
  const parsed = new URL(relayUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Put.io OAuth relay URL must use http or https');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizePutioOAuthSettingsInput(input) {
  const source = input ?? {};
  const output = {};
  if (source.reset === true) output.reset = true;
  if (source.appId !== undefined) {
    const appId = normalizeOAuthAppId(source.appId);
    if (!appId) throw new Error('Put.io OAuth app id is required');
    output.appId = appId;
  }
  if (source.relayUrl !== undefined) {
    output.relayUrl = normalizeOAuthRelayUrl(source.relayUrl);
  }
  return output;
}

function encodeOAuthState(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function oauthCallbackHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0f766e">
    <title>Put.io connection</title>
    <link rel="icon" href="/favicon.ico?v=portal" sizes="any">
    <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16x16.png?v=portal">
    <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png?v=portal">
    <link rel="icon" type="image/png" sizes="48x48" href="/icons/favicon-48x48.png?v=portal">
    <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png?v=portal">
    <link rel="manifest" href="/manifest.webmanifest?v=portal">
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7f8; color: #172326; }
      main { width: min(460px, calc(100vw - 32px)); border: 1px solid #d9e2e4; border-radius: 8px; background: #fff; padding: 22px; box-shadow: 0 18px 50px rgba(23, 35, 38, 0.08); }
      .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; color: #172326; font-size: 20px; font-weight: 750; }
      .brand img { display: block; width: 34px; height: 34px; }
      h1 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0; color: #647275; line-height: 1.5; }
      .ok { color: #16803f; }
      .error { color: #b42318; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <img src="/icons/putiorr-icon-64.png?v=portal" alt="">
        <span>putiorr</span>
      </div>
      <h1>Put.io connection</h1>
      <p id="message">Completing authorization...</p>
    </main>
    <script>
      (async () => {
        const message = document.querySelector('#message');
        const query = new URLSearchParams(window.location.search.slice(1));
        const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const params = fragment.toString() ? fragment : query;
        window.history.replaceState(null, document.title, window.location.pathname);
        const error = params.get('error_description') || params.get('error');
        if (error) throw new Error(error);
        const oauthToken = params.get('access_token') || params.get('oauth_token') || params.get('token');
        const state = params.get('state');
        if (!oauthToken) throw new Error('put.io did not return an OAuth token.');
        const response = await fetch('/api/oauth/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oauthToken, state }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not save the put.io token.');
        message.className = 'ok';
        message.textContent = window.opener
          ? 'Put.io connected. You can close this window.'
          : 'Put.io connected. Returning to putiorr...';
        window.sessionStorage.setItem('putiorr:oauth-result', JSON.stringify({
          status: 'connected',
        }));
        if (window.opener) {
          window.opener.postMessage({ type: 'putiorr:putio-oauth-complete' }, window.location.origin);
          window.setTimeout(() => window.close(), 1200);
        } else {
          window.setTimeout(() => window.location.replace('/?putioOAuth=connected'), 1200);
        }
      })().catch((error) => {
        const message = document.querySelector('#message');
        message.className = 'error';
        message.textContent = error.message;
        window.sessionStorage.setItem('putiorr:oauth-result', JSON.stringify({
          status: 'error',
          message: error.message,
        }));
        window.setTimeout(() => window.location.replace('/?putioOAuth=error'), 1800);
      });
    </script>
  </body>
</html>`;
}

export class TransmissionRpcServer {
  constructor({ config, service, downloadManager, fetch: fetchImpl } = {}) {
    this.config = config;
    this.service = service;
    this.downloadManager = downloadManager;
    this.oauth = new PutioOAuthClient({ appId: config.putioAppId });
    this.versionChecker = new VersionChecker({ fetch: fetchImpl });
    this.oauthStates = new Map();
    this.sessionId = crypto.randomBytes(24).toString('hex');
    this.liveReloadClients = new Set();
    this.liveReloadWatcher = undefined;
    this.liveReloadTimer = undefined;
    this.liveReloadVersion = String(Date.now());
    this.webSocketClients = new Set();
    this.webSocketDownloadsBroadcastTimer = undefined;
    this.webSocketRefreshTimer = undefined;
    this.grabAutoRemoveWarned = new Set();
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        logger.error('unhandled rpc error', { error: error.message, stack: error.stack });
        jsonResponse(res, 500, { result: error.message || 'error', message: error.message }, this.sessionId);
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.listenPort, this.config.listenHost, () => {
        this.server.off('error', reject);
        this.startLiveReload();
        this.startWebSocketBroadcasts();
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.stopLiveReload();
      this.stopWebSockets();
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  cleanupOAuthStates() {
    const now = Date.now();
    for (const [state, record] of this.oauthStates.entries()) {
      if (record.expiresAt <= now) this.oauthStates.delete(state);
    }
  }

  oauthSettings() {
    const storedAppId = this.service.store.getSetting(OAUTH_APP_ID_SETTING);
    const storedRelayUrl = this.service.store.getSetting(OAUTH_RELAY_URL_SETTING);
    const appId = storedAppId !== undefined
      ? normalizeOAuthAppId(storedAppId)
      : this.config.putioAppId;
    const relayUrl = storedRelayUrl !== undefined
      ? normalizeOAuthRelayUrl(storedRelayUrl)
      : this.config.putioOAuthRelayUrl;
    return {
      appId,
      relayUrl,
      defaultAppId: this.config.putioAppId,
      defaultRelayUrl: this.config.putioOAuthRelayUrl,
      appIdOverridden: storedAppId !== undefined,
      relayUrlOverridden: storedRelayUrl !== undefined,
    };
  }

  oauthClient(appId = this.oauthSettings().appId) {
    if (!this.oauth?.appId || this.oauth.appId === appId) return this.oauth;
    return new PutioOAuthClient({ appId });
  }

  createOAuthState({ callbackUrl, relayUrl } = {}) {
    this.cleanupOAuthStates();
    const nonce = crypto.randomBytes(24).toString('hex');
    const state = relayUrl
      ? encodeOAuthState({
          v: 1,
          nonce,
          callbackUrl,
        })
      : nonce;
    this.oauthStates.set(state, { expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    return state;
  }

  consumeOAuthState(state) {
    this.cleanupOAuthStates();
    const normalizedState = String(state ?? '').trim();
    if (!normalizedState) return false;
    if (!this.oauthStates.has(normalizedState)) return false;
    this.oauthStates.delete(normalizedState);
    return true;
  }

  publicBaseUrl(req) {
    if (this.config.publicUrl) return this.config.publicUrl;
    const protocol = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
    const host = firstHeaderValue(req.headers['x-forwarded-host'])
      || firstHeaderValue(req.headers.host)
      || `127.0.0.1:${this.config.listenPort}`;
    return `${protocol}://${host}`.replace(/\/+$/, '');
  }

  oauthRedirectUri(req) {
    return new URL('/api/oauth/callback', this.publicBaseUrl(req)).toString();
  }

  putioAuthorizeRedirectUri() {
    return this.oauthSettings().relayUrl || undefined;
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const requestPath = url.pathname;

    if (!this.isAuthorized(req)) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Basic realm="putiorr"');
      res.end('Unauthorized');
      return;
    }

    if (requestPath === '/__putiorr/livereload') {
      this.handleLiveReload(req, res);
      return;
    }

    // Only a profile an *arr download client can reach makes the shared
    // endpoint ambiguous. A Putiorr Grab profile is never one: nothing connects
    // to it, which is why the wizard hides its RPC settings. Counting it here
    // used to unbind this endpoint the moment a user added their first grab
    // profile, breaking torrent-remove on a setup that had been working.
    const rpcProfiles = this.service.listArrProfiles();
    const pathProfile = this.service.store.findProfileByRpcPath(requestPath);
    // A Putiorr Grab profile used to hold a derived /grab/<slug>/rpc only
    // because profiles.rpc_path was NOT NULL UNIQUE, and that accident made it
    // a live Transmission endpoint an *arr could add into. Phase 3 removed the
    // path, which would leave the endpoint falling through to serveWeb — and
    // serveWeb answers any unknown path with index.html and HTTP 200, so an
    // *arr still pointed at it would read "success" and garbage. The guard is
    // therefore static, on the shape of the path, rather than on a profile
    // lookup that can no longer match anything.
    if (GRAB_RPC_PATH_PATTERN.test(requestPath)) {
      this.refuseGrabRpcPath(req, res);
      return;
    }
    const rpcProfile = requestPath === SHARED_RPC_PATH
      ? (rpcProfiles.length === 1 ? rpcProfiles[0] : undefined)
      : pathProfile;
    if (rpcProfile || requestPath === SHARED_RPC_PATH) {
      await this.handleRpc(req, res, rpcProfile);
      return;
    }

    if (requestPath.startsWith('/api/')) {
      await this.handleApi(req, res, requestPath, url.searchParams);
      return;
    }

    await this.serveWeb(req, res, requestPath);
  }

  // Transmission reports failures as a human-readable string in `result` with
  // HTTP 200, and *arr apps surface that string, so the refusal arrives where
  // the user is looking instead of as an opaque transport error.
  refuseGrabRpcPath(req, res) {
    logger.warn('refused Transmission RPC on a retired Putiorr Grab endpoint', {
      requestPath: new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname,
      requestMethod: req.method,
    });
    jsonResponse(res, 200, {
      result: 'This endpoint belonged to a Putiorr Grab profile and no longer accepts Transmission RPC;'
        + ' browser grabs reach a grab profile through the browser extension',
    }, this.sessionId);
  }

  async handleRpc(req, res, profile) {
    const clientSessionId = req.headers['x-transmission-session-id'];
    if (clientSessionId !== this.sessionId) {
      res.statusCode = 409;
      res.setHeader(SESSION_HEADER, this.sessionId);
      res.end('409 Conflict');
      return;
    }

    // The request path is the only thing that names a profile here. The
    // client's User-Agent used to select one when the path did not — and to
    // veto the one the category picked — which made a header any client on the
    // LAN can set the boundary between one profile's downloads and another's.
    // RPC auth is off by default, so that header was the whole barrier.
    //
    // Whether the profile is switched on is not asked here. It used to be, and
    // it refused every method — so an *arr pointed at a profile the user had
    // just disabled could not list, import or clean up the downloads already in
    // its queue, and re-grabbed all of them on its next RSS cycle. Disabled
    // means "accepts no new work", so torrent-add is the method that asks.
    const currentProfile = profile;

    let rpcRequest;
    if (req.method === 'GET') {
      rpcRequest = { method: 'session-get', arguments: {} };
    } else if (req.method === 'POST') {
      rpcRequest = await readJsonBody(req);
    } else {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    let result;
    try {
      result = await this.dispatch(
        rpcRequest.method,
        rpcRequest.arguments ?? {},
        currentProfile,
      );
    } catch (error) {
      // Transmission RPC reports failures in the `result` field as a
      // human-readable string (with HTTP 200). Transmission clients such as
      // Sonarr/Radarr/Prowlarr surface `result`, so carrying the real message
      // here makes the actual reason visible instead of a generic "error".
      const requestUrl = req.url ?? '/';
      const requestPath = new URL(requestUrl, `http://${req.headers.host ?? '127.0.0.1'}`).pathname;
      logger.error('rpc request failed', {
        method: rpcRequest.method,
        requestMethod: req.method,
        requestUrl,
        requestPath,
        requestHeaders: requestHeadersForLog(req.headers),
        requestPayload: rpcRequest,
        matchedProfile: currentProfile
          ? {
              id: currentProfile.id,
              name: currentProfile.name,
              slug: currentProfile.slug,
              rpcPath: currentProfile.rpc_path,
            }
          : null,
        // Every profile, switched on or off, with which it is. A disabled
        // profile is one of the likelier reasons a request is being logged
        // here at all, and the old enabled-only list left it out of the very
        // record someone reads to find out why.
        profiles: this.service.store.listProfiles({ includeDisabled: true }).map((listed) => ({
          id: listed.id,
          name: listed.name,
          slug: listed.slug,
          rpcPath: listed.rpc_path,
          enabled: listed.enabled,
        })),
        error: error.message,
      });
      jsonResponse(res, 200, {
        ...(rpcRequest.tag !== undefined ? { tag: rpcRequest.tag } : {}),
        result: error.message || 'error',
      }, this.sessionId);
      return;
    }

    const body = {
      ...(rpcRequest.tag !== undefined ? { tag: rpcRequest.tag } : {}),
      result: 'success',
      arguments: result,
    };
    jsonResponse(res, 200, body, this.sessionId);
    if (['torrent-add', 'torrent-remove'].includes(rpcRequest.method)) {
      this.scheduleWebSocketDownloadsBroadcast(`rpc:${rpcRequest.method}`);
    }
  }

  // The query string is passed alongside the path rather than replacing it:
  // every branch below matches on the path, and so does the failure log.
  async handleApi(req, res, requestPath, searchParams = new URLSearchParams()) {
    try {
      const method = req.method ?? 'GET';

      if (method === 'GET' && requestPath === '/api/settings') {
        jsonResponse(res, 200, this.settingsResponse(req), this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/version') {
        res.setHeader('Cache-Control', 'no-store');
        jsonResponse(res, 200, await this.versionChecker.check(), this.sessionId);
        return;
      }

      if (method === 'PUT' && requestPath === '/api/settings') {
        const body = await readJsonBody(req);
        if (body.putioToken !== undefined) {
          const token = String(body.putioToken ?? '').trim();
          if (token) this.service.store.setSetting('putio_token', token);
          else this.service.store.deleteSetting('putio_token');
          this.service.putioClient = undefined;
          this.service.putioToken = undefined;
        }
        if (body.putioOAuth !== undefined) {
          const oauthSettings = normalizePutioOAuthSettingsInput(body.putioOAuth);
          if (oauthSettings.reset) {
            this.service.store.deleteSetting(OAUTH_APP_ID_SETTING);
            this.service.store.deleteSetting(OAUTH_RELAY_URL_SETTING);
          } else {
            if (oauthSettings.appId !== undefined) {
              this.service.store.setSetting(OAUTH_APP_ID_SETTING, oauthSettings.appId);
            }
            if (oauthSettings.relayUrl !== undefined) {
              this.service.store.setSetting(OAUTH_RELAY_URL_SETTING, oauthSettings.relayUrl);
            }
          }
        }
        if (body.downloadPolicy !== undefined) {
          saveDownloadPolicyToStore(this.service.store, body.downloadPolicy, this.config);
        }
        jsonResponse(res, 200, this.settingsResponse(req), this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/putio/test') {
        const body = await readJsonBody(req);
        const token = String(body.putioToken || this.service.getPutioToken() || '').trim();
        if (!token) throw new Error('Put.io token is required');
        const account = await this.service.putioFactory(token).getAccountInfo();
        jsonResponse(res, 200, {
          ok: true,
          username: account.username ?? account.user_name ?? account.name ?? '',
          disk: account.disk ?? {},
        }, this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/oauth/callback') {
        htmlResponse(res, 200, oauthCallbackHtml(), this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/oauth/start') {
        const oauthSettings = this.oauthSettings();
        const redirectUri = this.oauthRedirectUri(req);
        const putioRedirectUri = oauthSettings.relayUrl || redirectUri;
        if (oauthSettings.appId === PUTIO_SWAGGER_APP_ID) {
          throw new Error(
            `Put.io OAuth redirect requires your own put.io OAuth app. `
            + `The default app id ${PUTIO_SWAGGER_APP_ID} is put.io's Swagger test API and will reject `
            + `${putioRedirectUri}. Create a put.io app, add that callback URL, then change the App Id under Advanced or set PUTIORR_PUTIO_APP_ID.`,
          );
        }
        const state = this.createOAuthState({ callbackUrl: redirectUri, relayUrl: oauthSettings.relayUrl });
        const result = this.oauthClient(oauthSettings.appId).startRedirect({ redirectUri: putioRedirectUri, state });
        jsonResponse(res, 200, {
          mode: 'redirect',
          ...result,
          redirectUri,
          putioRedirectUri,
        }, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/oauth/complete') {
        const body = await readJsonBody(req);
        const token = String(body.oauthToken ?? '').trim();
        if (!token) throw new Error('Put.io OAuth token is required');
        if (!this.consumeOAuthState(body.state)) throw new Error('Put.io OAuth state is invalid or expired');
        this.service.store.setSetting('putio_token', token);
        this.service.putioClient = undefined;
        this.service.putioToken = undefined;
        const result = this.settingsResponse(req);
        jsonResponse(res, 200, result, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/oauth/poll') {
        const body = await readJsonBody(req);
        const result = await this.oauthClient().poll(String(body.code ?? '').trim());
        if (result.status === 'OK' && result.oauthToken) {
          this.service.store.setSetting('putio_token', result.oauthToken);
          this.service.putioClient = undefined;
          this.service.putioToken = undefined;
        }
        jsonResponse(res, 200, {
          status: result.status,
          tokenConfigured: Boolean(result.oauthToken || this.service.getPutioToken()),
        }, this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/profiles') {
        // The browser extension asks for `?type=grab` so it never has to know
        // the preset vocabulary. An absent or empty value is a caller with no
        // filter, not one asking for profiles whose type is the empty string.
        // Presets are stored lowercase wherever they enter putiorr, so the
        // filter that reads them back normalizes the same way.
        const type = (searchParams.get('type') ?? '').trim().toLowerCase();
        const profiles = this.service.store.listProfiles({ includeDisabled: true });
        jsonResponse(
          res,
          200,
          type ? profiles.filter((profile) => profile.type === type) : profiles,
          this.sessionId,
        );
        return;
      }

      if (method === 'POST' && requestPath === '/api/profiles/test-client-settings') {
        jsonResponse(res, 200, await this.testClientSettings(await readJsonBody(req)), this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/download-profiles') {
        jsonResponse(res, 200, this.service.store.listDownloadProfiles(), this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/download-profiles') {
        const downloadProfile = this.service.store.createDownloadProfile(
          normalizeDownloadProfileInput(await readJsonBody(req)),
        );
        jsonResponse(res, 201, downloadProfile, this.sessionId);
        return;
      }

      const downloadProfileMatch = requestPath.match(/^\/api\/download-profiles\/(\d+)$/);
      if (downloadProfileMatch && method === 'PUT') {
        const id = Number(downloadProfileMatch[1]);
        const existingDownloadProfile = this.service.store.findDownloadProfileById(id);
        if (!existingDownloadProfile) throw new Error('Download profile not found');
        const patch = normalizeDownloadProfileInput(await readJsonBody(req), { partial: true });
        if (existingDownloadProfile.slug === 'default') patch.slug = 'default';
        const downloadProfile = this.service.store.updateDownloadProfile(
          id,
          patch,
        );
        jsonResponse(res, 200, downloadProfile, this.sessionId);
        return;
      }

      if (downloadProfileMatch && method === 'DELETE') {
        const id = Number(downloadProfileMatch[1]);
        const downloadProfile = this.service.store.findDownloadProfileById(id);
        if (!downloadProfile) throw new Error('Download profile not found');
        const defaultDownloadProfile = this.service.store.findDefaultDownloadProfile();
        if (defaultDownloadProfile?.id === id || downloadProfile.slug === 'default') {
          throw new Error('Default download profile cannot be deleted');
        }
        // ON DELETE RESTRICT: the RR profiles that use it have to be moved
        // first, in the same transaction. Deleting and reassigning afterwards
        // now throws FOREIGN KEY constraint failed for every download profile
        // anything actually uses.
        this.service.store.deleteDownloadProfile(id, { reassignTo: defaultDownloadProfile?.id });
        jsonResponse(res, 200, { ok: true }, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/profiles') {
        const input = normalizeProfileInput(await readJsonBody(req));
        const profile = writeProfile(this.service.store, input, () => this.service.store.createProfile(input));
        jsonResponse(res, 201, profileResponse(profile, input), this.sessionId);
        return;
      }

      const profileMatch = requestPath.match(/^\/api\/profiles\/(\d+)$/);
      if (profileMatch && method === 'PUT') {
        const input = normalizeProfileInput(await readJsonBody(req), { partial: true });
        const profile = writeProfile(
          this.service.store,
          input,
          () => this.service.store.updateProfile(Number(profileMatch[1]), input),
        );
        if (!profile) throw new Error('Profile not found');
        jsonResponse(res, 200, profileResponse(profile, input), this.sessionId);
        return;
      }

      // What the confirmation states before anything irreversible is offered.
      // Read fresh rather than counted off the dashboard's list: tombstoned
      // downloads are not in it, and they still hold put.io transfers, still
      // hold files, and still block the delete.
      const profilePreviewMatch = requestPath.match(/^\/api\/profiles\/(\d+)\/deletion-preview$/);
      if (profilePreviewMatch && method === 'GET') {
        jsonResponse(res, 200, this.service.profileDeletionPreview(Number(profilePreviewMatch[1])), this.sessionId);
        return;
      }

      if (profileMatch && method === 'DELETE') {
        const body = await readJsonBody(req);
        // Neither delete flag defaults to true (design decision 5), and the
        // third answer — move these downloads to another profile — is a
        // different outcome for the same rows, so it is sent on its own.
        const result = await this.service.deleteProfileWithDownloads(Number(profileMatch[1]), {
          reassignTo: normalizeOptionalId(body.reassignTo ?? body.reassign_to),
          deleteDownloads: body.deleteDownloads === true,
          deleteRemote: body.deleteRemote === true,
          deleteLocal: body.deleteLocal === true,
        });
        this.scheduleWebSocketDownloadsBroadcast('profiles:delete');
        jsonResponse(res, 200, result, this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/downloads') {
        jsonResponse(res, 200, this.downloadsResponse(), this.sessionId);
        return;
      }

      // Quarantined legacy rows, kept out of the working list on purpose: the
      // dashboard renders them as a needs-attention section, not interleaved
      // with downloads that are actually running.
      const orphanAssignMatch = requestPath.match(/^\/api\/downloads\/orphaned\/(\d+)\/assign$/);
      if (orphanAssignMatch && method === 'POST') {
        const body = await readJsonBody(req);
        const result = this.service.assignOrphanedDownload(
          Number(orphanAssignMatch[1]),
          normalizeOptionalId(body.profileId ?? body.profile_id),
        );
        this.scheduleWebSocketDownloadsBroadcast('downloads:orphan-assign');
        jsonResponse(res, 200, { ...result, ...this.downloadsResponse() }, this.sessionId);
        return;
      }

      const orphanDeleteMatch = requestPath.match(/^\/api\/downloads\/orphaned\/(\d+)$/);
      if (orphanDeleteMatch && method === 'DELETE') {
        const body = await readJsonBody(req);
        const result = await this.service.deleteOrphanedDownload(Number(orphanDeleteMatch[1]), {
          deleteRemote: body.deleteRemote === true,
          deleteLocal: body.deleteLocal === true,
        });
        this.scheduleWebSocketDownloadsBroadcast('downloads:orphan-delete');
        jsonResponse(res, 200, { ...result, ...this.downloadsResponse() }, this.sessionId);
        return;
      }

      const downloadStartMatch = requestPath.match(/^\/api\/downloads\/(\d+)\/start$/);
      if (downloadStartMatch && method === 'POST') {
        if (!this.downloadManager) throw new Error('Download manager is not available');
        const result = await this.downloadManager.startTransferDownload(Number(downloadStartMatch[1]));
        this.scheduleWebSocketDownloadsBroadcast('downloads:start');
        jsonResponse(res, 200, {
          ...result,
          ...this.downloadsResponse(),
        }, this.sessionId);
        return;
      }

      const downloadDeleteMatch = requestPath.match(/^\/api\/downloads\/(\d+)\/delete$/);
      if (downloadDeleteMatch && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.service.deleteDownloadBucket(Number(downloadDeleteMatch[1]), {
          deleteRemote: body.deleteRemote !== false,
          deleteLocal: body.deleteLocal === true,
        });
        this.scheduleWebSocketDownloadsBroadcast('downloads:delete-bucket');
        jsonResponse(res, 200, result, this.sessionId);
        return;
      }

      const downloadFilesDeleteMatch = requestPath.match(/^\/api\/downloads\/(\d+)\/files\/delete$/);
      if (downloadFilesDeleteMatch && method === 'POST') {
        const body = await readJsonBody(req);
        const result = await this.service.deleteDownloadFiles(Number(downloadFilesDeleteMatch[1]), body.fileIds, {
          deleteRemote: body.deleteRemote !== false,
          deleteLocal: body.deleteLocal === true,
        });
        this.scheduleWebSocketDownloadsBroadcast('downloads:delete-files');
        jsonResponse(res, 200, result, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/poll') {
        await this.service.refreshRemoteTransfers();
        this.scheduleWebSocketDownloadsBroadcast('downloads');
        jsonResponse(res, 200, { ok: true }, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/grab') {
        await this.handleGrab(req, res);
        return;
      }

      jsonResponse(res, 404, { error: 'Not Found' }, this.sessionId);
    } catch (error) {
      logger.warn('api request failed', { path: requestPath, error: error.message });
      jsonResponse(res, 400, { error: error.message }, this.sessionId);
    }
  }

  settingsResponse(req) {
    const defaultDownloadProfile = this.service.store.findDefaultDownloadProfile();
    const oauthSettings = this.oauthSettings();
    const redirectUri = req
      ? this.oauthRedirectUri(req)
      : new URL(
          '/api/oauth/callback',
          this.config.publicUrl || `http://127.0.0.1:${this.config.listenPort}`,
        ).toString();
    const putioRedirectUri = oauthSettings.relayUrl || redirectUri;
    return {
      tokenConfigured: Boolean(this.service.getPutioToken()),
      putioOAuth: {
        appId: oauthSettings.appId,
        defaultAppId: oauthSettings.defaultAppId,
        appIdOverridden: oauthSettings.appIdOverridden,
        redirectUri,
        putioRedirectUri,
        relayUrl: oauthSettings.relayUrl,
        defaultRelayUrl: oauthSettings.defaultRelayUrl,
        relayUrlOverridden: oauthSettings.relayUrlOverridden,
        overridesConfigured: oauthSettings.appIdOverridden || oauthSettings.relayUrlOverridden,
        mode: oauthSettings.relayUrl ? 'hosted-relay' : 'self-hosted',
        requiresCustomApp: oauthSettings.appId === PUTIO_SWAGGER_APP_ID,
      },
      defaultDownloadProfileId: defaultDownloadProfile?.id,
      downloadPolicy: downloadPolicyFromStore(this.service.store, this.config),
      // What the last schema upgrade migrated and quarantined. The dashboard
      // renders the quarantine itself; this is the record of the run.
      schemaMigrations: this.service.store.schemaMigrationReports(),
      // put.io transfers the last poll could not attribute to one RR profile.
      // The dashboard renders it; without it, a shared put.io folder means
      // nothing is ever adopted and nothing ever says so.
      adoptionNotices: this.service.store.adoptionNotices(),
      // Staging folders two downloads resolve to. Only the older one is
      // downloaded, so the other is waiting on a decision nobody has been
      // asked for yet.
      stagingCollisions: this.service.store.stagingCollisions(),
    };
  }

  async serveWeb(_req, res, requestPath) {
    const fileName = requestPath === '/' ? 'index.html' : requestPath.slice(1);
    if (fileName.includes('..')) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const filePath = path.join(WEB_DIR, fileName);
    try {
      let body = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream');
      if (path.extname(filePath) === '.html') body = this.injectLiveReload(body);
      res.end(body);
    } catch (error) {
      if (error.code === 'ENOENT') {
        const body = this.injectLiveReload(await readFile(path.join(WEB_DIR, 'index.html')));
        res.statusCode = 200;
        res.setHeader('Content-Type', CONTENT_TYPES['.html']);
        res.end(body);
        return;
      }
      throw error;
    }
  }

  injectLiveReload(body) {
    if (!this.config.liveReload) return body;
    const html = body.toString('utf8');
    const script = `
    <script type="module">
      const source = new EventSource('/__putiorr/livereload');
      const versionKey = 'putiorrLiveReloadVersion';
      source.addEventListener('ready', (event) => {
        const previous = sessionStorage.getItem(versionKey);
        sessionStorage.setItem(versionKey, event.data);
        if (previous && previous !== event.data) location.reload();
      });
      source.addEventListener('reload', () => location.reload());
    </script>`;
    return Buffer.from(html.replace('</body>', `${script}\n  </body>`));
  }

  handleLiveReload(req, res) {
    if (!this.config.liveReload) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`event: ready\ndata: ${this.liveReloadVersion}\n\n`);
    this.liveReloadClients.add(res);

    req.on('close', () => {
      this.liveReloadClients.delete(res);
    });
  }

  startLiveReload() {
    if (!this.config.liveReload || this.liveReloadWatcher) return;
    this.liveReloadWatcher = watch(WEB_DIR, { persistent: false }, (_eventType, fileName) => {
      if (!fileName) return;
      this.queueLiveReload(fileName);
    });
    this.liveReloadWatcher.on('error', (error) => {
      logger.warn('live reload watcher failed', { error: error.message });
    });
  }

  queueLiveReload(fileName) {
    if (this.liveReloadTimer) clearTimeout(this.liveReloadTimer);
    this.liveReloadTimer = setTimeout(() => {
      const payload = JSON.stringify({ fileName: String(fileName), at: Date.now() });
      for (const client of this.liveReloadClients) {
        client.write(`event: reload\ndata: ${payload}\n\n`);
      }
    }, 150);
  }

  stopLiveReload() {
    if (this.liveReloadTimer) clearTimeout(this.liveReloadTimer);
    this.liveReloadTimer = undefined;
    this.liveReloadWatcher?.close();
    this.liveReloadWatcher = undefined;
    for (const client of this.liveReloadClients) {
      client.end();
    }
    this.liveReloadClients.clear();
  }

  handleUpgrade(req, socket, _head) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/api/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="putiorr"\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      '\r\n',
    ].join('\r\n'));
    socket.setNoDelay(true);

    const client = {
      socket,
      buffer: Buffer.alloc(0),
    };
    this.webSocketClients.add(client);

    socket.on('data', (chunk) => this.handleWebSocketData(client, chunk));
    socket.on('close', () => this.webSocketClients.delete(client));
    socket.on('error', () => this.webSocketClients.delete(client));

    this.sendWebSocketDownloads(client, 'connect');
  }

  handleWebSocketData(client, chunk) {
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (client.buffer.length >= 2) {
      const first = client.buffer[0];
      const second = client.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (client.buffer.length < offset + 2) return;
        length = client.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (client.buffer.length < offset + 8) return;
        length = Number(client.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      const frameEnd = offset + length;
      if (client.buffer.length < frameEnd) return;

      let payload = client.buffer.subarray(offset, frameEnd);
      if (masked) {
        const mask = client.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      client.buffer = client.buffer.subarray(frameEnd);

      if (opcode === 0x8) {
        this.closeWebSocket(client);
        return;
      }
      if (opcode === 0x9) {
        this.sendWebSocketFrame(client, payload, 0x0a);
        continue;
      }
      if (opcode !== 0x1 || !fin) continue;

      this.handleWebSocketMessage(client, payload.toString('utf8'));
    }
  }

  handleWebSocketMessage(client, rawMessage) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return;
    }

    if (message?.type === 'refresh') {
      this.sendWebSocketDownloads(client, 'refresh');
    }
  }

  startWebSocketBroadcasts() {
    if (this.webSocketRefreshTimer) return;
    this.webSocketRefreshTimer = setInterval(() => {
      if (this.webSocketClients.size > 0) {
        this.broadcastWebSocketDownloads('tick');
      }
    }, 2_000);
  }

  scheduleWebSocketDownloadsBroadcast(reason) {
    if (this.webSocketDownloadsBroadcastTimer) clearTimeout(this.webSocketDownloadsBroadcastTimer);
    this.webSocketDownloadsBroadcastTimer = setTimeout(() => {
      this.broadcastWebSocketDownloads(reason);
    }, 100);
  }

  downloadsResponse() {
    return {
      downloads: this.service.listDownloads(),
      orphaned: this.service.listOrphanedDownloads(),
    };
  }

  webDownloadsState(reason) {
    return {
      type: 'downloads',
      reason,
      sentAt: new Date().toISOString(),
      ...this.downloadsResponse(),
    };
  }

  sendWebSocketDownloads(client, reason) {
    this.sendWebSocketJson(client, this.webDownloadsState(reason));
  }

  broadcastWebSocketDownloads(reason) {
    if (this.webSocketClients.size === 0) return;
    const payload = JSON.stringify(this.webDownloadsState(reason));
    for (const client of this.webSocketClients) {
      this.sendWebSocketFrame(client, payload);
    }
  }

  sendWebSocketJson(client, message) {
    this.sendWebSocketFrame(client, JSON.stringify(message));
  }

  sendWebSocketFrame(client, payload, opcode = 0x1) {
    if (client.socket.destroyed) {
      this.webSocketClients.delete(client);
      return;
    }
    client.socket.write(websocketFrame(payload, opcode), (error) => {
      if (error) this.webSocketClients.delete(client);
    });
  }

  closeWebSocket(client) {
    if (!client.socket.destroyed) {
      client.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
    }
    this.webSocketClients.delete(client);
  }

  stopWebSockets() {
    if (this.webSocketDownloadsBroadcastTimer) clearTimeout(this.webSocketDownloadsBroadcastTimer);
    this.webSocketDownloadsBroadcastTimer = undefined;
    if (this.webSocketRefreshTimer) clearInterval(this.webSocketRefreshTimer);
    this.webSocketRefreshTimer = undefined;
    for (const client of this.webSocketClients) {
      this.closeWebSocket(client);
    }
    this.webSocketClients.clear();
  }

  isAuthorized(req) {
    if (!this.config.rpcUsername && !this.config.rpcPassword) return true;
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    return timingSafeEqualString(username, this.config.rpcUsername)
      && timingSafeEqualString(password, this.config.rpcPassword);
  }

  async dispatch(method, args, profile) {
    logger.debug('rpc dispatch', { method });
    switch (method) {
      case 'session-get':
        // session-get only advertises a directory, so an endpoint that names no
        // profile answers with the server's own target dir rather than guessing
        // a profile from the client. It is deliberately not a hard refusal:
        // *arr apps call session-get to test the connection, and a refusal here
        // reads as "putiorr is down" instead of "address your own RPC path".
        profile = profile ? this.service.requireProfile(profile) : undefined;
        return {
          'download-dir': profile?.download_at ?? this.config.targetDir,
          'rpc-version': 15,
          'rpc-version-minimum': 1,
          version: '2.94',
        };
      case 'torrent-add':
        return this.service.addTorrent(args, profile);
      case 'torrent-get':
        return this.service.getTorrents(args, profile);
      case 'torrent-set':
      case 'queue-move-top':
        return {};
      case 'torrent-remove':
        return this.service.removeTorrents(args, profile);
      default:
        logger.debug('unsupported rpc method', { method });
        return {};
    }
  }

  async handleGrab(req, res) {
    // A custom header cannot be set by a cross-site simple request, so browsers must preflight
    // it; the server never answers preflights, which keeps attacker pages out of this endpoint.
    if (!req.headers['x-putiorr-grab']) {
      jsonResponse(res, 403, { error: 'grab requires the X-Putiorr-Grab header' }, this.sessionId);
      return;
    }
    const body = await readJsonBody(req);
    const pageHost = String(body.pageHost ?? '').trim();
    const resolved = this.resolveGrabProfile(body, pageHost);
    if (!resolved.ok) {
      jsonResponse(res, resolved.status, { error: resolved.error }, this.sessionId);
      return;
    }
    const { profile } = resolved;
    const magnet = String(body.magnet ?? '').trim().replace(/^magnet:/i, 'magnet:');
    const torrentBase64 = String(body.torrentBase64 ?? '').trim();
    if (!torrentBase64 && !magnet.startsWith('magnet:')) {
      jsonResponse(res, 400, { error: 'grab requires a magnet link or torrentBase64 metainfo' }, this.sessionId);
      return;
    }
    if (torrentBase64 && !isTorrentMetainfoBase64(torrentBase64)) {
      jsonResponse(res, 400, { error: 'torrentBase64 is not a valid .torrent file' }, this.sessionId);
      return;
    }
    if (!profile.auto_remove_completed && !this.grabAutoRemoveWarned.has(profile.id)) {
      this.grabAutoRemoveWarned.add(profile.id);
      logger.warn('grab profile keeps completed transfers in the list; enable auto-remove on the profile for browser grabs', {
        profile: profile.slug,
      });
    }
    logger.info('grab from browser', {
      profile: profile.slug,
      sourceType: torrentBase64 ? 'torrent' : 'magnet',
      // The page URL and host are attacker-influenced and unbounded; a log line
      // is not the place to copy an arbitrarily long one.
      sourceUrl: String(body.sourceUrl ?? '').slice(0, 500),
      // Which site a grab came from is what explains which profile it landed in.
      pageHost: pageHost.slice(0, 253),
    });
    const args = torrentBase64
      // The upload name goes to put.io as sent; coercing it here keeps a client
      // that posts a number or an object from naming a transfer with one.
      // addTorrent falls back to "upload.torrent" when the result is empty.
      ? { metainfo: torrentBase64, filename: String(body.filename ?? '').trim() }
      : { filename: magnet };
    const result = await this.service.addTorrent(args, profile);
    this.scheduleWebSocketDownloadsBroadcast('api:grab');
    jsonResponse(res, 200, {
      ok: true,
      // The caller may not have chosen the profile, so it is told which one
      // answered rather than left to repeat its own guess back to the user.
      profile: { id: profile.id, name: profile.name },
      transfer: {
        id: result['torrent-added'].id,
        name: result['torrent-added'].name,
      },
    }, this.sessionId);
  }

  // Resolution order for a browser grab: the caller's explicit pick, then the
  // enabled profile that claims the site the grab came from, then the caller's
  // configured default. Returns `{ ok: true, profile }` or the refusal to send
  // as `{ ok: false, status, error }` — tagged so a resolved profile is never
  // confused with a branch that forgot to answer. Every path ends at a Putiorr
  // Grab profile: no other preset is configured for browser grabs.
  //
  // The refusals follow this file's convention: one that is about a named field
  // opens with that field spelled exactly as the caller sends it, and one that
  // is a plain sentence opens capitalized.
  resolveGrabProfile(body, pageHost) {
    // An unset <select> submits '' and a cleared cached pick is null; neither
    // is the caller naming a profile, so both fall through to site matching.
    const explicitId = body.profileId;
    if (explicitId !== undefined && explicitId !== null && String(explicitId) !== '') {
      // An explicit pick is not silently downgraded to site matching: the
      // caller named a profile, so a value that is not an id is its own error.
      const profileId = Number(explicitId);
      if (!Number.isInteger(profileId) || profileId <= 0) {
        return { ok: false, status: 400, error: 'profileId must be a positive integer' };
      }
      // Disabled is deliberately not filtered here — requireProfile refuses it
      // by name later, which tells the user why their pick did nothing.
      const profile = this.service.store.findProfileById(profileId);
      if (!profile) return { ok: false, status: 404, error: 'Profile not found' };
      return refuseNonGrabProfile(profile) ?? { ok: true, profile };
    }

    // A disabled profile still claims its sites, and addTorrent then refuses
    // the grab by name. Filtering it out here instead sent the grab on to the
    // caller's default profile — a transfer landing in a folder the user never
    // chose, from switching a profile off. Only a Putiorr Grab profile claims a
    // site, so browser_domains left on an *arr profile is not consulted.
    const matched = pageHost
      ? matchProfileByHost(
        this.service.store.listProfiles({ includeDisabled: true })
          .filter((profile) => profile.type === GRAB_PROFILE_TYPE),
        pageHost,
      )
      : undefined;
    if (matched) return { ok: true, profile: matched };

    // 0 is how the extension spells "no default profile", so it counts as an
    // absent one rather than a bad id, as do '' and null.
    const rawDefault = body.defaultProfileId;
    const defaultId = Number(rawDefault);
    const hasDefault = rawDefault !== undefined && rawDefault !== null
      && String(rawDefault).trim() !== '' && defaultId !== 0;
    if (!hasDefault) {
      return {
        ok: false,
        status: 400,
        error: 'No profile matches this site and no default profile is configured',
      };
    }
    // A caller that sent something it believed was an id is told what was wrong
    // with it: answering "no default profile is configured" would describe a
    // request it did not make and hide the typo that caused this one.
    if (!Number.isInteger(defaultId) || defaultId <= 0) {
      return { ok: false, status: 400, error: 'defaultProfileId must be a positive integer' };
    }
    // A stale cached default has to surface; routing the grab elsewhere would
    // put the transfer somewhere the user never chose.
    const fallback = this.service.store.findProfileById(defaultId);
    if (!fallback) return { ok: false, status: 404, error: 'Profile not found' };
    return refuseNonGrabProfile(fallback) ?? { ok: true, profile: fallback };
  }

  async testClientSettings(input) {
    const profile = normalizeProfileInput(input, { partial: true });
    // No download client connects to a grab profile, so its host, port, SSL and
    // endpoint are defaults the wizard never shows. Probing them reports a
    // failure in terms of every field the same wizard just said does not apply
    // — and the folder, which is the one thing a browser grab needs, is the
    // only thing worth checking here.
    if (profile.type === GRAB_PROFILE_TYPE) {
      await probeWritableDownloadFolder(profile.download_at);
      return {
        ok: true,
        testedRpcPath: false,
        message: 'Shared folder write test passed from putiorr. Browser grabs are downloaded straight into that folder.',
      };
    }
    const rpcPath = profile.rpc_path || normalizeRpcPath(input.rpc_path ?? input.rpcPath ?? SHARED_RPC_PATH);
    const rpcPathIsActive = rpcPath === SHARED_RPC_PATH || Boolean(this.service.store.findProfileByRpcPath(rpcPath));
    const testedPath = rpcPathIsActive ? rpcPath : SHARED_RPC_PATH;
    const url = clientSettingsUrl({
      host: profile.client_host || 'putiorr',
      port: profile.client_port || '9091',
      useSsl: profile.client_use_ssl,
      rpcPath: testedPath,
    });
    await probeWritableDownloadFolder(profile.download_at);
    await this.probeTransmissionEndpoint(url);
    return {
      ok: true,
      testedRpcPath: rpcPathIsActive,
      message: rpcPathIsActive
        ? 'Connection and shared folder write tests passed from putiorr. Confirm the *arr container can see the same host and download folder.'
        // Not "save and enable": a saved profile's path answers whether or not
        // it is switched on — disabling refuses new adds, it does not retire
        // the endpoint — so saving is the whole of what is missing here.
        : 'Host, port, SSL, and shared folder write tests passed from putiorr. Save this profile before testing its custom RPC path.',
    };
  }

  async probeTransmissionEndpoint(url) {
    const authHeaders = this.rpcAuthHeaders();
    const first = await fetch(url, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
      signal: AbortSignal.timeout(CLIENT_SETTINGS_TEST_TIMEOUT_MS),
    });
    if (first.status === 401) {
      throw new Error('Endpoint requires RPC username and password.');
    }
    const sessionId = first.headers.get(SESSION_HEADER);
    if (first.status !== 409 || !sessionId) {
      throw new Error(`Endpoint did not answer like Transmission RPC (HTTP ${first.status}).`);
    }

    const second = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        [SESSION_HEADER]: sessionId,
      },
      body: JSON.stringify({ method: 'session-get', arguments: {} }),
      signal: AbortSignal.timeout(CLIENT_SETTINGS_TEST_TIMEOUT_MS),
    });
    const body = await second.json().catch(() => ({}));
    if (!second.ok) throw new Error(`Transmission RPC test failed with HTTP ${second.status}.`);
    if (body.result !== 'success') {
      throw new Error(body.result || 'Transmission RPC test did not return success.');
    }
  }

  rpcAuthHeaders() {
    if (!this.config.rpcUsername && !this.config.rpcPassword) return {};
    const token = Buffer.from(`${this.config.rpcUsername}:${this.config.rpcPassword}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
}

function clientSettingsUrl({ host, port, useSsl, rpcPath }) {
  const scheme = useSsl ? 'https' : 'http';
  const portPart = port ? `:${port}` : '';
  try {
    return new URL(`${scheme}://${host}${portPart}${rpcPath}`).toString();
  } catch {
    throw new Error('Host, port, SSL, or RPC path is not a valid URL.');
  }
}

async function probeWritableDownloadFolder(downloadAt) {
  const folder = String(downloadAt ?? '').trim();
  if (!folder) throw new Error('Shared download folder is required.');
  const testDir = path.join(folder, `.putiorr-write-test-${crypto.randomUUID()}`);
  const testFile = path.join(testDir, 'probe.tmp');
  try {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, 'putiorr write test');
    await rm(testFile);
    await rm(testDir, { recursive: true });
  } catch (error) {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Shared download folder is not writable: ${error.message}`);
  }
}

const BROWSER_DOMAIN_ERROR_LIMIT = 5;

// #profileWizardMessage renders with white-space: pre-line, so one refused
// entry per line. Capped because the request body is bounded by bytes rather
// than by entry count: a pasted list must not turn into a message no dialog can
// show.
function browserDomainError(errors) {
  const shown = errors.slice(0, BROWSER_DOMAIN_ERROR_LIMIT).join('\n');
  return errors.length > BROWSER_DOMAIN_ERROR_LIMIT
    ? `${shown}\n…and ${errors.length - BROWSER_DOMAIN_ERROR_LIMIT} more`
    : shown;
}

// Warnings are advice about what was just typed, not profile data: they ride
// along on the reply that answered for them and are never stored.
function profileResponse(profile, input) {
  const warnings = input.browser_domain_warnings;
  return warnings?.length ? { ...profile, browser_domain_warnings: warnings } : profile;
}

function normalizeProfileInput(input, { partial = false } = {}) {
  const output = {};
  const name = input.name == null ? undefined : String(input.name).trim();
  const type = input.type == null ? undefined : String(input.type).trim().toLowerCase();
  const slug = input.slug == null ? undefined : slugify(input.slug || name);
  const downloadProfileId = input.download_profile_id ?? input.downloadProfileId;
  const autoRemoveCompleted = input.auto_remove_completed ?? input.autoRemoveCompleted;
  const putioFolderName = input.putio_folder_name ?? input.putioFolderName;
  const downloadAt = input.downloadAt ?? input.download_at ?? input.local_path ?? input.localPath;
  // ?? would fold an explicit null into "not mentioned", and null is exactly
  // what a grab profile sends to clear the path it may have held.
  const rpcPath = input.rpc_path !== undefined ? input.rpc_path : input.rpcPath;
  const clientHost = input.client_host ?? input.clientHost;
  const clientPort = input.client_port ?? input.clientPort;
  const clientUseSsl = input.client_use_ssl ?? input.clientUseSsl;
  const browserDomains = input.browser_domains ?? input.browserDomains;

  if (name !== undefined) output.name = name;
  if (type !== undefined) output.type = type || 'custom';
  if (slug !== undefined) output.slug = slug;
  if (downloadProfileId !== undefined) output.download_profile_id = normalizeOptionalId(downloadProfileId);
  if (autoRemoveCompleted !== undefined) output.auto_remove_completed = normalizeBooleanInput(autoRemoveCompleted);
  if (putioFolderName !== undefined) output.putio_folder_name = String(putioFolderName).trim();
  if (downloadAt !== undefined) output.download_at = path.resolve(String(downloadAt).trim());
  // null or '' means "this profile has no Transmission endpoint", which is what
  // a grab profile is. normalizeRpcPath would turn either into '', and the
  // column is nullable now, so the distinction has to survive to the store.
  if (rpcPath !== undefined) {
    output.rpc_path = rpcPath == null || rpcPath === '' ? null : normalizeRpcPath(rpcPath);
  }
  if (clientHost !== undefined) output.client_host = String(clientHost).trim() || 'putiorr';
  if (clientPort !== undefined) output.client_port = String(clientPort).trim();
  if (clientUseSsl !== undefined) output.client_use_ssl = Boolean(clientUseSsl);
  if (browserDomains !== undefined) {
    // The form sends the raw comma-separated text. An entry no hostname can
    // ever match is a refusal rather than a silent drop: the profile would
    // otherwise look configured for a site it can never receive a grab from.
    const { domains, errors, warnings } = normalizeBrowserDomains(browserDomains);
    if (errors.length) throw new Error(browserDomainError(errors));
    output.browser_domains = domains;
    // Not a column: the store ignores unknown keys, and profileResponse lifts
    // this back out onto the reply.
    if (warnings.length) output.browser_domain_warnings = warnings;
  }
  if (input.putio_folder_id !== undefined || input.putioFolderId !== undefined) {
    output.putio_folder_id = Number(input.putio_folder_id ?? input.putioFolderId) || null;
  }
  if (input.enabled !== undefined) output.enabled = Boolean(input.enabled);

  if (!partial) {
    for (const key of ['name', 'slug', 'putio_folder_name', 'download_at']) {
      if (!output[key]) throw new Error(`${key} is required`);
    }
    // Only an *arr ingress needs one. A grab profile is reached exclusively
    // through the extension, and requiring a path here is what forced the
    // wizard to derive one it never showed.
    if (output.type !== GRAB_PROFILE_TYPE && !output.rpc_path) {
      throw new Error('rpc_path is required');
    }
  }

  if (output.rpc_path && (output.rpc_path.startsWith('/api/') || output.rpc_path === '/')) {
    throw new Error('RPC path cannot conflict with the web UI or API');
  }
  return output;
}

function normalizeDownloadProfileInput(input, { partial = false } = {}) {
  const policySource = input.downloadPolicy && typeof input.downloadPolicy === 'object'
    ? { ...input.downloadPolicy, ...input }
    : input;
  const output = {};
  const name = input.name == null ? undefined : String(input.name).trim();
  const slug = input.slug == null ? undefined : slugify(input.slug || name);

  if (name !== undefined) output.name = name;
  if (slug !== undefined) output.slug = slug;
  copyNonNegativePolicyValue(
    output,
    policySource,
    'slowSpeedThresholdBytesPerSecond',
    'slow_speed_threshold_bytes_per_second',
  );
  copyNonNegativePolicyValue(
    output,
    policySource,
    'slowSpeedDurationSeconds',
    'slow_speed_duration_seconds',
  );
  copyNonNegativePolicyValue(
    output,
    policySource,
    'slowSpeedGraceSeconds',
    'slow_speed_grace_seconds',
  );
  copyNonNegativePolicyValue(
    output,
    policySource,
    'slowSpeedMinSizeBytes',
    'slow_speed_min_size_bytes',
  );

  if (!partial) {
    for (const key of ['name', 'slug']) {
      if (!output[key]) throw new Error(`${key} is required`);
    }
  }

  return output;
}

function copyNonNegativePolicyValue(output, input, camelKey, snakeKey) {
  const value = input[camelKey] ?? input[snakeKey];
  if (value === undefined) return;
  const parsed = Number.parseInt(value, 10);
  output[snakeKey] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeOptionalId(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeBooleanInput(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function slugify(value) {
  return String(value ?? 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'profile';
}

function normalizeRpcPath(value) {
  const pathValue = String(value).trim();
  if (!pathValue) throw new Error('rpc_path is required');
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}
