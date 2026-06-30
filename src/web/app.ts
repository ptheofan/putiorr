type WebValue = string | number | boolean | null | undefined | WebRecord | WebValue[];
interface WebRecord {
  [key: string]: WebValue;
}

interface AppElement extends HTMLElement {
  checked: boolean;
  close(): void;
  disabled: boolean;
  href: string;
  indeterminate: boolean;
  open: boolean;
  options: HTMLOptionsCollection;
  selectedOptions: HTMLCollectionOf<HTMLOptionElement>;
  showModal(): void;
  value: string;
}

type PutioAccount = {
  status: 'idle' | 'loading' | 'ok' | 'error';
  username: string;
  error: string;
};

interface WebSettings extends WebRecord {
  tokenConfigured?: boolean;
  defaultDownloadProfileId?: number | string;
  downloadPolicy?: WebDownloadProfile;
  putioOAuth?: WebRecord & {
    appId?: string;
    defaultAppId?: string;
    relayUrl?: string;
    defaultRelayUrl?: string;
    redirectUri?: string;
    putioRedirectUri?: string;
    overridesConfigured?: boolean;
    requiresCustomApp?: boolean;
    mode?: string;
  };
}

interface WebProfile extends WebRecord {
  id: number | string;
  name: string;
  type: string;
  slug?: string;
  putio_folder_name?: string;
  download_at?: string;
  downloadAt?: string;
  download_profile_id?: number | string | null;
  downloadProfileId?: number | string | null;
  rpc_path?: string;
  client_host?: string;
  clientHost?: string;
  client_port?: string;
  clientPort?: string;
  client_use_ssl?: boolean;
  clientUseSsl?: boolean;
  enabled?: boolean;
}

interface WebDownloadProfile extends WebRecord {
  id?: number | string;
  name?: string;
  slug?: string;
  slowSpeedThresholdBytesPerSecond?: number;
  slowSpeedDurationSeconds?: number;
  slowSpeedGraceSeconds?: number;
  slowSpeedMinSizeBytes?: number;
}

interface WebDownloadFile extends WebRecord {
  id: number | string;
  relativePath: string;
  size: number;
  downloadedSize: number;
  speed?: number;
  progress: number;
  status: string;
  error?: string;
}

interface WebDownload extends WebRecord {
  id: number | string;
  name: string;
  hash?: string;
  profileName: string;
  profileType: string;
  downloadProfileName?: string;
  downloadAt: string;
  lifecycle: string;
  putioStatus: string;
  putioProgress: number;
  putioCompletion: number;
  localProgress: number;
  combinedProgress: number;
  speed: number;
  eta: number;
  error?: string;
  totalSize: number;
  downloadedSize: number;
  files: {
    total: number;
    complete: number;
    failed: number;
    items: WebDownloadFile[];
  };
}

type WebVersion = {
  updateAvailable?: boolean;
  latestVersion?: string;
  releaseUrl?: string;
  currentVersion?: string;
};

type DeleteTarget = {
  type: 'bucket' | 'files';
  downloadId: number | string;
  fileIds: Array<number | string>;
};

type IdValue = number | string | null;

type ClientSettings = {
  appLabel: string;
  category: string;
  directory: string;
  fullEndpoint: string;
  host: string;
  note: string;
  port: string;
  urlBase: string;
  useSsl: boolean;
};

type SaveProfileOptions = {
  close?: boolean;
  showMessage?: boolean;
  manageButton?: boolean;
  throwOnError?: boolean;
};

type SaveProfileResult = WebProfile | undefined;
type ScrollPosition = { x: number; y: number };
type PutioTestResponse = WebRecord & { username?: string };
type OAuthStartResponse = WebRecord & {
  authUrl: string;
  putioRedirectUri?: string;
  redirectUri?: string;
};

type HelpItem<T> = {
  title: string;
  paragraphs: string[] | ((profile: T, settings: ClientSettings) => string[]);
  tips?: string[] | ((profile: T, settings: ClientSettings) => string[]);
  valueLabel: string;
  value: (profile: T, settings: ClientSettings) => string;
};

type DownloadProfileHelpItem = {
  title: string;
  paragraphs: string[];
  tips?: string[];
  valueLabel: string;
  value: (profile: WebDownloadProfile) => string;
};

type Tone = 'neutral' | 'ok' | 'warn' | 'error' | 'info';
type PutioTab = 'oauth' | 'token';

function q(selector: string): AppElement {
  return document.querySelector(selector) as AppElement;
}

function qa(selector: string): AppElement[] {
  return Array.from(document.querySelectorAll(selector)) as AppElement[];
}

function child(root: ParentNode, selector: string): AppElement {
  return root.querySelector(selector) as AppElement;
}

function children(root: ParentNode, selector: string): AppElement[] {
  return Array.from(root.querySelectorAll(selector)) as AppElement[];
}

const state: {
  settings: WebSettings | undefined;
  profiles: WebProfile[];
  downloadProfiles: WebDownloadProfile[];
  downloads: WebDownload[];
  expandedDownloads: Set<string>;
  fileListScrollTops: Map<string, number>;
  selectedFilesByDownload: Map<string, Set<string>>;
  startingDownloads: Set<string>;
  pendingDelete: DeleteTarget | undefined;
  putioConnectionPromptShown: boolean;
  putioAdvancedOpen: boolean;
  putioAccount: PutioAccount;
  version: WebVersion | undefined;
} = {
  settings: undefined,
  profiles: [],
  downloadProfiles: [],
  downloads: [],
  expandedDownloads: new Set(),
  fileListScrollTops: new Map(),
  selectedFilesByDownload: new Map(),
  startingDownloads: new Set(),
  pendingDelete: undefined,
  putioConnectionPromptShown: false,
  putioAdvancedOpen: false,
  putioAccount: {
    status: 'idle',
    username: '',
    error: '',
  },
  version: undefined,
};

const el = {
  connectionState: q('#connectionState'),
  versionUpdateLink: q('#versionUpdateLink'),
  putioStatusButton: q('#putioStatusButton'),
  putioDialog: q('#putioDialog'),
  putioDialogClose: q('#putioDialogClose'),
  putioTabButtons: qa('[data-putio-tab]'),
  putioTabPanels: qa('[data-putio-panel]'),
  settingsForm: q('#settingsForm'),
  putioToken: q('#putioToken'),
  settingsMessageBox: q('#settingsMessageBox'),
  settingsMessage: q('#settingsMessage'),
  settingsMessageClose: q('#settingsMessageClose'),
  oauthStartButton: q('#oauthStartButton'),
  putioOauthStepLabel: q('#putioOauthStepLabel'),
  putioConnectPanel: q('#putioConnectPanel'),
  putioConnectedPanel: q('#putioConnectedPanel'),
  putioConnectedAccount: q('#putioConnectedAccount'),
  putioDisconnectButton: q('#putioDisconnectButton'),
  oauthSetupHint: q('#oauthSetupHint'),
  putioAdvancedSummary: q('#putioAdvancedSummary'),
  togglePutioAdvancedButton: q('#togglePutioAdvancedButton'),
  putioAdvancedPanel: q('#putioAdvancedPanel'),
  putioOAuthRelayUrl: q('#putioOAuthRelayUrl'),
  putioOAuthAppId: q('#putioOAuthAppId'),
  savePutioOAuthSettingsButton: q('#savePutioOAuthSettingsButton'),
  resetPutioOAuthSettingsButton: q('#resetPutioOAuthSettingsButton'),
  oauthPanel: q('#oauthPanel'),
  oauthCode: q('#oauthCode'),
  oauthLink: q('#oauthLink'),
  oauthCallbackUrl: q('#oauthCallbackUrl'),
  oauthPollButton: q('#oauthPollButton'),
  testConnectionButton: q('#testConnectionButton'),
  savePutioTokenButton: q('#savePutioTokenButton'),
  addProfileButton: q('#addProfileButton'),
  profilesBody: q('#profilesBody'),
  linkDownloadProfilesButton: q('#linkDownloadProfilesButton'),
  addDownloadProfileButton: q('#addDownloadProfileButton'),
  downloadProfilesBody: q('#downloadProfilesBody'),
  profileWizard: q('#profileWizard'),
  profileWizardForm: q('#profileWizardForm'),
  profileWizardTitle: q('#profileWizardTitle'),
  profileWizardIntro: q('#profileWizardIntro'),
  profileWizardClose: q('#profileWizardClose'),
  wizardProfileId: q('#wizardProfileId'),
  wizardProfileType: q('#wizardProfileType'),
  wizardProfileName: q('#wizardProfileName'),
  wizardPutioFolder: q('#wizardPutioFolder'),
  wizardDownloadAt: q('#wizardDownloadAt'),
  wizardDownloadProfile: q('#wizardDownloadProfile'),
  wizardRpcPath: q('#wizardRpcPath'),
  wizardClientHost: q('#wizardClientHost'),
  wizardClientPort: q('#wizardClientPort'),
  wizardUseSsl: q('#wizardUseSsl'),
  wizardEnabled: q('#wizardEnabled'),
  wizardHelpKicker: q('#wizardHelpKicker'),
  wizardHelpTitle: q('#wizardHelpTitle'),
  wizardHelpBody: q('#wizardHelpBody'),
  wizardHelpList: q('#wizardHelpList'),
  wizardHelpValueLabel: q('#wizardHelpValueLabel'),
  wizardHelpValue: q('#wizardHelpValue'),
  profileWizardMessage: q('#profileWizardMessage'),
  saveProfileButton: q('#saveProfileButton'),
  deleteProfileButton: q('#deleteProfileButton'),
  copyClientSettingsButton: q('#copyClientSettingsButton'),
  downloadProfileDialog: q('#downloadProfileDialog'),
  downloadProfileForm: q('#downloadProfileForm'),
  downloadProfileDialogTitle: q('#downloadProfileDialogTitle'),
  downloadProfileDialogClose: q('#downloadProfileDialogClose'),
  downloadProfileId: q('#downloadProfileId'),
  downloadProfileName: q('#downloadProfileName'),
  downloadSlowSpeedThreshold: q('#downloadSlowSpeedThreshold'),
  downloadSlowSpeedThresholdDisabled: q('#downloadSlowSpeedThresholdDisabled'),
  downloadSlowSpeedThresholdAmount: q('#downloadSlowSpeedThresholdAmount'),
  downloadSlowSpeedThresholdUnit: q('#downloadSlowSpeedThresholdUnit'),
  downloadSlowSpeedDuration: q('#downloadSlowSpeedDuration'),
  downloadSlowSpeedDurationAmount: q('#downloadSlowSpeedDurationAmount'),
  downloadSlowSpeedDurationUnit: q('#downloadSlowSpeedDurationUnit'),
  downloadSlowSpeedGrace: q('#downloadSlowSpeedGrace'),
  downloadSlowSpeedGraceAmount: q('#downloadSlowSpeedGraceAmount'),
  downloadSlowSpeedGraceUnit: q('#downloadSlowSpeedGraceUnit'),
  downloadSlowSpeedMinSize: q('#downloadSlowSpeedMinSize'),
  downloadSlowSpeedMinSizeDisabled: q('#downloadSlowSpeedMinSizeDisabled'),
  downloadSlowSpeedMinSizeAmount: q('#downloadSlowSpeedMinSizeAmount'),
  downloadSlowSpeedMinSizeUnit: q('#downloadSlowSpeedMinSizeUnit'),
  downloadProfileHelpKicker: q('#downloadProfileHelpKicker'),
  downloadProfileHelpTitle: q('#downloadProfileHelpTitle'),
  downloadProfileHelpBody: q('#downloadProfileHelpBody'),
  downloadProfileHelpList: q('#downloadProfileHelpList'),
  downloadProfileHelpValueLabel: q('#downloadProfileHelpValueLabel'),
  downloadProfileHelpValue: q('#downloadProfileHelpValue'),
  downloadProfileMessage: q('#downloadProfileMessage'),
  saveDownloadProfileButton: q('#saveDownloadProfileButton'),
  deleteDownloadProfileButton: q('#deleteDownloadProfileButton'),
  profileLinksDialog: q('#profileLinksDialog'),
  profileLinksForm: q('#profileLinksForm'),
  profileLinksClose: q('#profileLinksClose'),
  profileLinksList: q('#profileLinksList'),
  profileLinksMessage: q('#profileLinksMessage'),
  saveProfileLinksButton: q('#saveProfileLinksButton'),
  downloadsList: q('#downloadsList'),
  deleteConfirmDialog: q('#deleteConfirmDialog'),
  deleteConfirmForm: q('#deleteConfirmForm'),
  deleteConfirmTitle: q('#deleteConfirmTitle'),
  deleteConfirmIntro: q('#deleteConfirmIntro'),
  deleteConfirmClose: q('#deleteConfirmClose'),
  deleteFromPutio: q('#deleteFromPutio'),
  deleteFromPutioLabel: q('#deleteFromPutioLabel'),
  deleteLocalFiles: q('#deleteLocalFiles'),
  deleteLocalFilesLabel: q('#deleteLocalFilesLabel'),
  deleteConfirmMessage: q('#deleteConfirmMessage'),
  deleteConfirmButton: q('#deleteConfirmButton'),
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
} as const;

