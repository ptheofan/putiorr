import { state, el } from './state.js';
import { api } from './api.js';
import {
  PROFILE_TYPES,
  DEFAULT_PROFILE_TYPE,
  GRAB_PROFILE_TYPE,
  DEFAULT_PUTIO_FOLDER,
  DEFAULT_DOWNLOAD_FOLDER,
  DEFAULT_CLIENT_HOST,
  DEFAULT_CLIENT_PORT,
  DEFAULT_HELP_FIELD,
} from './constants.js';
import {
  fieldChecked,
  fieldValue,
  slugify,
  numericSelectValue,
  normalizeRpcPath,
  defaultRpcPathForType,
  joinPathParts,
  setText,
  setHidden,
  setProfileFact,
  browserDomainsPayload,
  browserCatchAllPayload,
  grabProfileSummary,
  presetDisplayName,
  setCheckboxChecked,
  setDisabled,
  profileDeletionSummary,
  profileDeletionOutcome,
  profileDeletionRequest,
} from './util.js';
import { setMessage } from './putio.js';
import {
  renderDownloadProfiles,
  downloadProfileDisplayName,
  defaultDownloadProfileId,
  populateDownloadProfileSelect,
} from './download-profiles.js';
import { renderTopology } from './topology.js';

// The wizard intro and the two field-help lines under the App and Storage
// steps are written for an *arr download client. A grab profile has no client
// to copy settings into and no category folder, so both sets are swapped by
// applyProfileTypeLayout() rather than left to contradict the panel.
export const ARR_WIZARD_INTRO = 'Answer a few setup questions, then copy the matching *arr download-client values.';
export const GRAB_WIZARD_INTRO = 'Answer a few setup questions, then point the putiorr browser extension at this profile.';
export const ARR_APP_STEP_HELP = 'The preset fills sensible defaults and adjusts the download funnel for the requirements of this type of *rr app.';
export const GRAB_APP_STEP_HELP = 'Putiorr Grab profiles serve the putiorr browser extension. No *arr app connects to them, so they have no RPC endpoint settings.';
export const ARR_STORAGE_STEP_HELP = 'This path must also be mounted in the app container. The category creates the final app-specific folder inside it.';
export const GRAB_STORAGE_STEP_HELP = 'Browser grabs land directly in this folder. No *arr app asks for a category, so nothing creates a subfolder here.';
export const ARR_AUTO_REMOVE_LABEL = 'App will not signal import completion; remove from putiorr once files download locally';
export const GRAB_AUTO_REMOVE_LABEL = 'Nothing imports a browser grab; remove from putiorr once files download locally';
// What the submit button promises has to be what the server runs: saving a
// grab profile checks the download folder and nothing else, because there is no
// download client at the other end to connect to.
export const ARR_SAVE_BUTTON_LABEL = 'Save & test';
export const GRAB_SAVE_BUTTON_LABEL = 'Save & check folder';
export const ARR_SAVE_PROGRESS_MESSAGE = 'Saving profile and testing connection...';
export const GRAB_SAVE_PROGRESS_MESSAGE = 'Saving profile and checking the download folder...';
export const ARR_SAVE_SUCCESS_MESSAGE = 'Profile tested and saved successfully!';
export const GRAB_SAVE_SUCCESS_MESSAGE = 'Profile saved. The download folder is writable, so browser grabs have somewhere to land.';

