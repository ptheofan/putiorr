# Browser Grab Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome MV3 extension in `extension/` that captures `magnet:` and `.torrent` links and posts them to a new `POST /api/grab` putiorr endpoint, which routes them through the existing profile machinery.

**Architecture:** One new route in the existing `handleApi` switch calls the existing `service.addTorrent()` with an explicitly resolved profile. The extension is a thin client: a content script captures clicks (fetching `.torrent` files from the page context so tracker cookies apply), a module service worker resolves the profile (explicit pick → site rule → default) and POSTs to putiorr, and an options page manages settings. Pure logic lives in `extension/lib/resolve.js` so node's test runner covers it.

**Tech Stack:** Node 22+ (`node --test`), Chrome Manifest V3, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-25-browser-grab-extension-design.md` — tracking issue [#59](https://github.com/ptheofan/putiorr/issues/59).

**Branch:** `feat/browser-grab-extension` (already created from `origin/main`).

**Conventions:** Run tests with `pnpm test test/<file>.test.js` (wraps `node --test`). Lint with `node scripts/lint.js`. Commit after every green step.

---

### Task 1: `POST /api/grab` server endpoint

The endpoint accepts `{ profileId, magnet }` or `{ profileId, torrentBase64, filename }` plus optional `sourceUrl`, and calls `service.addTorrent()` — the same code path as Transmission `torrent-add`. Passing the profile explicitly with no `downloadDir` skips category matching entirely (`src/transfer/service.js:184-198` returns the profile when category is empty; `extractCategory` returns `''` for an empty `downloadDir`, `src/download/paths.js:5`).

**Files:**
- Create: `test/api-grab.test.js`
- Modify: `src/transmission/server.js` (inside `handleApi`, before the final 404 at line ~700)

- [ ] **Step 1: Write the failing tests**

Create `test/api-grab.test.js`:

```js
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

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-grab-'));
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
  const putio = new FakePutio();
  const service = new TransferService({ config, store, putioFactory: () => putio });
  const rpcServer = new TransmissionRpcServer({ config, service });
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  return { store, putio, rpcServer, base: `http://127.0.0.1:${port}` };
}

