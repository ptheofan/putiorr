import { encodeCredentials } from './lib/auth.js';
import { sanitizeProfiles } from './lib/resolve.js';
import { SYNC_DEFAULTS, validateBaseUrl } from './lib/settings.js';

// This page is the only place the extension's settings can be repaired, so it
// refuses to store a value it cannot use and reports every rewrite it makes.
// Which sites route to which profile is putiorr's setting now, so everything
// about them here is read-only. Nothing builds markup from data: profile names
// and domains come from the server.

const PROFILES_TIMEOUT_MS = 15000;

const el = (id) => document.getElementById(id);

// The cached {id, name} list the worker's context menu is built from.
let profiles = [];
// One row per profile: `{ name, sites, known }`. Only a load knows the sites —
// they are deliberately not cached, since they would be stale the moment
// someone edits a profile in putiorr — so a restored page lists the names it
// does have and says the sites are the part it cannot know.
let profileSites = [];

function cachedProfileRows() {
  return profiles.map((profile) => ({ name: profile.name, sites: [], known: false }));
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

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

// The placeholder is deliberate: without it a fresh selection would silently
// point at whichever profile happens to sort first.
function renderDefaultProfileSelect(selectedId) {
  const select = el('defaultProfile');
  // With no profiles loaded, "No default profile" reads as a choice the user
  // declined to make rather than one they cannot make yet.
  const placeholder = profiles.length ? 'No default profile' : 'Load profiles first';
  select.replaceChildren(createOption('', placeholder));
  for (const profile of profiles) select.append(createOption(String(profile.id), profile.name));
  select.value = profiles.some((profile) => profile.id === selectedId) ? String(selectedId) : '';
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
    empty.textContent = 'Test the connection to see which sites putiorr routes to which profile.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...profileSites.map(({ name, sites, known }) => {
    const row = document.createElement('div');
    row.className = 'profile-row';
    // "no sites" is a fact putiorr just stated; the cached list has no such
    // fact to state, and claiming one would contradict the next load.
    const text = known
      ? (sites.length ? sites.join(', ') : 'no sites')
      : 'sites unknown until you load';
    row.append(
      createCell('span', 'profile-row-name', name),
      createCell('span', known && sites.length ? 'profile-row-sites' : 'profile-row-sites is-empty', text),
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

  const defaultProfileId = Number(el('defaultProfile').value) || 0;

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
      defaultProfileId,
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
  } else if (!defaultProfileId) {
    notes.push('No default profile: only sites configured in putiorr and the right-click menu will grab');
  }
  setStatus(['Saved', ...notes], 'ok');
}

async function fetchProfiles(baseUrl, headers) {
  let response;
  try {
    response = await fetch(new URL('/api/profiles', baseUrl), {
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
  // The rows come back whole: the browser sites are shown from them, and only
  // the cached {id, name} pairs are stored.
  return body.filter((profile) => profile?.enabled);
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

  const loaded = sanitizeProfiles(rows);

  // An empty answer is never worth applying: it would clear the profile list and
  // every selection on the page, and the next Save would commit that loss under
  // a green "Saved" — including to the worker's context menu. A putiorr with no
  // enabled profiles and a URL pointing at the wrong host look identical here.
  if (!loaded.length) {
    setStatus(`putiorr at ${url.baseUrl} has no enabled profiles; create one there first`, 'error');
    return;
  }

  // The selection that the new list may no longer contain is about to be
  // cleared by the re-render, so it is read while it is still on screen.
  const previousDefault = Number(el('defaultProfile').value) || 0;

  const sitesById = new Map(rows.map((row) => [Number(row?.id), browserSitesOf(row)]));
  profiles = loaded;
  profileSites = loaded.map((profile) => ({
    name: profile.name,
    sites: sitesById.get(profile.id) ?? [],
    known: true,
  }));
  renderDefaultProfileSelect(previousDefault);
  renderProfileSites();

  const notes = [];
  if (previousDefault && !loaded.some((profile) => profile.id === previousDefault)) {
    notes.push(`Profile #${previousDefault} no longer exists: pick a new default`);
  }
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

  const defaultProfileId = Number(sync.defaultProfileId) || 0;
  renderDefaultProfileSelect(defaultProfileId);
  // The select below is built from the same cached names, so an empty card
  // here would contradict a dropdown the user can see is populated.
  profileSites = cachedProfileRows();
  renderProfileSites();

  if (Array.isArray(sync.rules) && sync.rules.length) renderLegacyRules(sync.rules);

  if (defaultProfileId && !profiles.some((profile) => profile.id === defaultProfileId)) {
    setStatus(`Saved default profile #${defaultProfileId} is not in the stored list; load profiles again`, 'error');
  }
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
