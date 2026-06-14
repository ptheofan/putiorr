const state = {
  settings: undefined,
  profiles: [],
  downloads: [],
  expandedDownloads: new Set(),
  fileListScrollTops: new Map(),
  downloaderPolicyDirty: false,
  downloaderPolicyBaseline: '',
};

const el = {
  connectionState: document.querySelector('#connectionState'),
  connectionBadge: document.querySelector('#connectionBadge'),
  settingsForm: document.querySelector('#settingsForm'),
  putioToken: document.querySelector('#putioToken'),
  settingsMessage: document.querySelector('#settingsMessage'),
  oauthStartButton: document.querySelector('#oauthStartButton'),
  oauthPanel: document.querySelector('#oauthPanel'),
  oauthCode: document.querySelector('#oauthCode'),
  oauthLink: document.querySelector('#oauthLink'),
  oauthPollButton: document.querySelector('#oauthPollButton'),
  testConnectionButton: document.querySelector('#testConnectionButton'),
  downloaderSettingsForm: document.querySelector('#downloaderSettingsForm'),
  slowSpeedThreshold: document.querySelector('#slowSpeedThreshold'),
  slowSpeedDuration: document.querySelector('#slowSpeedDuration'),
  slowSpeedGrace: document.querySelector('#slowSpeedGrace'),
  slowSpeedMinSize: document.querySelector('#slowSpeedMinSize'),
  addProfileButton: document.querySelector('#addProfileButton'),
  profilesBody: document.querySelector('#profilesBody'),
  profileWizard: document.querySelector('#profileWizard'),
  profileWizardForm: document.querySelector('#profileWizardForm'),
  profileWizardTitle: document.querySelector('#profileWizardTitle'),
  profileWizardIntro: document.querySelector('#profileWizardIntro'),
  profileWizardClose: document.querySelector('#profileWizardClose'),
  wizardProfileId: document.querySelector('#wizardProfileId'),
  wizardProfileType: document.querySelector('#wizardProfileType'),
  wizardProfileName: document.querySelector('#wizardProfileName'),
  wizardPutioFolder: document.querySelector('#wizardPutioFolder'),
  wizardDownloadAt: document.querySelector('#wizardDownloadAt'),
  wizardRpcPath: document.querySelector('#wizardRpcPath'),
  wizardClientHost: document.querySelector('#wizardClientHost'),
  wizardClientPort: document.querySelector('#wizardClientPort'),
  wizardUseSsl: document.querySelector('#wizardUseSsl'),
  wizardEnabled: document.querySelector('#wizardEnabled'),
  wizardHelpKicker: document.querySelector('#wizardHelpKicker'),
  wizardHelpTitle: document.querySelector('#wizardHelpTitle'),
  wizardHelpBody: document.querySelector('#wizardHelpBody'),
  wizardHelpList: document.querySelector('#wizardHelpList'),
  wizardHelpValueLabel: document.querySelector('#wizardHelpValueLabel'),
  wizardHelpValue: document.querySelector('#wizardHelpValue'),
  profileWizardMessage: document.querySelector('#profileWizardMessage'),
  saveProfileButton: document.querySelector('#saveProfileButton'),
  deleteProfileButton: document.querySelector('#deleteProfileButton'),
  copyClientSettingsButton: document.querySelector('#copyClientSettingsButton'),
  downloadsList: document.querySelector('#downloadsList'),
  refreshButton: document.querySelector('#refreshButton'),
};

const PROFILE_TYPES = {
  sonarr: {
    label: 'Sonarr',
    root: '/series',
    note: 'In Sonarr, add a Transmission download client and paste these values. Leave username and password blank unless putiorr has RPC auth configured.',
  },
  radarr: {
    label: 'Radarr',
    root: '/movies',
    note: 'In Radarr, add a Transmission download client and paste these values. Leave username and password blank unless putiorr has RPC auth configured.',
  },
  lidarr: {
    label: 'Lidarr',
    root: '/music',
    note: 'In Lidarr, add a Transmission download client and paste these values. Leave username and password blank unless putiorr has RPC auth configured.',
  },
  readarr: {
    label: 'Readarr',
    root: '/books',
    note: 'In Readarr, add a Transmission download client and paste these values. Leave username and password blank unless putiorr has RPC auth configured.',
  },
  prowlarr: {
    label: 'Prowlarr',
    root: '',
    note: 'Prowlarr usually talks to Sonarr/Radarr/Lidarr instead of putiorr. Use this only if Prowlarr sends grabs directly to a Transmission client.',
  },
  custom: {
    label: 'Custom',
    root: '',
    note: 'Use these Transmission-compatible values in the app that will send downloads to putiorr.',
  },
};

const DEFAULT_PROFILE_TYPE = 'sonarr';
const DEFAULT_PUTIO_FOLDER = 'putiorr';
const DEFAULT_DOWNLOAD_FOLDER = '/putiorr';
const DEFAULT_CLIENT_HOST = 'putiorr';
const DEFAULT_CLIENT_PORT = '9091';
const DEFAULT_HELP_FIELD = 'wizardProfileType';