async function postGrab(harness, payload) {
  const response = await fetch(`${harness.base}/api/grab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('grab with a magnet link adds a put.io transfer for the profile', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
    sourceUrl: 'https://tracker.example/release/1',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(typeof body.transfer.id, 'number');
  assert.equal(harness.putio.added.length, 1);
  assert.equal(harness.putio.added[0].folderId, 42);
});

test('grab with base64 torrent metainfo uploads the torrent file', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];
  const torrentBase64 = Buffer.from('d8:announce0:e').toString('base64');

  const { status, body } = await postGrab(harness, {
    profileId: profile.id,
    torrentBase64,
    filename: 'Example.Release.torrent',
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.transfer.name, 'Example.Release');
  assert.equal(harness.putio.uploads.length, 1);
  assert.equal(harness.putio.uploads[0].name, 'Example.Release.torrent');
});

test('grab with an unknown profile returns 404', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());

  const { status, body } = await postGrab(harness, {
    profileId: 9999,
    magnet: 'magnet:?xt=urn:btih:abcdef1234567890',
  });

  assert.equal(status, 404);
  assert.equal(body.error, 'Profile not found');
});

test('grab without a magnet or torrent returns 400', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];

  const { status, body } = await postGrab(harness, { profileId: profile.id });

  assert.equal(status, 400);
  assert.match(body.error, /magnet link or torrentBase64/);
});

test('grab with a non-magnet string returns 400', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.rpcServer.stop());
  const profile = harness.store.listProfiles()[0];

  const { status } = await postGrab(harness, {
    profileId: profile.id,
    magnet: 'https://tracker.example/not-a-magnet',
  });

  assert.equal(status, 400);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test test/api-grab.test.js`
Expected: all 5 tests FAIL — the endpoint returns 404 `{ error: 'Not Found' }`, so status assertions like `assert.equal(status, 200)` fail.

- [ ] **Step 3: Implement the endpoint**

In `src/transmission/server.js`, inside `handleApi`, insert **before** the `jsonResponse(res, 404, { error: 'Not Found' }, ...)` fallthrough (around line 700):

```js
      if (method === 'POST' && requestPath === '/api/grab') {
        const body = await readJsonBody(req);
        const profile = this.service.store.findProfileById(Number(body.profileId));
        if (!profile) {
          jsonResponse(res, 404, { error: 'Profile not found' }, this.sessionId);
          return;
        }
        const magnet = String(body.magnet ?? '').trim();
        const torrentBase64 = String(body.torrentBase64 ?? '').trim();
        if (!torrentBase64 && !magnet.startsWith('magnet:')) {
          jsonResponse(res, 400, { error: 'grab requires a magnet link or torrentBase64 metainfo' }, this.sessionId);
          return;
        }
        if (!profile.auto_remove_completed) {
          logger.warn('grab profile keeps completed transfers in the list; enable auto-remove on the profile for browser grabs', {
            profile: profile.slug,
          });
        }
        logger.info('grab from browser', {
          profile: profile.slug,
          sourceType: torrentBase64 ? 'torrent' : 'magnet',
          sourceUrl: body.sourceUrl,
        });
        const args = torrentBase64
          ? { metainfo: torrentBase64, filename: body.filename }
          : { filename: magnet };
        const result = await this.service.addTorrent(args, profile);
        this.scheduleWebSocketDownloadsBroadcast('api:grab');
        jsonResponse(res, 200, {
          ok: true,
          transfer: {
            id: result['torrent-added'].id,
            name: result['torrent-added'].name,
          },
        }, this.sessionId);
        return;
      }
```

Notes for the implementer:
- `readJsonBody`, `jsonResponse`, and `logger` are already imported/in scope in this file.
- Errors thrown by `addTorrent` (disabled profile, put.io failures) fall through to the existing `catch` in `handleApi`, which returns 400 `{ error }` — exactly what the extension displays.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test test/api-grab.test.js`
Expected: 5 tests PASS.

- [ ] **Step 5: Run the full suite and lint**

Run: `pnpm test && node scripts/lint.js`
Expected: all tests PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add test/api-grab.test.js src/transmission/server.js
git commit -m "Add POST /api/grab endpoint for browser grabs (#59)"
```

---

### Task 2: Pure extension logic (`extension/lib/resolve.js`)

Link detection and profile resolution, importable by both the extension and node tests. No chrome APIs in this file.

**Files:**
- Create: `extension/lib/resolve.js`
- Create: `test/extension-resolve.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/extension-resolve.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test test/extension-resolve.test.js`
Expected: FAIL — `Cannot find module .../extension/lib/resolve.js`.

- [ ] **Step 3: Implement the module**

Create `extension/lib/resolve.js`:

```js
// Pure helpers shared by the content script and the service worker.
// No chrome.* APIs here so node's test runner can import this file.

export function isMagnetLink(href) {
  return typeof href === 'string' && href.startsWith('magnet:');
}

export function isTorrentLink(href) {
  if (typeof href !== 'string') return false;
  try {
    const url = new URL(href, 'http://placeholder.invalid');
    return /\.torrent$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function matchSiteRuleProfileId(rules, hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return undefined;
  for (const rule of rules ?? []) {
    for (const domain of rule.domains ?? []) {
      const normalized = String(domain).trim().toLowerCase();
      if (!normalized) continue;
      if (host === normalized || host.endsWith(`.${normalized}`)) return rule.profileId;
    }
  }
  return undefined;
}

export function resolveProfileId({ explicitProfileId, rules, hostname, defaultProfileId }) {
  if (explicitProfileId) return explicitProfileId;
  const ruleProfileId = matchSiteRuleProfileId(rules, hostname);
  if (ruleProfileId) return ruleProfileId;
  return defaultProfileId;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test test/extension-resolve.test.js`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/resolve.js test/extension-resolve.test.js
git commit -m "Add pure link-detection and profile-resolution helpers for the extension (#59)"
```

---

### Task 3: Extension scaffold — manifest, icons, service worker

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/icons/icon16.png`, `extension/icons/icon48.png`, `extension/icons/icon128.png` (copied from `src/web/icons/`)
- Create: `extension/background.js`

- [ ] **Step 1: Copy icons**

```bash
mkdir -p extension/icons
cp src/web/icons/putiorr-icon-16.png extension/icons/icon16.png
cp src/web/icons/putiorr-icon-48.png extension/icons/icon48.png
cp src/web/icons/putiorr-icon-128.png extension/icons/icon128.png
```

- [ ] **Step 2: Create the manifest**

Create `extension/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "putiorr grab",
  "version": "0.1.0",
  "description": "Send magnet links and .torrent files to putiorr",
  "permissions": ["storage", "notifications", "contextMenus"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],
  "options_page": "options.html",
  "web_accessible_resources": [
    { "resources": ["lib/resolve.js"], "matches": ["<all_urls>"] }
  ],
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

Why: `type: "module"` lets `background.js` statically import `lib/resolve.js`; `web_accessible_resources` lets the content script dynamically import the same file; `<all_urls>` covers both click capture on any tracker and fetches to the putiorr origin.

- [ ] **Step 3: Create the service worker**

Create `extension/background.js`:

```js
import { isMagnetLink, resolveProfileId } from './lib/resolve.js';

const MENU_ROOT = 'putiorr-root';
const MENU_CONFIGURE = 'putiorr-configure';
const MENU_PREFIX = 'putiorr-profile-';

const SYNC_DEFAULTS = {
  baseUrl: '',
  defaultProfileId: 0,
  autoCapture: true,
  rules: [],
  profiles: [],
};

async function loadSettings() {
  const sync = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const local = await chrome.storage.local.get({ username: '', password: '' });
  return { ...sync, ...local };
}

function authHeaders(settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.username || settings.password) {
    headers.Authorization = `Basic ${btoa(`${settings.username}:${settings.password}`)}`;
  }
  return headers;
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: String(message ?? ''),
  });
}

