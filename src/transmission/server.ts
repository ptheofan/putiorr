import crypto from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadPolicyFromStore, saveDownloadPolicyToStore } from '../download/policy.ts';
import { logger } from '../logger.ts';
import { PutioOAuthClient } from '../putio/oauth.ts';
import { VersionChecker } from '../version.ts';
import type { FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { DownloadManager } from '../download/manager.ts';
import type { TransferService } from '../transfer/service.ts';
import type {
  AppConfig,
  DbScalar,
  DownloadProfileInput,
  DownloadPolicyInput,
  Profile,
  ProfileInput,
} from '../types.ts';

const SESSION_HEADER = 'X-Transmission-Session-Id';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PUTIO_SWAGGER_APP_ID = '3270';
const OAUTH_APP_ID_SETTING = 'putio_oauth_app_id';
const OAUTH_RELAY_URL_SETTING = 'putio_oauth_relay_url';
const CLIENT_SETTINGS_TEST_TIMEOUT_MS = 5_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
} as Record<string, string>;

type JsonValue = DbScalar | JsonRecord | JsonValue[];
interface JsonRecord {
  [key: string]: JsonValue;
}

type RpcArgs = Record<string, DbScalar | Array<string | number>>;
type WebSocketClient = {
  socket: Socket;
  buffer: Buffer;
};

function jsonResponse(res: ServerResponse, status: number, body: object, sessionId: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(SESSION_HEADER, sessionId);
  res.end(JSON.stringify(body));
}

function htmlResponse(res: ServerResponse, status: number, body: string, sessionId: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(SESSION_HEADER, sessionId);
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function websocketAccept(key: string): string {
  return crypto
    .createHash('sha1')
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest('base64');
}

function websocketFrame(payload: string | Buffer, opcode = 0x1): Buffer {
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

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return String(value ?? '').split(',')[0].trim();
}

function jsonRecord(value: JsonValue): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function rpcArgValue(value: JsonValue): DbScalar | Array<string | number> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (
      typeof item === 'string' || typeof item === 'number' ? [item] : []
    ));
  }
  return value == null || typeof value !== 'object' ? value : undefined;
}

function scalarValue(value: JsonValue): DbScalar {
  return value == null || typeof value !== 'object' ? value : undefined;
}

function rpcArgs(value: JsonValue): RpcArgs {
  const source = jsonRecord(value) ?? {};
  const output: RpcArgs = {};
  for (const [key, entry] of Object.entries(source)) {
    output[key] = rpcArgValue(entry);
  }
  return output;
}

function downloadPolicyInputFromJson(value: JsonValue): DownloadPolicyInput {
  const source = jsonRecord(value) ?? {};
  return {
    slowSpeedThresholdBytesPerSecond: scalarValue(source.slowSpeedThresholdBytesPerSecond),
    slowSpeedDurationSeconds: scalarValue(source.slowSpeedDurationSeconds),
    slowSpeedGraceSeconds: scalarValue(source.slowSpeedGraceSeconds),
    slowSpeedMinSizeBytes: scalarValue(source.slowSpeedMinSizeBytes),
  };
}

function normalizeOAuthAppId(value: JsonValue | string | undefined): string {
  return String(value ?? '').trim();
}

