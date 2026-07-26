import { encodeCredentials } from './lib/auth.js';
import { magnetFromLink, sanitizeProfiles } from './lib/resolve.js';
import { SYNC_DEFAULTS } from './lib/settings.js';

const MENU_ROOT = 'putiorr-root';
const MENU_CONFIGURE = 'putiorr-configure';
const MENU_PREFIX = 'putiorr-profile-';
// Same spelling as the menu entry, different namespace: menu ids and
// notification ids never meet.
const NOTIFY_CONFIGURE = 'putiorr-configure';

// Longer than the content script's fetch budget on purpose: putiorr waits on
// put.io during addTorrent, so the server legitimately needs the headroom. It
// stays under 30s all the same: that is when Chrome retires an idle MV3 worker,
// and a request timing out exactly on that line would race the teardown.
const GRAB_TIMEOUT_MS = 25000;

async function loadSettings() {
  const sync = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const local = await chrome.storage.local.get({ username: '', password: '' });
  // storage.sync can hold data written by a different extension version, so the
  // shapes are normalized here; callers below index them without guards.
  return {
    ...sync,
    ...local,
    profiles: sanitizeProfiles(sync.profiles),
  };
}

function authHeaders(settings) {
  // X-Putiorr-Grab is the anti-CSRF token /api/grab requires; the extension
  // is exempt from CORS via host_permissions, attacker web pages are not.
  const headers = { 'Content-Type': 'application/json', 'X-Putiorr-Grab': '1' };
  if (settings.username || settings.password) {
    headers.Authorization = `Basic ${encodeCredentials(settings.username, settings.password)}`;
  }
  return headers;
}

// An id makes the notification addressable from onClicked below; passing one
// also replaces the previous notification carrying it instead of stacking.
function notify(title, message, id) {
  const options = {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: String(message ?? ''),
  };
  if (id) chrome.notifications.create(id, options);
  else chrome.notifications.create(options);
}

// "Set the URL in the options" is otherwise a dead end: the notification cannot
// say where the options are, and nothing else on screen leads there.
chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIFY_CONFIGURE) chrome.runtime.openOptionsPage();
});