export const WIZARD_HELP = {
  wizardProfileType: {
    title: 'App preset',
    paragraphs: (profile) => isGrabProfile(profile)
      ? [
        'Putiorr Grab is the preset for the putiorr browser extension. The extension captures the magnet links and .torrent downloads you click in the browser and sends them to putiorr, which queues them on put.io and downloads them into this profile.',
        'The sites listed on this profile route to it: a grab from one of them lands here, and one profile can additionally be set to take the grabs no site claims. Only Putiorr Grab profiles are offered to the extension, and a grab aimed at any other preset is refused.',
        'Install the extension from the Chrome Web Store once it is published. Until then, open chrome://extensions, turn on Developer mode, choose Load unpacked, and pick the extension/ folder from the putiorr repository.',
        'Then open the extension options and set the putiorr URL. Where a grab lands is decided here, on these profiles; the extension only holds the connection and whether clicks are captured.',
      ]
      : [
        'The preset fills sensible defaults and adjusts the download funnel for the requirements of this type of *rr app.',
        'For apps such as Prowlarr that do not later signal import completion, the preset can remove completed local downloads from putiorr automatically.',
        'Use Custom when another app will send Transmission RPC requests to putiorr, or when you want to name and route an endpoint yourself.',
      ],
    tips: (profile) => isGrabProfile(profile)
      ? [
        'Auto-remove completed downloads is on by default here: nothing imports a browser grab, so putiorr drops the finished transfer while the files stay on disk.',
        'The RPC endpoint step is hidden because this profile has no Transmission endpoint at all. Nothing connects to it as a download client, and the browser extension reaches it through /api/grab.',
        'Reloading the unpacked extension after a putiorr update keeps its options page in step with the dashboard.',
      ]
      : [
        'Changing the preset rewrites the RPC endpoint path, and the Display name with it while that name is still the one a preset chose. A name you typed yourself is kept.',
        'Sonarr, Radarr, Lidarr, Readarr, and Prowlarr presets each get their own path because the request path is what names the profile. The shared /transmission/rpc endpoint serves one RR profile and refuses once there are two.',
      ],
    valueLabel: 'Selected setup',
    value: (profile, settings) => isGrabProfile(profile)
      ? `${settings.appLabel}: sites ${browserDomainsText(profile)}, downloads to ${settings.directory}`
      : `${settings.appLabel}: category ${settings.category}, URL Base ${settings.urlBase}`,
  },
  wizardProfileName: {
    title: 'Display name',
    paragraphs: (profile) => isGrabProfile(profile)
      ? [
        'The display name is shown on the profile card and in the browser extension, both in its profile list and in the right-click menu that sends a link to a specific profile.',
        'Nothing outside putiorr addresses this profile by name, so the name is yours to choose. It does have to be unique: putiorr identifies the profile by the slug derived from it.',
      ]
      : [
        'The display name is shown on the profile card and is also converted into the download-client Category.',
        'For the usual setup, keep names simple: Sonarr becomes category sonarr, Radarr becomes category radarr, and so on.',
      ],
    tips: (profile) => isGrabProfile(profile)
      ? [
        'Name grab profiles after what they collect, such as movies or music, because that is what the right-click menu will read.',
        'Two profiles cannot share a name: the slug derived from it identifies the profile, so the save is refused and names the profile already holding it.',
      ]
      : [
        'If you create two profiles for the same app, use names that make different categories obvious, such as sonarr-4k and sonarr-anime.',
        'Keep this value stable after a download is queued. Changing the category can make older completed downloads harder for the app to match.',
      ],
    valueLabel: (profile) => isGrabProfile(profile) ? 'Name in the extension' : 'Download-client Category',
    value: (profile, settings) => isGrabProfile(profile)
      ? profile.name || settings.appLabel
      : settings.category,
  },
  wizardPutioFolder: {
    title: 'Put.io destination folder',
    paragraphs: (profile) => isGrabProfile(profile)
      ? [
        'This is the remote put.io folder where putiorr asks put.io to place the transfers this profile starts. It is not the local folder the files are downloaded into.',
        'A single put.io folder, such as putiorr, is usually enough. Browser grabs are separated by the local folder each grab profile downloads into, not by anything on put.io.',
      ]
      : [
        'This is the remote put.io folder where putiorr asks put.io to place new transfers. It is not the local folder Sonarr or Radarr imports from.',
        'A single put.io folder, such as putiorr, is usually enough. The local category keeps each app separated later.',
      ],
    tips: (profile) => isGrabProfile(profile)
      ? [
        'Changing this affects new transfers only; it does not move existing files already on put.io.',
        'Give browser grabs their own put.io folder if you want the put.io web UI to keep them apart from what the *arr apps queue.',
      ]
      : [
        'Changing this affects new transfers only; it does not move existing files already on put.io.',
        'Use a dedicated folder if you want the put.io web UI to show these app downloads separately from manual downloads.',
      ],
    valueLabel: 'Remote put.io folder',
    value: (profile) => profile.putio_folder_name || DEFAULT_PUTIO_FOLDER,
  },
  wizardDownloadAt: {
    title: 'Shared download folder',
    paragraphs: (profile) => isGrabProfile(profile)
      ? [
        'Browser grabs are copied into this folder as they are named on put.io. There is no category subfolder here: that folder exists so an *arr app can find its own imports, and no app imports a browser grab.',
        'The folder only has to be reachable by putiorr. Point it at whatever library or inbox you want browser downloads to appear in.',
      ]
      : [
        'You can use a single folder for all *arr apps, for example /putiorr. When you do that, set the *arr download-client Category to the app category so imports land under /putiorr/sonarr, /putiorr/radarr, and similar app-specific folders.',
        'This folder must be mounted in both putiorr and the *arr container. If the app cannot see this exact path, completed-download import fails even though putiorr finished copying the files.',
      ],
    tips: (profile) => isGrabProfile(profile)
      ? [
        'Give grab profiles their own folder when you want browser downloads kept apart from what the *arr apps import.',
        'If putiorr runs in Docker, this path must be mounted into the putiorr container.',
      ]
      : [
        'Recommended shared setup: Directory is /putiorr and Category is sonarr, radarr, lidarr, or readarr.',
        'If you use separate folders per app, set Directory to that app mount and still keep Category consistent with the profile.',
        'If imports fail with a path-not-found error, compare the container volume mounts before changing this value.',
      ],
    valueLabel: (profile) => isGrabProfile(profile) ? 'Grab download folder' : 'Final category folder',
    value: (profile, settings) => isGrabProfile(profile)
      ? settings.directory
      : joinPathParts(settings.directory, settings.category),
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
      'This is the unique path putiorr reserves for this profile. The request path is the only thing that tells putiorr which profile a download belongs to.',
      'The shared /transmission/rpc endpoint works only while one RR profile could have meant it. Add a second and putiorr refuses requests there until each app uses its own path.',
    ],
    tips: [
      'No *arr change is required while this is your only RR profile. Beyond that, set the app URL Base so it reaches this path.',
      'Choose a path ending in /rpc and set the app URL Base to the preceding path. The app Category then only names the subfolder downloads are staged into.',
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
    // Disabled means one thing everywhere: this profile accepts no new work.
    // It is a refusal, not a disappearance — the help says so in both
    // directions, because the old behaviour was that a disabled profile
    // quietly handed its downloads to another one.
    paragraphs: (profile) => isGrabProfile(profile)
      ? [
        'Enabled profiles accept browser grabs. Disable one when you want to keep its sites and folders but stop new grabs landing in it.',
        'A disabled profile still claims its sites, and still holds the catch-all if it has it: a grab is refused by name rather than passed to the next profile, so nothing lands in a folder you did not choose.',
      ]
      : [
        'Enabled profiles accept new downloads from the matching endpoint path. Disable a profile when you want to keep its settings but stop new grabs using it.',
        'A disabled profile still owns its RPC path and the shared endpoint it was resolving: an add is refused with a message naming this profile, rather than routed to another one.',
      ],
    tips: (profile) => isGrabProfile(profile)
      ? [
        'Downloads already in progress keep downloading, and stay listed and deletable in the dashboard.',
        'The extension lists enabled profiles only, so a disabled one drops out of its profile list and its right-click menu until you switch it back on.',
        'put.io transfers that land in this profile\'s folder while it is off are not adopted, and say so in the dashboard.',
      ]
      : [
        'Downloads already in progress keep downloading, and the app can still list, import and remove them over RPC.',
        'Re-enable the profile when the corresponding *arr download client is ready to test again.',
      ],
    valueLabel: 'Profile state',
    value: (profile) => {
      if (isGrabProfile(profile)) {
        return profile.enabled ? 'Enabled: accepts browser grabs' : 'Disabled: refuses new grabs, keeps the ones it has';
      }
      return profile.enabled ? 'Enabled: accepts new downloads' : 'Disabled: refuses new adds, keeps the ones it has';
    },
  },
  wizardAutoRemoveCompleted: {
    title: 'Auto-remove completed downloads',
    paragraphs: [
      'Use this when the app will not call torrent-remove to signal import or completion, even though it uses putiorr as a download client.',
      'When enabled, putiorr removes the download from its own list as soon as all files are downloaded locally. The local files stay on disk.',
    ],
    tips: [
      'Leave this off for Sonarr, Radarr, Lidarr, and Readarr because those apps remove imported downloads themselves.',
      'The Prowlarr and Putiorr Grab presets enable this by default: nothing imports those downloads, so nobody would ever clear them.',
    ],
    valueLabel: 'Completion behavior',
    value: (profile) => profile.auto_remove_completed || profile.autoRemoveCompleted
      ? 'Auto-remove from putiorr after local download'
      : 'Wait for the app to remove the download',
  },
  wizardBrowserDomains: {
    title: 'Browser sites',
    paragraphs: [
      'The websites whose browser-extension grabs are sent to this profile. A magnet or torrent clicked on one of these sites lands here, and this claim beats every other way a grab could be routed except a profile picked by hand from the right-click menu.',
      'Separate sites with commas. Subdomains are matched automatically, so x.example also covers tracker.x.example. Do not write *.x.example.',
    ],
    tips: [
      'Leave this empty and tick the box below to take every grab no other profile claims. Empty with the box clear keeps this profile out of browser grabs entirely.',
      'Only Putiorr Grab profiles claim sites. A site listed on an *arr profile is never consulted, which is why the field is shown for this preset alone.',
      'The first matching profile wins, so avoid listing the same site on two profiles.',
      'putiorr rewrites what you type: sites are lowercased, unicode becomes punycode, and any scheme, port, or path is dropped.',
    ],
    valueLabel: 'Sites as typed',
    value: (profile) => browserDomainsText(profile),
  },
  wizardBrowserCatchAll: {
    title: 'Take grabs from any other site',
    paragraphs: [
      'Ticked, this profile takes every browser grab that no profile\'s Browser sites claimed. It is the answer to "where does a grab from a site I never listed go?", and it is the only answer there is: without it, such a grab is refused rather than guessed at.',
      'This is a fallback, not a wildcard. A profile that lists a site still wins for that site and its subdomains, so ticking this box never takes a grab away from a profile that asked for it by name.',
    ],
    tips: [
      'Only one profile may take the rest. Saving a second is refused, naming the profile that already holds it, because two would leave every unlisted site ambiguous.',
      'A profile can do both: list the sites it cares about and take everything else. The two settings answer different grabs.',
      'Switching this profile off does not release the role. A grab from an unlisted site is then refused by name rather than landing in some other profile\'s folder.',
      'With no profile ticked, putiorr refuses such a grab with a message naming this very checkbox. Nothing is dropped in silence.',
    ],
    valueLabel: 'Grabs from unlisted sites',
    value: (profile) => (browserCatchAll(profile)
      ? 'Land in this profile'
      : 'Are refused unless another profile takes them'),
  },
};

