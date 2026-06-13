import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTransmissionProgress, TRANSMISSION_STATUS } from '../src/transmission/progress.js';

test('remote download maps to first half of progress', () => {
  const result = calculateTransmissionProgress({
    putio_status: 'DOWNLOADING',
    percent_done: 40,
    total_size: 1000,
    lifecycle: 'remote',
  });

  assert.equal(result.percentDone, 0.2);
  assert.equal(result.status, TRANSMISSION_STATUS.download);
  assert.equal(result.leftUntilDone, 800);
});

test('local download maps to second half of progress', () => {
  const result = calculateTransmissionProgress({
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 1000,
    lifecycle: 'downloading',
  }, {
    total_files: 2,
    completed_files: 0,
    total_size: 1000,
    downloaded_size: 340,
  });

  assert.equal(result.percentDone, 0.67);
  assert.equal(result.status, TRANSMISSION_STATUS.download);
  assert.equal(result.leftUntilDone, 330);
});

test('local completion reports seeding', () => {
  const result = calculateTransmissionProgress({
    putio_status: 'SEEDING',
    percent_done: 100,
    total_size: 1000,
    lifecycle: 'processed',
  }, {
    total_files: 1,
    completed_files: 1,
    total_size: 1000,
    downloaded_size: 1000,
  });

  assert.equal(result.percentDone, 1);
  assert.equal(result.status, TRANSMISSION_STATUS.seed);
  assert.equal(result.leftUntilDone, 0);
});