async function postGrab(settings, payload) {
  let response;
  try {
    response = await fetch(new URL('/api/grab', settings.baseUrl), {
      method: 'POST',
      headers: authHeaders(settings),
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`putiorr is unreachable at ${settings.baseUrl}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `putiorr responded with ${response.status}`);
  }
  return body;
}

async function handleGrab(payload) {
  const settings = await loadSettings();
  if (!settings.baseUrl) {
    notify('putiorr grab failed', 'Set the putiorr URL in the extension options first');
    return { ok: false, error: 'putiorr is not configured' };
  }
  const hostname = (() => {
    try {
      return new URL(payload.pageUrl).hostname;
    } catch {
      return '';
    }
  })();
  const profileId = resolveProfileId({
    explicitProfileId: payload.profileId,
    rules: settings.rules,
    hostname,
    defaultProfileId: settings.defaultProfileId,
  });
  if (!profileId) {
    notify('putiorr grab failed', 'No profile matches this site; set a default profile in options');
    return { ok: false, error: 'no profile configured' };
  }
  const profileName = settings.profiles.find((profile) => profile.id === profileId)?.name ?? `profile #${profileId}`;
  try {
    const result = await postGrab(settings, {
      profileId,
      magnet: payload.magnet,
      torrentBase64: payload.torrentBase64,
      filename: payload.filename,
      sourceUrl: payload.pageUrl,
    });
    notify(`Sent to putiorr → ${profileName}`, result.transfer?.name ?? '');
    return { ok: true };
  } catch (error) {
    notify('putiorr grab failed', error.message);
    return { ok: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== 'grab') return undefined;
  handleGrab(message).then(sendResponse);
  return true;
});

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const settings = await loadSettings();
  chrome.contextMenus.create({ id: MENU_ROOT, title: 'Send to putiorr', contexts: ['link'] });
  if (!settings.profiles.length) {
    chrome.contextMenus.create({
      id: MENU_CONFIGURE,
      parentId: MENU_ROOT,
      title: 'Configure putiorr…',
      contexts: ['link'],
    });
    return;
  }
  for (const profile of settings.profiles) {
    chrome.contextMenus.create({
      id: `${MENU_PREFIX}${profile.id}`,
      parentId: MENU_ROOT,
      title: profile.name,
      contexts: ['link'],
    });
  }
}

chrome.runtime.onInstalled.addListener(rebuildMenus);
chrome.runtime.onStartup.addListener(rebuildMenus);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.profiles) rebuildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_CONFIGURE) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (!String(info.menuItemId).startsWith(MENU_PREFIX)) return;
  const profileId = Number(String(info.menuItemId).slice(MENU_PREFIX.length));
  const linkUrl = info.linkUrl ?? '';
  const pageUrl = tab?.url ?? info.pageUrl ?? '';
  if (isMagnetLink(linkUrl)) {
    await handleGrab({ magnet: linkUrl, pageUrl, profileId });
    return;
  }
  if (!tab?.id) {
    notify('putiorr grab failed', 'No tab available to fetch the link');
    return;
  }
  // Fetch the .torrent from the page context so tracker session cookies apply.
  try {
    const fetched = await chrome.tabs.sendMessage(tab.id, { kind: 'fetch-link', url: linkUrl });
    if (!fetched?.ok) throw new Error(fetched?.error ?? 'failed to fetch the link');
    await handleGrab({
      torrentBase64: fetched.torrentBase64,
      filename: fetched.filename,
      pageUrl,
      profileId,
    });
  } catch (error) {
    notify('putiorr grab failed', error.message);
  }
});
```

- [ ] **Step 4: Verify the pieces parse as valid JS/JSON**

Run: `node --input-type=module -e "await import('./extension/lib/resolve.js'); JSON.parse(await (await import('node:fs/promises')).readFile('extension/manifest.json', 'utf8')); console.log('ok')"`
Expected: `ok` (background.js can't be imported in node because it references `chrome`; syntax-check it instead):

Run: `node --check extension/background.js`
Expected: no output (syntax OK).

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/icons extension/background.js
git commit -m "Add extension manifest, icons, and service worker (#59)"
```