// The stored value is an array, the wizard field is the raw comma-separated
// text the user typed, and the help panel reads whichever of the two it is
// handed. Both shapes collapse to the same list here.
export function browserDomainsList(profile) {
  const stored = profile?.browser_domains ?? profile?.browserDomains;
  const entries = Array.isArray(stored) ? stored : String(stored ?? '').split(',');
  return entries.map((entry) => String(entry ?? '').trim()).filter(Boolean);
}

export function browserDomainsText(profile) {
  const domains = browserDomainsList(profile);
  return domains.length ? domains.join(', ') : 'None';
}

// Read off a stored profile, off the wizard's own payload, or off a row an
// older putiorr wrote without the column — all three reach the help panel and
// the card.
export function browserCatchAll(profile) {
  return Boolean(profile?.browser_catch_all ?? profile?.browserCatchAll);
}

// The card answers "where does a grab from an unlisted site go?" for this
// profile, so the negative answer has to be a fact rather than a bare "No":
// off means this profile takes only what it names, not that nothing is set.
export function browserCatchAllText(profile) {
  return browserCatchAll(profile)
    ? 'Takes grabs from any site no other profile claims'
    : 'Only the sites listed';
}

// Warnings ride along on the save response and are never stored, so they are
// read off the reply once and shown with the confirmation. #profileWizardMessage
// renders white-space: pre-line, so one warning per line.
export function browserDomainWarnings(profile) {
  const warnings = profile?.browser_domain_warnings;
  return Array.isArray(warnings) ? warnings.filter((warning) => typeof warning === 'string') : [];
}