const WIZARD_HELP = {
  wizardProfileType: {
    title: 'App preset',
    paragraphs: [
      'The preset picks the normal display name and RPC path for the app you are connecting. It does not change how putiorr talks to put.io; it only gives each app its own endpoint and category.',
      'Use Custom when another app will send Transmission RPC requests to putiorr, or when you want to name and route an endpoint yourself.',
    ],
    tips: [
      'Changing the preset rewrites Display name and RPC endpoint path so they stay aligned.',
      'Sonarr, Radarr, Lidarr, Readarr, and Prowlarr presets use separate paths so their requests do not share one category by accident.',
    ],
    valueLabel: 'Selected setup',
    value: (profile, settings) => `${settings.appLabel}: category ${settings.category}, URL Base ${settings.urlBase}`,
  },
  wizardProfileName: {
    title: 'Display name',
    paragraphs: [
      'The display name is shown on the profile card and is also converted into the download-client Category.',
      'For the usual setup, keep names simple: Sonarr becomes category sonarr, Radarr becomes category radarr, and so on.',
    ],
    tips: [
      'If you create two profiles for the same app, use names that make different categories obvious, such as sonarr-4k and sonarr-anime.',
      'Keep this value stable after a download is queued. Changing the category can make older completed downloads harder for the app to match.',
    ],
    valueLabel: 'Download-client Category',
    value: (profile, settings) => settings.category,
  },
  wizardPutioFolder: {
    title: 'Put.io destination folder',
    paragraphs: [
      'This is the remote put.io folder where putiorr asks put.io to place new transfers. It is not the local folder Sonarr or Radarr imports from.',
      'A single put.io folder, such as putiorr, is usually enough. The local category keeps each app separated later.',
    ],
    tips: [
      'Changing this affects new transfers only; it does not move existing files already on put.io.',
      'Use a dedicated folder if you want the put.io web UI to show these app downloads separately from manual downloads.',
    ],
    valueLabel: 'Remote put.io folder',
    value: (profile) => profile.putio_folder_name || DEFAULT_PUTIO_FOLDER,
  },
  wizardDownloadAt: {
    title: 'Shared download folder',
    paragraphs: [
      'You can use a single folder for all *arr apps, for example /putiorr. When you do that, set the *arr download-client Category to the app category so imports land under /putiorr/sonarr, /putiorr/radarr, and similar app-specific folders.',
      'This folder must be mounted in both putiorr and the *arr container. If the app cannot see this exact path, completed-download import fails even though putiorr finished copying the files.',
    ],
    tips: [
      'Recommended shared setup: Directory is /putiorr and Category is sonarr, radarr, lidarr, or readarr.',
      'If you use separate folders per app, set Directory to that app mount and still keep Category consistent with the profile.',
      'If imports fail with a path-not-found error, compare the container volume mounts before changing this value.',
    ],
    valueLabel: 'Final category folder',
    value: (profile, settings) => joinPathParts(settings.directory, settings.category),
  },
  wizardRpcPath: {
    title: 'RPC endpoint path',
    paragraphs: [
      'This is the path putiorr exposes for Transmission RPC. In the *arr download client, use everything before /rpc as URL Base.',
      'Keep each app on a unique endpoint path. That is what lets putiorr know which app profile and category should handle the request.',
    ],
    tips: [
      'For Sonarr, /sonarr/transmission/rpc means URL Base is /sonarr/transmission.',
      'Do not point this at an app API path. This must be a Transmission RPC path served by putiorr.',
    ],
    valueLabel: 'Full RPC endpoint',
    value: (profile, settings) => settings.fullEndpoint,
  },
  wizardClientHost: {
    title: 'Host from the *arr container',
    paragraphs: [
      'This is the host value Sonarr, Radarr, or another app should use when it connects to putiorr as a Transmission download client.',
      'If the apps run in the same Docker Compose network, the service name is usually the right value. The default service name here is putiorr.',
    ],
    tips: [
      'Use a NAS hostname, LAN IP, or reverse-proxy hostname only when the app is outside the Docker network.',
      'The host must be reachable from the *arr container, not just from your browser.',
    ],
    valueLabel: 'Download-client Host',
    value: (profile, settings) => settings.host,
  },
  wizardClientPort: {
    title: 'Port',
    paragraphs: [
      'This is the port the *arr app should use to reach putiorr. In the normal Compose setup, containers talk to putiorr on port 9091.',
      'A published host port may be different. Use that only when the *arr app connects from outside the container network.',
    ],
    tips: [
      'Inside Docker Compose, prefer the container port rather than the host-mapped port.',
      'If SSL is enabled through a proxy, this port must match the HTTPS endpoint the app can reach.',
    ],
    valueLabel: 'Download-client Port',
    value: (profile, settings) => settings.port || '(default HTTP port)',
  },
  wizardUseSsl: {
    title: 'Use SSL',
    paragraphs: [
      'Leave SSL off for the normal internal Docker Compose setup. The app will connect to putiorr over plain HTTP inside the private network.',
      'Turn SSL on only when the app reaches putiorr through an HTTPS reverse proxy or another TLS endpoint.',
    ],
    tips: [
      'If SSL is on, Host and Port must also point at the HTTPS endpoint.',
      'A mismatch here usually appears as a connection timeout, TLS error, or health-check failure in the *arr download client test.',
    ],
    valueLabel: 'Endpoint scheme',
    value: (profile, settings) => settings.useSsl ? 'https' : 'http',
  },
  wizardEnabled: {
    title: 'Enable this profile',
    paragraphs: [
      'Enabled profiles accept RPC requests from the matching endpoint path. Disable a profile when you want to keep its settings but stop new requests from using it.',
      'Disabling a profile is useful while changing app configuration because it avoids accepting new downloads with a half-finished setup.',
    ],
    tips: [
      'Existing queued downloads are not deleted just because this profile is disabled.',
      'Re-enable the profile when the corresponding *arr download client is ready to test again.',
    ],
    valueLabel: 'Profile state',
    value: (profile) => profile.enabled ? 'Enabled: accepts new RPC requests' : 'Disabled: saved, but not used for new RPC requests',
  },
};

