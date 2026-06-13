export const DOWNLOAD_POLICY_SETTING_KEYS = {
  slowSpeedThresholdBytesPerSecond: 'download_slow_speed_threshold_bytes_per_second',
  slowSpeedDurationSeconds: 'download_slow_speed_duration_seconds',
  slowSpeedGraceSeconds: 'download_slow_speed_grace_seconds',
  slowSpeedMinSizeBytes: 'download_slow_speed_min_size_bytes',
};

const DEFAULT_POLICY = {
  slowSpeedThresholdBytesPerSecond: 0,
  slowSpeedDurationSeconds: 120,
  slowSpeedGraceSeconds: 30,
  slowSpeedMinSizeBytes: 100 * 1024 * 1024,
};

function nonNegativeInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function normalizeDownloadPolicy(input = {}, fallback = DEFAULT_POLICY) {
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
  const fallback = downloadPolicyFromConfig(config);
  const input = {};
  for (const [property, key] of Object.entries(DOWNLOAD_POLICY_SETTING_KEYS)) {
    const value = store.getSetting(key);
    if (value !== undefined) input[property] = value;
  }
  return normalizeDownloadPolicy(input, fallback);
}

export function saveDownloadPolicyToStore(store, patch, config) {
  const current = downloadPolicyFromStore(store, config);
  const next = normalizeDownloadPolicy(patch, current);
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