// Under their own heading after a blank line: the message being appended to may
// already end in a labelled section, such as the dash-list of checks a failed
// client test produces, and a bare line would read as one more entry in it.
export function withBrowserDomainWarnings(message, profile) {
  const warnings = browserDomainWarnings(profile);
  return warnings.length ? [message, '', 'Browser sites:', ...warnings].join('\n') : message;
}

// The reply that answered for them is the only place they belong; keeping the
// key would leave a stale note attached to the profile in state.
export function withoutBrowserDomainWarnings(profile) {
  const { browser_domain_warnings: warnings, ...rest } = profile;
  return warnings === undefined ? profile : rest;
}

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
  const isGrab = isGrabProfile(profile);
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
      <div class="profile-fact-wide">
        <dt>Browser sites</dt>
        <dd data-role="browser-domains" data-testid="profile-card-browser-domains"></dd>
      </div>
      <div class="profile-fact-wide">
        <dt>Unlisted sites</dt>
        <dd data-role="browser-catch-all" data-testid="profile-card-browser-catch-all"></dd>
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
  // "Not set" reads like a misconfiguration; a grab profile is not supposed to
  // have one. The fact is hidden for grab profiles anyway, so this is the
  // fallback for the one that is mid-switch.
  setProfileFact(card, 'rpc', profile.rpc_path || (isGrab ? 'Not used' : 'Not set'));
  setProfileFact(card, 'putio', profile.putio_folder_name || 'Not set');
  setProfileFact(card, 'download', profile.downloadAt ?? profile.download_at ?? 'Not set');
  setProfileFact(card, 'download-profile', downloadProfileDisplayName(profile.download_profile_id ?? profile.downloadProfileId));
  setProfileFact(card, 'browser-domains', browserDomainsText(profile));
  setProfileFact(card, 'browser-catch-all', browserCatchAllText(profile));
  // A grab profile has no download client to point at its RPC endpoint, and no
  // other preset claims sites or serves a grab from an unlisted one, so each
  // card drops the facts that cannot apply.
  toggleProfileFact(card, 'rpc', isGrab);
  toggleProfileFact(card, 'browser-domains', !isGrab);
  toggleProfileFact(card, 'browser-catch-all', !isGrab);
  const status = card.querySelector('[data-role="status"]');
  status.className = `profile-status status ${profile.enabled === false ? 'warn' : 'ok'}`;
  setText(status, profile.enabled === false ? 'Disabled' : 'Enabled');

  card.querySelector('[data-action="edit"]').addEventListener('click', () => openProfileWizard(profile));
  card.querySelector('[data-action="delete"]').addEventListener('click', () => {
    deleteProfileById(profile.id).catch((error) => setMessage(error.message, 'error'));
  });
  return card;
}

