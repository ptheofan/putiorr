// `autoRemoveCompleted` here only pre-checks the wizard's box. The default
// itself is the store's (profileDefaultsToAutoRemoveCompleted): a profile
// created through POST /api/profiles or seeded from PUTIORR_PROFILES_JSON
// never opens the wizard, and used to miss the default entirely. The two must
// agree, or the wizard shows a box the server would have ticked anyway.
export const PROFILE_TYPES = {
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
    autoRemoveCompleted: true,
    note: 'Prowlarr usually talks to Sonarr/Radarr/Lidarr instead of putiorr. Use this only if Prowlarr sends grabs directly to a Transmission client.',
  },
  // Browser grabs, not an *arr download client: the wizard hides the RPC
  // endpoint step for this preset and derives the path instead. Auto-remove is
  // on for the same reason prowlarr has it — nothing imports a browser grab, so
  // the finished transfer leaves putiorr while the files stay on disk.
  grab: {
    label: 'Putiorr Grab',
    root: '',
    autoRemoveCompleted: true,
    note: 'Browser grabs come from the putiorr grab extension, not from an *arr app. List the sites this profile should claim, then point the extension at putiorr.',
  },
  custom: {
    label: 'Custom',
    root: '',
    note: 'Use these Transmission-compatible values in the app that will send downloads to putiorr.',
  },
};

export const DEFAULT_PROFILE_TYPE = 'sonarr';
// Mirrors the server's GRAB_PROFILE_TYPE: the only preset the browser
// extension may send grabs to.
export const GRAB_PROFILE_TYPE = 'grab';
// Issue #111. The presets whose queue blocklist API putiorr speaks. It decides
// both whether the wizard offers the rejection step and whether the downloader
// will act on it, and those two must never disagree — a step offered for a
// preset the downloader skips is a setting that silently does nothing. Lidarr
// and Readarr serve a v1 API this does not implement.
export const ARR_REJECTION_PRESETS = new Set(['sonarr', 'radarr']);

export function supportsArrRejection(type) {
  return ARR_REJECTION_PRESETS.has(String(type ?? '').trim().toLowerCase());
}
// What a refused profile save says when another grab profile already takes the
// grabs no site claims. It rides on `code` in the error body, next to the
// sentence and the holder, so the wizard can offer the takeover without
// matching prose — a boundary this codebase has been bitten across before.
// Imported by the server as well as the wizard: one string, one definition.
export const CATCH_ALL_CONFLICT_CODE = 'catch_all_conflict';
// What a profile save refused for moving its download folder rides on, next to
// the sentence and the counts, for the same reason the catch-all conflict does:
// the wizard puts the folder back in one click, and deciding that from the
// prose would break on the next reword. Imported by the store as well as the
// wizard: one string, one definition.
export const DOWNLOAD_FOLDER_LOCKED_CODE = 'download_folder_locked';
// The endpoint every Transmission client reaches by default. It belongs to one
// *arr profile or to none; it is never a Putiorr Grab profile's path, and the
// server refuses it outright once more than one *arr profile could have meant it.
export const SHARED_RPC_PATH = '/transmission/rpc';
export const DEFAULT_PUTIO_FOLDER = 'putiorr';
export const DEFAULT_DOWNLOAD_FOLDER = '/putiorr';
export const DEFAULT_CLIENT_HOST = 'putiorr';
export const DEFAULT_CLIENT_PORT = '9091';
export const DEFAULT_HELP_FIELD = 'wizardProfileType';
export const DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD = 'downloadProfileName';
export const PUTIO_CONNECTION_TABS = ['oauth', 'token'];
export const BYTE_UNITS = {
  bytes: 1,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};
export const TIME_UNITS = {
  seconds: 1,
  minutes: 60,
};

export const PUTIO_PHASE_LABELS = {
  IN_QUEUE: 'Queued on Put.io',
  WAITING: 'Queued on Put.io',
  PREPARING_DOWNLOAD: 'Preparing on Put.io',
  DOWNLOADING: 'Downloading on Put.io',
  COMPLETING: 'Completing on Put.io',
  SEEDING: 'Ready on Put.io',
  COMPLETED: 'Ready on Put.io',
  ERROR: 'Put.io error',
};

// Mirrors the backend READY_REMOTE_STATUSES: a local download can only start once put.io
// has the files ready. While COMPLETING/DOWNLOADING/queued the Start button would only
// produce a "not ready to download yet" error, so it stays hidden.
export const READY_PUTIO_STATUSES = new Set(['COMPLETED', 'SEEDING']);
