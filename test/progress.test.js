import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTransmissionProgress, mapPutioStatus, TRANSMISSION_STATUS } from '../src/transmission/progress.js';

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

test('put.io statuses map to Transmission statuses', () => {
  assert.equal(mapPutioStatus('IN_QUEUE'), TRANSMISSION_STATUS.downloadWait);
  assert.equal(mapPutioStatus('WAITING'), TRANSMISSION_STATUS.downloadWait);
  assert.equal(mapPutioStatus('PREPARING'), TRANSMISSION_STATUS.downloadWait);
  assert.equal(mapPutioStatus('COMPLETING'), TRANSMISSION_STATUS.download);
  assert.equal(mapPutioStatus('ERROR'), TRANSMISSION_STATUS.stopped);
  assert.equal(mapPutioStatus('UNKNOWN'), TRANSMISSION_STATUS.stopped);
});

test('progress handles completed remote and file-count-only local stats', () => {
  assert.deepEqual(calculateTransmissionProgress({
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 100,
    lifecycle: 'remote',
  }), {
    percentDone: 0.5,
    leftUntilDone: 50,
    status: TRANSMISSION_STATUS.download,
  });

  assert.deepEqual(calculateTransmissionProgress({
    putio_status: 'SEEDING',
    percent_done: 100,
    total_size: 100,
    lifecycle: 'local',
  }), {
    percentDone: 1,
    leftUntilDone: 0,
    status: TRANSMISSION_STATUS.seed,
  });

  assert.equal(calculateTransmissionProgress({
    putio_status: 'DOWNLOADING',
    percent_done: 150,
    total_size: 10,
  }, {
    total_files: 4,
    completed_files: 1,
  }).percentDone, 0.625);
});