function normalizeOAuthRelayUrl(value: JsonValue | string | undefined): string {
  const relayUrl = String(value ?? '').trim().replace(/\/+$/, '');
  if (!relayUrl) return '';
  const parsed = new URL(relayUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Put.io OAuth relay URL must use http or https');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizePutioOAuthSettingsInput(input?: JsonRecord): { reset?: boolean; appId?: string; relayUrl?: string } {
  const source = input ?? {};
  const output: { reset?: boolean; appId?: string; relayUrl?: string } = {};
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

function encodeOAuthState(payload: object): string {
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
  config: AppConfig;
  service: TransferService;
  downloadManager: DownloadManager | undefined;
  oauth: PutioOAuthClient;
  versionChecker: VersionChecker;
  oauthStates: Map<string, { expiresAt: number }>;
  sessionId: string;
  liveReloadClients: Set<ServerResponse>;
  liveReloadWatcher: FSWatcher | undefined;
  liveReloadTimer: NodeJS.Timeout | undefined;
  liveReloadVersion: string;
  webSocketClients: Set<WebSocketClient>;
  webSocketDownloadsBroadcastTimer: NodeJS.Timeout | undefined;
  webSocketRefreshTimer: NodeJS.Timeout | undefined;
  server: http.Server;

  constructor({
    config,
    service,
    downloadManager,
    fetch: fetchImpl,
  }: {
    config: AppConfig;
    service: TransferService;
    downloadManager?: DownloadManager;
    fetch?: typeof globalThis.fetch;
  }) {
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
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        logger.error('unhandled rpc error', { error: error.message, stack: error.stack });
        jsonResponse(res, 500, { result: error.message || 'error', message: error.message }, this.sessionId);
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head);
    });
  }

  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.listenPort, this.config.listenHost, () => {
        this.server.off('error', reject);
        this.startLiveReload();
        this.startWebSocketBroadcasts();
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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

  cleanupOAuthStates(): void {
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

  oauthClient(appId = this.oauthSettings().appId): PutioOAuthClient {
    if (!this.oauth?.appId || this.oauth.appId === appId) return this.oauth;
    return new PutioOAuthClient({ appId });
  }

  createOAuthState({ callbackUrl, relayUrl }: { callbackUrl?: string; relayUrl?: string } = {}): string {
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

  consumeOAuthState(state: JsonValue): boolean {
    this.cleanupOAuthStates();
    const normalizedState = String(state ?? '').trim();
    if (!normalizedState) return false;
    if (!this.oauthStates.has(normalizedState)) return false;
    this.oauthStates.delete(normalizedState);
    return true;
  }

  publicBaseUrl(req: IncomingMessage): string {
    if (this.config.publicUrl) return this.config.publicUrl;
    const protocol = firstHeaderValue(req.headers['x-forwarded-proto']) || 'http';
    const host = firstHeaderValue(req.headers['x-forwarded-host'])
      || firstHeaderValue(req.headers.host)
      || `127.0.0.1:${this.config.listenPort}`;
    return `${protocol}://${host}`.replace(/\/+$/, '');
  }

  oauthRedirectUri(req: IncomingMessage): string {
    return new URL('/api/oauth/callback', this.publicBaseUrl(req)).toString();
  }

  putioAuthorizeRedirectUri(): string | undefined {
    return this.oauthSettings().relayUrl || undefined;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const rpcProfile = requestPath === '/transmission/rpc'
      ? undefined
      : this.service.store.findProfileByRpcPath(requestPath);
    if (rpcProfile || requestPath === '/transmission/rpc') {
      await this.handleRpc(req, res, rpcProfile);
      return;
    }

    if (requestPath.startsWith('/api/')) {
      await this.handleApi(req, res, requestPath);
      return;
    }

    await this.serveWeb(req, res, requestPath);
  }

  async handleRpc(req: IncomingMessage, res: ServerResponse, profile?: Profile): Promise<void> {
    const clientSessionId = req.headers['x-transmission-session-id'];
    if (clientSessionId !== this.sessionId) {
      res.statusCode = 409;
      res.setHeader(SESSION_HEADER, this.sessionId);
      res.end('409 Conflict');
      return;
    }

    const currentProfile = profile ? this.service.requireProfile(profile) : undefined;

    let rpcRequest: { method: string; arguments: RpcArgs; tag?: JsonValue };
    if (req.method === 'GET') {
      rpcRequest = { method: 'session-get', arguments: {} };
    } else if (req.method === 'POST') {
      const body = await readJsonBody(req);
      rpcRequest = {
        method: String(body.method ?? ''),
        arguments: rpcArgs(body.arguments),
        ...(body.tag !== undefined ? { tag: body.tag } : {}),
      };
    } else {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    let result;
    try {
      result = await this.dispatch(rpcRequest.method, rpcRequest.arguments ?? {}, currentProfile);
    } catch (error) {
      // Transmission RPC reports failures in the `result` field as a
      // human-readable string (with HTTP 200). Transmission clients such as
      // Sonarr/Radarr/Prowlarr surface `result`, so carrying the real message
      // here makes the actual reason visible instead of a generic "error".
      logger.error('rpc request failed', { method: rpcRequest.method, error: error.message });
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

  async handleApi(req: IncomingMessage, res: ServerResponse, requestPath: string): Promise<void> {
    try {
      const method = req.method ?? 'GET';

      if (method === 'GET' && requestPath === '/api/settings') {
        jsonResponse(res, 200, this.settingsResponse(req), this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/version') {
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
          const oauthSettings = normalizePutioOAuthSettingsInput(jsonRecord(body.putioOAuth));
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
          saveDownloadPolicyToStore(this.service.store, downloadPolicyInputFromJson(body.downloadPolicy), this.config);
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
        jsonResponse(res, 200, this.service.store.listProfiles({ includeDisabled: true }), this.sessionId);
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
        if (!downloadProfile) throw new Error('Could not create download profile');
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
        if (!downloadProfile) throw new Error('Download profile not found');
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
        this.service.store.deleteDownloadProfile(id);
        if (defaultDownloadProfile) {
          this.service.store.assignMissingProfileDownloadProfiles(defaultDownloadProfile.id);
        }
        jsonResponse(res, 200, { ok: true }, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/profiles') {
        const profile = this.service.store.createProfile(normalizeProfileInput(await readJsonBody(req)));
        if (!profile) throw new Error('Could not create profile');
        jsonResponse(res, 201, profile, this.sessionId);
        return;
      }

      const profileMatch = requestPath.match(/^\/api\/profiles\/(\d+)$/);
      if (profileMatch && method === 'PUT') {
        const profile = this.service.store.updateProfile(
          Number(profileMatch[1]),
          normalizeProfileInput(await readJsonBody(req), { partial: true }),
        );
        if (!profile) throw new Error('Profile not found');
        jsonResponse(res, 200, profile, this.sessionId);
        return;
      }

      if (profileMatch && method === 'DELETE') {
        this.service.store.deleteProfile(Number(profileMatch[1]));
        jsonResponse(res, 200, { ok: true }, this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/downloads') {
        jsonResponse(res, 200, this.service.listDownloads(), this.sessionId);
        return;
      }

      const downloadStartMatch = requestPath.match(/^\/api\/downloads\/(\d+)\/start$/);
      if (downloadStartMatch && method === 'POST') {
        if (!this.downloadManager) throw new Error('Download manager is not available');
        const result = await this.downloadManager.startTransferDownload(Number(downloadStartMatch[1]));
        this.scheduleWebSocketDownloadsBroadcast('downloads:start');
        jsonResponse(res, 200, {
          ...result,
          downloads: this.service.listDownloads(),
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
        const result = await this.service.deleteDownloadFiles(Number(downloadFilesDeleteMatch[1]), rpcArgValue(body.fileIds), {
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

      jsonResponse(res, 404, { error: 'Not Found' }, this.sessionId);
    } catch (error) {
      logger.warn('api request failed', { path: requestPath, error: error.message });
      jsonResponse(res, 400, { error: error.message }, this.sessionId);
    }
  }

  settingsResponse(req?: IncomingMessage) {
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
    };
  }

  async serveWeb(_req: IncomingMessage, res: ServerResponse, requestPath: string): Promise<void> {
    const requestedFileName = requestPath === '/' ? 'index.html' : requestPath.slice(1);
    const fileName = requestedFileName === 'app.js' ? 'app.ts' : requestedFileName;
    if (fileName.includes('..')) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const filePath = path.join(WEB_DIR, fileName);
    try {
      let body: Buffer = await readFile(filePath);
      if (fileName.endsWith('.ts')) {
        body = Buffer.from(stripTypeScriptTypes(body.toString('utf8')));
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(requestedFileName)] ?? 'application/octet-stream');
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

  injectLiveReload(body: Uint8Array): Buffer {
    if (!this.config.liveReload) return Buffer.from(body);
    const html = Buffer.from(body).toString('utf8');
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

  handleLiveReload(req: IncomingMessage, res: ServerResponse): void {
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

  startLiveReload(): void {
    if (!this.config.liveReload || this.liveReloadWatcher) return;
    this.liveReloadWatcher = watch(WEB_DIR, { persistent: false }, (_eventType, fileName) => {
      if (!fileName) return;
      this.queueLiveReload(fileName);
    });
    this.liveReloadWatcher.on('error', (error: Error) => {
      logger.warn('live reload watcher failed', { error: error.message });
    });
  }

  queueLiveReload(fileName: string | Buffer): void {
    if (this.liveReloadTimer) clearTimeout(this.liveReloadTimer);
    this.liveReloadTimer = setTimeout(() => {
      const payload = JSON.stringify({ fileName: String(fileName), at: Date.now() });
      for (const client of this.liveReloadClients) {
        client.write(`event: reload\ndata: ${payload}\n\n`);
      }
    }, 150);
  }

  stopLiveReload(): void {
    if (this.liveReloadTimer) clearTimeout(this.liveReloadTimer);
    this.liveReloadTimer = undefined;
    this.liveReloadWatcher?.close();
    this.liveReloadWatcher = undefined;
    for (const client of this.liveReloadClients) {
      client.end();
    }
    this.liveReloadClients.clear();
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, _head: Buffer): void {
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

    socket.on('data', (chunk) => this.handleWebSocketData(client, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.on('close', () => this.webSocketClients.delete(client));
    socket.on('error', () => this.webSocketClients.delete(client));

    this.sendWebSocketDownloads(client, 'connect');
  }

  handleWebSocketData(client: WebSocketClient, chunk: Buffer): void {
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

  handleWebSocketMessage(client: WebSocketClient, rawMessage: string): void {
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

  startWebSocketBroadcasts(): void {
    if (this.webSocketRefreshTimer) return;
    this.webSocketRefreshTimer = setInterval(() => {
      if (this.webSocketClients.size > 0) {
        this.broadcastWebSocketDownloads('tick');
      }
    }, 2_000);
  }

  scheduleWebSocketDownloadsBroadcast(reason: string): void {
    if (this.webSocketDownloadsBroadcastTimer) clearTimeout(this.webSocketDownloadsBroadcastTimer);
    this.webSocketDownloadsBroadcastTimer = setTimeout(() => {
      this.broadcastWebSocketDownloads(reason);
    }, 100);
  }

  webDownloadsState(reason: string) {
    return {
      type: 'downloads',
      reason,
      sentAt: new Date().toISOString(),
      downloads: this.service.listDownloads(),
    };
  }

  sendWebSocketDownloads(client: WebSocketClient, reason: string): void {
    this.sendWebSocketJson(client, this.webDownloadsState(reason));
  }

  broadcastWebSocketDownloads(reason: string): void {
    if (this.webSocketClients.size === 0) return;
    const payload = JSON.stringify(this.webDownloadsState(reason));
    for (const client of this.webSocketClients) {
      this.sendWebSocketFrame(client, payload);
    }
  }

  sendWebSocketJson(client: WebSocketClient, message: object): void {
    this.sendWebSocketFrame(client, JSON.stringify(message));
  }

  sendWebSocketFrame(client: WebSocketClient, payload: string | Buffer, opcode = 0x1): void {
    if (client.socket.destroyed) {
      this.webSocketClients.delete(client);
      return;
    }
    client.socket.write(websocketFrame(payload, opcode), (error) => {
      if (error) this.webSocketClients.delete(client);
    });
  }

  closeWebSocket(client: WebSocketClient): void {
    if (!client.socket.destroyed) {
      client.socket.end(websocketFrame(Buffer.alloc(0), 0x8));
    }
    this.webSocketClients.delete(client);
  }

  stopWebSockets(): void {
    if (this.webSocketDownloadsBroadcastTimer) clearTimeout(this.webSocketDownloadsBroadcastTimer);
    this.webSocketDownloadsBroadcastTimer = undefined;
    if (this.webSocketRefreshTimer) clearInterval(this.webSocketRefreshTimer);
    this.webSocketRefreshTimer = undefined;
    for (const client of this.webSocketClients) {
      this.closeWebSocket(client);
    }
    this.webSocketClients.clear();
  }

  isAuthorized(req: IncomingMessage): boolean {
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

  async dispatch(method: string, args: RpcArgs, profile?: Profile) {
    logger.debug('rpc dispatch', { method });
    switch (method) {
      case 'session-get':
        profile ??= this.service.getDefaultProfile();
        profile = this.service.requireProfile(profile);
        return {
          'download-dir': profile.download_at,
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

  async testClientSettings(input: JsonRecord) {
    const profile = normalizeProfileInput(input, { partial: true });
    const rpcPath = profile.rpc_path || normalizeRpcPath(input.rpc_path ?? input.rpcPath ?? '/transmission/rpc');
    const rpcPathIsActive = rpcPath === '/transmission/rpc' || Boolean(this.service.store.findProfileByRpcPath(rpcPath));
    const testedPath = rpcPathIsActive ? rpcPath : '/transmission/rpc';
    const url = clientSettingsUrl({
      host: profile.client_host || 'putiorr',
      port: profile.client_port || '9091',
      useSsl: Boolean(profile.client_use_ssl),
      rpcPath: testedPath,
    });
    await probeWritableDownloadFolder(profile.download_at);
    await this.probeTransmissionEndpoint(url);
    return {
      ok: true,
      testedRpcPath: rpcPathIsActive,
      message: rpcPathIsActive
        ? 'Connection and shared folder write tests passed from putiorr. Confirm the *arr container can see the same host and download folder.'
        : 'Host, port, SSL, and shared folder write tests passed from putiorr. Save and enable this profile before testing its custom RPC path.',
    };
  }

  async probeTransmissionEndpoint(url: string): Promise<void> {
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

  rpcAuthHeaders(): Record<string, string> {
    if (!this.config.rpcUsername && !this.config.rpcPassword) return {};
    const token = Buffer.from(`${this.config.rpcUsername}:${this.config.rpcPassword}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
}

function clientSettingsUrl({
  host,
  port,
  useSsl,
  rpcPath,
}: {
  host: string;
  port: string;
  useSsl: boolean;
  rpcPath: string;
}): string {
  const scheme = useSsl ? 'https' : 'http';
  const portPart = port ? `:${port}` : '';
  try {
    return new URL(`${scheme}://${host}${portPart}${rpcPath}`).toString();
  } catch {
    throw new Error('Host, port, SSL, or RPC path is not a valid URL.');
  }
}

async function probeWritableDownloadFolder(downloadAt: JsonValue): Promise<void> {
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

function normalizeProfileInput(input: JsonRecord, { partial = false }: { partial?: boolean } = {}): ProfileInput {
  const output: ProfileInput = {};
  const name = input.name == null ? undefined : String(input.name).trim();
  const type = input.type == null ? undefined : String(input.type).trim().toLowerCase();
  const slug = input.slug == null ? undefined : slugify(input.slug || name);
  const downloadProfileId = input.download_profile_id ?? input.downloadProfileId;
  const putioFolderName = input.putio_folder_name ?? input.putioFolderName;
  const downloadAt = input.downloadAt ?? input.download_at ?? input.local_path ?? input.localPath;
  const rpcPath = input.rpc_path ?? input.rpcPath;
  const clientHost = input.client_host ?? input.clientHost;
  const clientPort = input.client_port ?? input.clientPort;
  const clientUseSsl = input.client_use_ssl ?? input.clientUseSsl;

  if (name !== undefined) output.name = name;
  if (type !== undefined) output.type = type || 'custom';
  if (slug !== undefined) output.slug = slug;
  if (downloadProfileId !== undefined) output.download_profile_id = normalizeOptionalId(downloadProfileId);
  if (putioFolderName !== undefined) output.putio_folder_name = String(putioFolderName).trim();
  if (downloadAt !== undefined) output.download_at = path.resolve(String(downloadAt).trim());
  if (rpcPath !== undefined) output.rpc_path = normalizeRpcPath(rpcPath);
  if (clientHost !== undefined) output.client_host = String(clientHost).trim() || 'putiorr';
  if (clientPort !== undefined) output.client_port = String(clientPort).trim();
  if (clientUseSsl !== undefined) output.client_use_ssl = Boolean(clientUseSsl);
  if (input.putio_folder_id !== undefined || input.putioFolderId !== undefined) {
    output.putio_folder_id = Number(input.putio_folder_id ?? input.putioFolderId) || null;
  }
  if (input.enabled !== undefined) output.enabled = Boolean(input.enabled);

  if (!partial) {
    for (const key of ['name', 'slug', 'putio_folder_name', 'download_at', 'rpc_path'] as const) {
      if (!output[key]) throw new Error(`${key} is required`);
    }
  }

  if (output.rpc_path && (output.rpc_path.startsWith('/api/') || output.rpc_path === '/')) {
    throw new Error('RPC path cannot conflict with the web UI or API');
  }

  return output;
}

function normalizeDownloadProfileInput(
  input: JsonRecord,
  { partial = false }: { partial?: boolean } = {},
): DownloadProfileInput {
  const policySource = input.downloadPolicy && typeof input.downloadPolicy === 'object' && !Array.isArray(input.downloadPolicy)
    ? { ...jsonRecord(input.downloadPolicy), ...input }
    : input;
  const output: DownloadProfileInput = {};
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
    for (const key of ['name', 'slug'] as const) {
      if (!output[key]) throw new Error(`${key} is required`);
    }
  }

  return output;
}

function copyNonNegativePolicyValue(
  output: DownloadProfileInput,
  input: DownloadPolicyInput,
  camelKey: keyof DownloadPolicyInput,
  snakeKey: keyof DownloadPolicyInput,
): void {
  const value = input[camelKey] ?? input[snakeKey];
  if (value === undefined) return;
  const parsed = Number.parseInt(String(value), 10);
  output[snakeKey] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeOptionalId(value: JsonValue): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function slugify(value: JsonValue): string {
  return String(value ?? 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'profile';
}

function normalizeRpcPath(value: JsonValue): string {
  const pathValue = String(value).trim();
  if (!pathValue) throw new Error('rpc_path is required');
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}
