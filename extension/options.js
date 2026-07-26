import { encodeCredentials } from './lib/auth.js';
import { sanitizeProfiles } from './lib/resolve.js';
import { SYNC_DEFAULTS, validateBaseUrl } from './lib/settings.js';

// This page is the only place the extension's settings can be repaired, so it
// refuses to store a value it cannot use and reports every rewrite it makes.
// Where a grab lands is putiorr's setting now — which sites a profile claims,
// and which profile takes the sites nobody claimed — so everything about it
// here is read-only. Nothing builds markup from data: profile names and domains
// come from the server.

const PROFILES_TIMEOUT_MS = 15000;

const el = (id) => document.getElementById(id);

// The cached {id, name} list the worker's context menu is built from.
let profiles = [];
// One row per profile: `{ name, sites, catchAll, known }`. Only a load knows
// where a profile takes its grabs from — that is not cached, since it would be
// stale the moment someone edits a profile in putiorr — so a restored page
// lists the names it does have and says the routing is the part it cannot know.
let profileSites = [];

function cachedProfileRows() {
  return profiles.map((profile) => ({ name: profile.name, sites: [], catchAll: false, known: false }));
}

// Tones: 'note' for a request in flight, 'ok' for news that landed, 'error'
// for a refusal — "Saved" and "Contacting putiorr…" are not the same news.
// 'note' is the absence of a class; anything else is used as one, so a tone
// this page does not style shows up unstyled instead of passing for neutral.
function setStatus(message, tone = 'note') {
  const status = el('status');
  const lines = Array.isArray(message) ? message.filter(Boolean) : [message];
  status.textContent = lines.join('\n');
  status.className = tone === 'note' ? '' : tone;
  // The status line sits with the connection card and Save at the bottom:
  // without this, a refused save looks like a button that does nothing at all.
  status.scrollIntoView?.({ block: 'nearest' });
}

// Domains reach this page from putiorr and from storage written by an older
// version of the extension; neither is guaranteed to be a list of strings.
function cleanDomains(value) {
  return (Array.isArray(value) ? value : [])
    .map((domain) => String(domain ?? '').trim())
    .filter(Boolean);
}

// /api/profiles answers with both key styles; either one is the mapping, and a
// row written by an older putiorr has neither.
function browserSitesOf(row) {
  return cleanDomains(Array.isArray(row?.browser_domains) ? row.browser_domains : row?.browserDomains);
}

// The profile that takes a grab from a site nobody listed. It is why the
// Default profile dropdown used to be on this page, so the card has to answer
// it — read from putiorr on every load rather than stored, exactly like sites.
function catchAllOf(row) {
  return Boolean(row?.browser_catch_all ?? row?.browserCatchAll);
}

// What this profile actually takes, in one line. "no sites" is a fact putiorr
// just stated; the cached list has no such fact to state, and claiming one
// would contradict the next load.
function profileRoutingText({ sites, catchAll, known }) {
  if (!known) return 'routing unknown until you load';
  if (catchAll) {
    return sites.length
      ? `${sites.join(', ')}, and any site no other profile claims`
      : 'any site no other profile claims';
  }
  return sites.length ? sites.join(', ') : 'no sites';
}

function createCell(tagName, className, text) {
  const cell = document.createElement(tagName);
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function renderProfileSites() {
  const list = el('profileList');
  if (!profileSites.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = 'Test the connection to see which grabs putiorr routes to which profile.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...profileSites.map((entry) => {
    const row = document.createElement('div');
    row.className = 'profile-row';
    const routes = entry.known && (entry.sites.length || entry.catchAll);
    row.append(
      createCell('span', 'profile-row-name', entry.name),
      createCell(
        'span',
        routes ? 'profile-row-sites' : 'profile-row-sites is-empty',
        profileRoutingText(entry),
      ),
    );
    return row;
  }));
}

// Rules stored by an older version are shown once and then dropped. They are
// never pushed to putiorr: only the user knows whether that mapping is still
// what they want, and a profile there may not even exist any more.
function renderLegacyRules(rules) {
  el('legacyRules').replaceChildren(...rules.map((rule) => {
    const domains = cleanDomains(rule?.domains);
    const profileId = Number(rule?.profileId) || 0;
    const name = profiles.find((profile) => profile.id === profileId)?.name
      ?? (profileId ? `#${profileId}` : 'no profile');
    return createCell('li', 'legacy-rule', `${domains.join(', ') || 'no sites'} → ${name}`);
  }));
  el('legacyNotice').hidden = false;
}

