import { encodeCredentials } from './lib/auth.js';
import { sanitizeProfiles } from './lib/resolve.js';
import { parseRuleDomains, validateBaseUrl } from './lib/settings.js';

// This page is the only place the extension's settings can be repaired, so it
// refuses to store a value it cannot use and reports every rewrite it makes.
// Nothing here builds markup from data: profile names come from the server.

const PROFILES_TIMEOUT_MS = 15000;

const SYNC_DEFAULTS = {
  baseUrl: '',
  defaultProfileId: 0,
  autoCapture: true,
  rules: [],
  profiles: [],
};

const el = (id) => document.getElementById(id);

let profiles = [];
const ruleRows = [];

function setStatus(message, ok = true) {
  const status = el('status');
  const lines = Array.isArray(message) ? message.filter(Boolean) : [message];
  status.textContent = lines.join('\n');
  status.className = ok ? '' : 'error';
}

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

// The placeholder is deliberate: without it a fresh row would silently point at
// whichever profile happens to sort first.
function fillProfileSelect(select, selectedId, placeholder) {
  select.replaceChildren(createOption('', placeholder));
  for (const profile of profiles) select.append(createOption(String(profile.id), profile.name));
  select.value = profiles.some((profile) => profile.id === selectedId) ? String(selectedId) : '';
}

function defaultPlaceholder() {
  return profiles.length ? 'No default profile' : 'Load profiles first';
}

function renderProfileSelects(defaultProfileId) {
  fillProfileSelect(el('defaultProfile'), defaultProfileId, defaultPlaceholder());
  for (const { select } of ruleRows) {
    fillProfileSelect(select, Number(select.value) || 0, 'Pick a profile');
  }
}

function addRuleRow(rule = {}) {
  const row = document.createElement('tr');

  const domainsCell = document.createElement('td');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rule-domains';
  input.placeholder = 'x.example, z.example';
  input.value = (Array.isArray(rule.domains) ? rule.domains : []).join(', ');
  domainsCell.append(input);

  const profileCell = document.createElement('td');
  const select = document.createElement('select');
  select.className = 'rule-profile';
  profileCell.append(select);

  const removeCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    row.remove();
    const index = ruleRows.findIndex((entry) => entry.row === row);
    if (index >= 0) ruleRows.splice(index, 1);
  });
  removeCell.append(remove);

  row.append(domainsCell, profileCell, removeCell);
  el('rules').append(row);

  const entry = { row, input, select };
  ruleRows.push(entry);
  fillProfileSelect(select, Number(rule.profileId) || 0, 'Pick a profile');
  return entry;
}

// Rules are collected rather than saved so the caller can refuse the whole save:
// a half-stored rule set would send grabs to the wrong profile.
function collectRules() {
  const rules = [];
  const errors = [];
  const warnings = [];

  for (const { input, select } of ruleRows) {
    const parsed = parseRuleDomains(input.value);
    const profileId = Number(select.value) || 0;
    errors.push(...parsed.errors);
    warnings.push(...parsed.warnings);

    if (parsed.errors.length) continue;
    // An untouched row added by mistake is not an error, it is just empty.
    if (!parsed.domains.length && !profileId) continue;

    if (!parsed.domains.length) {
      errors.push('A site rule has a profile but no domains: add one or remove the row');
      continue;
    }
    if (!profileId) {
      errors.push(profiles.length
        ? `Pick a profile for the site rule "${parsed.domains.join(', ')}"`
        : `Load profiles before saving the site rule "${parsed.domains.join(', ')}"`);
      continue;
    }

    rules.push({ domains: parsed.domains, profileId, input });
  }

  return { rules, errors, warnings };
}