// The fact lives in a wrapper div with its own grid cell, so the row has to be
// hidden rather than emptied; the global [hidden] rule collapses it.
export function toggleProfileFact(card, role, hidden) {
  const fact = card.querySelector(`[data-role="${role}"]`)?.closest('div');
  if (fact) setHidden(fact, hidden);
}

export function profileSummary(profile) {
  if (isGrabProfile(profile)) return grabProfileSummary(
    browserDomainsList(profile),
    browserCatchAll(profile),
  );
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

function setWizardField(input, value) {
  const nextValue = String(value ?? '');
  input.value = nextValue;
  input.setAttribute('value', nextValue);
}

function setWizardChecked(input, checked) {
  input.checked = Boolean(checked);
  input.toggleAttribute('checked', Boolean(checked));
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
  setWizardField(el.wizardProfileId, profile.id || '');
  setWizardField(el.wizardProfileType, type);
  setWizardField(el.wizardProfileName, displayName);
  setWizardField(el.wizardPutioFolder, profile.putio_folder_name || DEFAULT_PUTIO_FOLDER);
  setWizardField(el.wizardDownloadAt, profile.downloadAt ?? profile.download_at ?? defaultDownloadFolder());
  renderDownloadProfileOptions(profile.download_profile_id ?? profile.downloadProfileId ?? defaultDownloadProfileId());
  setWizardField(el.wizardRpcPath, profile.rpc_path || rpcPathForType(type) || '');
  setWizardField(el.wizardClientHost, profile.client_host ?? profile.clientHost ?? DEFAULT_CLIENT_HOST);
  setWizardField(el.wizardClientPort, profile.client_port ?? profile.clientPort ?? DEFAULT_CLIENT_PORT);
  setWizardChecked(el.wizardUseSsl, Boolean(profile.client_use_ssl ?? profile.clientUseSsl));
  setWizardChecked(el.wizardEnabled, profile.enabled !== false);
  setWizardChecked(el.wizardAutoRemoveCompleted, Boolean(
    profile.auto_remove_completed
      ?? profile.autoRemoveCompleted
      ?? detail.autoRemoveCompleted,
  ));
  setWizardField(el.wizardBrowserDomains, browserDomainsList(profile).join(', '));
  setWizardChecked(el.wizardBrowserCatchAll, browserCatchAll(profile));
  el.deleteProfileButton.hidden = !isExisting;
  setText(el.saveProfileButton, saveButtonLabel(type));
  el.profileWizard.dataset.activeHelpField = DEFAULT_HELP_FIELD;
  setWizardMessage('');
  // The dialog element is reused across opens, so the layout of the profile
  // closed last is still in place until this runs.
  applyProfileTypeLayout(type);
  updateWizardPreview();

  el.profileWizard.open = true;
  el.wizardProfileType.focus();
}

export function closeProfileWizard() {
  if (el.profileWizard.open) el.profileWizard.open = false;
}

// A new profile starts on the folder the first one uses, because the *arr apps
// share one staging mount and an add whose download-dir falls outside the
// resolved profile's folder is refused — extractCategory has no subfolder to
// name. Fall back to the hardcoded default only before any profile exists.
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
    rpc_path: rpcPathForType(type),
    auto_remove_completed: Boolean(detail.autoRemoveCompleted),
    enabled: true,
  };
}

export function renderDownloadProfileOptions(selectedId = defaultDownloadProfileId()) {
  el.wizardDownloadProfile.replaceChildren();
  populateDownloadProfileSelect(el.wizardDownloadProfile, selectedId);
}

export function syncWizardDefaultsForType() {
  const nextType = fieldValue(el.wizardProfileType) || DEFAULT_PROFILE_TYPE;
  const nextDetail = profileType(nextType);
  const previousDetail = profileType(el.profileWizard.dataset.previousType || DEFAULT_PROFILE_TYPE);

  setWizardField(el.wizardProfileName, presetDisplayName(
    fieldValue(el.wizardProfileName),
    previousDetail.label,
    nextDetail.label,
  ));
  setWizardField(el.wizardRpcPath, rpcPathForType(nextType) || '');
  setWizardChecked(el.wizardAutoRemoveCompleted, Boolean(nextDetail.autoRemoveCompleted));
  el.profileWizard.dataset.previousType = nextType;
  applyProfileTypeLayout(nextType);
  updateWizardPreview();
}

