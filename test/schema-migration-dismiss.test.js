import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state/store.js';
import { TransferService } from '../src/transfer/service.js';
import { TransmissionRpcServer } from '../src/transmission/server.js';
import { schemaMigrationNoticeView, schemaMigrationSummary, schemaMigrationWarning } from '../src/web/util.js';

const DOWNLOADS_REPORT = {
  version: 1,
  at: '2026-01-01T00:00:00.000Z',
  migrated: 4,
  adoptedBySoleProfile: 0,
  extraAssociations: [],
  noPutioId: [],
  ownerless: [],
  droppedFiles: 0,
};

async function tempDbPath(name = 'state.sqlite') {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-dismiss-'));
  return path.join(root, name);
}

function recordReport(store, report = DOWNLOADS_REPORT) {
  store.setSetting('downloads_schema_v1_report', JSON.stringify(report));
}

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-dismiss-api-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_LISTEN_HOST: '127.0.0.1',
    PUTIORR_LISTEN_PORT: '0',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    PUTIORR_PUTIO_APP_ID: '12345',
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const service = new TransferService({ config, store, putioFactory: () => ({}) });
  const rpcServer = new TransmissionRpcServer({ config, service });
  await rpcServer.start();
  const { port } = rpcServer.server.address();
  return { config, store, rpcServer, base: `http://127.0.0.1:${port}` };
}

