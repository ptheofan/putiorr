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
    'adoption-notice',
    'adoption-notice-text',
    'staging-collision-notice',
    'staging-collision-text',
    'schema-migration-notice',
    'schema-migration-summary',
    'schema-migration-summary-dismiss',
    'schema-migration-warning',
    'orphaned-downloads',
    'orphaned-download',
    'orphaned-download-profile',
    'orphaned-download-assign',
    'orphaned-download-delete',
  ]) {
    assert.match(source, new RegExp(`data-testid=["']${testId}["']|['"]data-testid['"], ['"]${testId}['"]`));
  }
});

test('downloads UI renders Put.io status messages or peer availability below the progress bars', () => {
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');

  assert.match(downloadsJs, /data-role="putio-status-message"/);
  assert.match(downloadsJs, /\$\{peerText\} \| availability: \$\{clampPercent\(download\.putioAvailability\)\}%/);
  assert.doesNotMatch(downloadsJs, /putioDownloaded|putioUploaded/);
});

// The owner's ruling on phase 3: legacy rows the schema collapse cannot
// represent are quarantined for the user to reassign, not dropped — so they
// need somewhere to be seen, with the reason, the path their files are still
// at, a profile picker and a delete control.
test('the needs-attention section renders the reason, the local path and a profile picker', () => {
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');

  assert.match(html, /id="orphanedDownloadsList"/);
  assert.match(downloadsJs, /data-role="reason"/);
  assert.match(downloadsJs, /data-role="local-path"/);
  // A row with no put.io transfer id has no identity to reattach, and a
  // dashboard with no profiles has nothing to assign to. Either way the picker
  // and the assign button are disabled and only delete remains.
  assert.match(downloadsJs, /const assignable = orphan\.assignable && profiles\.length > 0;/);
  assert.match(downloadsJs, /select\.disabled = !assignable;/);
  assert.match(downloadsJs, /assign\.disabled = !assignable;/);
  // Hidden entirely when there is nothing to fix.
  assert.match(downloadsJs, /setHidden\(el\.orphanedDownloads, orphans\.length === 0\)/);
});

test('the downloads view renders the schema migration report it is served', () => {
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');

  // GET /api/settings carries schemaMigrations; without a consumer it is a
  // field nobody ever sees.
  assert.match(downloadsJs, /state\.settings\?\.schemaMigrations/);
  assert.match(downloadsJs, /export function renderDownloads\(\) \{\s*renderSchemaMigrations\(\);/);
});

// The upgrade summary is a finished fact and can be put away; the quarantine
// warning beside it is work still waiting, so it has no control of its own and
// no way to be hidden.
test('only the upgrade summary carries a dismiss control, wired without an inline handler', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');

  assert.match(html, /id="schemaMigrationSummaryDismiss"/);
  assert.match(html, /aria-label="Dismiss the database upgrade summary"/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(html, /schemaMigrationWarningDismiss/);
  assert.match(downloadsJs, /'\/api\/schema-migrations\/summary\/dismiss'/);
  assert.match(appJs, /el\.schemaMigrationSummaryDismiss\.addEventListener\('click'/);
});

// Audit finding 9: with every profile on one put.io folder, adoption never
// happens. GET /api/settings carries the report; a payload nobody renders
// leaves the user with a poll that quietly does nothing.
test('the downloads view renders the adoption notice it is served', () => {
  const downloadsJs = readFileSync(new URL('../src/web/downloads.js', import.meta.url), 'utf8');

  assert.match(downloadsJs, /state\.settings\?\.adoptionNotices/);
  assert.match(downloadsJs, /renderAdoptionNotices\(\);/);
  // Same for two downloads put.io named the same thing: only the older one
  // stages, and the other looks like a download that just stopped.
  assert.match(downloadsJs, /state\.settings\?\.stagingCollisions/);
  assert.match(downloadsJs, /renderStagingCollisions\(\);/);
});