const oauth = {
  code: '',
  timer: undefined,
};

const updates = {
  socket: undefined,
  reconnectTimer: undefined,
  reconnectDelayMs: 1_000,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function setMessage(message, tone = 'neutral') {
  el.settingsMessage.textContent = message;
  el.settingsMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

function stopOAuthPolling() {
  if (oauth.timer) {
    clearInterval(oauth.timer);
    oauth.timer = undefined;
  }
}

function connectUpdates() {
  if (updates.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(updates.socket.readyState)) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
  updates.socket = socket;

  socket.addEventListener('open', () => {
    updates.reconnectDelayMs = 1_000;
    requestStateRefresh();
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'downloads') {
      applyDownloadsUpdate(message);
    }
  });

  socket.addEventListener('close', () => {
    if (updates.socket !== socket) return;
    updates.socket = undefined;
    scheduleUpdateReconnect();
  });
}

function scheduleUpdateReconnect() {
  if (updates.reconnectTimer) return;
  updates.reconnectTimer = setTimeout(() => {
    updates.reconnectTimer = undefined;
    connectUpdates();
  }, updates.reconnectDelayMs);
  updates.reconnectDelayMs = Math.min(15_000, updates.reconnectDelayMs * 2);
}

function requestStateRefresh() {
  if (updates.socket?.readyState === WebSocket.OPEN) {
    updates.socket.send(JSON.stringify({ type: 'refresh' }));
    return true;
  }
  return false;
}

async function loadAll() {
  const [settings, profiles, downloads] = await Promise.all([
    api('/api/settings'),
    api('/api/profiles'),
    api('/api/downloads'),
  ]);
  state.settings = settings;
  state.profiles = profiles;
  state.downloads = downloads;
  render();
}

function applyDownloadsUpdate(message) {
  if (Array.isArray(message.downloads)) state.downloads = message.downloads;
  renderDownloads();
}

function render() {
  renderConnection();
  renderProfiles();
  renderDownloads();
}

function renderConnection() {
  const connected = Boolean(state.settings?.tokenConfigured);
  el.connectionState.textContent = connected
    ? 'A put.io token is configured. You can test or rotate it here.'
    : 'No put.io token is configured. Add one before RPC clients can add downloads.';
  el.connectionBadge.textContent = connected ? 'Connected' : 'Needs token';
  el.connectionBadge.className = `status ${connected ? 'ok' : 'warn'}`;
  if (connected) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
  }
  renderDownloadPolicy();
}

function renderDownloadPolicy() {
  const policy = state.settings?.downloadPolicy;
  if (!policy || isDownloaderPolicyDrafting()) return;

  setNumberInput(el.slowSpeedThreshold, policy.slowSpeedThresholdBytesPerSecond);
  setNumberInput(el.slowSpeedDuration, policy.slowSpeedDurationSeconds);
  setNumberInput(el.slowSpeedGrace, policy.slowSpeedGraceSeconds);
  setNumberInput(el.slowSpeedMinSize, policy.slowSpeedMinSizeBytes);
  state.downloaderPolicyBaseline = JSON.stringify(getDownloadPolicyPayload());
  state.downloaderPolicyDirty = false;
}

function isDownloaderPolicyDrafting() {
  return state.downloaderPolicyDirty || el.downloaderSettingsForm.contains(document.activeElement);
}

function setNumberInput(input, value) {
  const nextValue = String(Math.max(0, Number.parseInt(value ?? 0, 10) || 0));
  if (input.value !== nextValue) input.value = nextValue;
}