---

### Task 4: Content script — click capture and page-context fetch

**Files:**
- Create: `extension/content.js`

- [ ] **Step 1: Implement the content script**

Create `extension/content.js`:

```js
// Captures clicks on magnet:/.torrent links and forwards them to the service
// worker. .torrent files are fetched here, in the page context, so
// private-tracker session cookies apply. Not a module (content scripts can't
// be), so shared helpers load via dynamic import.

(() => {
  const bypass = new WeakSet();
  let lib;
  let autoCapture = true;

  import(chrome.runtime.getURL('lib/resolve.js')).then((module) => {
    lib = module;
  });

  chrome.storage.sync.get({ autoCapture: true }).then((value) => {
    autoCapture = value.autoCapture;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.autoCapture) autoCapture = changes.autoCapture.newValue;
  });

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function filenameFrom(response, url) {
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
    const base = new URL(url, window.location.href).pathname.split('/').pop();
    return base || 'upload.torrent';
  }

  async function fetchTorrent(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`fetch failed with ${response.status}`);
    const buffer = await response.arrayBuffer();
    return { torrentBase64: arrayBufferToBase64(buffer), filename: filenameFrom(response, url) };
  }

  function refire(anchor) {
    bypass.add(anchor);
    anchor.click();
  }

  document.addEventListener('click', (event) => {
    if (!lib || !autoCapture || event.button !== 0 || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    if (bypass.has(anchor)) {
      bypass.delete(anchor);
      return;
    }
    const href = anchor.href;
    const magnet = lib.isMagnetLink(href);
    if (!magnet && !lib.isTorrentLink(href)) return;
    event.preventDefault();
    event.stopPropagation();
    (async () => {
      try {
        const payload = magnet
          ? { kind: 'grab', magnet: href, pageUrl: window.location.href }
          : { kind: 'grab', ...(await fetchTorrent(href)), pageUrl: window.location.href };
        await chrome.runtime.sendMessage(payload);
      } catch (error) {
        // Capture failed before reaching putiorr (e.g. the .torrent fetch
        // errored). Fall through to the normal browser download so the user
        // is never stuck. Grab failures reported by putiorr already surfaced
        // as a notification from the service worker.
        console.warn('[putiorr] capture failed, falling back to normal download:', error);
        if (!magnet) refire(anchor);
      }
    })();
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind !== 'fetch-link') return undefined;
    fetchTorrent(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
```

- [ ] **Step 2: Syntax-check**

Run: `node --check extension/content.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add extension/content.js
git commit -m "Add content script click capture with page-context torrent fetch (#59)"
```

---

### Task 5: Options page

**Files:**
- Create: `extension/options.html`
- Create: `extension/options.js`

- [ ] **Step 1: Create the options page markup**

