import type {
  AppConfig,
  DbScalar,
  DownloadPolicy,
  DownloadPolicyInput,
  DownloadProfile,
  Profile,
} from '../types.ts';

export const DOWNLOAD_POLICY_SETTING_KEYS = {
  slowSpeedThresholdBytesPerSecond: 'download_slow_speed_threshold_bytes_per_second',
  slowSpeedDurationSeconds: 'download_slow_speed_duration_seconds',
  slowSpeedGraceSeconds: 'download_slow_speed_grace_seconds',
  slowSpeedMinSizeBytes: 'download_slow_speed_min_size_bytes',
} as const;

export const DEFAULT_DOWNLOAD_POLICY = {
  slowSpeedThresholdBytesPerSecond: 0,
  slowSpeedDurationSeconds: 120,
  slowSpeedGraceSeconds: 30,
  slowSpeedMinSizeBytes: 100 * 1024 * 1024,
} satisfies DownloadPolicy;

export const DOWNLOAD_POLICY_COLUMNS = {
  slowSpeedThresholdBytesPerSecond: 'slow_speed_threshold_bytes_per_second',
  slowSpeedDurationSeconds: 'slow_speed_duration_seconds',
  slowSpeedGraceSeconds: 'slow_speed_grace_seconds',
  slowSpeedMinSizeBytes: 'slow_speed_min_size_bytes',
} as const;

type PolicyStore = {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: number): void;
  findProfileById(id: number): Profile | undefined;
  findDownloadProfileById(id: number): DownloadProfile | undefined;
  findDefaultDownloadProfile?(): DownloadProfile | undefined;
  updateDownloadProfile(id: number, patch: DownloadPolicyInput): DownloadProfile | undefined;
};

function nonNegativeInteger(value: DbScalar, fallback: number): number {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function downloadPolicyInput(input: DownloadPolicyInput = {}): DownloadPolicyInput {
  const output: DownloadPolicyInput = {};
  for (const [property, column] of Object.entries(DOWNLOAD_POLICY_COLUMNS)) {
    const key = property as keyof DownloadPolicy;
    const value = input[key] ?? input[column as keyof DownloadPolicyInput];
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export function normalizeDownloadPolicy(
  input: DownloadPolicyInput = {},
  fallback: DownloadPolicy = DEFAULT_DOWNLOAD_POLICY,
): DownloadPolicy {
  return {
    slowSpeedThresholdBytesPerSecond: nonNegativeInteger(
      input.slowSpeedThresholdBytesPerSecond,
      fallback.slowSpeedThresholdBytesPerSecond,
    ),
    slowSpeedDurationSeconds: nonNegativeInteger(
      input.slowSpeedDurationSeconds,
      fallback.slowSpeedDurationSeconds,
    ),
    slowSpeedGraceSeconds: nonNegativeInteger(
      input.slowSpeedGraceSeconds,
      fallback.slowSpeedGraceSeconds,
    ),
    slowSpeedMinSizeBytes: nonNegativeInteger(
      input.slowSpeedMinSizeBytes,
      fallback.slowSpeedMinSizeBytes,
    ),
  };
}

export function downloadPolicyFromConfig(config: AppConfig): DownloadPolicy {
  return normalizeDownloadPolicy({
    slowSpeedThresholdBytesPerSecond: config.slowSpeedThresholdBytesPerSecond,
    slowSpeedDurationSeconds: config.slowSpeedDurationSeconds,
    slowSpeedGraceSeconds: config.slowSpeedGraceSeconds,
    slowSpeedMinSizeBytes: config.slowSpeedMinSizeBytes,
  });
}

export function downloadPolicyFromStore(store: PolicyStore, config: AppConfig): DownloadPolicy {
  return downloadPolicyForContext(store, config);
}

export function legacyDownloadPolicyFromStore(store: PolicyStore, config: AppConfig): DownloadPolicy {
  const fallback = downloadPolicyFromConfig(config);
  const input: DownloadPolicyInput = {};
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    const value = store.getSetting(key);
    if (value !== undefined) input[property as keyof DownloadPolicy] = value;
  }
  return normalizeDownloadPolicy(input, fallback);
}

export function downloadPolicyForContext(
  store: PolicyStore,
  config: AppConfig,
  { profile, profileId, downloadProfileId }: {
    profile?: Profile;
    profileId?: number | null;
    downloadProfileId?: number | null;
  } = {},
): DownloadPolicy {
  const fallback = legacyDownloadPolicyFromStore(store, config);
  let attachedDownloadProfileId = downloadProfileId;
  if (attachedDownloadProfileId == null && profileId != null) {
    attachedDownloadProfileId = store.findProfileById(profileId)?.download_profile_id;
  }
  if (attachedDownloadProfileId == null && profile) {
    attachedDownloadProfileId = profile.download_profile_id ?? profile.downloadProfileId;
  }

  const downloadProfile = attachedDownloadProfileId != null
    ? store.findDownloadProfileById(attachedDownloadProfileId)
    : undefined;
  const fallbackProfile = store.findDefaultDownloadProfile?.();
  return normalizeDownloadPolicy(downloadPolicyInput(downloadProfile ?? fallbackProfile ?? {}), fallback);
}

export function saveDownloadPolicyToStore(
  store: PolicyStore,
  patch: DownloadPolicyInput,
  config: AppConfig,
  downloadProfileId?: number | null,
): DownloadPolicy {
  const current = downloadPolicyForContext(store, config, { downloadProfileId });
  const next = normalizeDownloadPolicy(patch, current);
  const targetProfile = downloadProfileId != null
    ? store.findDownloadProfileById(downloadProfileId)
    : store.findDefaultDownloadProfile?.();
  if (targetProfile) {
    store.updateDownloadProfile(targetProfile.id, next);
  }
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    store.setSetting(key, next[property as keyof DownloadPolicy]);
  }
  return next;
}

export function isSlowSpeedResetEnabled(policy: DownloadPolicy, fileSize: number): boolean {
  return Number(policy.slowSpeedThresholdBytesPerSecond) > 0
    && Number(policy.slowSpeedDurationSeconds) > 0
    && Number(fileSize ?? 0) >= Number(policy.slowSpeedMinSizeBytes ?? 0);
}
