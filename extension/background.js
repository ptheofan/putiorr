import { encodeCredentials } from './lib/auth.js';
import { isTorrentLink, magnetFromLink, sanitizeProfiles } from './lib/resolve.js';
import { SYNC_DEFAULTS } from './lib/settings.js';
import { fetchTorrent, looksLikeMetainfo } from './lib/torrent.js';

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
    const transferName = result.transfer?.name ?? '';
    notify(profileName ? `Sent to putiorr → ${profileName}` : 'Sent to putiorr', transferName);
    // Both ride back to the caller rather than dying with the notification: the
    // page draws the same two facts, and the notification is not a channel that
    // can be relied on — macOS drops it under Focus, silently.
    return { ok: true, profileName, transferName };
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

// The worker's own .torrent fetch, which exists because a page's cannot always
// be made: a link that redirects to a download host or CDN leaves the page's
// origin behind, the response carries no Access-Control-Allow-Origin, and the
// fetch fails on a file that is perfectly reachable. This worker holds
// host_permissions and is not bound by the page's CORS, so it can get the file
// the page was refused.
//
// It is a rescue and stays one. The page is asked first everywhere, because
// only the page's fetch carries the tracker's session cookies: a cross-site
// request from here is not same-site with the tracker, so Chrome withholds
// every SameSite=Lax cookie and a tracker that gates downloads on its session
// refuses this attempt too.
async function fetchTorrentHere(url) {
  const file = await fetchTorrent(url);
  // What a redirect can land on. An HTML login or error page answers 200 and
  // would be uploaded to put.io as a torrent — putiorr refuses those, but a
  // refusal from putiorr is the end of the road, while a rescue that reports
  // failure still lets the click fall back to the browser and show the user
  // the page the tracker actually sent.
  if (!looksLikeMetainfo(file.torrentBase64)) throw new Error('that link did not answer with a .torrent file');
  return file;
}