Create `extension/options.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>putiorr grab options</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 42rem; padding: 0 1rem; }
    label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
    input[type="text"], input[type="password"], input[type="url"] { width: 100%; padding: 0.4rem; box-sizing: border-box; }
    table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
    th, td { text-align: left; padding: 0.3rem 0.5rem 0.3rem 0; }
    td input[type="text"] { width: 100%; box-sizing: border-box; }
    button { margin-top: 0.75rem; padding: 0.4rem 0.9rem; }
    #status { margin-left: 0.75rem; }
    .hint { color: #666; font-size: 0.9rem; margin: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>putiorr grab</h1>

  <label for="baseUrl">putiorr URL</label>
  <input id="baseUrl" type="url" placeholder="http://nas:9091">

  <label for="username">Username</label>
  <input id="username" type="text" autocomplete="off">

  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="off">

  <button id="loadProfiles" type="button">Test connection &amp; load profiles</button>
  <span id="status"></span>

  <label for="defaultProfile">Default profile</label>
  <select id="defaultProfile"></select>
  <p class="hint">Use a dedicated profile with “auto-remove completed” enabled so finished browser grabs are cleaned up like prowlarr grabs.</p>

  <label><input id="autoCapture" type="checkbox" checked> Auto-capture magnet and .torrent clicks</label>

  <h2>Site rules</h2>
  <p class="hint">Grabs from these domains use the selected profile instead of the default. Subdomains match automatically.</p>
  <table>
    <thead><tr><th>Domains (comma separated)</th><th>Profile</th><th></th></tr></thead>
    <tbody id="rules"></tbody>
  </table>
  <button id="addRule" type="button">Add rule</button>

  <div>
    <button id="save" type="button">Save</button>
  </div>

  <script src="options.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Implement the options logic**

Create `extension/options.js`:

```js
const el = (id) => document.getElementById(id);

let profiles = [];

function setStatus(message, ok = true) {
  const status = el('status');
  status.textContent = message;
  status.style.color = ok ? 'inherit' : '#c0392b';
}

function profileOptions(selected) {
  return profiles
    .map((profile) => `<option value="${profile.id}"${profile.id === selected ? ' selected' : ''}>${profile.name}</option>`)
    .join('');
}

function renderProfileSelects(defaultProfileId) {
  el('defaultProfile').innerHTML = profileOptions(defaultProfileId);
  for (const select of document.querySelectorAll('#rules select')) {
    const current = Number(select.value);
    select.innerHTML = profileOptions(current);
  }
}

function addRuleRow(rule = { domains: [], profileId: 0 }) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><input type="text" class="rule-domains" placeholder="x.example, z.example"></td>
    <td><select class="rule-profile">${profileOptions(rule.profileId)}</select></td>
    <td><button type="button" class="rule-remove">Remove</button></td>
  `;
  row.querySelector('.rule-domains').value = (rule.domains ?? []).join(', ');
  row.querySelector('.rule-remove').addEventListener('click', () => row.remove());
  el('rules').append(row);
}

function collectRules() {
  const rules = [];
  for (const row of el('rules').querySelectorAll('tr')) {
    const domains = row.querySelector('.rule-domains').value
      .split(',')
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean);
    const profileId = Number(row.querySelector('.rule-profile').value);
    if (domains.length && profileId) rules.push({ domains, profileId });
  }
  return rules;
}

async function loadProfilesFromPutiorr() {
  const baseUrl = el('baseUrl').value.trim();
  if (!baseUrl) {
    setStatus('Enter the putiorr URL first', false);
    return;
  }
  const headers = {};
  const username = el('username').value;
  const password = el('password').value;
  if (username || password) headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
  try {
    const response = await fetch(new URL('/api/profiles', baseUrl), { headers });
    if (!response.ok) throw new Error(`putiorr responded with ${response.status}`);
    const list = await response.json();
    profiles = list
      .filter((profile) => profile.enabled)
      .map((profile) => ({ id: profile.id, name: profile.name }));
    renderProfileSelects(Number(el('defaultProfile').value));
    setStatus(`Loaded ${profiles.length} profile(s)`);
  } catch (error) {
    setStatus(error.message, false);
  }
}

async function restore() {
  const sync = await chrome.storage.sync.get({
    baseUrl: '',
    defaultProfileId: 0,
    autoCapture: true,
    rules: [],
    profiles: [],
  });
  const local = await chrome.storage.local.get({ username: '', password: '' });
  profiles = sync.profiles;
  el('baseUrl').value = sync.baseUrl;
  el('username').value = local.username;
  el('password').value = local.password;
  el('autoCapture').checked = sync.autoCapture;
  el('defaultProfile').innerHTML = profileOptions(sync.defaultProfileId);
  for (const rule of sync.rules) addRuleRow(rule);
}

async function save() {
  await chrome.storage.sync.set({
    baseUrl: el('baseUrl').value.trim(),
    defaultProfileId: Number(el('defaultProfile').value) || 0,
    autoCapture: el('autoCapture').checked,
    rules: collectRules(),
    profiles,
  });
  await chrome.storage.local.set({
    username: el('username').value,
    password: el('password').value,
  });
  setStatus('Saved');
}

el('loadProfiles').addEventListener('click', loadProfilesFromPutiorr);
el('addRule').addEventListener('click', () => addRuleRow());
el('save').addEventListener('click', save);
restore();
```

