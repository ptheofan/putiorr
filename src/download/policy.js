export const DOWNLOAD_POLICY_SETTING_KEYS = {
  slowSpeedThresholdBytesPerSecond: 'download_slow_speed_threshold_bytes_per_second',
  slowSpeedDurationSeconds: 'download_slow_speed_duration_seconds',
  slowSpeedGraceSeconds: 'download_slow_speed_grace_seconds',
  slowSpeedMinSizeBytes: 'download_slow_speed_min_size_bytes',
};

export const DEFAULT_DOWNLOAD_POLICY = {
  slowSpeedThresholdBytesPerSecond: 0,
  slowSpeedDurationSeconds: 120,
  slowSpeedGraceSeconds: 30,
  slowSpeedMinSizeBytes: 100 * 1024 * 1024,
};

export const DOWNLOAD_POLICY_COLUMNS = {
  slowSpeedThresholdBytesPerSecond: 'slow_speed_threshold_bytes_per_second',
  slowSpeedDurationSeconds: 'slow_speed_duration_seconds',
  slowSpeedGraceSeconds: 'slow_speed_grace_seconds',
  slowSpeedMinSizeBytes: 'slow_speed_min_size_bytes',
};

function nonNegativeInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function downloadPolicyInput(input = {}) {
  const output = {};
  for (const [property, column] of Object.entries(DOWNLOAD_POLICY_COLUMNS)) {
    const value = input[property] ?? input[column];
    if (value !== undefined) output[property] = value;
  }
  return output;
}

export function normalizeDownloadPolicy(input = {}, fallback = DEFAULT_DOWNLOAD_POLICY) {
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

export function downloadPolicyFromConfig(config) {
  return normalizeDownloadPolicy({
    slowSpeedThresholdBytesPerSecond: config.slowSpeedThresholdBytesPerSecond,
    slowSpeedDurationSeconds: config.slowSpeedDurationSeconds,
    slowSpeedGraceSeconds: config.slowSpeedGraceSeconds,
    slowSpeedMinSizeBytes: config.slowSpeedMinSizeBytes,
  });
}

export function downloadPolicyFromStore(store, config) {
  return downloadPolicyForContext(store, config);
}

export function legacyDownloadPolicyFromStore(store, config) {
  const fallback = downloadPolicyFromConfig(config);
  const input = {};
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    const value = store.getSetting(key);
    if (value !== undefined) input[property] = value;
  }
  return normalizeDownloadPolicy(input, fallback);
}

export function downloadPolicyForContext(store, config, { profile, profileId, downloadProfileId } = {}) {
  const fallback = legacyDownloadPolicyFromStore(store, config);
  let attachedDownloadProfileId = downloadProfileId;
  if (attachedDownloadProfileId == null && profileId != null) {
    attachedDownloadProfileId = store.findProfileById(profileId)?.download_profile_id;
  }
  if (attachedDownloadProfileId == null && profile) {
    attachedDownloadProfileId = profile.download_profile_id ?? profile.downloadProfileId;
  }

  const downloadProfile = attachedDownloadProfileId != null
    ? store.findDownloadProfileById?.(attachedDownloadProfileId)
    : undefined;
  const fallbackProfile = store.findDefaultDownloadProfile?.();
  return normalizeDownloadPolicy(downloadPolicyInput(downloadProfile ?? fallbackProfile ?? {}), fallback);
}

export function saveDownloadPolicyToStore(store, patch, config, downloadProfileId) {
  const current = downloadPolicyForContext(store, config, { downloadProfileId });
  const next = normalizeDownloadPolicy(patch, current);
  const targetProfile = downloadProfileId != null
    ? store.findDownloadProfileById?.(downloadProfileId)
    : store.findDefaultDownloadProfile?.();
  if (targetProfile) {
    store.updateDownloadProfile(targetProfile.id, next);
  }
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    store.setSetting(key, next[property]);
  }
  return next;
}

export function isSlowSpeedResetEnabled(policy, fileSize) {
  return Number(policy.slowSpeedThresholdBytesPerSecond) > 0
    && Number(policy.slowSpeedDurationSeconds) > 0
    && Number(fileSize ?? 0) >= Number(policy.slowSpeedMinSizeBytes ?? 0);
}