type ProfileTypeDetail = (typeof PROFILE_TYPES)[keyof typeof PROFILE_TYPES];

const DEFAULT_PROFILE_TYPE = 'sonarr';
const DEFAULT_PUTIO_FOLDER = 'putiorr';
const DEFAULT_DOWNLOAD_FOLDER = '/putiorr';
const DEFAULT_CLIENT_HOST = 'putiorr';
const DEFAULT_CLIENT_PORT = '9091';
const DEFAULT_HELP_FIELD = 'wizardProfileType';
const DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD = 'downloadProfileName';
const PUTIO_CONNECTION_TABS: PutioTab[] = ['oauth', 'token'];
const BYTE_UNITS = {
  bytes: 1,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};
const TIME_UNITS = {
  seconds: 1,
  minutes: 60,
};

const WIZARD_HELP: Record<string, HelpItem<WebProfile>> = {
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

const DOWNLOAD_PROFILE_HELP: Record<string, DownloadProfileHelpItem> = {
  downloadProfileName: {
    title: 'Name',
    paragraphs: [
      'The name is shown on download profile cards, RR profile cards, and the link dialog where RR profiles attach to downloader behavior.',
      'Create names around the shape of the files being copied locally, such as Movies, TV Episodes, Music, or Books.',
    ],
    tips: [
      'Keep names short enough to scan in RR profile cards.',
      'If two apps need different reset rules, give each behavior its own download profile.',
    ],
    valueLabel: 'Generated slug',
    value: (profile) => profile.slug || 'Name this profile',
  },
  downloadSlowSpeedThreshold: {
    title: 'Slow threshold',
    paragraphs: [
      'When this is greater than zero, putiorr watches the local copy speed from put.io. If the speed stays below this value for the configured duration, the local copy is reset and resumed.',
      'Use the Off checkbox to disable slow-speed resets for this profile without entering a magic zero value.',
    ],
    tips: [
      'Large movie files can usually tolerate a higher threshold than small music files.',
      'Enter an integer amount and choose bytes/s, MB/s, or GB/s from the unit selector.',
    ],
    valueLabel: 'Current threshold',
    value: (profile) => Number(profile.slowSpeedThresholdBytesPerSecond ?? 0) > 0
      ? formatWholeSpeed(profile.slowSpeedThresholdBytesPerSecond ?? 0)
      : 'Off: slow-speed reset disabled',
  },
  downloadSlowSpeedDuration: {
    title: 'Duration',
    paragraphs: [
      'This is how long the local copy speed must remain below the threshold before putiorr resets the stalled copy.',
      'A longer duration avoids resetting short dips. A shorter duration reacts faster to truly stuck downloads.',
    ],
    tips: [
      'Start around 60 to 120 seconds for large files.',
      'Enter an integer amount and choose seconds or minutes from the unit selector.',
    ],
    valueLabel: 'Reset after',
    value: (profile) => `${profile.slowSpeedDurationSeconds}s below threshold`,
  },
  downloadSlowSpeedGrace: {
    title: 'Startup grace',
    paragraphs: [
      'This delay starts when putiorr begins copying a file locally. Slow-speed checks wait until the grace period has passed.',
      'It prevents a reset while the transfer is still ramping up or opening the destination file.',
    ],
    tips: [
      'Keep a small grace period for fast local disks.',
      'Enter an integer amount and choose seconds or minutes from the unit selector.',
    ],
    valueLabel: 'Grace period',
    value: (profile) => `${profile.slowSpeedGraceSeconds}s before checks start`,
  },
  downloadSlowSpeedMinSize: {
    title: 'Ignore below',
    paragraphs: [
      'Files smaller than this size skip the slow-speed reset guard. That keeps tiny metadata, subtitle, sample, and music files from being reset unnecessarily.',
      'Use the Off checkbox when every file should be eligible for slow-speed checks, regardless of size.',
    ],
    tips: [
      'Music profiles usually need a much lower value than movie profiles.',
      'Enter an integer amount and choose bytes, MB, or GB from the unit selector.',
    ],
    valueLabel: 'Ignored files',
    value: (profile) => `Below ${formatWholeBytes(profile.slowSpeedMinSizeBytes)}`,
  },
};

const oauth: {
  timer: ReturnType<typeof setInterval> | undefined;
  popup: Window | null | undefined;
} = {
  timer: undefined,
  popup: undefined,
};

const updates: {
  socket: WebSocket | undefined;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  reconnectDelayMs: number;
} = {
  socket: undefined,
  reconnectTimer: undefined,
  reconnectDelayMs: 1_000,
};

async function api<T = WebRecord>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const body = await response.json().catch(() => ({})) as WebRecord;
  if (!response.ok) {
    throw new Error(String(body.error || `HTTP ${response.status}`));
  }
  return body as T;
}

function setMessage(message: string, tone: Tone = 'neutral'): void {
  if (!message) {
    el.settingsMessage.textContent = '';
    el.settingsMessageBox.hidden = true;
    return;
  }
  el.settingsMessage.textContent = message;
  el.settingsMessageBox.dataset.tone = tone;
  el.settingsMessageBox.hidden = false;
}

function clearMessage() {
  setMessage('');
}

function stopOAuthPolling() {
  if (oauth.timer) {
    clearInterval(oauth.timer);
    oauth.timer = undefined;
  }
  oauth.popup = undefined;
}

function connectUpdates() {
  if (
    updates.socket
    && (updates.socket.readyState === WebSocket.CONNECTING || updates.socket.readyState === WebSocket.OPEN)
  ) {
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

function resetPutioAccount() {
  state.putioAccount = {
    status: 'idle',
    username: '',
    error: '',
  };
}

function putioAccountName() {
  if (state.putioAccount.status === 'ok') {
    return state.putioAccount.username || 'Put.io account';
  }
  if (state.putioAccount.status === 'error') {
    return 'Connected, account unavailable';
  }
  return 'Checking account...';
}

function putioConnectionSummary() {
  if (!state.settings?.tokenConfigured) {
    return 'No put.io token is configured. Connect with OAuth or paste a token before RPC clients can add downloads.';
  }
  if (state.putioAccount.status === 'ok') {
    return `${putioAccountName()} is connected.`;
  }
  if (state.putioAccount.status === 'error') {
    return 'Put.io token is configured, but account details could not be loaded.';
  }
  return 'Put.io token is configured. Checking account...';
}

async function refreshPutioAccount({ force = false } = {}) {
  if (!state.settings?.tokenConfigured) {
    resetPutioAccount();
    renderConnection();
    return;
  }
  if (
    !force
    && ['loading', 'ok'].includes(state.putioAccount.status)
  ) {
    return;
  }
  state.putioAccount = {
    status: 'loading',
    username: '',
    error: '',
  };
  renderConnection();
  try {
    const result = await api<WebRecord>('/api/putio/test', {
      method: 'POST',
      body: '{}',
    });
    state.putioAccount = {
      status: 'ok',
      username: String(result.username || ''),
      error: '',
    };
  } catch (error) {
    state.putioAccount = {
      status: 'error',
      username: '',
      error: error.message,
    };
  }
  renderConnection();
}

async function loadAll() {
  const [settings, profiles, downloadProfiles, downloads] = await Promise.all([
    api<WebSettings>('/api/settings'),
    api<WebProfile[]>('/api/profiles'),
    api<WebDownloadProfile[]>('/api/download-profiles'),
    api<WebDownload[]>('/api/downloads'),
  ]);
  state.settings = settings;
  state.profiles = profiles;
  state.downloadProfiles = downloadProfiles;
  state.downloads = downloads;
  render();
  if (!consumeOAuthLanding()) promptForMissingPutioConnection();
}

async function refreshDownloads() {
  state.downloads = await api<WebDownload[]>('/api/downloads');
  renderDownloads();
}

async function loadVersion() {
  state.version = await api<WebVersion>('/api/version');
  renderVersion();
}

function applyDownloadsUpdate(message: WebRecord): void {
  if (Array.isArray(message.downloads)) state.downloads = message.downloads as WebDownload[];
  renderDownloads();
}

function render(): void {
  renderVersion();
  renderConnection();
  renderProfiles();
  renderDownloadProfiles();
  renderDownloads();
}

function renderVersion(): void {
  const version = state.version;
  const isUpdateAvailable = Boolean(version?.updateAvailable && version.latestVersion);
  el.versionUpdateLink.hidden = !isUpdateAvailable;
  if (!isUpdateAvailable || !version?.latestVersion) {
    el.versionUpdateLink.removeAttribute('aria-label');
    el.versionUpdateLink.removeAttribute('title');
    return;
  }

  const latest = `v${version.latestVersion}`;
  el.versionUpdateLink.href = version.releaseUrl || 'https://github.com/ptheofan/putiorr/releases/latest';
  el.versionUpdateLink.textContent = `${latest} available`;
  el.versionUpdateLink.title = `putiorr ${latest} is available. Current version: ${version.currentVersion}.`;
  el.versionUpdateLink.setAttribute('aria-label', `${el.versionUpdateLink.textContent}. Open putiorr releases.`);
}

function renderConnection() {
  const connected = Boolean(state.settings?.tokenConfigured);
  const putioOAuth = state.settings?.putioOAuth ?? {};
  const putioRedirectUri = putioOAuth.putioRedirectUri ?? putioOAuth.redirectUri ?? '';
  if (!connected && state.putioAccount.status !== 'idle') resetPutioAccount();
  el.connectionState.textContent = putioConnectionSummary();
  const stateName = connected ? 'connected' : 'needs-token';
  el.putioStatusButton.dataset.state = stateName;
  el.putioStatusButton.title = connected ? 'Put.io connected' : 'Put.io needs a token';
  el.putioStatusButton.setAttribute('aria-label', connected ? 'Put.io connected. Open connection settings.' : 'Put.io needs a token. Open connection settings.');
  if (connected) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
  }
  el.putioOauthStepLabel.textContent = connected ? 'Connected' : 'Connect';
  el.putioConnectPanel.hidden = connected;
  el.putioConnectedPanel.hidden = !connected;
  el.putioConnectedAccount.textContent = putioAccountName();
  el.testConnectionButton.disabled = !connected;
  el.putioDisconnectButton.hidden = !connected;
  el.putioDisconnectButton.disabled = !connected;
  el.putioOAuthRelayUrl.value = putioOAuth.relayUrl ?? putioOAuth.defaultRelayUrl ?? '';
  el.putioOAuthAppId.value = putioOAuth.appId ?? putioOAuth.defaultAppId ?? '';
  el.resetPutioOAuthSettingsButton.disabled = !putioOAuth.overridesConfigured;
  el.putioAdvancedSummary.textContent = putioOAuth.overridesConfigured
    ? 'Using custom OAuth settings'
    : putioOAuth.relayUrl
      ? 'Using default OAuth relay settings'
      : 'Using default self-hosted OAuth settings';
  el.putioAdvancedPanel.hidden = !state.putioAdvancedOpen;
  el.togglePutioAdvancedButton.textContent = state.putioAdvancedOpen
    ? 'hide OAuth settings'
    : 'change OAuth settings';
  if (putioRedirectUri) {
    el.oauthCallbackUrl.textContent = putioRedirectUri;
  }
  el.oauthStartButton.disabled = Boolean(putioOAuth.requiresCustomApp);
  el.oauthStartButton.title = putioOAuth.requiresCustomApp
    ? 'Change the Put.io OAuth App Id under Advanced first.'
    : '';
  if (putioOAuth.requiresCustomApp) {
    el.oauthSetupHint.textContent = `OAuth redirect needs your own put.io app. App id ${putioOAuth.appId} is put.io's Swagger test API. Register ${putioRedirectUri} as the callback URL, then change App Id under Advanced or set PUTIORR_PUTIO_APP_ID.`;
  } else if (putioOAuth.mode === 'hosted-relay') {
    el.oauthSetupHint.textContent = `Hosted relay mode. Register ${putioRedirectUri} as the put.io callback URL. After put.io authorizes, the relay returns to ${putioOAuth.redirectUri}.`;
  } else {
    el.oauthSetupHint.textContent = `Self-hosted redirect mode. Register ${putioRedirectUri} as the put.io callback URL.`;
  }
  el.oauthSetupHint.hidden = !putioRedirectUri;
  if (connected && state.putioAccount.status === 'idle') {
    refreshPutioAccount().catch(() => {});
  }
}

function activePutioTab(): PutioTab {
  return PUTIO_CONNECTION_TABS.includes(el.putioDialog.dataset.activeTab as PutioTab)
    ? el.putioDialog.dataset.activeTab as PutioTab
    : 'oauth';
}

function putioTabFromValue(value: string | undefined): PutioTab {
  return PUTIO_CONNECTION_TABS.includes(value as PutioTab) ? value as PutioTab : 'oauth';
}

function focusPutioTab(tab: PutioTab = activePutioTab()): void {
  if (tab === 'token') {
    el.putioToken.focus();
    return;
  }
  if (state.settings?.tokenConfigured) {
    el.testConnectionButton.focus();
    return;
  }
  el.oauthStartButton.focus();
}

function setPutioTab(tab: PutioTab, { focus = true }: { focus?: boolean } = {}): void {
  const activeTab: PutioTab = PUTIO_CONNECTION_TABS.includes(tab) ? tab : 'oauth';
  el.putioDialog.dataset.activeTab = activeTab;
  for (const button of el.putioTabButtons) {
    const selected = button.dataset.putioTab === activeTab;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of el.putioTabPanels) {
    panel.hidden = panel.dataset.putioPanel !== activeTab;
  }
  el.savePutioTokenButton.hidden = activeTab !== 'token';
  if (focus) focusPutioTab(activeTab);
}

function openPutioDialog(tab: PutioTab = activePutioTab()): void {
  renderConnection();
  setPutioTab(tab, { focus: false });
  if (!el.putioDialog.open) {
    if (typeof el.putioDialog.showModal === 'function') {
      el.putioDialog.showModal();
    } else {
      el.putioDialog.setAttribute('open', '');
    }
  }
  focusPutioTab(activePutioTab());
}

function promptForMissingPutioConnection(): void {
  if (state.putioConnectionPromptShown || state.settings?.tokenConfigured) return;
  state.putioConnectionPromptShown = true;
  openPutioDialog('oauth');
  if (state.settings?.putioOAuth?.requiresCustomApp) {
    setMessage('Put.io OAuth needs your own put.io app id. Direct token still works.', 'warn');
    return;
  }
  setMessage('Put.io not connected. Connect with OAuth or paste a token.', 'warn');
}

function consumeOAuthLanding(): boolean {
  const params = new URLSearchParams(window.location.search);
  const marker = params.get('putioOAuth');
  let stored: WebRecord = {};
  try {
    stored = JSON.parse(window.sessionStorage.getItem('putiorr:oauth-result') || '{}');
  } catch {
    stored = {};
  }
  if (!marker && !stored.status) return false;
  window.sessionStorage.removeItem('putiorr:oauth-result');
  if (window.history?.replaceState) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.hash);
  }
  openPutioDialog('oauth');
  if (stored.status === 'error' || marker === 'error') {
    setMessage(String(stored.message || 'Put.io OAuth did not complete.'), 'error');
    return true;
  }
  if (state.settings?.tokenConfigured) {
    setMessage('Put.io OAuth connected and token saved.', 'ok');
    return true;
  }
  setMessage('Put.io OAuth returned, but no token is configured. Check the put.io redirect URI and try again.', 'error');
  return true;
}