function numberInputValue(input) {
  const parsed = Number.parseInt(input.value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getDownloadPolicyPayload() {
  return {
    slowSpeedThresholdBytesPerSecond: numberInputValue(el.slowSpeedThreshold),
    slowSpeedDurationSeconds: numberInputValue(el.slowSpeedDuration),
    slowSpeedGraceSeconds: numberInputValue(el.slowSpeedGrace),
    slowSpeedMinSizeBytes: numberInputValue(el.slowSpeedMinSize),
  };
}

function updateDownloaderPolicyDirtyState() {
  state.downloaderPolicyDirty = state.downloaderPolicyBaseline !== JSON.stringify(getDownloadPolicyPayload());
}

function renderProfiles() {
  el.profilesBody.replaceChildren();
  if (state.profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state profile-empty';
    empty.textContent = 'No RR profiles yet. Use the setup wizard to create the Sonarr, Radarr, or Lidarr endpoint.';
    el.profilesBody.appendChild(empty);
    return;
  }

  for (const profile of state.profiles) {
    el.profilesBody.appendChild(createProfileCard(profile));
  }
}

function createProfileCard(profile) {
  const type = profileType(profile.type);
  const displayName = profileDisplayName(profile, type);
  const card = document.createElement('article');
  card.className = 'profile-card';
  card.dataset.id = profile.id || '';
  card.innerHTML = `
    <div class="profile-card-main">
      <div>
        <div class="profile-eyebrow" data-role="type"></div>
        <h3 data-role="name"></h3>
        <p data-role="summary"></p>
      </div>
      <span data-role="status" class="status"></span>
    </div>
    <dl class="profile-facts">
      <div>
        <dt>RPC</dt>
        <dd data-role="rpc"></dd>
      </div>
      <div>
        <dt>Put.io</dt>
        <dd data-role="putio"></dd>
      </div>
      <div>
        <dt>Download</dt>
        <dd data-role="download"></dd>
      </div>
    </dl>
    <div class="profile-actions">
      <button data-action="setup" class="button secondary" type="button">
        <span aria-hidden="true">↗</span>
        Setup
      </button>
      <button data-action="edit" class="button secondary" type="button">Edit</button>
      <button data-action="delete" class="icon-button danger" type="button">Delete</button>
    </div>
  `;

  setText(card.querySelector('[data-role="type"]'), type.label);
  setText(card.querySelector('[data-role="name"]'), displayName);
  setText(card.querySelector('[data-role="summary"]'), profileSummary(profile));
  setProfileFact(card, 'rpc', profile.rpc_path || 'Not set');
  setProfileFact(card, 'putio', profile.putio_folder_name || 'Not set');
  setProfileFact(card, 'download', profile.downloadAt ?? profile.download_at ?? 'Not set');
  const status = card.querySelector('[data-role="status"]');
  status.className = `status ${profile.enabled === false ? 'warn' : 'ok'}`;
  setText(status, profile.enabled === false ? 'Disabled' : 'Enabled');

  card.querySelector('[data-action="setup"]').addEventListener('click', () => openProfileWizard(profile));
  card.querySelector('[data-action="edit"]').addEventListener('click', () => openProfileWizard(profile));
  card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteProfileById(profile.id));
  return card;
}

function setProfileFact(card, role, value) {
  const element = card.querySelector(`[data-role="${role}"]`);
  setText(element, value);
  setAttribute(element, 'title', value);
}

function profileSummary(profile) {
  const payload = getClientSettingsFromProfile({
    ...profile,
    name: profileDisplayName(profile),
  });
  const rootHint = profileType(profile.type).root;
  return rootHint
    ? `${payload.appLabel} imports from ${payload.directory}/${payload.category} to its ${rootHint} library root.`
    : `${payload.appLabel} sends downloads to category ${payload.category}.`;
}

function upsertProfileState(profile) {
  const index = state.profiles.findIndex((existing) => String(existing.id) === String(profile.id));
  if (index >= 0) state.profiles[index] = profile;
  else state.profiles.push(profile);
}

function openProfileWizard(profile = createDefaultProfile(DEFAULT_PROFILE_TYPE)) {
  const type = profile.type || DEFAULT_PROFILE_TYPE;
  const detail = profileType(type);
  const displayName = profileDisplayName(profile, detail);
  const isExisting = Boolean(profile.id);

  el.profileWizard.dataset.previousType = type;
  el.profileWizardTitle.textContent = isExisting
    ? `Set up ${displayName}`
    : `Set up ${detail.label}`;
  el.profileWizardIntro.textContent = 'Answer a few setup questions, then copy the matching *arr download-client values.';
  el.wizardProfileId.value = profile.id || '';
  el.wizardProfileType.value = type;
  el.wizardProfileName.value = displayName;
  el.wizardPutioFolder.value = profile.putio_folder_name || DEFAULT_PUTIO_FOLDER;
  el.wizardDownloadAt.value = profile.downloadAt ?? profile.download_at ?? DEFAULT_DOWNLOAD_FOLDER;
  el.wizardRpcPath.value = profile.rpc_path || defaultRpcPathForType(type);
  el.wizardClientHost.value = DEFAULT_CLIENT_HOST;
  el.wizardClientPort.value = DEFAULT_CLIENT_PORT;
  el.wizardUseSsl.checked = false;
  el.wizardEnabled.checked = profile.enabled !== false;
  el.deleteProfileButton.hidden = !isExisting;
  el.saveProfileButton.textContent = isExisting ? 'Save profile' : 'Create profile';
  el.profileWizard.dataset.activeHelpField = DEFAULT_HELP_FIELD;
  setWizardMessage('');
  updateWizardPreview();

  if (typeof el.profileWizard.showModal === 'function') {
    el.profileWizard.showModal();
  } else {
    el.profileWizard.setAttribute('open', '');
  }
  el.wizardProfileType.focus();
}

function closeProfileWizard() {
  if (el.profileWizard.open && typeof el.profileWizard.close === 'function') {
    el.profileWizard.close();
  } else {
    el.profileWizard.removeAttribute('open');
  }
}

function createDefaultProfile(type) {
  const detail = profileType(type);
  return {
    id: '',
    name: detail.label,
    type,
    putio_folder_name: DEFAULT_PUTIO_FOLDER,
    downloadAt: DEFAULT_DOWNLOAD_FOLDER,
    rpc_path: defaultRpcPathForType(type),
    enabled: true,
  };
}

function syncWizardDefaultsForType() {
  const nextType = el.wizardProfileType.value || DEFAULT_PROFILE_TYPE;
  const nextDetail = profileType(nextType);

  el.wizardProfileName.value = nextDetail.label;
  el.wizardRpcPath.value = defaultRpcPathForType(nextType);
  el.profileWizard.dataset.previousType = nextType;
  updateWizardPreview();
}

function getWizardPayload() {
  return {
    name: el.wizardProfileName.value.trim(),
    type: el.wizardProfileType.value,
    slug: slugify(el.wizardProfileName.value),
    putio_folder_name: el.wizardPutioFolder.value.trim(),
    downloadAt: el.wizardDownloadAt.value.trim(),
    rpc_path: normalizeRpcPath(el.wizardRpcPath.value),
    enabled: el.wizardEnabled.checked,
  };
}

async function saveProfileFromWizard() {
  const id = el.wizardProfileId.value;
  const payload = getWizardPayload();
  if (!payload.name || !payload.putio_folder_name || !payload.downloadAt || !payload.rpc_path) {
    setWizardMessage('Profile name, put.io folder, download folder, and RPC endpoint are required.', 'error');
    return;
  }

  el.saveProfileButton.disabled = true;
  try {
    const savedProfile = id
      ? await api(`/api/profiles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      : await api('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    upsertProfileState(savedProfile);
    renderProfiles();
    closeProfileWizard();
    setMessage('Profile saved.', 'ok');
  } catch (error) {
    setWizardMessage(error.message, 'error');
  } finally {
    el.saveProfileButton.disabled = false;
  }
}

async function deleteProfileById(id = el.wizardProfileId.value) {
  if (!id) {
    closeProfileWizard();
    return;
  }

  await api(`/api/profiles/${id}`, { method: 'DELETE' });
  state.profiles = state.profiles.filter((profile) => String(profile.id) !== String(id));
  renderProfiles();
  closeProfileWizard();
  setMessage('Profile deleted.', 'ok');
}

function updateWizardPreview() {
  const profile = getWizardPayload();
  const settings = getClientSettingsFromProfile(profile);
  el.profileWizardTitle.textContent = `Set up ${profile.name || settings.appLabel}`;
  setWizardHelpForField(el.profileWizard.dataset.activeHelpField || DEFAULT_HELP_FIELD, profile, settings);
}

function setWizardHelpForField(fieldId = DEFAULT_HELP_FIELD, profile = getWizardPayload(), settings = getClientSettingsFromProfile(profile)) {
  const nextFieldId = WIZARD_HELP[fieldId] ? fieldId : DEFAULT_HELP_FIELD;
  const help = WIZARD_HELP[nextFieldId];
  el.profileWizard.dataset.activeHelpField = nextFieldId;
  setText(el.wizardHelpKicker, 'Field guide');
  setText(el.wizardHelpTitle, help.title);
  setText(el.wizardHelpValueLabel, help.valueLabel || 'Current effect');
  setText(el.wizardHelpValue, resolveWizardHelpValue(help, profile, settings));
  renderWizardHelpParagraphs(resolveWizardHelpContent(help.paragraphs, profile, settings));
  renderWizardHelpList(resolveWizardHelpContent(help.tips, profile, settings));
}

function resolveWizardHelpContent(content, profile, settings) {
  return typeof content === 'function' ? content(profile, settings) : content;
}

function resolveWizardHelpValue(help, profile, settings) {
  return typeof help.value === 'function' ? help.value(profile, settings) : help.value;
}

function renderWizardHelpParagraphs(paragraphs = []) {
  el.wizardHelpBody.replaceChildren();
  for (const paragraphText of paragraphs) {
    const paragraph = document.createElement('p');
    setText(paragraph, paragraphText);
    el.wizardHelpBody.appendChild(paragraph);
  }
}

function renderWizardHelpList(items = []) {
  el.wizardHelpList.replaceChildren();
  for (const itemText of items) {
    const item = document.createElement('li');
    setText(item, itemText);
    el.wizardHelpList.appendChild(item);
  }
}

function getClientSettingsFromProfile(profile) {
  const detail = profileType(profile.type);
  const host = el.wizardClientHost?.value.trim() || DEFAULT_CLIENT_HOST;
  const port = el.wizardClientPort?.value.trim() || DEFAULT_CLIENT_PORT;
  const useSsl = Boolean(el.wizardUseSsl?.checked);
  const rpcPath = normalizeRpcPath(profile.rpc_path || defaultRpcPathForType(profile.type));
  const protocol = useSsl ? 'https' : 'http';
  const portSuffix = port ? `:${port}` : '';
  return {
    appLabel: detail.label,
    host,
    port,
    useSsl,
    urlBase: rpcPath.replace(/\/rpc\/?$/, '') || rpcPath,
    category: slugify(profile.name || detail.label),
    directory: profile.downloadAt ?? profile.download_at ?? DEFAULT_DOWNLOAD_FOLDER,
    fullEndpoint: `${protocol}://${host}${portSuffix}${rpcPath}`,
    note: detail.note,
  };
}

function getClientSettingsText() {
  const settings = getClientSettingsFromProfile(getWizardPayload());
  return [
    `${settings.appLabel} Transmission download client`,
    'Name: putiorr',
    `Host: ${settings.host}`,
    `Port: ${settings.port}`,
    `Use SSL: ${settings.useSsl ? 'on' : 'off'}`,
    'Username: blank unless configured',
    'Password: blank unless configured',
    `Category: ${settings.category}`,
    `Directory: ${settings.directory}`,
    `URL Base: ${settings.urlBase}`,
    `Full RPC endpoint: ${settings.fullEndpoint}`,
  ].join('\n');
}

async function copyClientSettings() {
  const text = getClientSettingsText();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    setWizardMessage('Download-client settings copied.', 'ok');
  } catch {
    if (copyTextWithSelection(text)) {
      setWizardMessage('Download-client settings copied.', 'ok');
      return;
    }
    setWizardMessage('Copy failed. Select the generated settings manually.', 'error');
  }
}

function copyTextWithSelection(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

function setWizardMessage(message, tone = 'neutral') {
  el.profileWizardMessage.textContent = message;
  el.profileWizardMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

function profileType(type) {
  return PROFILE_TYPES[type] ?? PROFILE_TYPES.custom;
}

function profileDisplayName(profile, detail = profileType(profile?.type)) {
  const name = String(profile?.name ?? '').trim();
  const type = String(profile?.type ?? '').toLowerCase();
  const slug = String(profile?.slug ?? '').toLowerCase();
  if (type === 'custom' && slug === 'default' && name.toLowerCase() === 'default') {
    return PROFILE_TYPES.custom.label;
  }
  return name || detail.label;
}

function defaultRpcPathForType(type) {
  return `/${slugify(type || DEFAULT_PROFILE_TYPE)}/transmission/rpc`;
}

function normalizeRpcPath(value) {
  const pathValue = String(value ?? '').trim();
  if (!pathValue) return '';
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}

function joinPathParts(base, segment) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanSegment = String(segment || '').replace(/^\/+/, '');
  if (!cleanBase) return cleanSegment ? `/${cleanSegment}` : '';
  return cleanSegment ? `${cleanBase}/${cleanSegment}` : cleanBase;
}

function renderDownloads() {
  const viewportScroll = captureViewportScroll();
  rememberFileListScrollTops();
  pruneDownloadUiState();

  if (state.downloads.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No active downloads yet. Once an RR client adds a release, progress will appear here.';
    el.downloadsList.replaceChildren(empty);
    restoreViewportScroll(viewportScroll);
    return;
  }

  el.downloadsList.querySelector('.empty-state')?.remove();
  const existingRows = Array.from(el.downloadsList.querySelectorAll('.download-row[data-id]'));
  const existingById = new Map(existingRows.map((row) => [String(row.dataset.id), row]));
  const seen = new Set();

  state.downloads.forEach((download, index) => {
    const id = String(download.id);
    let row = existingById.get(id);
    if (!row) row = createDownloadRow(download);
    updateDownloadRow(row, download);
    seen.add(id);
    placeChildAt(el.downloadsList, row, index);
  });

  for (const row of existingRows) {
    if (row.dataset.id && !seen.has(String(row.dataset.id))) {
      row.remove();
    }
  }
  restoreViewportScroll(viewportScroll);
}

function createDownloadRow(download) {
  const row = document.createElement('article');
  row.className = 'download-row';
  row.dataset.id = download.id;
  row.innerHTML = `
    <div class="download-summary">
      <div>
        <div class="download-title" data-role="download-title"></div>
        <div class="download-meta" data-role="download-location"></div>
        <button class="file-toggle" type="button" data-action="toggle-files">
          Files
          <span data-role="file-count"></span>
        </button>
      </div>
      <div>
        <div class="metric-label">Status</div>
        <strong data-role="download-status"></strong>
        <div class="download-meta" data-role="download-files"></div>
      </div>
      <div class="progress-group">
        ${progressLine('Put.io', 0, 'putio-bar', 'putio-progress')}
        ${progressLine('Local', 0, 'local-bar', 'local-progress', 'local')}
      </div>
      <div>
        <div class="metric-label">Speed / ETA</div>
        <strong data-role="download-speed"></strong>
        <div class="download-meta" data-role="download-eta"></div>
      </div>
    </div>
    <div class="file-panel" data-role="file-panel" hidden>
      <div class="file-panel-head">
        <strong>Files</strong>
        <span data-role="file-panel-summary"></span>
      </div>
      <div class="file-list" data-role="file-list"></div>
    </div>
  `;
  row.querySelector('[data-action="toggle-files"]').addEventListener('click', () => {
    toggleFilePanel(row.dataset.id);
  });
  const fileList = row.querySelector('[data-role="file-list"]');
  fileList.addEventListener('scroll', () => {
    state.fileListScrollTops.set(String(row.dataset.id), fileList.scrollTop);
  }, { passive: true });
  return row;
}

function updateDownloadRow(row, download) {
  const putioProgress = clampPercent(download.putioProgress);
  const localProgress = clampPercent(download.localProgress);
  const combinedProgress = clampPercent(download.combinedProgress);
  const files = download.files ?? {};
  const fileItems = Array.isArray(files.items) ? files.items : [];
  const completeFiles = Number(files.complete ?? 0);
  const totalFiles = Number(files.total ?? 0);
  const downloadedSize = Number(download.downloadedSize ?? 0);
  const totalSize = Number(download.totalSize ?? 0);
  const fileText = totalFiles > 0
    ? `${completeFiles}/${totalFiles} files`
    : 'Files pending';
  const sizeText = totalSize > 0
    ? `${formatBytes(downloadedSize)} / ${formatBytes(totalSize)}`
    : `${formatBytes(downloadedSize)} copied`;

  setDataValue(row, 'id', download.id);
  setText(row.querySelector('[data-role="download-title"]'), download.name);
  setText(row.querySelector('[data-role="download-location"]'), `${download.profileName} · ${download.downloadAt}`);
  setText(row.querySelector('[data-role="download-status"]'), `${download.lifecycle} · ${combinedProgress}%`);
  setText(row.querySelector('[data-role="download-files"]'), download.error || `${fileText} · ${sizeText}`);
  setText(row.querySelector('[data-role="download-speed"]'), formatSpeed(download.speed));
  setText(row.querySelector('[data-role="download-eta"]'), formatEta(download.eta));
  setText(row.querySelector('[data-role="file-count"]'), totalFiles > 0 ? String(totalFiles) : '0');
  setProgressValue(row, 'putio-bar', 'putio-progress', putioProgress);
  setProgressValue(row, 'local-bar', 'local-progress', localProgress);
  populateFilePanel(row, download, fileItems);
}

function toggleFilePanel(downloadId) {
  rememberFileListScrollTops();
  const key = String(downloadId);
  if (state.expandedDownloads.has(key)) {
    state.expandedDownloads.delete(key);
  } else {
    state.expandedDownloads.add(key);
  }
  renderDownloads();
}

function populateFilePanel(row, download, fileItems) {
  const key = String(download.id);
  const expanded = state.expandedDownloads.has(key);
  const button = row.querySelector('[data-action="toggle-files"]');
  const panel = row.querySelector('[data-role="file-panel"]');
  const list = row.querySelector('[data-role="file-list"]');
  const summary = row.querySelector('[data-role="file-panel-summary"]');

  setAttribute(button, 'aria-expanded', String(expanded));
  button.classList.toggle('open', expanded);
  setHidden(panel, !expanded);

  const completed = fileItems.filter((file) => file.status === 'complete').length;
  const downloading = fileItems.filter((file) => file.status === 'downloading').length;
  const failed = fileItems.filter((file) => file.status === 'failed').length;
  const pending = Math.max(0, fileItems.length - completed - downloading - failed);
  setText(
    summary,
    fileItems.length > 0
      ? `${completed} complete · ${downloading} active · ${pending} pending${failed > 0 ? ` · ${failed} failed` : ''}`
      : 'Waiting for put.io file list',
  );

  if (!expanded) return;

  if (fileItems.length === 0) {
    renderEmptyFileList(list);
    return;
  }

  list.querySelector('.file-empty')?.remove();
  const existingRows = Array.from(list.querySelectorAll('.file-row[data-id]'));
  const existingById = new Map(existingRows.map((fileRow) => [String(fileRow.dataset.id), fileRow]));
  const seen = new Set();

  fileItems.forEach((file, index) => {
    const id = String(file.id);
    let fileRow = existingById.get(id);
    if (!fileRow) fileRow = createFileRow(file);
    updateFileRow(fileRow, file);
    seen.add(id);
    placeChildAt(list, fileRow, index);
  });

  for (const fileRow of existingRows) {
    if (fileRow.dataset.id && !seen.has(String(fileRow.dataset.id))) {
      fileRow.remove();
    }
  }
}

function renderEmptyFileList(list) {
  if (list.querySelector('.file-empty')) return;
  list.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'file-empty';
  empty.textContent = 'File details appear after put.io finishes preparing the transfer.';
  list.appendChild(empty);
}

function createFileRow(file) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.id = file.id;
  row.innerHTML = `
    <div class="file-main">
      <div class="file-name" data-role="file-name"></div>
      <div class="download-meta" data-role="file-size"></div>
    </div>
    <span class="file-status" data-role="file-status"></span>
    <div class="file-progress">
      <span class="bar local" data-role="file-bar"><span></span></span>
      <span data-role="file-progress"></span>
    </div>
  `;
  updateFileRow(row, file);
  return row;
}

function updateFileRow(row, file) {
  const progress = clampPercent(file.progress);
  const status = file.status || 'pending';
  const speed = Number(file.speed ?? 0);
  const fileSizeText = `${formatBytes(file.downloadedSize)} / ${formatBytes(file.size)}`;
  const sizeText = file.error
    || (status === 'downloading' && speed > 0
      ? `${fileSizeText} · ${formatSpeed(speed)}`
      : fileSizeText);
  const statusBadge = row.querySelector('[data-role="file-status"]');

  setDataValue(row, 'id', file.id);
  setText(row.querySelector('[data-role="file-name"]'), file.relativePath || 'Unknown file');
  setText(row.querySelector('[data-role="file-size"]'), sizeText);
  setText(statusBadge, statusLabel(file.status));
  setDataValue(statusBadge, 'status', status);
  setProgressValue(row, 'file-bar', 'file-progress', progress);
}

function progressLine(label, value, barRole, valueRole, className = '') {
  return `
    <div class="progress-line">
      <span>${label}</span>
      <span class="bar ${className}" data-role="${barRole}"><span></span></span>
      <span data-role="${valueRole}">${value}%</span>
    </div>
  `;
}

function setProgressValue(row, barRole, valueRole, value) {
  const nextValue = `${value}%`;
  const bar = row.querySelector(`[data-role="${barRole}"] > span`);
  if (bar.style.getPropertyValue('--value') !== nextValue) {
    bar.style.setProperty('--value', nextValue);
  }
  setText(row.querySelector(`[data-role="${valueRole}"]`), nextValue);
}

function setText(element, value) {
  const nextValue = String(value ?? '');
  if (element.textContent !== nextValue) {
    element.textContent = nextValue;
  }
}

function setAttribute(element, name, value) {
  const nextValue = String(value ?? '');
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
  }
}