async function postGrab(settings, payload) {
  // The request is built outside the try below so a bad URL or unencodable
  // credentials surface as themselves instead of being reported as a dead server.
  let endpoint;
  try {
    endpoint = new URL('/api/grab', settings.baseUrl);
  } catch {
    throw new Error(`putiorr URL is not valid: ${settings.baseUrl}`);
  }
  const request = {
    method: 'POST',
    headers: authHeaders(settings),
    body: JSON.stringify(payload),
    // A sleeping NAS accepts the connection and then says nothing. Without a
    // deadline this fetch never settles, so the content script's sendMessage
    // hangs with it and the link stays stuck until Chrome tears the worker down.
    signal: AbortSignal.timeout(GRAB_TIMEOUT_MS),
  };

  let response;
  try {
    response = await fetch(endpoint, request);
  } catch (error) {
    // A host that is simply not there fails as a TypeError; only the deadline
    // produces these two. Saying "unreachable" for a server that answered the
    // connection and then stalled would send the user hunting the wrong fault.
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`putiorr did not respond within ${GRAB_TIMEOUT_MS / 1000}s at ${settings.baseUrl}`);
    }
    throw new Error(`putiorr is unreachable at ${settings.baseUrl}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    if (response.status === 401) {
      throw new Error('putiorr rejected the credentials; check username and password in options');
    }
    // The status rides along: the caller knows which of the ids it sent could
    // have produced a 404, and putiorr cannot know which of them was a stored
    // setting rather than a deliberate pick.
    throw Object.assign(new Error(body.error || `putiorr responded with ${response.status}`), {
      status: response.status,
    });
  }
  return body;
}

async function handleGrab(payload) {
  const settings = await loadSettings();
  if (!settings.baseUrl) {
    notify('putiorr grab failed', 'Set the putiorr URL in the extension options first — click here to open them', NOTIFY_CONFIGURE);
    return { ok: false, error: 'putiorr is not configured' };
  }
  const pageHost = (() => {
    try {
      return new URL(payload.pageUrl).hostname;
    } catch {
      return '';
    }
  })();
  // Which profile a site belongs to is putiorr's answer to give: it holds the
  // browser sites, and it holds the one profile set to take the sites nobody
  // listed. The worker only says where the click came from and which profile
  // the user picked by hand, if any.
  const explicitId = payload.profileId;
  const hasExplicitId = explicitId !== undefined && explicitId !== null && String(explicitId) !== '';
  try {
    const result = await postGrab(settings, {
      // An explicit pick is passed through as it came: putiorr refuses a value
      // that is not an id rather than quietly grabbing into some other profile.
      profileId: hasExplicitId ? explicitId : undefined,
      pageHost: pageHost || undefined,
      magnet: payload.magnet,
      torrentBase64: payload.torrentBase64,
      filename: payload.filename,
      sourceUrl: payload.pageUrl,
    });
    // The response names the profile that actually answered. The cached name is
    // only a fallback for a putiorr too old to send one, and only for an
    // explicit pick: with a site match there is nothing local left to guess.
    const cachedName = hasExplicitId
      ? settings.profiles.find((profile) => profile.id === Number(explicitId))?.name ?? `profile #${explicitId}`
      : '';
    const profileName = result.profile?.name ?? cachedName;
    notify(profileName ? `Sent to putiorr → ${profileName}` : 'Sent to putiorr', result.transfer?.name ?? '');
    return { ok: true };
  } catch (error) {
    // The one id a grab can still carry comes from the right-click menu, which
    // is built from the last Save — so a profile deleted in putiorr stays on it
    // until the next load, and that is the fix worth naming. "Profile not
    // found" alone would leave the user hunting a profile on a page that has no
    // idea it was deleted. The message is part of the test: any unrouted path
    // answers 404 too, and a putiorr too old to have /api/grab must keep
    // saying so.
    if (error.status === 404 && error.message === 'Profile not found' && hasExplicitId) {
      const message = `putiorr no longer has the profile you picked (#${explicitId}); load profiles again in the options — click here to open them`;
      notify('putiorr grab failed', message, NOTIFY_CONFIGURE);
      return { ok: false, error: message };
    }
    // Everything else is relayed as putiorr said it. The refusal a grab from an
    // unlisted site draws used to be rewritten here, back when the fix was the
    // extension's own Default profile setting; it is a checkbox on a putiorr
    // profile now, which putiorr's sentence names exactly. A second copy of it
    // on this side would be a copy free to drift — the extension and the server
    // ship and update on different schedules — and the options page it offered
    // to open can no longer fix it.
    notify('putiorr grab failed', error.message);
    return { ok: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Other installed extensions can message this worker; only our own content
  // script may spend the user's put.io account.
  if (sender?.id !== chrome.runtime.id) return undefined;
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

// Three triggers can fire close together, and rebuildMenus interleaves badly:
// a second removeAll landing mid-rebuild leaves ghost entries behind. Chaining
// every rebuild onto one promise keeps the runs strictly sequential.
let menuQueue = Promise.resolve();
function queueRebuild() {
  menuQueue = menuQueue.then(rebuildMenus).catch((error) => console.error('menu rebuild failed', error));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  queueRebuild();
  // A fresh install has no URL, so every link click would fail into a
  // notification before the user ever finds the options page. An update must not
  // reopen it: the settings are already there.
  if (details?.reason !== 'install') return;
  try {
    const { baseUrl } = await chrome.storage.sync.get({ baseUrl: '' });
    if (!baseUrl) chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('could not check the stored putiorr URL', error);
  }
});
chrome.runtime.onStartup.addListener(queueRebuild);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.profiles) queueRebuild();
});

function menuErrorMessage(error) {
  const message = error?.message ?? '';
  // The content script is missing on tabs that were open when the extension
  // loaded; Chrome's own wording for that is not actionable for a user.
  if (message.includes('Receiving end does not exist')) return 'Reload the page, then try again';
  return message;
}

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
    // Both a magnet: link and an http(s) handler link carrying one: asking the
    // tab to fetch the latter would upload the handler page's HTML to put.io.
    const magnet = magnetFromLink(linkUrl);
    if (magnet) {
      await handleGrab({ magnet, pageUrl, profileId });
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
    notify('putiorr grab failed', menuErrorMessage(error));
  }
});