async function save() {
  const url = validateBaseUrl(el('baseUrl').value);
  if (!url.ok) {
    setStatus(url.error, false);
    return;
  }

  const collected = collectRules();
  if (collected.errors.length) {
    setStatus(collected.errors, false);
    return;
  }

  // Write the stored form back into the fields: normalization here is otherwise
  // invisible, and a rule that matches something other than what is on screen
  // is the hardest kind of misconfiguration to notice.
  el('baseUrl').value = url.baseUrl;
  for (const rule of collected.rules) rule.input.value = rule.domains.join(', ');

  const defaultProfileId = Number(el('defaultProfile').value) || 0;

  await chrome.storage.sync.set({
    baseUrl: url.baseUrl,
    defaultProfileId,
    autoCapture: el('autoCapture').checked,
    rules: collected.rules.map(({ domains, profileId }) => ({ domains, profileId })),
    // The service worker sanitizes what it reads, but storing a clean list keeps
    // a malformed profile out of the context menu in the first place.
    profiles: sanitizeProfiles(profiles),
  });
  // Credentials stay in storage.local: storage.sync is synchronized to the
  // user's Google account, and putiorr's password does not belong there.
  await chrome.storage.local.set({
    username: el('username').value,
    password: el('password').value,
  });

  const notes = [...collected.warnings];
  if (!defaultProfileId) {
    notes.push('No default profile: only site rules and the right-click menu will grab');
  }
  setStatus(['Saved', ...notes]);
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
  return sanitizeProfiles(body.filter((profile) => profile?.enabled));
}

async function loadProfilesFromPutiorr() {
  const url = validateBaseUrl(el('baseUrl').value);
  if (!url.ok) {
    setStatus(url.error, false);
    return;
  }
  el('baseUrl').value = url.baseUrl;

  const username = el('username').value;
  const password = el('password').value;
  const headers = {};
  if (username || password) headers.Authorization = `Basic ${encodeCredentials(username, password)}`;

  setStatus('Contacting putiorr…');
  let loaded;
  try {
    loaded = await fetchProfiles(url.baseUrl, headers);
  } catch (error) {
    setStatus(error.message, false);
    return;
  }

  // Selections that the new list no longer contains are about to be cleared by
  // the re-render, so they are counted while they are still on screen.
  const previousDefault = Number(el('defaultProfile').value) || 0;
  const keeps = (id) => loaded.some((profile) => profile.id === id);
  const lostRules = ruleRows.filter(({ select }) => {
    const id = Number(select.value) || 0;
    return id && !keeps(id);
  }).length;

  profiles = loaded;
  renderProfileSelects(previousDefault);

  if (!loaded.length) {
    setStatus(`putiorr at ${url.baseUrl} has no enabled profiles; create one there first`, false);
    return;
  }

  const notes = [];
  if (previousDefault && !keeps(previousDefault)) {
    notes.push(`Profile #${previousDefault} no longer exists: pick a new default`);
  }
  if (lostRules) {
    notes.push(`${lostRules} site rule(s) pointed at a profile that no longer exists: pick a new one`);
  }
  setStatus([`Loaded ${loaded.length} profile(s) — press Save to use them`, ...notes]);
}

async function restore() {
  const sync = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const local = await chrome.storage.local.get({ username: '', password: '' });

  // storage can hold data written by a different extension version, so every
  // shape is coerced before it reaches the form.
  profiles = sanitizeProfiles(sync.profiles);
  el('baseUrl').value = String(sync.baseUrl ?? '');
  el('username').value = String(local.username ?? '');
  el('password').value = String(local.password ?? '');
  el('autoCapture').checked = sync.autoCapture !== false;

  for (const rule of Array.isArray(sync.rules) ? sync.rules : []) addRuleRow(rule);

  const defaultProfileId = Number(sync.defaultProfileId) || 0;
  renderProfileSelects(defaultProfileId);

  if (defaultProfileId && !profiles.some((profile) => profile.id === defaultProfileId)) {
    setStatus(`Saved default profile #${defaultProfileId} is not in the stored list; load profiles again`, false);
  }
}

// storage.sync.set rejects on its own quota, and a rejection escaping a click
// listener would leave the page claiming nothing at all.
const reporting = (action) => () => action().catch((error) => setStatus(error.message, false));

el('loadProfiles').addEventListener('click', reporting(loadProfilesFromPutiorr));
el('addRule').addEventListener('click', () => addRuleRow());
el('save').addEventListener('click', reporting(save));
// An unhandled rejection here would leave an empty form that looks like a first
// run and would overwrite the stored settings on the next save.
restore().catch((error) => setStatus(`Could not read the stored settings: ${error.message}`, false));