// The notice is only hidden once the key is actually gone: hiding it on a
// failed remove would bring it straight back on the next reload.
async function dismissLegacyRules() {
  try {
    await chrome.storage.sync.remove('rules');
  } catch (error) {
    throw new Error(`The old site rules could not be removed: ${error.message}`);
  }
  el('legacyRules').replaceChildren();
  el('legacyNotice').hidden = true;
}

async function save() {
  const url = validateBaseUrl(el('baseUrl').value);
  if (!url.ok) {
    setStatus(url.error, 'error');
    return;
  }

  // Write the stored form back into the field: normalization here is otherwise
  // invisible, and a URL that is not what is on screen is the hardest kind of
  // misconfiguration to notice.
  el('baseUrl').value = url.baseUrl;

  // Credentials go first, and stay in storage.local: storage.sync is
  // synchronized to the user's Google account, and putiorr's password does not
  // belong there. Settings can be retyped from what is on screen; a password
  // that failed to store while the rest of the save reported success cannot.
  try {
    await chrome.storage.local.set({
      username: el('username').value,
      password: el('password').value,
    });
  } catch (error) {
    setStatus(`The username and password could not be stored: ${error.message}`, 'error');
    return;
  }

  try {
    await chrome.storage.sync.set({
      baseUrl: url.baseUrl,
      autoCapture: el('autoCapture').checked,
      // The service worker sanitizes what it reads, but storing a clean list keeps
      // a malformed profile out of the context menu in the first place.
      profiles: sanitizeProfiles(profiles),
    });
  } catch (error) {
    setStatus(`The username and password were saved, but the settings were not: ${error.message}`, 'error');
    return;
  }

  const notes = [];
  if (!profiles.length) {
    // With no profiles stored the right-click menu offers only "Configure…",
    // so nothing at all can grab yet.
    notes.push('No profiles loaded: nothing can grab until you load profiles and Save');
  }
  setStatus(['Saved', ...notes], 'ok');
}

