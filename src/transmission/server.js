import crypto from 'node:crypto';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { PutioOAuthClient } from '../putio/oauth.js';

const SESSION_HEADER = 'X-Transmission-Session-Id';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function jsonResponse(res, status, body, sessionId) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(SESSION_HEADER, sessionId);
  res.end(JSON.stringify(body));
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

function timingSafeEqualString(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
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

export class TransmissionRpcServer {
  constructor({ config, service }) {
    this.config = config;
    this.service = service;
    this.oauth = new PutioOAuthClient({ appId: config.putioAppId });
    this.sessionId = crypto.randomBytes(24).toString('hex');
    this.liveReloadClients = new Set();
    this.liveReloadWatcher = undefined;
    this.liveReloadTimer = undefined;
    this.liveReloadVersion = String(Date.now());
    this.webSocketClients = new Set();
    this.webSocketBroadcastTimer = undefined;
    this.webSocketRefreshTimer = undefined;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        logger.error('unhandled rpc error', { error: error.message, stack: error.stack });
        jsonResponse(res, 500, { result: 'error', message: error.message }, this.sessionId);
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

  async handleRpc(req, res, profile) {
    const clientSessionId = req.headers['x-transmission-session-id'];
    if (clientSessionId !== this.sessionId) {
      res.statusCode = 409;
      res.setHeader(SESSION_HEADER, this.sessionId);
      res.end('409 Conflict');
      return;
    }

    const currentProfile = profile ? this.service.requireProfile(profile) : undefined;

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

    const result = await this.dispatch(rpcRequest.method, rpcRequest.arguments ?? {}, currentProfile);
    const body = {
      ...(rpcRequest.tag !== undefined ? { tag: rpcRequest.tag } : {}),
      result: 'success',
      arguments: result,
    };
    jsonResponse(res, 200, body, this.sessionId);
    if (['torrent-add', 'torrent-remove'].includes(rpcRequest.method)) {
      this.scheduleWebSocketBroadcast(`rpc:${rpcRequest.method}`);
    }
  }

  async handleApi(req, res, requestPath) {
    try {
      const method = req.method ?? 'GET';

      if (method === 'GET' && requestPath === '/api/settings') {
        jsonResponse(res, 200, {
          tokenConfigured: Boolean(this.service.getPutioToken()),
        }, this.sessionId);
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
        this.scheduleWebSocketBroadcast('settings');
        jsonResponse(res, 200, {
          tokenConfigured: Boolean(this.service.getPutioToken()),
        }, this.sessionId);
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

      if (method === 'POST' && requestPath === '/api/oauth/start') {
        const result = await this.oauth.start();
        jsonResponse(res, 200, result, this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/oauth/poll') {
        const body = await readJsonBody(req);
        const result = await this.oauth.poll(String(body.code ?? '').trim());
        if (result.status === 'OK' && result.oauthToken) {
          this.service.store.setSetting('putio_token', result.oauthToken);
          this.service.putioClient = undefined;
          this.service.putioToken = undefined;
          this.scheduleWebSocketBroadcast('oauth');
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

      if (method === 'POST' && requestPath === '/api/profiles') {
        const profile = this.service.store.createProfile(normalizeProfileInput(await readJsonBody(req)));
        this.scheduleWebSocketBroadcast('profiles');
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
        this.scheduleWebSocketBroadcast('profiles');
        jsonResponse(res, 200, profile, this.sessionId);
        return;
      }

      if (profileMatch && method === 'DELETE') {
        this.service.store.deleteProfile(Number(profileMatch[1]));
        this.scheduleWebSocketBroadcast('profiles');
        jsonResponse(res, 200, { ok: true }, this.sessionId);
        return;
      }

      if (method === 'GET' && requestPath === '/api/downloads') {
        jsonResponse(res, 200, this.service.listDownloads(), this.sessionId);
        return;
      }

      if (method === 'POST' && requestPath === '/api/poll') {
        await this.service.refreshRemoteTransfers();
        this.scheduleWebSocketBroadcast('downloads');
        jsonResponse(res, 200, { ok: true }, this.sessionId);
        return;
      }

      jsonResponse(res, 404, { error: 'Not Found' }, this.sessionId);
    } catch (error) {
      logger.warn('api request failed', { path: requestPath, error: error.message });
      jsonResponse(res, 400, { error: error.message }, this.sessionId);
    }
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

    this.sendWebSocketState(client, 'connect');
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
      this.sendWebSocketState(client, 'refresh');
    }
  }

  startWebSocketBroadcasts() {
    if (this.webSocketRefreshTimer) return;
    this.webSocketRefreshTimer = setInterval(() => {
      if (this.webSocketClients.size > 0) {
        this.broadcastWebSocketState('tick');
      }
    }, 2_000);
  }

  scheduleWebSocketBroadcast(reason) {
    if (this.webSocketBroadcastTimer) clearTimeout(this.webSocketBroadcastTimer);
    this.webSocketBroadcastTimer = setTimeout(() => {
      this.broadcastWebSocketState(reason);
    }, 100);
  }

  webUiState(reason) {
    return {
      type: 'state',
      reason,
      sentAt: new Date().toISOString(),
      settings: {
        tokenConfigured: Boolean(this.service.getPutioToken()),
      },
      profiles: this.service.store.listProfiles({ includeDisabled: true }),
      downloads: this.service.listDownloads(),
    };
  }

  sendWebSocketState(client, reason) {
    this.sendWebSocketJson(client, this.webUiState(reason));
  }

  broadcastWebSocketState(reason) {
    if (this.webSocketClients.size === 0) return;
    const payload = JSON.stringify(this.webUiState(reason));
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
    if (this.webSocketBroadcastTimer) clearTimeout(this.webSocketBroadcastTimer);
    this.webSocketBroadcastTimer = undefined;
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
        profile ??= this.service.getDefaultProfile();
        this.service.requireProfile(profile);
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
      case 'torrent-remove':
        return this.service.removeTorrents(args, profile);
      default:
        logger.debug('unsupported rpc method', { method });
        return {};
    }
  }
}

function normalizeProfileInput(input, { partial = false } = {}) {
  const output = {};
  const name = input.name == null ? undefined : String(input.name).trim();
  const type = input.type == null ? undefined : String(input.type).trim().toLowerCase();
  const slug = input.slug == null ? undefined : slugify(input.slug || name);
  const putioFolderName = input.putio_folder_name ?? input.putioFolderName;
  const downloadAt = input.downloadAt ?? input.download_at ?? input.local_path ?? input.localPath;
  const rpcPath = input.rpc_path ?? input.rpcPath;

  if (name !== undefined) output.name = name;
  if (type !== undefined) output.type = type || 'custom';
  if (slug !== undefined) output.slug = slug;
  if (putioFolderName !== undefined) output.putio_folder_name = String(putioFolderName).trim();
  if (downloadAt !== undefined) output.download_at = path.resolve(String(downloadAt).trim());
  if (rpcPath !== undefined) output.rpc_path = normalizeRpcPath(rpcPath);
  if (input.putio_folder_id !== undefined || input.putioFolderId !== undefined) {
    output.putio_folder_id = Number(input.putio_folder_id ?? input.putioFolderId) || null;
  }
  if (input.enabled !== undefined) output.enabled = Boolean(input.enabled);

  if (!partial) {
    for (const key of ['name', 'slug', 'putio_folder_name', 'download_at', 'rpc_path']) {
      if (!output[key]) throw new Error(`${key} is required`);
    }
  }

  if (output.rpc_path && (output.rpc_path.startsWith('/api/') || output.rpc_path === '/')) {
    throw new Error('RPC path cannot conflict with the web UI or API');
  }

  return output;
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