async function postDismiss(harness, body = {}) {
  const response = await fetch(`${harness.base}/api/schema-migrations/summary/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getSettings(harness) {
  const response = await fetch(`${harness.base}/api/settings`);
  return response.json();
}

// The owner's complaint: "The last database upgrade migrated 4 downloads" has
// been on the dashboard since the upgrade and nothing ever takes it off.
test('a dismissed upgrade summary stays dismissed across a restart', async () => {
  const dbPath = await tempDbPath();
  const first = new StateStore(dbPath);
  try {
    recordReport(first);
    const before = first.schemaMigrationReports();
    assert.equal(before.summaryDismissed, false);
    assert.ok(before.summaryKey, 'a report the dashboard can show is a report that can be dismissed');

    first.dismissSchemaMigrationSummary(before.summaryKey);
    assert.equal(first.schemaMigrationReports().summaryDismissed, true);
  } finally {
    first.close();
  }

  // A new process against the same file: localStorage would have lost this,
  // and so would another browser.
  const second = new StateStore(dbPath);
  try {
    const reports = second.schemaMigrationReports();
    assert.equal(reports.summaryDismissed, true);
    // The record of what the upgrade did is still there for support.
    assert.equal(reports.downloads.migrated, 4);
    assert.equal(second.getSetting('downloads_schema_v1_report') !== undefined, true);
  } finally {
    second.close();
  }
});

// A dismissal answers for the upgrade it was shown for, not for every upgrade
// this install will ever run.
test('a later migration report is shown again after an earlier one was dismissed', async () => {
  const store = new StateStore(':memory:');
  try {
    recordReport(store);
    store.dismissSchemaMigrationSummary();
    assert.equal(store.schemaMigrationReports().summaryDismissed, true);

    recordReport(store, { ...DOWNLOADS_REPORT, at: '2026-06-01T00:00:00.000Z', migrated: 9 });
    const reports = store.schemaMigrationReports();
    assert.equal(reports.summaryDismissed, false, 'a new upgrade is new news');
    assert.notEqual(reports.summaryKey, undefined);
    assert.match(schemaMigrationSummary(reports), /migrated 9 downloads/);
  } finally {
    store.close();
  }
});

// The profiles half of the report moves the key too: it is the same sentence.
test('the dismissal key follows both halves of the report', async () => {
  const store = new StateStore(':memory:');
  try {
    recordReport(store);
    store.dismissSchemaMigrationSummary();
    store.setSetting('profiles_schema_v2_report', JSON.stringify({
      version: 2,
      at: '2026-06-01T00:00:00.000Z',
      downloadProfilesAssigned: 2,
      grabRpcPathsCleared: 0,
    }));
    assert.equal(store.schemaMigrationReports().summaryDismissed, false);
  } finally {
    store.close();
  }
});

test('dismissing a summary the caller did not see is refused', async () => {
  const store = new StateStore(':memory:');
  try {
    assert.throws(
      () => store.dismissSchemaMigrationSummary(),
      /no database upgrade summary to dismiss/,
    );
    recordReport(store);
    assert.throws(
      () => store.dismissSchemaMigrationSummary('downloads:1@1999-01-01T00:00:00.000Z'),
      /has changed/,
    );
    assert.equal(store.schemaMigrationReports().summaryDismissed, false);
  } finally {
    store.close();
  }
});

test('POST /api/schema-migrations/summary/dismiss hides the summary and keeps the report', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  recordReport(harness.store);

  const shown = await getSettings(harness);
  assert.equal(shown.schemaMigrations.summaryDismissed, false);
  assert.match(schemaMigrationSummary(shown.schemaMigrations), /migrated 4 downloads/);

  const dismissed = await postDismiss(harness, { key: shown.schemaMigrations.summaryKey });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.schemaMigrations.summaryDismissed, true);
  assert.equal(schemaMigrationSummary(dismissed.body.schemaMigrations), '');

  // The reload the owner would do to check it worked.
  const reloaded = await getSettings(harness);
  assert.equal(schemaMigrationSummary(reloaded.schemaMigrations), '');
  // Still the record of the upgrade, for a support question a year from now.
  assert.equal(reloaded.schemaMigrations.downloads.migrated, 4);
  assert.equal(reloaded.schemaMigrations.downloads.at, DOWNLOADS_REPORT.at);
});

test('the dismiss endpoint refuses a key from a summary that has since changed', async (t) => {
  const harness = await createHarness();
  t.after(async () => {
    await harness.rpcServer.stop();
    harness.store.close();
  });
  recordReport(harness.store);

  const refused = await postDismiss(harness, { key: 'downloads:1@1999-01-01T00:00:00.000Z' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /has changed/);
  const settings = await getSettings(harness);
  assert.equal(settings.schemaMigrations.summaryDismissed, false);
});

// The two halves are not the same kind of thing. The warning is unresolved
// work — downloads nobody can see until they act — and has no dismiss control
// at all.
test('the warning survives a dismissed summary and keeps the panel on screen', () => {
  const dismissed = {
    downloads: { ...DOWNLOADS_REPORT, strandedLegacyRows: 2 },
    summaryKey: 'downloads:1@2026-01-01T00:00:00.000Z',
    summaryDismissed: true,
  };

  const view = schemaMigrationNoticeView(dismissed);
  assert.equal(view.summary, '');
  assert.match(view.warning, /could not be read by the upgrade/);
  assert.equal(view.noticeVisible, true, 'work still waiting keeps the panel up');
  // The warning does not care whether the summary was dismissed.
  assert.equal(schemaMigrationWarning(dismissed), view.warning);
});

test('the panel goes away only when the summary is dismissed and the warning is empty', () => {
  const both = schemaMigrationNoticeView({ downloads: { ...DOWNLOADS_REPORT, strandedLegacyRows: 2 } });
  assert.equal(both.noticeVisible, true);
  assert.notEqual(both.summary, '');
  assert.notEqual(both.warning, '');

  const summaryOnly = schemaMigrationNoticeView({ downloads: DOWNLOADS_REPORT });
  assert.equal(summaryOnly.warning, '');
  assert.equal(summaryOnly.noticeVisible, true);

  const gone = schemaMigrationNoticeView({ downloads: DOWNLOADS_REPORT, summaryDismissed: true });
  assert.equal(gone.summary, '');
  assert.equal(gone.warning, '');
  assert.equal(gone.noticeVisible, false);

  assert.equal(schemaMigrationNoticeView(undefined).noticeVisible, false);
});