function isHttpLink(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// This worker is exempt from CORS, so a fetch it will make on request is a
// fetch someone else cannot make for themselves — with the user's cookies
// attached and the bytes handed back to the asker. It must therefore only
// fetch what the extension would have fetched anyway: an http(s) link whose
// path ends in .torrent, which is the same rule the content script captures
// clicks on. Two things already narrow who may ask — the sender check below,
// and the absence of externally_connectable in the manifest, which is what
// stops a web page from messaging this worker at all — and this narrows what
// may be asked, so a content script that a page had somehow bent to its will
// still cannot turn the worker into a general-purpose proxy.
async function handleLinkFetch(url) {
  if (!isHttpLink(url) || !isTorrentLink(url)) {
    return { ok: false, error: 'that is not a .torrent link the extension will fetch' };
  }
  try {
    return { ok: true, ...(await fetchTorrentHere(url)) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Other installed extensions can message this worker; only our own content
  // script may spend the user's put.io account.
  if (sender?.id !== chrome.runtime.id) return undefined;
  if (message?.kind === 'fetch-torrent') {
    handleLinkFetch(message?.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.kind !== 'grab') return undefined;
  // The .catch matters: an unhandled rejection would close the message port
  // silently and a magnet click (already preventDefault-ed) would do nothing.
  handleGrab(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

// chrome.contextMenus.create returns the id immediately and registers the item
// a tick later, reporting failure through runtime.lastError rather than by
// throwing. Awaiting the callback is what makes a rebuild finish when its menu
// actually exists: without it rebuildMenus resolved with its creates still in
// flight, the queue below advanced into the next pass, and that pass cleared
// menus the first had not finished creating — every id then collided and the
// extension's error page filled with "Cannot create item with duplicate id".
// An unchecked lastError is also what made those failures silent.
function createMenu(properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  const settings = await loadSettings();
  await createMenu({ id: MENU_ROOT, title: 'Send to putiorr', contexts: ['link'] });
  if (!settings.profiles.length) {
    await createMenu({
      id: MENU_CONFIGURE,
      parentId: MENU_ROOT,
      title: 'Configure putiorr…',
      contexts: ['link'],
    });
    return;
  }
  for (const profile of settings.profiles) {
    // Sequential on purpose: a child cannot be created before its parent, and
    // the ordering of the profile list is the ordering of the menu.
    // eslint-disable-next-line no-await-in-loop
    await createMenu({
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
  menuQueue = menuQueue.then(rebuildMenus).catch((error) => console.error('menu create failed', error));
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

// A right-click grab happens entirely in here, so the page it came from learns
// nothing about it unless it is told. The id ties the acknowledgement to the
// answer, so the second resolves the first in place.
let feedbackSeq = 0;

async function drawOnTab(tabId, id, result, profileName = '') {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { kind: 'grab-feedback', id, result, profileName });
  } catch {
    // Every tab open before the extension loaded has no content script, and a
    // page can navigate mid-grab. Neither is a problem with the grab, and
    // letting this escape would report a grab that worked as a failure. The
    // notification is the channel that is left, which is why it stays.
  }
}

// The name to put on a pick's acknowledgement, before putiorr has been asked
// anything. Only the stored list can answer that, and only for a pick: it is
// the one grab whose profile the user named themselves.
//
// Unknown is answered with nothing rather than with "profile #8". Menus outlive
// the worker that built them, so a pick can name a profile the list has since
// lost — and handleGrab's own `profile #N` is a last-resort stand-in for an
// answer that arrived without a name, which is not this. The lookup must never
// cost the acknowledgement: a storage read that fails leaves the pick
// acknowledged unnamed, exactly as a click is.
async function pickedProfileName(profileId) {
  try {
    const settings = await loadSettings();
    return settings.profiles.find((profile) => profile.id === profileId)?.name ?? '';
  } catch {
    return '';
  }
}

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
  const feedbackId = ++feedbackSeq;
  // Before anything else: putiorr waits on put.io, and the menu has already
  // closed over a page that shows no sign of what was asked of it. The one
  // await ahead of it is a local storage read for the name the user just
  // picked, which is what lets the acknowledgement say it.
  await drawOnTab(tab?.id, feedbackId, undefined, await pickedProfileName(profileId));
  // Every grab path stays inside this try: an escaping rejection would be an
  // unhandled promise in an event listener, leaving the click with no feedback.
  try {
    // Both a magnet: link and an http(s) handler link carrying one: asking the
    // tab to fetch the latter would upload the handler page's HTML to put.io.
    const magnet = magnetFromLink(linkUrl);
    if (magnet) {
      await drawOnTab(tab?.id, feedbackId, await handleGrab({ magnet, pageUrl, profileId }));
      return;
    }
    if (!tab?.id) {
      notify('putiorr grab failed', 'No tab available to fetch the link');
      return;
    }
    // Fetch the .torrent from the page context so tracker session cookies
    // apply, and fall back to this worker's own fetch when that cannot be
    // done — the page is subject to CORS and to having no content script in it
    // at all, and neither says anything about whether the file can be had.
    // The rescue is not held to the .torrent path rule the message handler
    // applies: this URL is a link the user right-clicked, not one a page
    // asked for, and grabbing a "download.php?id=…" is the whole reason the
    // menu exists.
    let file = null;
    let pageError;
    try {
      const fetched = await chrome.tabs.sendMessage(tab.id, { kind: 'fetch-link', url: linkUrl });
      if (fetched?.ok) file = fetched;
      else pageError = new Error(fetched?.error ?? 'failed to fetch the link');
    } catch (error) {
      pageError = error;
    }
    if (!file && isHttpLink(linkUrl)) {
      file = await fetchTorrentHere(linkUrl).catch((error) => {
        console.warn('the extension could not fetch the link either', error);
        return null;
      });
    }
    // The page's failure is the one reported: it is the attempt that had the
    // tracker's cookies, so its 403 or its 404 is the answer that means
    // something to the user. The rescue only ever adds a way to succeed.
    if (!file) throw pageError ?? new Error('failed to fetch the link');
    await drawOnTab(tab.id, feedbackId, await handleGrab({
      torrentBase64: file.torrentBase64,
      filename: file.filename,
      pageUrl,
      profileId,
    }));
  } catch (error) {
    const message = menuErrorMessage(error);
    notify('putiorr grab failed', message);
    // The same words on the page, so an acknowledgement that is still up
    // resolves into the reason rather than sitting there for its full life.
    await drawOnTab(tab?.id, feedbackId, { ok: false, error: message });
  }
});