async function fetchProfiles(baseUrl, headers) {
  let response;
  try {
    // ?type=grab is putiorr's filter, not one this page could apply itself: the
    // preset vocabulary lives there. Only a Putiorr Grab profile can accept a
    // grab, so listing any other kind here would offer a pick putiorr refuses.
    response = await fetch(new URL('/api/profiles?type=grab', baseUrl), {
      headers,
      // A sleeping NAS accepts the connection and then says nothing; without a
      // deadline the button would stay on "Contacting putiorr…" forever.
      signal: AbortSignal.timeout(PROFILES_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`putiorr did not respond within ${PROFILES_TIMEOUT_MS / 1000}s at ${baseUrl}`);
    }
    throw new Error(`putiorr is unreachable at ${baseUrl}`);
  }

  if (response.status === 401) {
    throw new Error('putiorr rejected the credentials; check username and password');
  }
  if (!response.ok) throw new Error(`putiorr responded with ${response.status}`);

  const body = await response.json().catch(() => undefined);
  if (!Array.isArray(body)) throw new Error(`${baseUrl} did not answer with a profile list; check the URL`);
  // The rows come back whole and unfiltered by `enabled`: the browser sites are
  // shown from them, only the cached {id, name} pairs are stored, and the
  // caller needs the disabled ones to tell its two empty states apart.
  return body;
}

// Three different answers end up with nothing to show, and only one of them is
// "create a profile". A row this page had to drop is a putiorr that answered
// with grab profiles, and a disabled row is a profile that exists: telling
// either user that none exist sends them to make a second one.
function emptyProfilesComplaint(rows, enabledRows) {
  if (enabledRows.length) {
    return 'answered with Putiorr Grab profiles this page could not read; check that the URL points at putiorr';
  }
  if (rows.length) return 'has no enabled Putiorr Grab profiles; enable one there';
  return 'has no Putiorr Grab profiles; create one there with the Putiorr Grab preset';
}

async function loadProfilesFromPutiorr() {
  const url = validateBaseUrl(el('baseUrl').value);
  if (!url.ok) {
    setStatus(url.error, 'error');
    return;
  }
  el('baseUrl').value = url.baseUrl;

  const username = el('username').value;
  const password = el('password').value;
  const headers = {};
  if (username || password) headers.Authorization = `Basic ${encodeCredentials(username, password)}`;

  setStatus('Contacting putiorr…');
  let rows;
  try {
    rows = await fetchProfiles(url.baseUrl, headers);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  // putiorr filtered by preset; `enabled` is filtered here, so a profile that
  // exists but is switched off is still a row this page has seen.
  const enabledRows = rows.filter((row) => row?.enabled);
  const loaded = sanitizeProfiles(enabledRows);

  // An empty answer is never worth applying: it would clear the profile list and
  // every selection on the page, and the next Save would commit that loss under
  // a green "Saved" — including to the worker's context menu. It is also the one
  // answer a wrong URL and a putiorr without the preset both produce, so the
  // status has to name the fix: a putiorr full of *arr profiles answers this
  // exactly like one with no profiles at all, since neither can accept a grab.
  if (!loaded.length) {
    setStatus(`putiorr at ${url.baseUrl} ${emptyProfilesComplaint(rows, enabledRows)}`, 'error');
    return;
  }

  const routingById = new Map(enabledRows.map((row) => [
    Number(row?.id),
    { sites: browserSitesOf(row), catchAll: catchAllOf(row) },
  ]));
  profiles = loaded;
  profileSites = loaded.map((profile) => ({
    name: profile.name,
    sites: routingById.get(profile.id)?.sites ?? [],
    catchAll: routingById.get(profile.id)?.catchAll ?? false,
    known: true,
  }));
  renderProfileSites();

  // A putiorr with no profile taking the rest refuses every grab from a site
  // none of them lists, and that refusal is the first the user hears of it —
  // on a link click, far from here. Saying so on the page that just read the
  // answer costs nothing.
  const notes = loaded.some((profile) => routingById.get(profile.id)?.catchAll)
    ? []
    : ['No profile takes grabs from unlisted sites: tick that box on one in putiorr, or those grabs are refused'];
  setStatus([`Loaded ${loaded.length} profile(s) — press Save to use them`, ...notes], 'ok');
}

async function restore() {
  // SYNC_DEFAULTS no longer lists the retired `rules` key and storage.get only
  // answers the keys it is asked for, so it is asked for here — in the same
  // read as the settings. A separate await for it would put an optional,
  // cosmetic notice in front of the form: its rejection would leave every field
  // empty, which looks like a first run and would overwrite the stored settings
  // on the next Save.
  const sync = await chrome.storage.sync.get({ ...SYNC_DEFAULTS, rules: [] });
  const local = await chrome.storage.local.get({ username: '', password: '' });

  // storage can hold data written by a different extension version, so every
  // shape is coerced before it reaches the form.
  profiles = sanitizeProfiles(sync.profiles);
  el('baseUrl').value = String(sync.baseUrl ?? '');
  el('username').value = String(local.username ?? '');
  el('password').value = String(local.password ?? '');
  el('autoCapture').checked = sync.autoCapture !== false;

  // The right-click menu is built from these same cached names, so the card
  // lists them rather than looking empty next to a menu that is populated.
  profileSites = cachedProfileRows();
  renderProfileSites();

  if (Array.isArray(sync.rules) && sync.rules.length) renderLegacyRules(sync.rules);
}

// storage.sync.set rejects on its own quota, and a rejection escaping a click
// listener would leave the page claiming nothing at all.
const reporting = (action) => () => action().catch((error) => setStatus(error.message, 'error'));

el('loadProfiles').addEventListener('click', reporting(loadProfilesFromPutiorr));
el('dismissLegacy').addEventListener('click', reporting(dismissLegacyRules));
el('save').addEventListener('click', reporting(save));
// An unhandled rejection here would leave an empty form that looks like a first
// run and would overwrite the stored settings on the next save.
restore().catch((error) => setStatus(`Could not read the stored settings: ${error.message}`, 'error'));
