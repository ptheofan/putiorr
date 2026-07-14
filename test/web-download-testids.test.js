import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { formatPutioStatusDetails } from '../src/web/util.js';

test('downloads UI exposes stable data-testid hooks for frontend tests', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');
  const source = `${html}\n${downloadsJs}`;

  for (const testId of [
    'downloads-bulk-bar',
    'downloads-select-all',
    'downloads-selected-count',
    'downloads-delete-selected',
    'download-row',
    'download-select-checkbox',
    'download-delete-bucket',
    'delete-confirm-dialog',
    'delete-confirm-title',
    'delete-confirm-intro',
    'delete-from-putio',
    'delete-local-files',
    'delete-confirm-submit',
  ]) {
    assert.match(source, new RegExp(`data-testid=["']${testId}["']|['"]data-testid['"], ['"]${testId}['"]`));
  }
});

test('downloads UI renders Put.io status messages or transfer metrics below the progress bars', () => {
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');

  assert.match(downloadsJs, /data-role="putio-status-message"/);
  assert.equal(formatPutioStatusDetails({
    lifecycle: 'remote',
    putioStatus: 'DOWNLOADING',
    putioPeers: 2,
    putioAvailability: 11,
    putioDownloaded: 108_480_000,
    putioUploaded: 0,
    putioTotalSize: 931_980_000,
  }), '2 peers | downloaded: 103.5 MB of 888.8 MB | uploaded: 0 B of 888.8 MB | availability: 11%');
  assert.equal(formatPutioStatusDetails({
    lifecycle: 'remote',
    putioStatus: 'DOWNLOADING',
    putioStatusMessage: 'Waiting for torrent details from the network...',
  }), 'Waiting for torrent details from the network...');
});