function setDataValue(element, name, value) {
  const nextValue = String(value ?? '');
  if (element.dataset[name] !== nextValue) {
    element.dataset[name] = nextValue;
  }
}

function setHidden(element, hidden) {
  if (element.hidden !== hidden) {
    element.hidden = hidden;
  }
}

function placeChildAt(parent, child, index) {
  const current = parent.children[index] ?? null;
  if (current !== child) {
    parent.insertBefore(child, current);
  }
}

function rememberFileListScrollTops() {
  for (const row of el.downloadsList.querySelectorAll('.download-row[data-id]')) {
    const panel = row.querySelector('[data-role="file-panel"]');
    const list = row.querySelector('[data-role="file-list"]');
    if (!panel || panel.hidden || !list) continue;
    state.fileListScrollTops.set(String(row.dataset.id), list.scrollTop);
  }
}

function pruneDownloadUiState() {
  const ids = new Set(state.downloads.map((download) => String(download.id)));
  for (const id of state.expandedDownloads) {
    if (!ids.has(id)) state.expandedDownloads.delete(id);
  }
  for (const id of state.fileListScrollTops.keys()) {
    if (!ids.has(id)) state.fileListScrollTops.delete(id);
  }
}

function captureViewportScroll() {
  return {
    x: window.scrollX,
    y: window.scrollY,
  };
}