// Which steps a preset needs: an *arr profile is reached over its RPC endpoint
// and never through the browser, and a grab profile is the reverse. Both
// directions run through here, so switching back restores what the other hid.
export function applyProfileTypeLayout(type = fieldValue(el.wizardProfileType)) {
  const isGrab = type === GRAB_PROFILE_TYPE;
  setHidden(el.wizardRpcStep, isGrab);
  setHidden(el.wizardBrowserStep, !isGrab);
  setHidden(el.copyClientSettingsButton, isGrab);
  setText(el.profileWizardIntro, isGrab ? GRAB_WIZARD_INTRO : ARR_WIZARD_INTRO);
  setText(el.wizardAppStepHelp, isGrab ? GRAB_APP_STEP_HELP : ARR_APP_STEP_HELP);
  setText(el.wizardStorageStepHelp, isGrab ? GRAB_STORAGE_STEP_HELP : ARR_STORAGE_STEP_HELP);
  // The checkbox is slot content, so its label is the element's own text; a
  // grab profile has no app to signal anything.
  setText(el.wizardAutoRemoveCompleted, isGrab ? GRAB_AUTO_REMOVE_LABEL : ARR_AUTO_REMOVE_LABEL);
  setText(el.saveProfileButton, saveButtonLabel(type));
  renumberWizardSteps();
}

// What the wizard is showing right now, which is what its own copy has to
// describe; the saved profile answers isGrabProfile() for everything else.
export function wizardIsGrabPreset() {
  return fieldValue(el.wizardProfileType) === GRAB_PROFILE_TYPE;
}

export function saveButtonLabel(type = fieldValue(el.wizardProfileType)) {
  return type === GRAB_PROFILE_TYPE ? GRAB_SAVE_BUTTON_LABEL : ARR_SAVE_BUTTON_LABEL;
}

// The step numbers count what the user can see, so a preset that hides a step
// still reads 1..N instead of skipping the hidden one's number.
export function renumberWizardSteps() {
  const steps = [...el.profileWizardSteps.querySelectorAll('.wizard-step')].filter((step) => !step.hidden);
  steps.forEach((step, index) => {
    const label = step.querySelector('.step-label');
    if (label) setText(label, `${index + 1}. ${label.dataset.stepTitle}`);
  });
}

// A grab profile has no Transmission endpoint at all. It used to carry a
// derived /grab/<slug>/rpc, invented here and never shown, purely because
// profiles.rpc_path was NOT NULL UNIQUE — and that made the derived path a live
// endpoint an *arr could add into.
export function rpcPathForType(type) {
  return type === GRAB_PROFILE_TYPE ? null : defaultRpcPathForType(type);
}

