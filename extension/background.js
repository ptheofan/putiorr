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
  // storage.sync can hold data written by a different extension version, so the
  // array shapes are normalized here; callers below index them without guards.
  return {
    ...sync,
    ...local,
    profiles: Array.isArray(sync.profiles) ? sync.profiles : [],
    rules: Array.isArray(sync.rules) ? sync.rules : [],
  };
}

function authHeaders(settings) {
  // X-Putiorr-Grab is the anti-CSRF token /api/grab requires; the extension
  // is exempt from CORS via host_permissions, attacker web pages are not.
  const headers = { 'Content-Type': 'application/json', 'X-Putiorr-Grab': '1' };
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== 'grab') return undefined;
  // The .catch matters: an unhandled rejection would close the message port
  // silently and a magnet click (already preventDefault-ed) would do nothing.
  handleGrab(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
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
  // Every grab path stays inside this try: an escaping rejection would be an
  // unhandled promise in an event listener, leaving the click with no feedback.
  try {
    if (isMagnetLink(linkUrl)) {
      await handleGrab({ magnet: linkUrl, pageUrl, profileId });
      return;
    }
    if (!tab?.id) {
      notify('putiorr grab failed', 'No tab available to fetch the link');
      return;
    }
    // Fetch the .torrent from the page context so tracker session cookies apply.
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