function restoreViewportScroll({ x, y }) {
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo(x, Math.min(y, maxY));
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatSpeed(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return 'Idle';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

function formatEta(value) {
  const seconds = Number(value ?? -1);
  if (seconds < 0) return 'ETA unavailable';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function statusLabel(value) {
  switch (value) {
    case 'complete':
      return 'Complete';
    case 'downloading':
      return 'Active';
    case 'failed':
      return 'Failed';
    default:
      return 'Pending';
  }
}

function slugify(value) {
  return String(value || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'profile';
}

el.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = el.putioToken.value.trim();
  if (!token && !state.settings?.tokenConfigured) {
    setMessage('Paste a put.io token before saving settings.', 'error');
    return;
  }
  const payload = token ? { putioToken: token } : {};
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  state.settings = settings;
  el.putioToken.value = '';
  renderConnection();
  setMessage('Settings saved.', 'ok');
  requestStateRefresh();
});

el.downloaderSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ downloadPolicy: getDownloadPolicyPayload() }),
  });
  state.settings = settings;
  state.downloaderPolicyDirty = false;
  renderDownloadPolicy();
  setMessage('Downloader settings saved.', 'ok');
  if (!requestStateRefresh()) await loadAll();
});

for (const input of el.downloaderSettingsForm.querySelectorAll('input')) {
  input.addEventListener('input', updateDownloaderPolicyDirtyState);
  input.addEventListener('change', updateDownloaderPolicyDirtyState);
}

