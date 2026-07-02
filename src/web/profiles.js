import { state, el } from './state.js';
import { api } from './api.js';
import {
  PROFILE_TYPES,
  DEFAULT_PROFILE_TYPE,
  DEFAULT_PUTIO_FOLDER,
  DEFAULT_DOWNLOAD_FOLDER,
  DEFAULT_CLIENT_HOST,
  DEFAULT_CLIENT_PORT,
  DEFAULT_HELP_FIELD,
} from './constants.js';
import {
  fieldValue,
  slugify,
  numericSelectValue,
  normalizeRpcPath,
  defaultRpcPathForType,
  joinPathParts,
  setText,
  setProfileFact,
} from './util.js';
import { setMessage } from './putio.js';
import {
  renderDownloadProfiles,
  downloadProfileDisplayName,
  defaultDownloadProfileId,
  populateDownloadProfileSelect,
} from './download-profiles.js';
import { renderTopology } from './topology.js';

export const WIZARD_HELP = {
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
  wizardDownloadProfile: {
    title: 'Download profile',
    paragraphs: [
      'Choose the local downloader behavior for releases sent through this RR profile. This lets movies, episodes, music, and books use different slow-speed reset thresholds.',
      'The selected download profile is used when putiorr copies files from put.io into the shared download folder.',
    ],
    tips: [
      'Use a stricter threshold for large movie files and a lower threshold for smaller music files.',
      'Changing this affects active and future local downloads that belong to this RR profile.',
    ],
    valueLabel: 'Downloader Profile',
    value: (profile) => downloadProfileDisplayName(profile.download_profile_id ?? profile.downloadProfileId),
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

export function renderProfiles() {
  el.profilesBody.replaceChildren();
  if (state.profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state profile-empty';
    empty.textContent = 'No RR profiles yet. Use the setup wizard to create the Sonarr, Radarr, or Lidarr endpoint.';
    el.profilesBody.appendChild(empty);
  } else {
    for (const profile of state.profiles) {
      el.profilesBody.appendChild(createProfileCard(profile));
    }
  }
  renderTopology();
}

export function createProfileCard(profile) {
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
      <span data-role="status" class="profile-status status"></span>
    </div>
    <dl class="profile-facts">
      <div>
        <dt>Put.io</dt>
        <dd data-role="putio"></dd>
      </div>
      <div>
        <dt>Download</dt>
        <dd data-role="download"></dd>
      </div>
      <div class="profile-fact-wide">
        <dt>Downloader Profile</dt>
        <dd data-role="download-profile"></dd>
      </div>
      <div>
        <dt>RPC</dt>
        <dd data-role="rpc"></dd>
      </div>
    </dl>
    <div class="profile-actions" aria-label="Profile actions">
      <button data-action="edit" class="profile-action primary" type="button">Edit</button>
      <button data-action="delete" class="profile-action danger" type="button">Delete</button>
    </div>
  `;

  setText(card.querySelector('[data-role="type"]'), type.label);
  setText(card.querySelector('[data-role="name"]'), displayName);
  setText(card.querySelector('[data-role="summary"]'), profileSummary(profile));
  setProfileFact(card, 'rpc', profile.rpc_path || 'Not set');
  setProfileFact(card, 'putio', profile.putio_folder_name || 'Not set');
  setProfileFact(card, 'download', profile.downloadAt ?? profile.download_at ?? 'Not set');
  setProfileFact(card, 'download-profile', downloadProfileDisplayName(profile.download_profile_id ?? profile.downloadProfileId));
  const status = card.querySelector('[data-role="status"]');
  status.className = `profile-status status ${profile.enabled === false ? 'warn' : 'ok'}`;
  setText(status, profile.enabled === false ? 'Disabled' : 'Enabled');

  card.querySelector('[data-action="edit"]').addEventListener('click', () => openProfileWizard(profile));
  card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteProfileById(profile.id));
  return card;
}

export function profileSummary(profile) {
  const payload = getClientSettingsFromProfile({
    ...profile,
    name: profileDisplayName(profile),
  });
  const rootHint = profileType(profile.type).root;
  return rootHint
    ? `Imports to ${rootHint}.`
    : `Uses category ${payload.category}.`;
}

export function upsertProfileState(profile) {
  const index = state.profiles.findIndex((existing) => String(existing.id) === String(profile.id));
  if (index >= 0) state.profiles[index] = profile;
  else state.profiles.push(profile);
}

export function openProfileWizard(profile = createDefaultProfile(DEFAULT_PROFILE_TYPE)) {
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
  el.wizardDownloadAt.value = profile.downloadAt ?? profile.download_at ?? defaultDownloadFolder();
  renderDownloadProfileOptions(profile.download_profile_id ?? profile.downloadProfileId ?? defaultDownloadProfileId());
  el.wizardRpcPath.value = profile.rpc_path || defaultRpcPathForType(type);
  el.wizardClientHost.value = profile.client_host ?? profile.clientHost ?? DEFAULT_CLIENT_HOST;
  el.wizardClientPort.value = profile.client_port ?? profile.clientPort ?? DEFAULT_CLIENT_PORT;
  el.wizardUseSsl.checked = Boolean(profile.client_use_ssl ?? profile.clientUseSsl);
  el.wizardEnabled.checked = profile.enabled !== false;
  el.deleteProfileButton.hidden = !isExisting;
  el.saveProfileButton.textContent = 'Save & test';
  el.profileWizard.dataset.activeHelpField = DEFAULT_HELP_FIELD;
  setWizardMessage('');
  updateWizardPreview();

  el.profileWizard.open = true;
  el.wizardProfileType.focus();
}

export function closeProfileWizard() {
  if (el.profileWizard.open) el.profileWizard.open = false;
}

// New profiles must share the download folder that the shared RPC endpoint
// advertises (the default profile's folder, returned by session-get). Otherwise
// a shared-endpoint grab routed here by category lands on a download-dir that is
// outside this profile's folder and the add is rejected. Fall back to the
// hardcoded default only before any profile exists.
export function defaultDownloadFolder() {
  const profiles = state.profiles ?? [];
  const base = profiles.find((profile) => profile.slug === 'default') ?? profiles[0];
  return base?.download_at ?? base?.downloadAt ?? DEFAULT_DOWNLOAD_FOLDER;
}

export function createDefaultProfile(type) {
  const detail = profileType(type);
  return {
    id: '',
    name: detail.label,
    type,
    putio_folder_name: DEFAULT_PUTIO_FOLDER,
    downloadAt: defaultDownloadFolder(),
    download_profile_id: defaultDownloadProfileId(),
    rpc_path: defaultRpcPathForType(type),
    enabled: true,
  };
}

export function renderDownloadProfileOptions(selectedId = defaultDownloadProfileId()) {
  el.wizardDownloadProfile.replaceChildren();
  populateDownloadProfileSelect(el.wizardDownloadProfile, selectedId);
}

export function syncWizardDefaultsForType() {
  const nextType = el.wizardProfileType.value || DEFAULT_PROFILE_TYPE;
  const nextDetail = profileType(nextType);

  el.wizardProfileName.value = nextDetail.label;
  el.wizardRpcPath.value = defaultRpcPathForType(nextType);
  el.profileWizard.dataset.previousType = nextType;
  updateWizardPreview();
}

export function getWizardPayload() {
  return {
    name: fieldValue(el.wizardProfileName).trim(),
    type: el.wizardProfileType.value,
    slug: slugify(fieldValue(el.wizardProfileName)),
    putio_folder_name: fieldValue(el.wizardPutioFolder).trim(),
    downloadAt: fieldValue(el.wizardDownloadAt).trim(),
    download_profile_id: numericSelectValue(el.wizardDownloadProfile.value),
    rpc_path: normalizeRpcPath(fieldValue(el.wizardRpcPath)),
    client_host: fieldValue(el.wizardClientHost).trim() || DEFAULT_CLIENT_HOST,
    client_port: fieldValue(el.wizardClientPort).trim(),
    client_use_ssl: el.wizardUseSsl.checked,
    enabled: el.wizardEnabled.checked,
  };
}

export async function saveProfileFromWizard({
  close = true,
  showMessage = true,
  manageButton = true,
  throwOnError = false,
} = {}) {
  const id = el.wizardProfileId.value;
  const payload = getWizardPayload();
  if (!payload.name || !payload.putio_folder_name || !payload.downloadAt || !payload.rpc_path) {
    setWizardMessage('Profile name, put.io folder, download folder, and RPC endpoint are required.', 'error');
    return undefined;
  }

  if (manageButton) el.saveProfileButton.disabled = true;
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
    renderDownloadProfiles();
    el.wizardProfileId.value = savedProfile.id || '';
    el.deleteProfileButton.hidden = !savedProfile.id;
    el.saveProfileButton.textContent = 'Save & test';
    if (close) closeProfileWizard();
    if (showMessage) setMessage('Profile saved.', 'ok');
    return savedProfile;
  } catch (error) {
    if (throwOnError) throw error;
    setWizardMessage(error.message, 'error');
    return undefined;
  } finally {
    if (manageButton) el.saveProfileButton.disabled = false;
  }
}

export async function saveAndTestClientSettings() {
  el.saveProfileButton.disabled = true;
  setWizardMessage('Saving profile and testing connection...', 'info');
  let savedProfile;
  try {
    savedProfile = await saveProfileFromWizard({
      close: false,
      showMessage: false,
      manageButton: false,
      throwOnError: true,
    });
    if (!savedProfile) return;
    await api('/api/profiles/test-client-settings', {
      method: 'POST',
      body: JSON.stringify(savedProfile),
    });
    setWizardMessage('Profile tested and saved successfully!', 'info');
  } catch (error) {
    setWizardMessage(
      savedProfile
        ? formatClientTestFailureMessage(error, savedProfile)
        : `Profile was not saved.\nReason: ${error.message}`,
      'warn',
    );
  } finally {
    el.saveProfileButton.disabled = false;
  }
}

export async function deleteProfileById(id = el.wizardProfileId.value) {
  if (!id) {
    closeProfileWizard();
    return;
  }

  await api(`/api/profiles/${id}`, { method: 'DELETE' });
  state.profiles = state.profiles.filter((profile) => String(profile.id) !== String(id));
  renderProfiles();
  renderDownloadProfiles();
  closeProfileWizard();
  setMessage('Profile deleted.', 'ok');
}

export function updateWizardPreview() {
  const profile = getWizardPayload();
  const settings = getClientSettingsFromProfile(profile);
  el.profileWizardTitle.textContent = `Set up ${profile.name || settings.appLabel}`;
  setWizardHelpForField(el.profileWizard.dataset.activeHelpField || DEFAULT_HELP_FIELD, profile, settings);
}

export function setWizardHelpForField(fieldId = DEFAULT_HELP_FIELD, profile = getWizardPayload(), settings = getClientSettingsFromProfile(profile)) {
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

export function resolveWizardHelpContent(content, profile, settings) {
  return typeof content === 'function' ? content(profile, settings) : content;
}

export function resolveWizardHelpValue(help, profile, settings) {
  return typeof help.value === 'function' ? help.value(profile, settings) : help.value;
}

export function renderWizardHelpParagraphs(paragraphs = []) {
  el.wizardHelpBody.replaceChildren();
  for (const paragraphText of paragraphs) {
    const paragraph = document.createElement('p');
    setText(paragraph, paragraphText);
    el.wizardHelpBody.appendChild(paragraph);
  }
}

export function renderWizardHelpList(items = []) {
  el.wizardHelpList.replaceChildren();
  for (const itemText of items) {
    const item = document.createElement('li');
    setText(item, itemText);
    el.wizardHelpList.appendChild(item);
  }
}

export function getClientSettingsFromProfile(profile) {
  const detail = profileType(profile.type);
  const host = (profile.client_host ?? profile.clientHost ?? fieldValue(el.wizardClientHost).trim()) || DEFAULT_CLIENT_HOST;
  const port = (profile.client_port ?? profile.clientPort ?? fieldValue(el.wizardClientPort).trim()) || DEFAULT_CLIENT_PORT;
  const useSsl = Boolean(profile.client_use_ssl ?? profile.clientUseSsl ?? el.wizardUseSsl?.checked);
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
    directory: profile.downloadAt ?? profile.download_at ?? defaultDownloadFolder(),
    fullEndpoint: `${protocol}://${host}${portSuffix}${rpcPath}`,
    note: detail.note,
  };
}

export function getClientSettingsText() {
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

export function formatClientTestFailureMessage(error, profile) {
  const settings = getClientSettingsFromProfile(profile);
  return [
    'Profile saved, but tests failed.',
    `Reason: ${error.message}`,
    '',
    'Values tested:',
    `Host: ${settings.host}`,
    `Port: ${settings.port}`,
    `Use SSL: ${settings.useSsl ? 'on' : 'off'}`,
    `URL Base: ${settings.urlBase}`,
    `Full RPC endpoint: ${settings.fullEndpoint}`,
    'Username/Password: blank unless putiorr RPC auth is configured',
    `Category: ${settings.category}`,
    `Shared folder: ${settings.directory}`,
    '',
    'What to check:',
    ...clientTestFailureChecks(error.message).map((check) => `- ${check}`),
  ].join('\n');
}

export function clientTestFailureChecks(message = '') {
  const lowerMessage = message.toLowerCase();
  const checks = [];
  if (
    lowerMessage.includes('shared download folder')
    || lowerMessage.includes('eacces')
    || lowerMessage.includes('eperm')
    || lowerMessage.includes('enotdir')
    || lowerMessage.includes('enoent')
  ) {
    checks.push(
      'The shared folder must be a directory, not a file.',
      'The putiorr process must be able to create a folder, write a file, delete that file, and delete the folder there.',
      'If putiorr runs in Docker, mount that host folder into the putiorr container at the same path.',
    );
  }
  if (lowerMessage.includes('username') || lowerMessage.includes('password') || lowerMessage.includes('401')) {
    checks.push('If RPC auth is enabled, enter the same RPC username and password in the *arr download client.');
  }
  if (
    lowerMessage.includes('fetch failed')
    || lowerMessage.includes('timeout')
    || lowerMessage.includes('timed out')
    || lowerMessage.includes('endpoint did not answer')
    || lowerMessage.includes('transmission rpc')
    || lowerMessage.includes('http ')
  ) {
    checks.push(
      'Host and port must be reachable from putiorr for this test, and from the *arr container after you copy the settings.',
      'SSL must match the endpoint: enable it only when the download client reaches putiorr through HTTPS.',
      'URL Base must be the path before /rpc, such as /sonarr/transmission for a /sonarr/transmission/rpc endpoint.',
    );
  }
  checks.push(
    'Mount the same shared folder path into the *arr container so it can see completed downloads at that exact Directory value.',
    'After fixing the value, click Save & test again.',
  );
  return [...new Set(checks)];
}

export async function copyClientSettings() {
  const text = getClientSettingsText();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    setWizardMessage('Download-client settings copied.', 'info');
  } catch {
    if (copyTextWithSelection(text)) {
      setWizardMessage('Download-client settings copied.', 'info');
      return;
    }
    setWizardMessage('Copy failed. Select the generated settings manually.', 'warn');
  }
}

export function copyTextWithSelection(text) {
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

export function setWizardMessage(message, tone = 'neutral') {
  el.profileWizardMessage.textContent = message;
  if (message) {
    el.profileWizardMessage.dataset.tone = tone === 'warn' || tone === 'error' ? 'warn' : 'info';
  } else {
    delete el.profileWizardMessage.dataset.tone;
  }
}

export function profileType(type) {
  return PROFILE_TYPES[type] ?? PROFILE_TYPES.custom;
}

export function profileDisplayName(profile, detail = profileType(profile?.type)) {
  const name = String(profile?.name ?? '').trim();
  const type = String(profile?.type ?? '').toLowerCase();
  const slug = String(profile?.slug ?? '').toLowerCase();
  if (type === 'custom' && slug === 'default' && name.toLowerCase() === 'default') {
    return PROFILE_TYPES.custom.label;
  }
  return name || detail.label;
}