export function getWizardPayload() {
  return {
    name: fieldValue(el.wizardProfileName).trim(),
    type: fieldValue(el.wizardProfileType) || DEFAULT_PROFILE_TYPE,
    slug: slugify(fieldValue(el.wizardProfileName)),
    putio_folder_name: fieldValue(el.wizardPutioFolder).trim(),
    downloadAt: fieldValue(el.wizardDownloadAt).trim(),
    download_profile_id: numericSelectValue(el.wizardDownloadProfile.value),
    // Explicitly null rather than absent: a profile switched from an *arr
    // preset to grab has to lose the path it used to hold.
    rpc_path: (fieldValue(el.wizardProfileType) || DEFAULT_PROFILE_TYPE) === GRAB_PROFILE_TYPE
      ? null
      : normalizeRpcPath(fieldValue(el.wizardRpcPath)),
    client_host: fieldValue(el.wizardClientHost).trim() || DEFAULT_CLIENT_HOST,
    client_port: fieldValue(el.wizardClientPort).trim(),
    client_use_ssl: fieldChecked(el.wizardUseSsl),
    auto_remove_completed: fieldChecked(el.wizardAutoRemoveCompleted),
    enabled: fieldChecked(el.wizardEnabled),
    // Sent as typed: the server normalizes the list and refuses entries no
    // hostname can match, so the wizard shows that error instead of guessing.
    // Only the presets that show the step send it at all.
    ...browserDomainsPayload(el.wizardBrowserStep.hidden, fieldValue(el.wizardBrowserDomains).trim()),
    ...browserCatchAllPayload(el.wizardBrowserStep.hidden, fieldChecked(el.wizardBrowserCatchAll)),
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
  const needsRpcPath = payload.type !== GRAB_PROFILE_TYPE;
  if (!payload.name || !payload.putio_folder_name || !payload.downloadAt || (needsRpcPath && !payload.rpc_path)) {
    setWizardMessage(needsRpcPath
      ? 'Profile name, put.io folder, download folder, and RPC endpoint are required.'
      : 'Profile name, put.io folder, and download folder are required.', 'error');
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
    upsertProfileState(withoutBrowserDomainWarnings(savedProfile));
    renderProfiles();
    renderDownloadProfiles();
    el.wizardProfileId.value = savedProfile.id || '';
    el.deleteProfileButton.hidden = !savedProfile.id;
    setText(el.saveProfileButton, saveButtonLabel());
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
  setWizardMessage(wizardIsGrabPreset() ? GRAB_SAVE_PROGRESS_MESSAGE : ARR_SAVE_PROGRESS_MESSAGE, 'info');
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
    setWizardMessage(withBrowserDomainWarnings(
      wizardIsGrabPreset() ? GRAB_SAVE_SUCCESS_MESSAGE : ARR_SAVE_SUCCESS_MESSAGE,
      savedProfile,
    ), 'info');
  } catch (error) {
    setWizardMessage(
      savedProfile
        ? withBrowserDomainWarnings(formatClientTestFailureMessage(error, savedProfile), savedProfile)
        : `Profile was not saved.\nReason: ${error.message}`,
      'warn',
    );
  } finally {
    el.saveProfileButton.disabled = false;
  }
}

// Deleting a profile is irreversible and reaches put.io and the disk, so it
// asks first — and asks with counts. The three answers (move, remove, remove
// and take put.io and the files with it) are exclusive per download, so the
// dialog offers one choice and describes exactly one outcome.
export async function deleteProfileById(id = el.wizardProfileId.value) {
  if (!id) {
    closeProfileWizard();
    return;
  }
  await openProfileDeleteDialog(id);
}

export async function openProfileDeleteDialog(id) {
  const preview = await api(`/api/profiles/${id}/deletion-preview`);
  state.pendingProfileDelete = { id: String(id), preview };
  setText(el.profileDeleteTitle, `Delete RR profile ${preview.profile.name}`);
  setText(el.profileDeleteSummary, profileDeletionSummary(preview));
  setProfileDeleteMessage('');
  el.profileDeleteMode.value = '';
  setCheckboxChecked(el.profileDeleteRemote, false);
  setCheckboxChecked(el.profileDeleteLocal, false);
  // Nothing to decide when the profile owns nothing: the choice would be
  // between three outcomes that are all "delete the profile".
  setHidden(el.profileDeleteMode, preview.downloads.total === 0);
  renderProfileDeleteTargets(preview);
  updateProfileDeleteState();
  if (!el.profileDeleteDialog.open) el.profileDeleteDialog.open = true;
}

export function closeProfileDeleteDialog() {
  state.pendingProfileDelete = undefined;
  setProfileDeleteMessage('');
  if (el.profileDeleteDialog.open) el.profileDeleteDialog.open = false;
}

// Only profiles that stage into the same folder are offered: nothing moves on
// disk, so any other target points putiorr at an empty directory. When there
// are none, the reason is spelled out rather than left as an empty picker.
export function renderProfileDeleteTargets(preview) {
  const targets = preview.reassignTargets ?? [];
  el.profileDeleteTarget.replaceChildren();
  for (const target of targets) {
    const option = document.createElement('wa-option');
    option.value = String(target.id);
    // The preset is named here because it changes what happens to a download
    // moved there — a Putiorr Grab profile auto-removes completed downloads by
    // default — and "Browser" alone gives the user nothing to go on.
    option.textContent = `${target.name} (${profileType(target.type).label})`;
    el.profileDeleteTarget.appendChild(option);
  }
  // Nothing preselected, here as well as on the radios: a dialog that arrives
  // with an answer already filled in is one the user can commit without ever
  // having chosen anything.
  el.profileDeleteTarget.value = '';
  const empty = targets.length === 0 && preview.downloads.total > 0;
  setText(el.profileDeleteTargetEmpty, empty
    ? `No other RR profile downloads into ${preview.profile.downloadAt || '(nothing)'},`
      + ' so these downloads have nowhere to move to without their files being left behind.'
    : '');
  setHidden(el.profileDeleteTargetEmpty, !empty);
  // Offering a choice that cannot be completed is worse than not offering it:
  // the radio is switched off and the sentence above says why.
  setDisabled(el.profileDeleteModeMove, empty);
}

export function profileDeleteChoice() {
  return {
    mode: fieldValue(el.profileDeleteMode),
    reassignTo: fieldValue(el.profileDeleteTarget),
    deleteRemote: fieldChecked(el.profileDeleteRemote),
    deleteLocal: fieldChecked(el.profileDeleteLocal),
  };
}

export function updateProfileDeleteState() {
  const pending = state.pendingProfileDelete;
  if (!pending) return;
  const choice = profileDeleteChoice();
  const hasDownloads = pending.preview.downloads.total > 0;
  const targets = pending.preview.reassignTargets ?? [];
  setHidden(el.profileDeleteTarget, !(hasDownloads && choice.mode === 'move' && targets.length > 0));
  setHidden(el.profileDeleteOptions, !(hasDownloads && choice.mode === 'delete'));
  setText(el.profileDeleteOutcome, profileDeletionOutcome(pending.preview, choice));
  // The button commits to an outcome, so it stays disabled until the dialog
  // can name one.
  const answered = !hasDownloads
    || choice.mode === 'delete'
    || (choice.mode === 'move' && Boolean(choice.reassignTo));
  setDisabled(el.profileDeleteButton, !answered);
}

// Coloured the way the download delete confirmation colours its own message,
// because this dialog's refusals are the reason it exists and a refusal that
// renders as ordinary body text reads as a caption.
export function setProfileDeleteMessage(message, tone = 'neutral') {
  setText(el.profileDeleteMessage, message);
  el.profileDeleteMessage.style.color = tone === 'error'
    ? '#b42318'
    : tone === 'ok' ? '#16803f' : '#647275';
}

export async function confirmProfileDelete() {
  const pending = state.pendingProfileDelete;
  if (!pending) return;
  setDisabled(el.profileDeleteButton, true);
  setProfileDeleteMessage('Deleting...');
  try {
    const result = await api(`/api/profiles/${pending.id}`, {
      method: 'DELETE',
      body: JSON.stringify(profileDeletionRequest(pending.preview, profileDeleteChoice())),
    });
    state.profiles = state.profiles.filter((profile) => String(profile.id) !== pending.id);
    closeProfileDeleteDialog();
    renderProfiles();
    renderDownloadProfiles();
    closeProfileWizard();
    setMessage(profileDeleteReport(result), 'ok');
  } catch (error) {
    // The refusals are the point of this dialog — "still owns 4 downloads",
    // "downloads into /other, not /downloads" — so they are shown on it rather
    // than swallowed by a closing modal.
    setProfileDeleteMessage(error.message, 'error');
    updateProfileDeleteState();
  }
}

// What was actually done, not what was asked for: the two differ whenever the
// server refused part of it, and the counts are the only record left.
export function profileDeleteReport(result) {
  const counts = result?.downloads ?? {};
  const parts = [`RR profile ${result?.profile?.name ?? ''} deleted`];
  if (counts.reassigned) parts.push(`${counts.reassigned} download${counts.reassigned === 1 ? '' : 's'} moved`);
  if (counts.deleted) parts.push(`${counts.deleted} download${counts.deleted === 1 ? '' : 's'} removed`);
  if (counts.remoteDeleted) parts.push(`${counts.remoteDeleted} deleted from put.io`);
  if (counts.localDeleted) parts.push(`${counts.localDeleted} deleted from disk`);
  return `${parts.join(', ')}.`;
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
  setText(el.wizardHelpValueLabel, resolveWizardHelpContent(help.valueLabel, profile, settings) || 'Current effect');
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
  const useSsl = Boolean(profile.client_use_ssl ?? profile.clientUseSsl ?? fieldChecked(el.wizardUseSsl));
  // Only ever reached for the *arr presets: a grab profile's wizard shows no
  // client settings at all, because nothing connects to one.
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
    `URL Base: ${settings.urlBase} (enable Show Advanced to reveal this field)`,
    `Full RPC endpoint: ${settings.fullEndpoint}`,
  ].join('\n');
}