el.testConnectionButton.addEventListener('click', async () => {
  try {
    const token = el.putioToken.value.trim();
    const result = await api('/api/putio/test', {
      method: 'POST',
      body: JSON.stringify(token ? { putioToken: token } : {}),
    });
    setMessage(`Connected to put.io${result.username ? ` as ${result.username}` : ''}.`, 'ok');
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthStartButton.addEventListener('click', async () => {
  try {
    stopOAuthPolling();
    const result = await api('/api/oauth/start', {
      method: 'POST',
      body: '{}',
    });
    oauth.code = result.code;
    el.oauthCode.textContent = result.code;
    el.oauthLink.href = result.linkUrl || 'https://put.io/link';
    el.oauthPanel.hidden = false;
    setMessage('Enter the code at put.io/link. Waiting for authorization...', 'neutral');
    oauth.timer = setInterval(() => {
      pollOAuth(false).catch((error) => setMessage(error.message, 'error'));
    }, 5000);
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthPollButton.addEventListener('click', () => {
  pollOAuth(true).catch((error) => setMessage(error.message, 'error'));
});

async function pollOAuth(manual) {
  if (!oauth.code) {
    setMessage('Start OAuth first to get a put.io code.', 'error');
    return;
  }
  const result = await api('/api/oauth/poll', {
    method: 'POST',
    body: JSON.stringify({ code: oauth.code }),
  });
  if (result.status === 'OK' && result.tokenConfigured) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
    oauth.code = '';
    state.settings = {
      ...(state.settings ?? {}),
      tokenConfigured: true,
    };
    renderConnection();
    setMessage('Put.io OAuth connected and token saved.', 'ok');
    requestStateRefresh();
    return;
  }
  if (manual) {
    setMessage(`Authorization status: ${result.status}.`, 'neutral');
  }
}

el.addProfileButton.addEventListener('click', () => openProfileWizard(createDefaultProfile(DEFAULT_PROFILE_TYPE)));
el.profileWizardForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveProfileFromWizard().catch((error) => setWizardMessage(error.message, 'error'));
});
el.profileWizardClose.addEventListener('click', closeProfileWizard);
el.profileWizard.querySelector('[data-action="cancel-profile-wizard"]').addEventListener('click', closeProfileWizard);
el.profileWizard.addEventListener('click', (event) => {
  if (event.target === el.profileWizard) closeProfileWizard();
});
el.profileWizardForm.addEventListener('focusin', (event) => {
  const fieldId = event.target?.id;
  if (WIZARD_HELP[fieldId]) setWizardHelpForField(fieldId);
});
el.wizardProfileType.addEventListener('change', syncWizardDefaultsForType);
for (const input of [
  el.wizardProfileName,
  el.wizardPutioFolder,
  el.wizardDownloadAt,
  el.wizardRpcPath,
  el.wizardClientHost,
  el.wizardClientPort,
  el.wizardUseSsl,
  el.wizardEnabled,
]) {
  input.addEventListener('input', updateWizardPreview);
  input.addEventListener('change', updateWizardPreview);
}
el.copyClientSettingsButton.addEventListener('click', () => {
  copyClientSettings().catch((error) => setWizardMessage(error.message, 'error'));
});
el.deleteProfileButton.addEventListener('click', () => {
  deleteProfileById().catch((error) => setWizardMessage(error.message, 'error'));
});
el.refreshButton.addEventListener('click', () => {
  if (!requestStateRefresh()) {
    loadAll().catch((error) => setMessage(error.message, 'error'));
  }
});

loadAll().catch((error) => setMessage(error.message, 'error'));
connectUpdates();
