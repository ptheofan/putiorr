import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downloadPolicyForContext,
  downloadPolicyInput,
  isSlowSpeedResetEnabled,
  normalizeDownloadPolicy,
  saveDownloadPolicyToStore,
} from '../src/download/policy.ts';

const config = {
  slowSpeedThresholdBytesPerSecond: 10,
  slowSpeedDurationSeconds: 20,
  slowSpeedGraceSeconds: 30,
  slowSpeedMinSizeBytes: 40,
};

test('download policy normalizes property and column input', () => {
  assert.deepEqual(downloadPolicyInput({
    slow_speed_threshold_bytes_per_second: 100,
    slowSpeedDurationSeconds: 200,
  }), {
    slowSpeedThresholdBytesPerSecond: 100,
    slowSpeedDurationSeconds: 200,
  });

  assert.deepEqual(normalizeDownloadPolicy({
    slowSpeedThresholdBytesPerSecond: '5',
    slowSpeedDurationSeconds: '-1',
    slowSpeedGraceSeconds: 'bad',
    slowSpeedMinSizeBytes: '',
  }, config), {
    slowSpeedThresholdBytesPerSecond: 5,
    slowSpeedDurationSeconds: 20,
    slowSpeedGraceSeconds: 30,
    slowSpeedMinSizeBytes: 40,
  });
});

test('download policy selects profile settings and saves fallback settings', () => {
  const settings = new Map();
  const store = {
    defaultProfile: {
      id: 1,
      slow_speed_threshold_bytes_per_second: 50,
      slow_speed_duration_seconds: 60,
      slow_speed_grace_seconds: 70,
      slow_speed_min_size_bytes: 80,
    },
    namedProfile: { id: 2, download_profile_id: 3 },
    downloadProfile: {
      id: 3,
      slowSpeedThresholdBytesPerSecond: 90,
      slowSpeedDurationSeconds: 100,
      slowSpeedGraceSeconds: 110,
      slowSpeedMinSizeBytes: 120,
    },
    updates: [],
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    findDefaultDownloadProfile() { return this.defaultProfile; },
    findProfileById(id) { return id === 2 ? this.namedProfile : undefined; },
    findDownloadProfileById(id) { return id === 3 ? this.downloadProfile : undefined; },
    updateDownloadProfile(id, patch) { this.updates.push({ id, patch }); },
  };
  settings.set('download_slow_speed_threshold_bytes_per_second', 15);

  assert.equal(downloadPolicyForContext(store, config).slowSpeedThresholdBytesPerSecond, 50);
  assert.equal(downloadPolicyForContext(store, config, { profileId: 2 }).slowSpeedThresholdBytesPerSecond, 90);
  assert.equal(downloadPolicyForContext(store, config, { profile: { downloadProfileId: 3 } }).slowSpeedDurationSeconds, 100);

  const saved = saveDownloadPolicyToStore(store, {
    slowSpeedThresholdBytesPerSecond: 99,
  }, config, 3);

  assert.equal(saved.slowSpeedThresholdBytesPerSecond, 99);
  assert.deepEqual(store.updates[0], { id: 3, patch: saved });
  assert.equal(settings.get('download_slow_speed_threshold_bytes_per_second'), 99);
});

test('slow speed reset requires threshold, duration, and minimum size', () => {
  assert.equal(isSlowSpeedResetEnabled({
    slowSpeedThresholdBytesPerSecond: 1,
    slowSpeedDurationSeconds: 1,
    slowSpeedMinSizeBytes: 10,
  }, 10), true);
  assert.equal(isSlowSpeedResetEnabled({
    slowSpeedThresholdBytesPerSecond: 0,
    slowSpeedDurationSeconds: 1,
    slowSpeedMinSizeBytes: 10,
  }, 10), false);
  assert.equal(isSlowSpeedResetEnabled({
    slowSpeedThresholdBytesPerSecond: 1,
    slowSpeedDurationSeconds: 0,
    slowSpeedMinSizeBytes: 10,
  }, 10), false);
  assert.equal(isSlowSpeedResetEnabled({
    slowSpeedThresholdBytesPerSecond: 1,
    slowSpeedDurationSeconds: 1,
    slowSpeedMinSizeBytes: 10,
  }, 9), false);
});