- [ ] **Step 3: Syntax-check**

Run: `node --check extension/options.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add extension/options.html extension/options.js
git commit -m "Add extension options page with site rules (#59)"
```

---

### Task 6: Documentation and full verification

**Files:**
- Create: `extension/README.md`
- Modify: `README.md` (add a "Browser Extension" section after the "Status" section)

- [ ] **Step 1: Write the extension README**

Create `extension/README.md`:

```markdown
# putiorr grab — Chrome extension

Captures `magnet:` links and `.torrent` downloads on any site and sends them
to putiorr, which adds them to put.io and downloads them locally according to
the selected putiorr profile.

## Install (load unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select this `extension/` directory.

## Configure

1. Open the extension options.
2. Enter the putiorr URL (e.g. `http://nas:9091`) and, if putiorr uses Basic
   auth, the username and password.
3. Click **Test connection & load profiles**, then pick a default profile.
4. Optionally add site rules: grabs from the listed domains use the selected
   profile instead of the default. Subdomains match automatically.

Create a dedicated putiorr profile for browser grabs and enable
**auto-remove completed** on it. Browser grabs have no *arr app to import
them, so — like the prowlarr profile — completed transfers are removed from
putiorr and put.io while the downloaded files stay on disk.

## Use

- Click any `magnet:` or `.torrent` link: it is captured and sent to putiorr
  (profile resolved as: site rule → default). A notification reports the
  result. Auto-capture can be toggled off in options.
- Right-click any link → **Send to putiorr → <profile>**: sends that link to
  a specific profile. This also works for trackers whose download URLs do not
  end in `.torrent` (e.g. `download.php?id=…`).
- `.torrent` files are fetched inside the page, so private-tracker session
  cookies apply. If the fetch fails, the click falls through to a normal
  browser download.
```

- [ ] **Step 2: Add the README section**

In `README.md`, after the "Status" section's bullet/method list and before "Quick Start With Docker Compose", add:

```markdown
## Browser Extension

The [`extension/`](extension) directory contains a Chrome (Manifest V3)
extension that captures `magnet:` links and `.torrent` downloads on any site
and sends them to putiorr via `POST /api/grab`. Profiles are resolved per
site rule with a configurable default, and completed grabs are cleaned up
like prowlarr grabs when the target profile has auto-remove enabled. See
[`extension/README.md`](extension/README.md) for setup.
```

- [ ] **Step 3: Run everything**

Run: `pnpm test && node scripts/lint.js`
Expected: all tests PASS, lint clean.

- [ ] **Step 4: Manual smoke test against the compose stack**

1. `cd putiorr-compose && docker compose up -d --build` (or run `pnpm run dev` locally with a valid put.io token).
2. Load the unpacked extension, point it at the putiorr URL, load profiles, set a default.
3. On any tracker page, click a magnet link → expect a "Sent to putiorr" notification and the transfer visible in the putiorr dashboard.
4. Click a `.torrent` link → same expectation, and the put.io transfer is created from the uploaded file.
5. Right-click a link → "Send to putiorr → <other profile>" → transfer lands under that profile's folder.

Record any deviations; do not mark this step complete on failures.

- [ ] **Step 5: Commit**

```bash
git add extension/README.md README.md
git commit -m "Document the browser grab extension (#59)"
```

---

### Task 7: Pull request

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/browser-grab-extension
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create \
  --title "Browser grab extension and POST /api/grab (#59)" \
  --body "$(cat <<'EOF'
Closes #59.

- `POST /api/grab` routes browser grabs through the existing `service.addTorrent()` profile machinery; warns when the target profile keeps completed transfers.
- Chrome MV3 extension in `extension/`: click capture for magnet/.torrent links, page-context torrent fetch (tracker cookies apply), context-menu per-profile override, site rules (domains → profile), options page, notifications.
- Pure logic (`extension/lib/resolve.js`) covered by node tests; endpoint covered by `test/api-grab.test.js`.

Spec: `docs/superpowers/specs/2026-07-25-browser-grab-extension-design.md`
Plan: `docs/superpowers/plans/2026-07-25-browser-grab-extension.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed; PR references and will close issue #59.