export function formatClientTestFailureMessage(error, profile) {
  const settings = getClientSettingsFromProfile(profile);
  // A grab profile is only ever checked for its folder, so the *arr value dump
  // below would answer a folder problem with a page of connection settings the
  // wizard does not even show for this preset.
  if (isGrabProfile(profile)) {
    return [
      'Profile saved, but the download folder check failed.',
      `Reason: ${error.message}`,
      '',
      `Shared folder: ${settings.directory}`,
      '',
      'What to check:',
      ...clientTestFailureChecks(error.message, { grab: true }).map((check) => `- ${check}`),
    ].join('\n');
  }
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

export function clientTestFailureChecks(message = '', { grab = false } = {}) {
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
  // Only the folder is ever checked for a grab profile, so nothing about a
  // connection can explain its failure. 401 is matched as a word: a temp-file
  // name with 401 in the middle of its uuid used to ask a folder error about
  // RPC credentials.
  if (!grab && (lowerMessage.includes('username') || lowerMessage.includes('password') || /\b401\b/.test(lowerMessage))) {
    checks.push('If RPC auth is enabled, enter the same RPC username and password in the *arr download client.');
  }
  if (
    !grab
    && (
      lowerMessage.includes('fetch failed')
      || lowerMessage.includes('timeout')
      || lowerMessage.includes('timed out')
      || lowerMessage.includes('endpoint did not answer')
      || lowerMessage.includes('transmission rpc')
      || lowerMessage.includes('http ')
    )
  ) {
    checks.push(
      'Host and port must be reachable from putiorr for this test, and from the *arr container after you copy the settings.',
      'SSL must match the endpoint: enable it only when the download client reaches putiorr through HTTPS.',
      'URL Base must be the path before /rpc, such as /sonarr/transmission for a /sonarr/transmission/rpc endpoint.',
    );
  }
  checks.push(...(grab
    ? [`After fixing the folder, click ${GRAB_SAVE_BUTTON_LABEL} again.`]
    : [
      'Mount the same shared folder path into the *arr container so it can see completed downloads at that exact Directory value.',
      `After fixing the value, click ${ARR_SAVE_BUTTON_LABEL} again.`,
    ]));
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

// Reads a stored profile or the wizard payload, which both spell the preset in
// `type`; the help panel is handed whichever of the two is current.
export function isGrabProfile(profile) {
  return String(profile?.type ?? '') === GRAB_PROFILE_TYPE;
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