function closePutioDialog(): void {
  if (el.putioDialog.open && typeof el.putioDialog.close === 'function') {
    el.putioDialog.close();
  } else {
    el.putioDialog.removeAttribute('open');
  }
}

function setNumberInput(input: AppElement, value: WebValue): void {
  const nextValue = String(Math.max(0, Number.parseInt(String(value ?? 0), 10) || 0));
  if (input.value !== nextValue) input.value = nextValue;
}

function numberInputValue(input: AppElement): number {
  const parsed = Number.parseInt(input.value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function integerInputValue(input: AppElement): number {
  const parsed = Number.parseInt(input.value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function setByteInput(
  hiddenInput: AppElement,
  disabledInput: AppElement,
  amountInput: AppElement,
  unitInput: AppElement,
  value: WebValue,
): void {
  const bytes = Math.max(0, Number.parseInt(String(value ?? 0), 10) || 0);
  const disabled = bytes <= 0;
  hiddenInput.value = String(bytes);
  disabledInput.checked = disabled;

  const { amount, unit } = splitBytesForInput(bytes);
  amountInput.value = disabled ? '' : String(amount);
  unitInput.value = unit;
  updateByteInputDisabledState(disabledInput, amountInput, unitInput);
}

function setTimeInput(hiddenInput: AppElement, amountInput: AppElement, unitInput: AppElement, value: WebValue): void {
  const seconds = Math.max(0, Number.parseInt(String(value ?? 0), 10) || 0);
  hiddenInput.value = String(seconds);
  amountInput.value = String(seconds);
  unitInput.value = 'seconds';
}

function splitBytesForInput(bytes: number): { amount: number; unit: keyof typeof BYTE_UNITS } {
  if (bytes > 0 && bytes % BYTE_UNITS.gb === 0) {
    return { amount: bytes / BYTE_UNITS.gb, unit: 'gb' };
  }
  if (bytes > 0 && bytes % BYTE_UNITS.mb === 0) {
    return { amount: bytes / BYTE_UNITS.mb, unit: 'mb' };
  }
  return { amount: bytes, unit: 'bytes' };
}

function byteInputValue(disabledInput: AppElement, amountInput: AppElement, unitInput: AppElement): number {
  if (disabledInput.checked) return 0;
  return integerInputValue(amountInput) * (BYTE_UNITS[unitInput.value as keyof typeof BYTE_UNITS] ?? BYTE_UNITS.bytes);
}

function timeInputValue(amountInput: AppElement, unitInput: AppElement): number {
  return integerInputValue(amountInput) * (TIME_UNITS[unitInput.value as keyof typeof TIME_UNITS] ?? TIME_UNITS.seconds);
}

function syncByteInput(hiddenInput: AppElement, disabledInput: AppElement, amountInput: AppElement, unitInput: AppElement): void {
  amountInput.value = amountInput.value.replace(/[^\d]/g, '');
  if (!disabledInput.checked && amountInput.value === '' && document.activeElement === disabledInput) {
    amountInput.value = '1';
  }
  hiddenInput.value = String(byteInputValue(disabledInput, amountInput, unitInput));
  updateByteInputDisabledState(disabledInput, amountInput, unitInput);
}

function syncTimeInput(hiddenInput: AppElement, amountInput: AppElement, unitInput: AppElement): void {
  amountInput.value = amountInput.value.replace(/[^\d]/g, '');
  hiddenInput.value = String(timeInputValue(amountInput, unitInput));
}

function updateByteInputDisabledState(disabledInput: AppElement, amountInput: AppElement, unitInput: AppElement): void {
  const disabled = disabledInput.checked;
  const wrapper = disabledInput.closest('.byte-input');
  if (wrapper) wrapper.classList.toggle('is-disabled', disabled);
  amountInput.disabled = disabled;
  unitInput.disabled = disabled;
}

function renderProfiles(): void {
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

function createProfileCard(profile: WebProfile): HTMLElement {
  const type = profileType(profile.type);
  const displayName = profileDisplayName(profile, type);
  const card = document.createElement('article');
  card.className = 'profile-card';
  card.dataset.id = String(profile.id || '');
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

  setText(child(card, '[data-role="type"]'), type.label);
  setText(child(card, '[data-role="name"]'), displayName);
  setText(child(card, '[data-role="summary"]'), profileSummary(profile));
  setProfileFact(card, 'rpc', profile.rpc_path || 'Not set');
  setProfileFact(card, 'putio', profile.putio_folder_name || 'Not set');
  setProfileFact(card, 'download', profile.downloadAt ?? profile.download_at ?? 'Not set');
  setProfileFact(card, 'download-profile', downloadProfileDisplayName(profile.download_profile_id ?? profile.downloadProfileId));
  const status = child(card, '[data-role="status"]');
  status.className = `profile-status status ${profile.enabled === false ? 'warn' : 'ok'}`;
  setText(status, profile.enabled === false ? 'Disabled' : 'Enabled');

  child(card, '[data-action="edit"]').addEventListener('click', () => openProfileWizard(profile));
  child(card, '[data-action="delete"]').addEventListener('click', () => deleteProfileById(profile.id));
  return card;
}

function renderDownloadProfiles(): void {
  el.downloadProfilesBody.replaceChildren();
  if (state.downloadProfiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state profile-empty';
    empty.textContent = 'No download profiles yet. Create one to control local download behavior.';
    el.downloadProfilesBody.appendChild(empty);
    return;
  }

  for (const downloadProfile of state.downloadProfiles) {
    el.downloadProfilesBody.appendChild(createDownloadProfileCard(downloadProfile));
  }
}

function createDownloadProfileCard(downloadProfile: WebDownloadProfile): HTMLElement {
  const card = document.createElement('article');
  const usageCount = countRrProfilesUsingDownloadProfile(downloadProfile.id);
  card.className = 'profile-card download-profile-card';
  card.dataset.id = String(downloadProfile.id || '');
  card.innerHTML = `
    <div class="profile-card-main">
      <div>
        <div class="profile-eyebrow">Download profile</div>
        <h3 data-role="name"></h3>
        <p data-role="summary"></p>
      </div>
      <span data-role="status" class="profile-status status"></span>
    </div>
    <dl class="profile-facts">
      <div>
        <dt>Startup grace</dt>
        <dd data-role="grace"></dd>
      </div>
      <div>
        <dt>Ignore below</dt>
        <dd data-role="min-size"></dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd data-role="duration"></dd>
      </div>
      <div>
        <dt>Slow threshold</dt>
        <dd data-role="threshold"></dd>
      </div>
    </dl>
    <div class="profile-actions" aria-label="Download profile actions">
      <button data-action="edit" class="profile-action primary" type="button">Edit</button>
      <button data-action="delete" class="profile-action danger" type="button">Delete</button>
    </div>
  `;

  setText(child(card, '[data-role="name"]'), downloadProfile.name);
  setText(child(card, '[data-role="summary"]'), downloadProfileSummary(downloadProfile, usageCount));
  setText(child(card, '[data-role="status"]'), isDefaultDownloadProfile(downloadProfile) ? 'Default' : `${usageCount} RR`);
  child(card, '[data-role="status"]').className = `profile-status status ${isDefaultDownloadProfile(downloadProfile) ? 'ok' : ''}`;
  setProfileFact(
    card,
    'threshold',
    Number(downloadProfile.slowSpeedThresholdBytesPerSecond) > 0
      ? formatWholeSpeed(downloadProfile.slowSpeedThresholdBytesPerSecond)
      : 'Off',
  );
  setProfileFact(card, 'duration', `${Number(downloadProfile.slowSpeedDurationSeconds ?? 0)}s`);
  setProfileFact(card, 'grace', `${Number(downloadProfile.slowSpeedGraceSeconds ?? 0)}s`);
  setProfileFact(card, 'min-size', formatWholeBytes(downloadProfile.slowSpeedMinSizeBytes));

  child(card, '[data-action="edit"]').addEventListener('click', () => openDownloadProfileDialog(downloadProfile));
  const deleteButton = child(card, '[data-action="delete"]');
  deleteButton.hidden = isDefaultDownloadProfile(downloadProfile);
  deleteButton.addEventListener('click', () => deleteDownloadProfileById(downloadProfile.id));
  return card;
}

function downloadProfileSummary(downloadProfile: WebDownloadProfile, usageCount: number): string {
  if (isDefaultDownloadProfile(downloadProfile)) {
    return 'Fallback policy for RR profiles without a custom attachment.';
  }
  return usageCount === 1
    ? 'Attached to 1 RR profile.'
    : `Attached to ${usageCount} RR profiles.`;
}

function countRrProfilesUsingDownloadProfile(downloadProfileId: WebValue): number {
  const defaultId = defaultDownloadProfileId();
  return state.profiles.filter((profile) => {
    const attachedId = profile.download_profile_id ?? profile.downloadProfileId ?? defaultId;
    return String(attachedId) === String(downloadProfileId);
  }).length;
}

function setProfileFact(card: ParentNode, role: string, value: WebValue): void {
  const element = child(card, `[data-role="${role}"]`);
  setText(element, value);
  setAttribute(element, 'title', value);
}

function profileSummary(profile: WebProfile): string {
  const payload = getClientSettingsFromProfile({
    ...profile,
    name: profileDisplayName(profile),
  });
  const rootHint = profileType(profile.type).root;
  return rootHint
    ? `Imports to ${rootHint}.`
    : `Uses category ${payload.category}.`;
}

function upsertProfileState(profile: WebProfile): void {
  const index = state.profiles.findIndex((existing) => String(existing.id) === String(profile.id));
  if (index >= 0) state.profiles[index] = profile;
  else state.profiles.push(profile);
}

function openProfileWizard(profile: WebProfile = createDefaultProfile(DEFAULT_PROFILE_TYPE)): void {
  const type = profile.type || DEFAULT_PROFILE_TYPE;
  const detail = profileType(type);
  const displayName = profileDisplayName(profile, detail);
  const isExisting = Boolean(profile.id);

  el.profileWizard.dataset.previousType = type;
  el.profileWizardTitle.textContent = isExisting
    ? `Set up ${displayName}`
    : `Set up ${detail.label}`;
  el.profileWizardIntro.textContent = 'Answer a few setup questions, then copy the matching *arr download-client values.';
  el.wizardProfileId.value = String(profile.id || '');
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

  if (typeof el.profileWizard.showModal === 'function') {
    el.profileWizard.showModal();
  } else {
    el.profileWizard.setAttribute('open', '');
  }
  el.wizardProfileType.focus();
}

function closeProfileWizard(): void {
  if (el.profileWizard.open && typeof el.profileWizard.close === 'function') {
    el.profileWizard.close();
  } else {
    el.profileWizard.removeAttribute('open');
  }
}

// New profiles must share the download folder that the shared RPC endpoint
// advertises (the default profile's folder, returned by session-get). Otherwise
// a shared-endpoint grab routed here by category lands on a download-dir that is
// outside this profile's folder and the add is rejected. Fall back to the
// hardcoded default only before any profile exists.
function defaultDownloadFolder(): string {
  const profiles = state.profiles ?? [];
  const base = profiles.find((profile) => profile.slug === 'default') ?? profiles[0];
  return base?.download_at ?? base?.downloadAt ?? DEFAULT_DOWNLOAD_FOLDER;
}

function createDefaultProfile(type: string): WebProfile {
  const detail = profileType(type);
  return {
    id: '',
    name: detail.label,
    type,
    putio_folder_name: DEFAULT_PUTIO_FOLDER,
    download_at: defaultDownloadFolder(),
    downloadAt: defaultDownloadFolder(),
    download_profile_id: defaultDownloadProfileId(),
    downloadProfileId: defaultDownloadProfileId(),
    rpc_path: defaultRpcPathForType(type),
    client_host: DEFAULT_CLIENT_HOST,
    clientHost: DEFAULT_CLIENT_HOST,
    client_port: DEFAULT_CLIENT_PORT,
    clientPort: DEFAULT_CLIENT_PORT,
    client_use_ssl: false,
    clientUseSsl: false,
    enabled: true,
  };
}

function renderDownloadProfileOptions(selectedId: WebValue = defaultDownloadProfileId()): void {
  el.wizardDownloadProfile.replaceChildren();
  populateDownloadProfileSelect(el.wizardDownloadProfile, selectedId);
}

function populateDownloadProfileSelect(select: AppElement, selectedId: WebValue = defaultDownloadProfileId()): void {
  select.replaceChildren();
  const profiles = state.downloadProfiles.length > 0
    ? state.downloadProfiles
    : [{
        id: '',
        name: 'Default',
      }];
  for (const downloadProfile of profiles) {
    const option = document.createElement('option');
    option.value = downloadProfile.id == null ? '' : String(downloadProfile.id);
    option.textContent = downloadProfile.name || 'Default';
    select.appendChild(option);
  }
  const nextValue = selectedId == null ? '' : String(selectedId);
  if (Array.from(select.options).some((option) => option.value === nextValue)) {
    select.value = nextValue;
  }
}

function numericSelectValue(value: WebValue): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function syncWizardDefaultsForType(): void {
  const nextType = el.wizardProfileType.value || DEFAULT_PROFILE_TYPE;
  const nextDetail = profileType(nextType);

  el.wizardProfileName.value = nextDetail.label;
  el.wizardRpcPath.value = defaultRpcPathForType(nextType);
  el.profileWizard.dataset.previousType = nextType;
  updateWizardPreview();
}

function getWizardPayload(): WebProfile {
  return {
    id: el.wizardProfileId.value,
    name: el.wizardProfileName.value.trim(),
    type: el.wizardProfileType.value,
    slug: slugify(el.wizardProfileName.value),
    putio_folder_name: el.wizardPutioFolder.value.trim(),
    downloadAt: el.wizardDownloadAt.value.trim(),
    download_profile_id: numericSelectValue(el.wizardDownloadProfile.value),
    rpc_path: normalizeRpcPath(el.wizardRpcPath.value),
    client_host: el.wizardClientHost.value.trim() || DEFAULT_CLIENT_HOST,
    client_port: el.wizardClientPort.value.trim(),
    client_use_ssl: el.wizardUseSsl.checked,
    enabled: el.wizardEnabled.checked,
  };
}

async function saveProfileFromWizard({
  close = true,
  showMessage = true,
  manageButton = true,
  throwOnError = false,
}: SaveProfileOptions = {}): Promise<SaveProfileResult> {
  const id = el.wizardProfileId.value;
  const payload = getWizardPayload();
  if (!payload.name || !payload.putio_folder_name || !payload.downloadAt || !payload.rpc_path) {
    setWizardMessage('Profile name, put.io folder, download folder, and RPC endpoint are required.', 'error');
    return undefined;
  }

  if (manageButton) el.saveProfileButton.disabled = true;
  try {
    const savedProfile = id
      ? await api<WebProfile>(`/api/profiles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      : await api<WebProfile>('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    upsertProfileState(savedProfile);
    renderProfiles();
    renderDownloadProfiles();
    el.wizardProfileId.value = String(savedProfile.id || '');
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

async function saveAndTestClientSettings(): Promise<void> {
  el.saveProfileButton.disabled = true;
  setWizardMessage('Saving profile and testing connection...', 'info');
  let savedProfile: WebProfile | undefined;
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

async function deleteProfileById(id: WebValue = el.wizardProfileId.value): Promise<void> {
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

function openDownloadProfileDialog(downloadProfile: WebDownloadProfile = createDefaultDownloadProfile()): void {
  const isExisting = Boolean(downloadProfile.id);
  el.downloadProfileDialogTitle.textContent = isExisting
    ? `Download profile: ${downloadProfile.name}`
    : 'New download profile';
  el.downloadProfileId.value = String(downloadProfile.id || '');
  el.downloadProfileName.value = downloadProfile.name || '';
  setByteInput(
    el.downloadSlowSpeedThreshold,
    el.downloadSlowSpeedThresholdDisabled,
    el.downloadSlowSpeedThresholdAmount,
    el.downloadSlowSpeedThresholdUnit,
    downloadProfile.slowSpeedThresholdBytesPerSecond ?? 0,
  );
  setTimeInput(
    el.downloadSlowSpeedDuration,
    el.downloadSlowSpeedDurationAmount,
    el.downloadSlowSpeedDurationUnit,
    downloadProfile.slowSpeedDurationSeconds ?? 120,
  );
  setTimeInput(
    el.downloadSlowSpeedGrace,
    el.downloadSlowSpeedGraceAmount,
    el.downloadSlowSpeedGraceUnit,
    downloadProfile.slowSpeedGraceSeconds ?? 30,
  );
  setByteInput(
    el.downloadSlowSpeedMinSize,
    el.downloadSlowSpeedMinSizeDisabled,
    el.downloadSlowSpeedMinSizeAmount,
    el.downloadSlowSpeedMinSizeUnit,
    downloadProfile.slowSpeedMinSizeBytes ?? 100 * 1024 * 1024,
  );
  el.deleteDownloadProfileButton.hidden = !isExisting || isDefaultDownloadProfile(downloadProfile);
  el.saveDownloadProfileButton.textContent = isExisting ? 'Save profile' : 'Create profile';
  setDownloadProfileMessage('');
  setDownloadProfileHelpForField(DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD);

  if (typeof el.downloadProfileDialog.showModal === 'function') {
    el.downloadProfileDialog.showModal();
  } else {
    el.downloadProfileDialog.setAttribute('open', '');
  }
  el.downloadProfileName.focus();
}

function closeDownloadProfileDialog(): void {
  if (el.downloadProfileDialog.open && typeof el.downloadProfileDialog.close === 'function') {
    el.downloadProfileDialog.close();
  } else {
    el.downloadProfileDialog.removeAttribute('open');
  }
}

function createDefaultDownloadProfile(): WebDownloadProfile {
  const fallback = state.settings?.downloadPolicy ?? state.downloadProfiles[0] ?? {};
  return {
    id: '',
    name: '',
    slowSpeedThresholdBytesPerSecond: fallback.slowSpeedThresholdBytesPerSecond ?? 0,
    slowSpeedDurationSeconds: fallback.slowSpeedDurationSeconds ?? 120,
    slowSpeedGraceSeconds: fallback.slowSpeedGraceSeconds ?? 30,
    slowSpeedMinSizeBytes: fallback.slowSpeedMinSizeBytes ?? 100 * 1024 * 1024,
  };
}

function getDownloadProfilePayload(): WebDownloadProfile {
  return {
    name: el.downloadProfileName.value.trim(),
    slug: slugify(el.downloadProfileName.value),
    slowSpeedThresholdBytesPerSecond: byteInputValue(
      el.downloadSlowSpeedThresholdDisabled,
      el.downloadSlowSpeedThresholdAmount,
      el.downloadSlowSpeedThresholdUnit,
    ),
    slowSpeedDurationSeconds: timeInputValue(el.downloadSlowSpeedDurationAmount, el.downloadSlowSpeedDurationUnit),
    slowSpeedGraceSeconds: timeInputValue(el.downloadSlowSpeedGraceAmount, el.downloadSlowSpeedGraceUnit),
    slowSpeedMinSizeBytes: byteInputValue(
      el.downloadSlowSpeedMinSizeDisabled,
      el.downloadSlowSpeedMinSizeAmount,
      el.downloadSlowSpeedMinSizeUnit,
    ),
  };
}

function updateDownloadProfileHelp(event: Event): void {
  const fieldId = getDownloadProfileHelpFieldFromEvent(event);
  if (fieldId) el.downloadProfileDialog.dataset.activeHelpField = fieldId;
  syncDownloadProfileTimeInputs();
  syncDownloadProfileByteInputs();
  setDownloadProfileHelpForField(el.downloadProfileDialog.dataset.activeHelpField || DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD);
}

function getDownloadProfileHelpFieldFromEvent(event: Event): string {
  const target = event.target as AppElement;
  const fieldId = target?.closest?.('[data-help-field]')?.getAttribute('data-help-field') || target?.id;
  return DOWNLOAD_PROFILE_HELP[fieldId] ? fieldId : '';
}

function syncDownloadProfileByteInputs(): void {
  syncByteInput(
    el.downloadSlowSpeedThreshold,
    el.downloadSlowSpeedThresholdDisabled,
    el.downloadSlowSpeedThresholdAmount,
    el.downloadSlowSpeedThresholdUnit,
  );
  syncByteInput(
    el.downloadSlowSpeedMinSize,
    el.downloadSlowSpeedMinSizeDisabled,
    el.downloadSlowSpeedMinSizeAmount,
    el.downloadSlowSpeedMinSizeUnit,
  );
}

function syncDownloadProfileTimeInputs(): void {
  syncTimeInput(el.downloadSlowSpeedDuration, el.downloadSlowSpeedDurationAmount, el.downloadSlowSpeedDurationUnit);
  syncTimeInput(el.downloadSlowSpeedGrace, el.downloadSlowSpeedGraceAmount, el.downloadSlowSpeedGraceUnit);
}

function setDownloadProfileHelpForField(
  fieldId: string = DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD,
  profile: WebDownloadProfile = getDownloadProfilePayload(),
): void {
  const nextFieldId = DOWNLOAD_PROFILE_HELP[fieldId] ? fieldId : DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD;
  const help = DOWNLOAD_PROFILE_HELP[nextFieldId];
  el.downloadProfileDialog.dataset.activeHelpField = nextFieldId;
  setText(el.downloadProfileHelpKicker, 'Field guide');
  setText(el.downloadProfileHelpTitle, help.title);
  setText(el.downloadProfileHelpValueLabel, help.valueLabel || 'Current value');
  setText(el.downloadProfileHelpValue, resolveDownloadProfileHelpValue(help, profile));
  renderDownloadProfileHelpParagraphs(resolveDownloadProfileHelpContent(help.paragraphs, profile));
  renderDownloadProfileHelpList(resolveDownloadProfileHelpContent(help.tips, profile));
}

function resolveDownloadProfileHelpContent(content: string[] | undefined, _profile: WebDownloadProfile): string[] {
  return content ?? [];
}

function resolveDownloadProfileHelpValue(help: DownloadProfileHelpItem, profile: WebDownloadProfile): string {
  return help.value(profile);
}

function renderDownloadProfileHelpParagraphs(paragraphs: string[] = []): void {
  el.downloadProfileHelpBody.replaceChildren();
  for (const paragraphText of paragraphs) {
    const paragraph = document.createElement('p');
    setText(paragraph, paragraphText);
    el.downloadProfileHelpBody.appendChild(paragraph);
  }
}

function renderDownloadProfileHelpList(items: string[] = []): void {
  el.downloadProfileHelpList.replaceChildren();
  for (const itemText of items) {
    const item = document.createElement('li');
    setText(item, itemText);
    el.downloadProfileHelpList.appendChild(item);
  }
}

async function saveDownloadProfileFromDialog(): Promise<void> {
  const id = el.downloadProfileId.value;
  const payload = getDownloadProfilePayload();
  if (!payload.name) {
    setDownloadProfileMessage('Download profile name is required.', 'error');
    return;
  }

  el.saveDownloadProfileButton.disabled = true;
  try {
    const savedProfile = id
      ? await api<WebDownloadProfile>(`/api/download-profiles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      : await api<WebDownloadProfile>('/api/download-profiles', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    upsertDownloadProfileState(savedProfile);
    renderProfiles();
    renderDownloadProfiles();
    closeDownloadProfileDialog();
    setMessage('Download profile saved.', 'ok');
  } catch (error) {
    setDownloadProfileMessage(error.message, 'error');
  } finally {
    el.saveDownloadProfileButton.disabled = false;
  }
}

function upsertDownloadProfileState(downloadProfile: WebDownloadProfile): void {
  const index = state.downloadProfiles.findIndex((existing) => String(existing.id) === String(downloadProfile.id));
  if (index >= 0) state.downloadProfiles[index] = downloadProfile;
  else state.downloadProfiles.push(downloadProfile);
}

async function deleteDownloadProfileById(id: WebValue = el.downloadProfileId.value): Promise<void> {
  if (!id) {
    closeDownloadProfileDialog();
    return;
  }

  await api(`/api/download-profiles/${id}`, { method: 'DELETE' });
  closeDownloadProfileDialog();
  setMessage('Download profile deleted.', 'ok');
  await loadAll();
}

function openProfileLinksDialog(): void {
  renderProfileLinksList();
  setProfileLinksMessage('');

  if (typeof el.profileLinksDialog.showModal === 'function') {
    el.profileLinksDialog.showModal();
  } else {
    el.profileLinksDialog.setAttribute('open', '');
  }
  child(el.profileLinksList, 'select')?.focus();
}

function closeProfileLinksDialog(): void {
  if (el.profileLinksDialog.open && typeof el.profileLinksDialog.close === 'function') {
    el.profileLinksDialog.close();
  } else {
    el.profileLinksDialog.removeAttribute('open');
  }
}

function renderProfileLinksList(): void {
  el.profileLinksList.replaceChildren();
  if (state.profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Create an RR profile before linking download profiles.';
    el.profileLinksList.appendChild(empty);
    return;
  }

  for (const profile of state.profiles) {
    el.profileLinksList.appendChild(createProfileLinkRow(profile));
  }
}

function createProfileLinkRow(profile: WebProfile): HTMLElement {
  const row = document.createElement('div');
  const selectedId = currentProfileDownloadProfileId(profile);
  row.className = 'link-row';
  row.dataset.id = String(profile.id || '');
  row.dataset.initialDownloadProfileId = selectedId == null ? '' : String(selectedId);
  row.innerHTML = `
    <div class="link-profile">
      <strong data-role="name"></strong>
      <span data-role="meta"></span>
    </div>
    <label>
      Download profile
      <select data-role="download-profile"></select>
    </label>
  `;

  setText(child(row, '[data-role="name"]'), profileDisplayName(profile));
  setText(child(row, '[data-role="meta"]'), `${profileType(profile.type).label} · ${profile.rpc_path || 'No RPC path'}`);
  populateDownloadProfileSelect(child(row, '[data-role="download-profile"]'), selectedId);
  return row;
}

function currentProfileDownloadProfileId(profile: WebProfile): WebValue {
  return profile.download_profile_id ?? profile.downloadProfileId ?? defaultDownloadProfileId();
}

async function saveProfileLinksFromDialog(): Promise<void> {
  const rows = children(el.profileLinksList, '.link-row[data-id]');
  const changes = rows.map((row) => {
    const select = child(row, '[data-role="download-profile"]');
    return {
      id: row.dataset.id,
      initialDownloadProfileId: row.dataset.initialDownloadProfileId,
      downloadProfileId: select?.value ?? '',
    };
  }).filter((change) => change.id && change.downloadProfileId !== change.initialDownloadProfileId);

  if (changes.length === 0) {
    setProfileLinksMessage('No link changes to save.', 'neutral');
    return;
  }

  el.saveProfileLinksButton.disabled = true;
  try {
    const savedProfiles = await Promise.all(changes.map((change) => api<WebProfile>(`/api/profiles/${change.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        download_profile_id: numericSelectValue(change.downloadProfileId),
      }),
    })));
    for (const profile of savedProfiles) upsertProfileState(profile);
    renderProfiles();
    renderDownloadProfiles();
    closeProfileLinksDialog();
    setMessage('RR profile links saved.', 'ok');
  } catch (error) {
    setProfileLinksMessage(error.message, 'error');
  } finally {
    el.saveProfileLinksButton.disabled = false;
  }
}

function updateWizardPreview(): void {
  const profile = getWizardPayload();
  const settings = getClientSettingsFromProfile(profile);
  el.profileWizardTitle.textContent = `Set up ${profile.name || settings.appLabel}`;
  setWizardHelpForField(el.profileWizard.dataset.activeHelpField || DEFAULT_HELP_FIELD, profile, settings);
}

function setWizardHelpForField(
  fieldId: string = DEFAULT_HELP_FIELD,
  profile: WebProfile = getWizardPayload(),
  settings: ClientSettings = getClientSettingsFromProfile(profile),
): void {
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

function resolveWizardHelpContent(
  content: string[] | ((profile: WebProfile, settings: ClientSettings) => string[]) | undefined,
  profile: WebProfile,
  settings: ClientSettings,
): string[] {
  if (!content) return [];
  return typeof content === 'function' ? content(profile, settings) : content;
}

function resolveWizardHelpValue(help: HelpItem<WebProfile>, profile: WebProfile, settings: ClientSettings): string {
  return help.value(profile, settings);
}

function renderWizardHelpParagraphs(paragraphs: string[] = []): void {
  el.wizardHelpBody.replaceChildren();
  for (const paragraphText of paragraphs) {
    const paragraph = document.createElement('p');
    setText(paragraph, paragraphText);
    el.wizardHelpBody.appendChild(paragraph);
  }
}

function renderWizardHelpList(items: string[] = []): void {
  el.wizardHelpList.replaceChildren();
  for (const itemText of items) {
    const item = document.createElement('li');
    setText(item, itemText);
    el.wizardHelpList.appendChild(item);
  }
}

function getClientSettingsFromProfile(profile: WebProfile): ClientSettings {
  const detail = profileType(profile.type);
  const host = (profile.client_host ?? profile.clientHost ?? el.wizardClientHost?.value.trim()) || DEFAULT_CLIENT_HOST;
  const port = (profile.client_port ?? profile.clientPort ?? el.wizardClientPort?.value.trim()) || DEFAULT_CLIENT_PORT;
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

function getClientSettingsText(): string {
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

function formatClientTestFailureMessage(error: Error, profile: WebProfile): string {
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

function clientTestFailureChecks(message: string = ''): string[] {
  const lowerMessage = message.toLowerCase();
  const checks: string[] = [];
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

async function copyClientSettings(): Promise<void> {
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

function copyTextWithSelection(text: string): boolean {
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

function setWizardMessage(message: string, tone: Tone = 'neutral'): void {
  el.profileWizardMessage.textContent = message;
  if (message) {
    el.profileWizardMessage.dataset.tone = tone === 'warn' || tone === 'error' ? 'warn' : 'info';
  } else {
    delete el.profileWizardMessage.dataset.tone;
  }
}

function setDownloadProfileMessage(message: string, tone: Tone = 'neutral'): void {
  el.downloadProfileMessage.textContent = message;
  el.downloadProfileMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

function setProfileLinksMessage(message: string, tone: Tone = 'neutral'): void {
  el.profileLinksMessage.textContent = message;
  el.profileLinksMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

function profileType(type: WebValue): ProfileTypeDetail {
  const key = String(type ?? '').toLowerCase();
  return key in PROFILE_TYPES
    ? PROFILE_TYPES[key as keyof typeof PROFILE_TYPES]
    : PROFILE_TYPES.custom;
}

function defaultDownloadProfileId(): IdValue {
  return state.settings?.defaultDownloadProfileId
    ?? state.downloadProfiles.find((profile) => profile.slug === 'default')?.id
    ?? state.downloadProfiles[0]?.id
    ?? null;
}

function isDefaultDownloadProfile(downloadProfile: WebDownloadProfile | undefined): boolean {
  return String(downloadProfile?.id) === String(defaultDownloadProfileId()) || downloadProfile?.slug === 'default';
}

function findDownloadProfile(id: WebValue): WebDownloadProfile | undefined {
  const targetId = id ?? defaultDownloadProfileId();
  return state.downloadProfiles.find((profile) => String(profile.id) === String(targetId));
}

function downloadProfileDisplayName(id: WebValue): string {
  return findDownloadProfile(id)?.name ?? 'Default';
}

function profileDisplayName(profile: WebProfile, detail: ProfileTypeDetail = profileType(profile?.type)): string {
  const name = String(profile?.name ?? '').trim();
  const type = String(profile?.type ?? '').toLowerCase();
  const slug = String(profile?.slug ?? '').toLowerCase();
  if (type === 'custom' && slug === 'default' && name.toLowerCase() === 'default') {
    return PROFILE_TYPES.custom.label;
  }
  return name || detail.label;
}

function defaultRpcPathForType(type: WebValue): string {
  return `/${slugify(type || DEFAULT_PROFILE_TYPE)}/transmission/rpc`;
}

function normalizeRpcPath(value: WebValue): string {
  const pathValue = String(value ?? '').trim();
  if (!pathValue) return '';
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}

function joinPathParts(base: WebValue, segment: WebValue): string {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanSegment = String(segment || '').replace(/^\/+/, '');
  if (!cleanBase) return cleanSegment ? `/${cleanSegment}` : '';
  return cleanSegment ? `${cleanBase}/${cleanSegment}` : cleanBase;
}

function renderDownloads(): void {
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

  child(el.downloadsList, '.empty-state')?.remove();
  const existingRows = children(el.downloadsList, '.download-row[data-id]');
  const existingById = new Map<string, HTMLElement>(existingRows.map((row) => [String(row.dataset.id), row]));
  const seen = new Set<string>();

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

function createDownloadRow(download: WebDownload): HTMLElement {
  const row = document.createElement('article');
  row.className = 'download-row';
  row.dataset.id = String(download.id);
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
        <div class="download-actions">
          <div class="download-speed-metric">
            <div class="metric-label">Speed / ETA</div>
            <strong data-role="download-speed"></strong>
            <div class="download-meta" data-role="download-eta"></div>
          </div>
          <button class="button secondary compact-button start-download-button" type="button" data-action="start-download">
            <span aria-hidden="true">▶</span>
            <span data-role="start-label">Start</span>
          </button>
          <button class="icon-button danger bucket-delete-button" type="button" data-action="delete-bucket" aria-label="Delete bucket" title="Delete bucket">${trashIcon()}</button>
        </div>
      </div>
    </div>
    <div class="file-panel" data-role="file-panel" hidden>
      <div class="file-panel-head">
        <div class="file-panel-title">
          <strong>Files</strong>
          <span data-role="file-panel-summary"></span>
        </div>
        <div class="file-panel-actions">
          <label class="file-select-all">
            <input type="checkbox" data-action="select-all-files">
            <span>Select all</span>
          </label>
          <button class="button danger compact-button" type="button" data-action="delete-selected-files" disabled>Delete selected</button>
        </div>
      </div>
      <div class="file-list" data-role="file-list"></div>
    </div>
  `;
  child(row, '[data-action="toggle-files"]').addEventListener('click', () => {
    toggleFilePanel(row.dataset.id);
  });
  child(row, '[data-action="delete-bucket"]').addEventListener('click', () => {
    const download = findDownload(row.dataset.id);
    if (download) openBucketDelete(download);
  });
  child(row, '[data-action="start-download"]').addEventListener('click', () => {
    const download = findDownload(row.dataset.id);
    if (download) startDownload(download);
  });
  child(row, '[data-action="select-all-files"]').addEventListener('change', (event) => {
    const download = findDownload(row.dataset.id);
    if (download) setFileSelectionForDownload(download, (event.target as AppElement).checked);
  });
  child(row, '[data-action="delete-selected-files"]').addEventListener('click', () => {
    const download = findDownload(row.dataset.id);
    if (download) openSelectedFilesDelete(download);
  });
  const fileList = child(row, '[data-role="file-list"]');
  fileList.addEventListener('scroll', () => {
    state.fileListScrollTops.set(String(row.dataset.id), fileList.scrollTop);
  }, { passive: true });
  return row;
}

function updateDownloadRow(row: HTMLElement, download: WebDownload): void {
  const putioProgress = clampPercent(download.putioProgress);
  const localProgress = clampPercent(download.localProgress);
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
  row.dataset.error = download.error ? 'true' : 'false';
  setText(child(row, '[data-role="download-title"]'), download.name);
  setText(
    child(row, '[data-role="download-location"]'),
    `${download.profileName} · ${download.downloadProfileName || 'Default'} · ${download.downloadAt}`,
  );
  setText(child(row, '[data-role="download-status"]'), downloadStatusText(download));
  setText(child(row, '[data-role="download-files"]'), download.error || `${fileText} · ${sizeText}`);
  setText(child(row, '[data-role="download-speed"]'), formatSpeed(download.speed));
  setText(child(row, '[data-role="download-eta"]'), formatEta(download.eta));
  setText(child(row, '[data-role="file-count"]'), totalFiles > 0 ? String(totalFiles) : '0');
  const startButton = child(row, '[data-action="start-download"]');
  const starting = state.startingDownloads.has(String(download.id));
  startButton.hidden = !canStartDownload(download);
  startButton.disabled = starting;
  startButton.title = starting ? 'Starting local download' : 'Start local download from put.io';
  setText(child(startButton, '[data-role="start-label"]'), starting ? 'Starting' : 'Start');
  setProgressValue(row, 'putio-bar', 'putio-progress', putioProgress);
  setProgressValue(row, 'local-bar', 'local-progress', localProgress);
  populateFilePanel(row, download, fileItems);
}

async function startDownload(download: WebDownload): Promise<void> {
  const id = String(download.id);
  state.startingDownloads.add(id);
  renderDownloads();
  try {
    const result = await api<{ downloads?: WebDownload[] }>(`/api/downloads/${id}/start`, {
      method: 'POST',
      body: '{}',
    });
    if (Array.isArray(result.downloads)) state.downloads = result.downloads;
    else await refreshDownloads();
  } catch (error) {
    const current = findDownload(id);
    if (current) current.error = error.message;
  } finally {
    state.startingDownloads.delete(id);
    renderDownloads();
    requestStateRefresh();
  }
}

function toggleFilePanel(downloadId: WebValue): void {
  rememberFileListScrollTops();
  const key = String(downloadId);
  if (state.expandedDownloads.has(key)) {
    state.expandedDownloads.delete(key);
  } else {
    state.expandedDownloads.add(key);
  }
  renderDownloads();
}

function populateFilePanel(row: HTMLElement, download: WebDownload, fileItems: WebDownloadFile[]): void {
  const key = String(download.id);
  const expanded = state.expandedDownloads.has(key);
  const button = child(row, '[data-action="toggle-files"]');
  const panel = child(row, '[data-role="file-panel"]');
  const list = child(row, '[data-role="file-list"]');
  const summary = child(row, '[data-role="file-panel-summary"]');
  const selectAll = child(row, '[data-action="select-all-files"]');
  const deleteSelected = child(row, '[data-action="delete-selected-files"]');

  setAttribute(button, 'aria-expanded', String(expanded));
  button.classList.toggle('open', expanded);
  setHidden(panel, !expanded);

  const selectedIds = selectedFileIdsForDownload(download.id);
  const visibleIds = new Set(fileItems.map((file) => String(file.id)));
  const selectedVisibleCount = [...selectedIds].filter((id) => visibleIds.has(id)).length;
  selectAll.checked = fileItems.length > 0 && selectedVisibleCount === fileItems.length;
  selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < fileItems.length;
  selectAll.disabled = fileItems.length === 0;
  deleteSelected.disabled = selectedVisibleCount === 0;
  setText(
    deleteSelected,
    selectedVisibleCount > 0 ? `Delete selected (${selectedVisibleCount})` : 'Delete selected',
  );

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

  child(list, '.file-empty')?.remove();
  const existingRows = Array.from(children(list, '.file-row[data-id]'));
  const existingById = new Map<string, HTMLElement>(existingRows.map((fileRow) => [String(fileRow.dataset.id), fileRow]));
  const seen = new Set<string>();

  fileItems.forEach((file, index) => {
    const id = String(file.id);
    let fileRow = existingById.get(id);
    if (!fileRow) fileRow = createFileRow(file);
    updateFileRow(fileRow, file, download);
    seen.add(id);
    placeChildAt(list, fileRow, index);
  });

  for (const fileRow of existingRows) {
    if (fileRow.dataset.id && !seen.has(String(fileRow.dataset.id))) {
      fileRow.remove();
    }
  }
}

function renderEmptyFileList(list: HTMLElement): void {
  if (child(list, '.file-empty')) return;
  list.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'file-empty';
  empty.textContent = 'File details appear after put.io finishes preparing the transfer.';
  list.appendChild(empty);
}

function createFileRow(file: WebDownloadFile): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.id = String(file.id);
  row.innerHTML = `
    <label class="file-select">
      <input type="checkbox" data-action="select-file">
      <span class="sr-only">Select file</span>
    </label>
    <div class="file-main">
      <div class="file-name" data-role="file-name"></div>
      <div class="download-meta" data-role="file-size"></div>
    </div>
    <span class="file-status" data-role="file-status"></span>
    <div class="file-progress">
      <span class="bar local" data-role="file-bar"><span></span></span>
      <span data-role="file-progress"></span>
    </div>
    <button class="icon-button danger file-delete-button" type="button" data-action="delete-file" aria-label="Delete file" title="Delete file">${trashIcon()}</button>
  `;
  child(row, '[data-action="select-file"]').addEventListener('change', (event) => {
    const downloadId = (row.closest('.download-row') as AppElement | null)?.dataset.id;
    if (downloadId) toggleFileSelection(downloadId, row.dataset.id, (event.target as AppElement).checked);
  });
  child(row, '[data-action="delete-file"]').addEventListener('click', () => {
    const download = findDownload((row.closest('.download-row') as AppElement | null)?.dataset.id);
    const currentFile = findDownloadFile(download, row.dataset.id);
    if (download && currentFile) openSingleFileDelete(download, currentFile);
  });
  return row;
}

function updateFileRow(row: HTMLElement, file: WebDownloadFile, download: WebDownload): void {
  const progress = clampPercent(file.progress);
  const status = file.status || 'pending';
  const speed = Number(file.speed ?? 0);
  const fileSizeText = `${formatBytes(file.downloadedSize)} / ${formatBytes(file.size)}`;
  const sizeText = file.error
    || (status === 'downloading' && speed > 0
      ? `${fileSizeText} · ${formatSpeed(speed)}`
      : fileSizeText);
  const statusBadge = child(row, '[data-role="file-status"]');

  setDataValue(row, 'id', file.id);
  const checkbox = child(row, '[data-action="select-file"]');
  checkbox.checked = selectedFileIdsForDownload(download.id).has(String(file.id));
  checkbox.setAttribute('aria-label', `Select ${file.relativePath || 'file'}`);
  setText(child(row, '[data-role="file-name"]'), file.relativePath || 'Unknown file');
  setText(child(row, '[data-role="file-size"]'), sizeText);
  setText(statusBadge, statusLabel(file.status));
  setDataValue(statusBadge, 'status', status);
  setProgressValue(row, 'file-bar', 'file-progress', progress);
}

function findDownload(downloadId: WebValue): WebDownload | undefined {
  return state.downloads.find((download) => String(download.id) === String(downloadId));
}

function downloadFileItems(download: WebDownload | undefined): WebDownloadFile[] {
  return Array.isArray(download?.files?.items) ? download.files.items : [];
}

function findDownloadFile(download: WebDownload | undefined, fileId: WebValue): WebDownloadFile | undefined {
  return downloadFileItems(download).find((file) => String(file.id) === String(fileId));
}

function selectedFileIdsForDownload(downloadId: WebValue): Set<string> {
  return state.selectedFilesByDownload.get(String(downloadId)) ?? new Set();
}

function editableSelectedFileIdsForDownload(downloadId: WebValue): Set<string> {
  const key = String(downloadId);
  let selected = state.selectedFilesByDownload.get(key);
  if (!selected) {
    selected = new Set<string>();
    state.selectedFilesByDownload.set(key, selected);
  }
  return selected;
}

function toggleFileSelection(downloadId: WebValue, fileId: WebValue, selected: boolean): void {
  const key = String(downloadId);
  const selectedIds = editableSelectedFileIdsForDownload(key);
  if (selected) selectedIds.add(String(fileId));
  else selectedIds.delete(String(fileId));
  if (selectedIds.size === 0) state.selectedFilesByDownload.delete(key);
  renderDownloads();
}

function setFileSelectionForDownload(download: WebDownload, selected: boolean): void {
  const key = String(download.id);
  if (!selected) {
    state.selectedFilesByDownload.delete(key);
    renderDownloads();
    return;
  }
  state.selectedFilesByDownload.set(
    key,
    new Set(downloadFileItems(download).map((file) => String(file.id))),
  );
  renderDownloads();
}

function selectedVisibleFiles(download: WebDownload): WebDownloadFile[] {
  const selectedIds = selectedFileIdsForDownload(download.id);
  return downloadFileItems(download).filter((file) => selectedIds.has(String(file.id)));
}

function openBucketDelete(download: WebDownload): void {
  const files = downloadFileItems(download);
  openDeleteConfirm({
    type: 'bucket',
    downloadId: String(download.id),
    fileIds: files.map((file) => Number(file.id)),
  });
}

function openSingleFileDelete(download: WebDownload, file: WebDownloadFile): void {
  const files = downloadFileItems(download);
  if (files.length === 1) {
    openBucketDelete(download);
    return;
  }
  openDeleteConfirm({
    type: 'files',
    downloadId: String(download.id),
    fileIds: [Number(file.id)],
  });
}

function openSelectedFilesDelete(download: WebDownload): void {
  const files = downloadFileItems(download);
  const selected = selectedVisibleFiles(download);
  if (selected.length === 0) return;
  if (selected.length === files.length) {
    openBucketDelete(download);
    return;
  }
  openDeleteConfirm({
    type: 'files',
    downloadId: String(download.id),
    fileIds: selected.map((file) => Number(file.id)),
  });
}

function openDeleteConfirm(pendingDelete: DeleteTarget): void {
  const download = findDownload(pendingDelete.downloadId);
  if (!download) return;
  const count = pendingDelete.type === 'bucket'
    ? downloadFileItems(download).length
    : pendingDelete.fileIds.length;
  const fileWord = count === 1 ? 'file' : 'files';
  state.pendingDelete = pendingDelete;
  el.deleteFromPutio.checked = true;
  el.deleteLocalFiles.checked = false;
  setDeleteConfirmMessage('');

  if (pendingDelete.type === 'bucket') {
    setText(el.deleteConfirmTitle, 'Delete bucket');
    setText(
      el.deleteConfirmIntro,
      `This will delete "${download.name}" and all ${count} ${fileWord} from putiorr.`,
    );
    setText(el.deleteFromPutioLabel, 'Also delete this bucket from put.io');
    setText(el.deleteLocalFilesLabel, 'Also delete the downloaded files from disk');
  } else {
    setText(el.deleteConfirmTitle, `Delete ${count} ${fileWord}`);
    setText(
      el.deleteConfirmIntro,
      `This will delete ${count} selected ${fileWord} from "${download.name}" in putiorr.`,
    );
    setText(el.deleteFromPutioLabel, count === 1
      ? 'Also delete this file from put.io'
      : 'Also delete these files from put.io');
    setText(el.deleteLocalFilesLabel, count === 1
      ? 'Also delete the downloaded file from disk'
      : 'Also delete the downloaded files from disk');
  }

  updateDeleteConfirmButtonState();
  if (!el.deleteConfirmDialog.open) el.deleteConfirmDialog.showModal();
}

function closeDeleteConfirm(): void {
  state.pendingDelete = undefined;
  setDeleteConfirmMessage('');
  if (el.deleteConfirmDialog.open) el.deleteConfirmDialog.close();
}

function updateDeleteConfirmButtonState(): void {
  const anyChecked = el.deleteFromPutio.checked || el.deleteLocalFiles.checked;
  el.deleteConfirmButton.disabled = !anyChecked;
}

function setDeleteConfirmMessage(message: string, tone: Tone = 'neutral'): void {
  el.deleteConfirmMessage.textContent = message;
  el.deleteConfirmMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

async function confirmPendingDelete(): Promise<void> {
  const pendingDelete = state.pendingDelete;
  if (!pendingDelete) return;

  el.deleteConfirmButton.disabled = true;
  setDeleteConfirmMessage('Deleting...', 'neutral');
  const deleteRemote = Boolean(el.deleteFromPutio.checked);
  const deleteLocal = Boolean(el.deleteLocalFiles.checked);

  try {
    const result = pendingDelete.type === 'bucket'
      ? await api<WebRecord>(`/api/downloads/${pendingDelete.downloadId}/delete`, {
          method: 'POST',
          body: JSON.stringify({ deleteRemote, deleteLocal }),
        })
      : await api<WebRecord>(`/api/downloads/${pendingDelete.downloadId}/files/delete`, {
          method: 'POST',
          body: JSON.stringify({
            fileIds: pendingDelete.fileIds,
            deleteRemote,
            deleteLocal,
          }),
        });

    if (result.bucketDeleted) {
      state.selectedFilesByDownload.delete(String(pendingDelete.downloadId));
      state.expandedDownloads.delete(String(pendingDelete.downloadId));
      state.fileListScrollTops.delete(String(pendingDelete.downloadId));
    } else {
      const selected = selectedFileIdsForDownload(pendingDelete.downloadId);
      for (const fileId of pendingDelete.fileIds) selected.delete(String(fileId));
      if (selected.size === 0) state.selectedFilesByDownload.delete(String(pendingDelete.downloadId));
    }

    closeDeleteConfirm();
    await refreshDownloads();
    requestStateRefresh();
  } catch (error) {
    setDeleteConfirmMessage(error.message, 'error');
  } finally {
    updateDeleteConfirmButtonState();
  }
}

function progressLine(label: string, value: number, barRole: string, valueRole: string, className: string = ''): string {
  return `
    <div class="progress-line">
      <span>${label}</span>
      <span class="bar ${className}" data-role="${barRole}"><span></span></span>
      <span data-role="${valueRole}">${value}%</span>
    </div>
  `;
}

function trashIcon(): string {
  return `
    <svg class="delete-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M7.2 4.2V3.4c0-.8.6-1.4 1.4-1.4h2.8c.8 0 1.4.6 1.4 1.4v.8M3.8 5h12.4M6 7.5l.5 8.2c.1.8.7 1.3 1.4 1.3h4.2c.8 0 1.4-.6 1.4-1.3l.5-8.2M8.7 8.8v5.4M11.3 8.8v5.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

function setProgressValue(row: ParentNode, barRole: string, valueRole: string, value: number): void {
  const nextValue = `${value}%`;
  const bar = child(row, `[data-role="${barRole}"] > span`);
  if (bar.style.getPropertyValue('--value') !== nextValue) {
    bar.style.setProperty('--value', nextValue);
  }
  setText(child(row, `[data-role="${valueRole}"]`), nextValue);
}

function setText(element: Node, value: WebValue): void {
  const nextValue = String(value ?? '');
  if (element.textContent !== nextValue) {
    element.textContent = nextValue;
  }
}

function setAttribute(element: Element, name: string, value: WebValue): void {
  const nextValue = String(value ?? '');
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
  }
}

function setDataValue(element: HTMLElement, name: string, value: WebValue): void {
  const nextValue = String(value ?? '');
  if (element.dataset[name] !== nextValue) {
    element.dataset[name] = nextValue;
  }
}

function setHidden(element: HTMLElement, hidden: boolean): void {
  if (element.hidden !== hidden) {
    element.hidden = hidden;
  }
}

function placeChildAt(parent: Element, childNode: Node, index: number): void {
  const current = parent.children[index] ?? null;
  if (current !== childNode) {
    parent.insertBefore(childNode, current);
  }
}

function rememberFileListScrollTops(): void {
  for (const row of children(el.downloadsList, '.download-row[data-id]')) {
    const panel = child(row, '[data-role="file-panel"]');
    const list = child(row, '[data-role="file-list"]');
    if (!panel || panel.hidden || !list) continue;
    state.fileListScrollTops.set(String(row.dataset.id), list.scrollTop);
  }
}

function pruneDownloadUiState(): void {
  const ids = new Set(state.downloads.map((download) => String(download.id)));
  const downloadsById = new Map(state.downloads.map((download) => [String(download.id), download]));
  for (const id of state.expandedDownloads) {
    if (!ids.has(id)) state.expandedDownloads.delete(id);
  }
  for (const id of state.fileListScrollTops.keys()) {
    if (!ids.has(id)) state.fileListScrollTops.delete(id);
  }
  for (const [id, selectedFileIds] of state.selectedFilesByDownload.entries()) {
    const download = downloadsById.get(id);
    if (!download) {
      state.selectedFilesByDownload.delete(id);
      continue;
    }
    const visibleFileIds = new Set(downloadFileItems(download).map((file) => String(file.id)));
    for (const fileId of selectedFileIds) {
      if (!visibleFileIds.has(fileId)) selectedFileIds.delete(fileId);
    }
    if (selectedFileIds.size === 0) state.selectedFilesByDownload.delete(id);
  }
}

function captureViewportScroll(): ScrollPosition {
  return {
    x: window.scrollX,
    y: window.scrollY,
  };
}

function restoreViewportScroll({ x, y }: ScrollPosition): void {
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo(x, Math.min(y, maxY));
}

function clampPercent(value: WebValue): number {
  return Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
}

function formatBytes(value: WebValue): string {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatWholeBytes(value: WebValue): string {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 / 1024)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatSpeed(value: WebValue): string {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return 'Idle';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

function formatWholeSpeed(value: WebValue): string {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return 'Idle';
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 / 1024)} GB/s`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB/s`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

function formatEta(value: WebValue): string {
  const seconds = Number(value ?? -1);
  if (seconds < 0) return 'ETA unavailable';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

// Mirrors the backend READY_REMOTE_STATUSES: a local download can only start once put.io
// has the files ready. While COMPLETING/DOWNLOADING/queued the Start button would only
// produce a "not ready to download yet" error, so it stays hidden.
const READY_PUTIO_STATUSES = new Set(['COMPLETED', 'SEEDING']);

function canStartDownload(download: WebDownload): boolean {
  return download.lifecycle === 'remote' && READY_PUTIO_STATUSES.has(download.putioStatus);
}

const PUTIO_PHASE_LABELS = {
  IN_QUEUE: 'Queued on Put.io',
  WAITING: 'Queued on Put.io',
  PREPARING_DOWNLOAD: 'Preparing on Put.io',
  DOWNLOADING: 'Downloading on Put.io',
  COMPLETING: 'Completing on Put.io',
  SEEDING: 'Ready on Put.io',
  COMPLETED: 'Ready on Put.io',
  ERROR: 'Put.io error',
};

// While a transfer is still `remote`, the local downloader has not started yet, so the
// lifecycle word alone ("remote") reads as stalled. Surface the put.io phase instead —
// in particular COMPLETING (put.io finished the torrent and is copying it into storage),
// which reports percent_done=100 but its real progress in completion_percent.
function downloadStatusText(download: WebDownload): string {
  const combinedProgress = clampPercent(download.combinedProgress);
  if (download.lifecycle !== 'remote') {
    return `${download.lifecycle} · ${combinedProgress}%`;
  }
  const phase = PUTIO_PHASE_LABELS[download.putioStatus as keyof typeof PUTIO_PHASE_LABELS] ?? 'On Put.io';
  if (download.putioStatus === 'COMPLETING') {
    return `${phase} · ${clampPercent(download.putioCompletion)}%`;
  }
  return `${phase} · ${clampPercent(download.putioProgress)}%`;
}

function statusLabel(value: WebValue): string {
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

function slugify(value: WebValue): string {
  return String(value || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'profile';
}

async function savePutioOAuthSettings(): Promise<void> {
  const appId = el.putioOAuthAppId.value.trim();
  const relayUrl = el.putioOAuthRelayUrl.value.trim();
  if (!appId) {
    setMessage('Put.io OAuth App Id is required.', 'error');
    el.putioOAuthAppId.focus();
    return;
  }
  const settings = await api<WebSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      putioOAuth: {
        appId,
        relayUrl,
      },
    }),
  });
  state.settings = settings;
  renderConnection();
  setMessage('OAuth settings saved.', 'ok');
}

async function resetPutioOAuthSettings(): Promise<void> {
  const settings = await api<WebSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      putioOAuth: {
        reset: true,
      },
    }),
  });
  state.settings = settings;
  renderConnection();
  setMessage('OAuth settings reset to baked defaults.', 'ok');
}

el.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activePutioTab() === 'oauth') {
    await savePutioOAuthSettings().catch((error) => setMessage(error.message, 'error'));
    return;
  }
  const token = el.putioToken.value.trim();
  if (!token && !state.settings?.tokenConfigured) {
    setMessage('Paste a put.io token before saving settings.', 'error');
    return;
  }
  const payload = token ? { putioToken: token } : {};
  const settings = await api<WebSettings>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  state.settings = settings;
  el.putioToken.value = '';
  resetPutioAccount();
  renderConnection();
  setMessage('Token saved.', 'ok');
  if (settings.tokenConfigured) refreshPutioAccount({ force: true }).catch(() => {});
  requestStateRefresh();
});

el.settingsMessageClose.addEventListener('click', clearMessage);

el.togglePutioAdvancedButton.addEventListener('click', () => {
  state.putioAdvancedOpen = !state.putioAdvancedOpen;
  renderConnection();
  if (state.putioAdvancedOpen) el.putioOAuthRelayUrl.focus();
});

el.savePutioOAuthSettingsButton.addEventListener('click', () => {
  savePutioOAuthSettings().catch((error) => setMessage(error.message, 'error'));
});

el.resetPutioOAuthSettingsButton.addEventListener('click', () => {
  resetPutioOAuthSettings().catch((error) => setMessage(error.message, 'error'));
});

el.testConnectionButton.addEventListener('click', async () => {
  try {
    const token = el.putioToken.value.trim();
    const result = await api<PutioTestResponse>('/api/putio/test', {
      method: 'POST',
      body: JSON.stringify(token ? { putioToken: token } : {}),
    });
    state.putioAccount = {
      status: 'ok',
      username: String(result.username || ''),
      error: '',
    };
    renderConnection();
    setMessage(`Connected to put.io${result.username ? ` as ${result.username}` : ''}.`, 'ok');
  } catch (error) {
    state.putioAccount = {
      status: 'error',
      username: '',
      error: error.message,
    };
    renderConnection();
    setMessage(error.message, 'error');
  }
});

el.putioDisconnectButton.addEventListener('click', async () => {
  try {
    stopOAuthPolling();
    const settings = await api<WebSettings>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ putioToken: '' }),
    });
    state.settings = settings;
    el.putioToken.value = '';
    el.oauthPanel.hidden = true;
    resetPutioAccount();
    renderConnection();
    setPutioTab('oauth', { focus: false });
    setMessage(
      settings.tokenConfigured
        ? 'Stored token removed, but an environment token is still configured.'
        : 'Put.io disconnected.',
      settings.tokenConfigured ? 'warn' : 'ok',
    );
    requestStateRefresh();
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthStartButton.addEventListener('click', async () => {
  stopOAuthPolling();
  try {
    const result = await api<OAuthStartResponse>('/api/oauth/start', {
      method: 'POST',
      body: '{}',
    });
    el.oauthCode.textContent = 'OAuth';
    el.oauthLink.href = result.authUrl;
    el.oauthCallbackUrl.textContent = result.putioRedirectUri || result.redirectUri || '';
    el.oauthPanel.hidden = false;
    setMessage('Redirecting to put.io authorization...', 'neutral');
    window.location.assign(result.authUrl);
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

el.oauthPollButton.addEventListener('click', () => {
  refreshOAuthStatus(true).catch((error) => setMessage(error.message, 'error'));
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== 'putiorr:putio-oauth-complete') return;
  refreshOAuthStatus(true).catch((error) => setMessage(error.message, 'error'));
});

async function refreshOAuthStatus(manual: boolean): Promise<void> {
  const settings = await api<WebSettings>('/api/settings');
  state.settings = settings;
  if (settings.tokenConfigured) {
    stopOAuthPolling();
    el.oauthPanel.hidden = true;
    resetPutioAccount();
    renderConnection();
    setMessage('Put.io OAuth connected and token saved.', 'ok');
    refreshPutioAccount({ force: true }).catch(() => {});
    requestStateRefresh();
    return;
  }
  if (manual) {
    setMessage('Still waiting for put.io authorization.', 'neutral');
  }
}

el.addProfileButton.addEventListener('click', () => openProfileWizard(createDefaultProfile(DEFAULT_PROFILE_TYPE)));
el.linkDownloadProfilesButton.addEventListener('click', openProfileLinksDialog);
el.addDownloadProfileButton.addEventListener('click', () => openDownloadProfileDialog(createDefaultDownloadProfile()));
el.profileWizardForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveAndTestClientSettings().catch((error) => setWizardMessage(error.message, 'error'));
});
el.profileWizardClose.addEventListener('click', closeProfileWizard);
child(el.profileWizard, '[data-action="cancel-profile-wizard"]').addEventListener('click', closeProfileWizard);
el.profileWizard.addEventListener('click', (event) => {
  if (event.target === el.profileWizard) closeProfileWizard();
});
el.profileWizardForm.addEventListener('focusin', (event) => {
  const fieldId = (event.target as AppElement).id;
  if (WIZARD_HELP[fieldId]) setWizardHelpForField(fieldId);
});
el.wizardProfileType.addEventListener('change', syncWizardDefaultsForType);
for (const input of [
  el.wizardProfileName,
  el.wizardPutioFolder,
  el.wizardDownloadAt,
  el.wizardDownloadProfile,
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
el.downloadProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveDownloadProfileFromDialog().catch((error) => setDownloadProfileMessage(error.message, 'error'));
});
el.downloadProfileForm.addEventListener('focusin', (event) => {
  const fieldId = getDownloadProfileHelpFieldFromEvent(event);
  if (DOWNLOAD_PROFILE_HELP[fieldId]) setDownloadProfileHelpForField(fieldId);
});
el.downloadProfileForm.addEventListener('click', updateDownloadProfileHelp);
for (const input of [
  el.downloadProfileName,
  el.downloadSlowSpeedThresholdDisabled,
  el.downloadSlowSpeedThresholdAmount,
  el.downloadSlowSpeedThresholdUnit,
  el.downloadSlowSpeedDurationAmount,
  el.downloadSlowSpeedDurationUnit,
  el.downloadSlowSpeedGraceAmount,
  el.downloadSlowSpeedGraceUnit,
  el.downloadSlowSpeedMinSizeDisabled,
  el.downloadSlowSpeedMinSizeAmount,
  el.downloadSlowSpeedMinSizeUnit,
]) {
  input.addEventListener('input', updateDownloadProfileHelp);
  input.addEventListener('change', updateDownloadProfileHelp);
}
el.downloadProfileDialogClose.addEventListener('click', closeDownloadProfileDialog);
child(el.downloadProfileDialog, '[data-action="cancel-download-profile"]').addEventListener('click', closeDownloadProfileDialog);
el.downloadProfileDialog.addEventListener('click', (event) => {
  if (event.target === el.downloadProfileDialog) closeDownloadProfileDialog();
});
el.deleteDownloadProfileButton.addEventListener('click', () => {
  deleteDownloadProfileById().catch((error) => setDownloadProfileMessage(error.message, 'error'));
});
el.profileLinksForm.addEventListener('submit', (event) => {
  event.preventDefault();
  saveProfileLinksFromDialog().catch((error) => setProfileLinksMessage(error.message, 'error'));
});
el.profileLinksClose.addEventListener('click', closeProfileLinksDialog);
child(el.profileLinksDialog, '[data-action="cancel-profile-links"]').addEventListener('click', closeProfileLinksDialog);
el.profileLinksDialog.addEventListener('click', (event) => {
  if (event.target === el.profileLinksDialog) closeProfileLinksDialog();
});
for (const button of el.putioTabButtons) {
  button.addEventListener('click', () => setPutioTab(putioTabFromValue(button.dataset.putioTab)));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = PUTIO_CONNECTION_TABS.indexOf(activePutioTab());
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + direction + PUTIO_CONNECTION_TABS.length) % PUTIO_CONNECTION_TABS.length;
    setPutioTab(PUTIO_CONNECTION_TABS[nextIndex]);
  });
}
el.putioStatusButton.addEventListener('click', () => openPutioDialog('oauth'));
el.putioDialogClose.addEventListener('click', closePutioDialog);
child(el.putioDialog, '[data-action="cancel-putio"]').addEventListener('click', closePutioDialog);
el.putioDialog.addEventListener('click', (event) => {
  if (event.target === el.putioDialog) closePutioDialog();
});
el.deleteConfirmForm.addEventListener('submit', (event) => {
  event.preventDefault();
  confirmPendingDelete();
});
el.deleteFromPutio.addEventListener('change', updateDeleteConfirmButtonState);
el.deleteLocalFiles.addEventListener('change', updateDeleteConfirmButtonState);
el.deleteConfirmClose.addEventListener('click', closeDeleteConfirm);
child(el.deleteConfirmDialog, '[data-action="cancel-delete"]').addEventListener('click', closeDeleteConfirm);
el.deleteConfirmDialog.addEventListener('click', (event) => {
  if (event.target === el.deleteConfirmDialog) closeDeleteConfirm();
});

function setSectionCollapsed(panel: HTMLElement, toggle: AppElement, collapsed: boolean): void {
  panel.classList.toggle('collapsed', collapsed);
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function initCollapsibleSections(): void {
  for (const toggle of children(document, '[data-action="toggle-section"]')) {
    const panel = toggle.closest('.panel') as HTMLElement | null;
    if (!panel) continue;
    const key = `putiorr:collapsed:${panel.id}`;
    let stored = null;
    try {
      stored = localStorage.getItem(key);
    } catch {}
    setSectionCollapsed(panel, toggle, stored === '1');
    const toggleSection = () => {
      const next = !panel.classList.contains('collapsed');
      setSectionCollapsed(panel, toggle, next);
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {}
    };
    toggle.addEventListener('click', toggleSection);
    child(panel, '.section-heading h2')?.addEventListener('click', toggleSection);
  }
}

initCollapsibleSections();
loadAll().catch((error) => setMessage(error.message, 'error'));
loadVersion().catch(() => {});
connectUpdates();
