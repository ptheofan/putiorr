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
    note: 'Prowlarr usually talks to Sonarr/Radarr/Lidarr instead of putiorr. Use this only if Prowlarr sends grabs directly to a Transmission client.',
  },
  custom: {
    label: 'Custom',
    root: '',
    note: 'Use these Transmission-compatible values in the app that will send downloads to putiorr.',
  },
};

export const DEFAULT_PROFILE_TYPE = 'sonarr';
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
