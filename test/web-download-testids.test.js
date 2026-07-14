import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

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

test('downloads UI renders Put.io status details below the progress bars', () => {
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');

  assert.match(downloadsJs, /data-role="putio-status-message"/);
  assert.match(downloadsJs, /Put\.io status: \$\{putioStatusMessage\}/);
});
