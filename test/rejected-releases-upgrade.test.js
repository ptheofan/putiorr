// Issue #111. The upgrade path, which the rest of the suite never exercises
// because every other test starts from an empty :memory: database where the
// table is created complete.
//
// A build shipped rejected_releases without read_at. On any install carrying
// that table, adding the column and its index in the same CREATE block threw
// "no such column: read_at" during migrate() — before the ALTER that would have
// added it — and putiorr crash-looped on boot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateStore } from '../src/state/store.js';

async function databaseWithOldRejectedReleases() {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-rejected-upgrade-'));
  const file = path.join(root, 'state.sqlite');
  const db = new DatabaseSync(file);
  // Exactly the shape the earlier build created: no read_at.
  db.exec(`
    CREATE TABLE rejected_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_name TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT 'blocklisted',
      rejected_at TEXT NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO rejected_releases (profile_name, name, reason, outcome, rejected_at) VALUES (?,?,?,?,?)',
  ).run('Sonarr', 'Already.Rejected', 'nothing Sonarr can import', 'blocklisted', new Date().toISOString());
  db.close();
  return file;
}

test('a database carrying the pre-read_at table still opens', async () => {
  const file = await databaseWithOldRejectedReleases();
  // The bug was here: constructing the store ran migrate() and threw.
  const store = new StateStore(file);
  try {
    const { rows, total } = store.listRejectedReleases();
    assert.equal(total, 1, 'the existing row survives the upgrade');
    assert.equal(rows[0].name, 'Already.Rejected');
    // Rows that predate the column are unread, which is the reading that gets
    // them looked at rather than silently marked as already seen.
    assert.equal(rows[0].read_at, null);
    assert.equal(store.countUnreadRejectedReleases(), 1);
    assert.equal(store.markAllRejectedReleasesRead(), 1);
    assert.equal(store.countUnreadRejectedReleases(), 0);
  } finally {
    store.close();
  }
});

test('opening the upgraded database twice is a no-op the second time', async () => {
  const file = await databaseWithOldRejectedReleases();
  new StateStore(file).close();
  // Re-running migrate() must not trip over the index it created last boot.
  const store = new StateStore(file);
  try {
    assert.equal(store.listRejectedReleases().total, 1);
  } finally {
    store.close();
  }
});
