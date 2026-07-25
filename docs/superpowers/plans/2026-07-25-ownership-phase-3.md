# Ownership Cleanup — Phase 3: Schema Collapse + Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `transfers` + `transfer_associations` collapse into one `downloads` table whose `profile_id` is `NOT NULL ... ON DELETE RESTRICT`; `association_files` becomes `download_files` keyed by `download_id`; `profiles.download_profile_id` becomes `NOT NULL ... ON DELETE RESTRICT` and `profiles.rpc_path` becomes nullable with a partial unique index. Existing databases migrate once, in one transaction, with a recorded report of everything dropped.

**Spec:** `docs/superpowers/specs/2026-07-25-ownership-cleanup-design.md` (target schema, migration rules) — audit `docs/superpowers/specs/2026-07-25-ownership-model-audit.md` — issue [#67](https://github.com/ptheofan/putiorr/issues/67).

**Branch:** `refactor/download-ownership`, on top of `7c19341` (Phase 2).

**Conventions:** `pnpm test [file]`, `node scripts/lint.js`; commit per task; baseline ~344 tests green. Node 24's `node:sqlite` (`DatabaseSync`, SQLite 3.50.4).

**Why this is the riskiest phase:** it rewrites the storage core *and* rewrites live user databases in place. Every claim below about SQLite behaviour was verified against `node:sqlite` on this machine, not assumed; the probes are reproduced inline so an implementer can re-run them.

---

## 0. Decisions this plan takes, and what needs sign-off

The design leaves five things unstated that phase 3 cannot avoid answering. Each is called out where it lands; collected here so they can be rejected before any code is written.

| # | Decision | Rationale | If rejected |
|---|---|---|---|
| D1 | The old association migration's `COALESCE(profile_id, first profile)` (`src/state/store.js:386-389`) becomes plain `profile_id`; ownerless rows are handled by **one** rule, in the collapse: *if the database has exactly one profile row, that profile owns them; otherwise record and drop.* | Rule 4 (owner never guessed). "Exactly one profile" is not a guess — it is the same determinism the design's own ingress table uses for the shared RPC path. Leaving the `COALESCE` keeps the guess the audit named as "the finding most likely to lose files quietly", but *removing* it without the single-profile rule would drop every row of any DB predating `transfers.profile_id` (added by `ensureColumn` at `:364`), which is mass data loss. | Keep `:386-389` as-is and let the collapse inherit its result. Lower blast radius, keeps a guess the design deleted. |
| D2 | `putio_transfer_id` becomes `NOT NULL UNIQUE` **now**, and `addTorrent` refuses an add whose put.io response carries no transfer id. | The migration drops the null rows; leaving the column nullable re-admits the exact zombies it just removed on the next boot. `PutioClient.normalizeTransfer` returns `id: numberOrNull(...)` (`src/putio/client.js:35`), so `uploadTorrent` genuinely can yield null — without the guard this is a raw `NOT NULL constraint failed` in an *arr's face. | Leave nullable until phase 4; the migration still drops the existing nulls. |
| D3 | `hash` stays `NOT NULL DEFAULT ''` (not nullable), loses its `UNIQUE`, and stops being an upsert key. | The design says "informational, NOT unique, correctable". Null vs `''` is a distinction no consumer makes (`service.js:79-81`, `:270`, `:806`), and `NOT NULL DEFAULT ''` avoids a null-guard sweep. Dropping `UNIQUE(hash)` forces the upsert onto `putio_transfer_id` — resolving by hash across a non-unique column would return an arbitrary row. This pulls the *first half* of phase-4 item 10 forward; hash correction and the disagreement-is-an-error rule stay in phase 4. | Keep `UNIQUE(hash)` through phase 3 and keep `generatedHash()` load-bearing. Then the collapse must also handle hash collisions between the surviving rows. |
| D4 | A second profile grabbing a release the first already owns is **refused**, naming the owning profile. | `UNIQUE(putio_transfer_id)` makes the second row unrepresentable; the alternative is silently handing profile B a row owned by profile A. This is the design's "Open decision", resolved in the direction it recommends. | Return profile A's row to profile B (and accept that `torrent-remove` from B then fails with the phase-1 "belongs to RR profile A" error). |
| D5 | The phase-2 "ownerless download" product surface is **deleted** (`ownerlessDownloadMessage`, the `ownerError` branch in `listDownloads`, `warnOwnerlessDownload`, the two sweep skips). | After phase 3 the state is unrepresentable: `NOT NULL` + `ON DELETE RESTRICT` + a migration that drops the leftovers. Keeping it is dead code the next audit re-flags. | Keep it as defence-in-depth against a hand-edited DB. Costs ~40 lines and four tests that can never fire. |

**D5 has a user-visible consequence that must reach the changelog.** The design's third breaking-change bullet currently reads "Downloads with no owning profile no longer acquire one at boot… They appear in the dashboard as errored… Fix: reassign or delete them." After phase 3 they do not appear at all — and there is no reassign control in the dashboard today (grep confirms no `PATCH /api/downloads/:id` and no profile picker in `src/web/downloads.js`), so a user upgrading straight from 2.0.x to the phase-3 release never gets the chance phase 2 advertised. That bullet must be rewritten to "are dropped from the database at upgrade, with a recorded report; their files are left on disk."

---

## 0b. Owner sign-off — overrides D1 and D5

The project owner ruled on the open decision: **a reassign action exists in
the dashboard.** Ownerless legacy rows are not dropped; they are parked in a
visible needs-attention state and the user assigns each one.

This overrides two decisions above:

- **D1 is rejected in its `record and drop` half.** The old
  `COALESCE(profile_id, first profile)` guess is still deleted, and the
  single-profile shortcut still applies (if a database has exactly one
  profile, it owns them — that is determinism, not inference). What changes is
  the remainder: rows that stay ownerless are **quarantined, not dropped**.
- **D5 is rejected.** The ownerless product surface is kept and extended
  rather than deleted, because it is now the UI for the quarantine.

### Quarantine

`downloads.profile_id` is still `NOT NULL … ON DELETE RESTRICT` — the
invariant holds — so quarantined rows cannot live in `downloads`. They go to
a holding table:

```sql
orphaned_downloads
  id                INTEGER PK
  putio_transfer_id INTEGER UNIQUE            -- may be NULL for the null-id rows
  hash, name, source, source_type
  category, lifecycle, total_size, downloaded_ever
  putio_file_id, save_parent_id
  legacy_download_dir TEXT                    -- the absolute path as last known,
                                              -- so the user can see where the files are
  quarantined_at    TEXT NOT NULL
  reason            TEXT NOT NULL             -- 'no owner' | 'extra association' |
                                              -- 'no put.io transfer id'
```

Their `association_files` rows are **not** carried over; a reassigned
download re-prepares from put.io, which is also what repairs any file list
that drifted while the row was unowned.

### Reassign

- `POST /api/downloads/orphaned/:id/assign` with `{ profileId }` — validates
  the profile, inserts a `downloads` row owned by it, deletes the quarantine
  row. A row whose `putio_transfer_id` is null cannot be assigned (rule 3
  gives it no identity) and is delete-only.
- `DELETE /api/downloads/orphaned/:id` with the usual
  `deleteLocal`/`deleteRemote` flags.
- `GET /api/downloads` returns them in a separate `orphaned` array so the
  dashboard can render a distinct needs-attention section — not interleaved
  with working downloads.
- Dashboard: a section listing each quarantined download with its reason, its
  last known local path, a profile picker, and a delete control.

This is a **repair** path, not a re-derivation path: it never runs
automatically, and rule 4 (the owner is frozen at creation) is unchanged for
every download that has one.

### Consequences for the rest of this plan

- Section 2's migration steps that say *record and drop* now mean *record and
  quarantine*; the settings-key report stays, as the machine-readable record of
  what happened.
- The extra-association rows (rule 1 makes them unrepresentable) and the
  null-put.io-id rows are quarantined the same way, with their `reason` set
  accordingly, rather than being dropped. Files on disk are still untouched.
- Section 7's commit sequence gains a commit for the quarantine table + API +
  dashboard section, after the collapse and before the cleanup commit.
- The changelog bullet D5 flagged is now accurate again in its original form:
  ownerless downloads are surfaced for the user to reassign or delete. It must
  additionally say they move to a needs-attention section rather than staying
  in the main list.
- Phase 5's profile-delete prompt should offer **reassign to another profile**
  alongside delete-remote and delete-local, since the machinery now exists.


## 1. Target DDL

### 1.1 `downloads` — was `transfers` + `transfer_associations`

```sql
CREATE TABLE IF NOT EXISTS downloads (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id            INTEGER NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  putio_transfer_id     INTEGER NOT NULL UNIQUE,
  putio_file_id         INTEGER,
  save_parent_id        INTEGER,
  hash                  TEXT    NOT NULL DEFAULT '',
  name                  TEXT    NOT NULL,
  source                TEXT    NOT NULL DEFAULT '',
  source_type           TEXT    NOT NULL DEFAULT 'unknown',
  category              TEXT    NOT NULL DEFAULT '',
  lifecycle             TEXT    NOT NULL DEFAULT 'remote',
  putio_status          TEXT    NOT NULL DEFAULT 'UNKNOWN',
  putio_status_message  TEXT    NOT NULL DEFAULT '',
  putio_peers           INTEGER NOT NULL DEFAULT 0,
  putio_availability    INTEGER NOT NULL DEFAULT 0,
  percent_done          INTEGER NOT NULL DEFAULT 0,
  completion_percent    INTEGER NOT NULL DEFAULT 0,
  total_size            INTEGER NOT NULL DEFAULT 0,
  downloaded_ever       INTEGER NOT NULL DEFAULT 0,
  uploaded_ever         INTEGER NOT NULL DEFAULT 0,
  download_speed        INTEGER NOT NULL DEFAULT 0,
  upload_speed          INTEGER NOT NULL DEFAULT 0,
  eta                   INTEGER NOT NULL DEFAULT -1,
  error                 INTEGER NOT NULL DEFAULT 0,
  error_string          TEXT    NOT NULL DEFAULT '',
  retry_count           INTEGER NOT NULL DEFAULT 0,
  removed_at            TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_downloads_profile_id ON downloads(profile_id);
CREATE INDEX IF NOT EXISTS idx_downloads_lifecycle  ON downloads(lifecycle);
CREATE INDEX IF NOT EXISTS idx_downloads_hash       ON downloads(hash);
```

Provenance of every column, and why:

| Column | Came from | Note |
|---|---|---|
| `id` | `transfer_associations.id` | **Must be preserved verbatim.** This is the id `torrent-add` handed the *arr apps (`service.js:278`) and the id they send back in `torrent-get`/`torrent-remove`. See risk R4. |
| `profile_id` | `transfer_associations.profile_id` | `transfers.profile_id` is the shadow column the audit found written-and-never-read; it is **not** the source. |
| `putio_transfer_id` | `transfers` | `NOT NULL UNIQUE` — D2. |
| `putio_file_id`, `save_parent_id`, `hash`, `name`, `source`, `source_type` | `transfers` | `source` gains `NOT NULL DEFAULT ''` (was nullable; every writer already passes `''`). |
| `category`, `lifecycle` | `transfer_associations` | `transfers.category`/`.lifecycle` are shadow columns. |
| `putio_status`, `putio_status_message`, `putio_peers`, `putio_availability`, `percent_done`, `completion_percent`, `uploaded_ever`, `upload_speed` | `transfers` | Genuinely remote-side; read by `listDownloads` (`service.js:795-801`) and `toTransmissionTorrent` (`:692-694`). |
| `total_size` | `COALESCE(a.total_size, r.total_size, 0)` | Exactly what `transferSelect` did (`store.js:990`). The association column is nullable; the new one is not. |
| `downloaded_ever`, `download_speed`, `eta`, `error`, `error_string`, `retry_count`, `removed_at`, `created_at`, `updated_at` | `transfer_associations` | The transfers-side copies are the "frozen progress columns" the design deletes. |

Dropped outright, with the reason:

- `transfers.profile_id`, `.category`, `.download_dir`, `.lifecycle`, `.total_size`, `.downloaded_ever`, `.download_speed`, `.eta`, `.error`, `.error_string`, `.retry_count`, `.removed_at` — written on insert (`store.js:780-818`), never updated, never read. Anyone querying the DB directly got the wrong owner.
- `transfer_associations.download_dir` — written (`store.js:877`, `service.js:262`, `:342`), never read for behaviour. Verified: the only consumer of a download dir is `path.join(profile.download_at, row.category)` (`service.js:686`, `:794`). The RPC's `downloadDir` field is computed, not stored.
- `idx_transfers_profile_id`, `idx_transfers_hash`, `idx_transfers_putio_status`, `idx_transfers_lifecycle`, `idx_transfer_associations_*` — replaced by the three above. `putio_status` is dropped as an index because no SQL predicate filters on it (`service.js:367`, `manager.js:102` filter in JS).
- The whole `transfer_files` table — created on every fresh DB, always empty after the association migration, and its global `putio_file_id UNIQUE` contradicts the model.
- `hasOtherActiveAssociations` / `allActiveAssociationsProcessed` have no SQL left to run against.

Considered and declined: a partial index `ON downloads(profile_id) WHERE removed_at IS NULL` for `listActiveTransfers`. These tables hold hundreds of rows on a real install; the index would be noise.

### 1.2 `download_files` — was `association_files`

```sql
CREATE TABLE IF NOT EXISTS download_files (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  download_id      INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
  putio_file_id    INTEGER NOT NULL,
  relative_path    TEXT    NOT NULL,
  size             INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  download_speed   INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_string     TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  UNIQUE(download_id, putio_file_id)
);

CREATE INDEX IF NOT EXISTS idx_download_files_download_id ON download_files(download_id);
CREATE INDEX IF NOT EXISTS idx_download_files_status      ON download_files(status);
```

The only change is the rename `association_files.transfer_id` → `download_files.download_id`. That column has always referenced `transfer_associations(id)`, not `transfers(id)` (`store.js:338`) — the audit's "naming landmine". Ids are preserved so nothing that cached a file id breaks.

### 1.3 `profiles` — rebuilt

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT    NOT NULL,
  type                  TEXT    NOT NULL DEFAULT 'custom',
  slug                  TEXT    NOT NULL UNIQUE,
  download_profile_id   INTEGER NOT NULL REFERENCES download_profiles(id) ON DELETE RESTRICT,
  auto_remove_completed INTEGER NOT NULL DEFAULT 0,
  putio_folder_name     TEXT    NOT NULL,
  putio_folder_id       INTEGER,
  download_at           TEXT    NOT NULL DEFAULT '',
  rpc_path              TEXT,
  client_host           TEXT    NOT NULL DEFAULT 'putiorr',
  client_port           TEXT    NOT NULL DEFAULT '9091',
  client_use_ssl        INTEGER NOT NULL DEFAULT 0,
  browser_domains       TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_rpc_path
  ON profiles(rpc_path) WHERE rpc_path IS NOT NULL;
```

Changes from today (`store.js:237-251` plus the `ensureColumn` calls at `:359-363`):

- `download_profile_id`: was `INTEGER REFERENCES download_profiles(id) ON DELETE SET NULL`, now `NOT NULL ... ON DELETE RESTRICT` (design rule 2).
- `rpc_path`: was `TEXT NOT NULL UNIQUE`, now `TEXT` with the partial unique index. This is what lets a Putiorr Grab profile stop holding a live Transmission endpoint (audit finding 6 / phase-3 item 9).
- `download_at` gains its `DEFAULT ''` explicitly — that is what `migrateProfileDownloadAt` has been adding since it was introduced (`store.js:457`), so the rebuilt table now states it instead of inheriting it from an `ALTER`.
- All `ensureColumn` additions (`client_host`, `client_port`, `client_use_ssl`, `browser_domains`) are folded into the base DDL. Their `ensureColumn` calls stay, guarded, for the one boot that upgrades an older DB *before* the rebuild runs.

Verified: a partial unique index still produces `UNIQUE constraint failed: profiles.rpc_path`, so `UNIQUE_PROFILE_COLUMN` (`server.js:29`) and `profileConflictError` keep working unchanged. Two rows with `rpc_path IS NULL` coexist happily.

```
D dup rejected: UNIQUE constraint failed: p.rpc_path
D rows = 3            (NULL, NULL, '/a')
```

---

## 2. The migration

### 2.1 What SQLite will and will not let us do

Four things were probed on `node:sqlite` 3.50.4 before writing this. They dictate the shape of everything below.

**(a) `DROP TABLE` cascades when foreign keys are on.** With `PRAGMA foreign_keys = ON` (which `StateStore`'s constructor sets, `store.js:209`), dropping a parent table performs an implicit `DELETE FROM`, which fires `ON DELETE CASCADE` all the way down:

```
A after drop t: a rows = 0   af rows = 0
```

Dropping `transfers` while `transfer_associations` still exists therefore **empties `transfer_associations` and `association_files`**. If any step of the migration reads them after that point, it reads nothing — and it fails silently, because zero rows is a legal answer.

**(b) `PRAGMA foreign_keys` is a no-op inside a transaction.**

```
B fk inside txn = { foreign_keys: 1 }     ← the OFF was ignored
B fk outside txn = { foreign_keys: 0 }
```

So the toggle must bracket the transaction, not sit inside it. This is SQLite's documented 12-step ALTER TABLE procedure.

**(c) `ALTER TABLE x RENAME TO y` rewrites other tables' foreign keys to point at the new name.** This is the trap that would silently break the rebuild of `profiles`:

```
E downloads sql after renaming profiles:
  ... REFERENCES "profiles_old"(id) ON DELETE RESTRICT
F downloads sql after creating a new profiles:
  ... REFERENCES "profiles_old"(id)    ← still dangling
```

The rebuild therefore **must not** rename the old table aside. The correct order is: create `profiles_new`, copy, `DROP TABLE profiles`, `ALTER TABLE profiles_new RENAME TO profiles`. Verified to leave the FK text intact and enforcing:

```
G downloads sql: ... REFERENCES profiles(id) ON DELETE RESTRICT
G restrict works: FOREIGN KEY constraint failed
```

**(d) `AUTOINCREMENT` follows explicit ids.** Inserting `id = 17` into an empty `AUTOINCREMENT` table sets `sqlite_sequence.seq = 17`; the next implicit insert is 18. Copying ids across therefore cannot collide with future inserts.

**(e) `VACUUM INTO` works and cannot run inside a transaction**, and it refuses to overwrite an existing file. This is the only safe way to back up a WAL database from inside the process (copying the `.sqlite` file alone loses the WAL).

### 2.2 Order of operations in `migrate()`

```
migrate()
 ├─ 1. CREATE TABLE IF NOT EXISTS  settings, download_profiles, profiles(new shape),
 │                                 downloads, download_files   ← no legacy tables
 ├─ 2. legacy column top-ups, each guarded by hasTable():
 │       migrateProfileDownloadAt / migrateProfileAutoRemoveCompleted
 │       ensureColumn(profiles, download_profile_id|client_*|browser_domains)
 │       if hasTable('transfers'):       ensureColumn(transfers, …)   (store.js:364-368)
 │       if hasTable('transfer_files'):  ensureColumn(transfer_files, download_speed)
 │       if hasTable('transfers'):       migrateTransferAssociations()   (chain hop 1)
 │       if hasTable('transfers'):       migrateMagnetTransferHashes()
 ├─ 3. migrateDownloadsCollapse()        (chain hop 2)   guard: downloads_schema_v1
 └─ 4. migrateProfilesSchema()           guard: profiles_schema_v2
```

Step 2 is where the **chained migration** (old DB → associations → downloads) keeps working, and it is the reason every legacy step must become conditional: `PRAGMA table_info(transfers)` on a fresh DB returns `[]`, and `ensureColumn` would then `ALTER` a table that does not exist. Add

```js
hasTable(name) {
  return Boolean(this.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}
```

and gate every legacy step on it. `migrateMagnetTransferHashes` must run *before* the collapse (it fixes `transfers.hash` in place) — after the collapse there is no `transfers` table for it to touch, and its `UNIQUE` conflict check (`store.js:479-484`) is meaningless once the hash is not unique. It is a legacy step from here on.

**The `COALESCE` at `store.js:386-389`** (D1): replace with plain `profile_id`. The one-shot association migration stops guessing; the collapse below owns the single ownership rule. Write the reason in the code comment — a shipped migration that changes behaviour needs to say why.

### 2.3 `migrateDownloadsCollapse()`

Runs only when `getSetting('downloads_schema_v1') !== '1'` **and** `hasTable('transfer_associations')`. A fresh DB sets the key and does nothing else.

```js
// outside any transaction — (b) and (e)
this.backupBeforeCollapse();          // VACUUM INTO, skipped for ':memory:'
this.db.exec('PRAGMA foreign_keys = OFF');
try {
  this.db.exec('BEGIN IMMEDIATE');
  try {
    const report = this.collapseTransfersIntoDownloads();   // overridable for tests
    this.db.exec('PRAGMA foreign_key_check');               // throws on a dangling ref
    this.setSetting('downloads_schema_v1', '1');
    this.setSetting('downloads_schema_v1_report', JSON.stringify(report));
    this.db.exec('COMMIT');
    logCollapseReport(report);
  } catch (error) {
    this.db.exec('ROLLBACK');
    throw error;
  }
} finally {
  this.db.exec('PRAGMA foreign_keys = ON');
}
```

Both settings writes are **inside** the transaction. The existing `migrateTransferAssociations` writes its key outside (`store.js:425`) and gets away with it because `INSERT OR IGNORE` makes it idempotent; this migration drops tables, so a crash between commit and key-write would re-run it against a database that no longer has the source tables. It must be atomic with the work.

`collapseTransfersIntoDownloads()` does the work row by row in JS rather than as one `INSERT ... SELECT`. The tables are small (hundreds of rows), and the loop is what makes the report — which profile, which local path, which put.io id — possible at all.

1. **Resolve the fallback owner.**
   ```sql
   SELECT id FROM profiles
   ```
   If exactly one row → `soleProfileId`. Otherwise `soleProfileId = null`. (D1. Considered and rejected: filtering to non-grab profiles first. It would resolve one more case and introduce a second rule; "exactly one profile exists" is explainable in a release note, "exactly one profile that isn't a grab profile" is not.)

2. **Group the associations.** `SELECT * FROM transfer_associations ORDER BY transfer_id, created_at ASC, id ASC`. Within each `transfer_id`, the first row wins ("oldest"); the rest go to `report.extraAssociations`. `created_at` first, `id` as the tiebreak: the association migration copies `created_at` verbatim from `transfers` (`store.js:401`), so every row born that way ties and `id` decides — which is also the order they were created in.

3. **For each surviving association, decide whether it can be represented.**
   - `transfers.putio_transfer_id IS NULL` → `report.noPutioId`, drop (design rule 3).
   - `profile_id IS NULL` and `soleProfileId` exists → adopt `soleProfileId`, count in `report.adoptedBySoleProfile`.
   - `profile_id IS NULL` and no sole profile → `report.ownerless`, drop.
   - `profile_id` points at a profile row that no longer exists (possible: the FK was `ON DELETE SET NULL`, so this should not happen, but `foreign_keys` has been off during at least one legacy `ALTER` in this codebase's history) → treat as ownerless. Cheap to check, and it is the difference between a report line and a `FOREIGN KEY constraint failed` that aborts the whole upgrade.
   - otherwise → insert.

4. **Insert**, preserving `id`, with the column mapping from §1.1. `total_size` is `a.total_size ?? r.total_size ?? 0`.

5. **Copy `association_files`** for the surviving associations only, preserving `id` and mapping `transfer_id` → `download_id`. Files belonging to a dropped association are not copied (they would violate the FK) and are counted in the report.

6. **Drop, in dependency order, with foreign keys already off:**
   ```sql
   DROP TABLE IF EXISTS association_files;
   DROP TABLE IF EXISTS transfer_associations;
   DROP TABLE IF EXISTS transfer_files;
   DROP TABLE IF EXISTS transfers;
   ```
   Order matters even with FKs off, for readability; it is *load-bearing* if anyone ever turns them back on inside this block (probe (a)).

7. **Return the report:**
   ```js
   {
     version: 1,
     at: '2026-07-25T…Z',
     migrated: 42,
     adoptedBySoleProfile: 3,
     extraAssociations: [{ associationId, transferId, putioTransferId, profileId, profileName, name, localPath, fileCount }],
     noPutioId:          [{ associationId, profileId, profileName, name, localPath, fileCount }],
     ownerless:          [{ associationId, putioTransferId, name, fileCount }],
     droppedFiles: 7,
   }
   ```
   `localPath` is `path.join(profile.download_at, category, name)` — the design asks the log to name "the profile and local path" so the user can find the files that were left behind. Every dropped entry also gets its own `logger.warn` line; the aggregate goes to `logger.info` as `downloads schema migration completed`.

**Nothing on disk is touched.** The store has no filesystem imports beyond `mkdirSync` for the DB directory (`store.js:3`), and the migration must not acquire one. That is the design's guarantee ("their files are left on disk") and it is enforced structurally.

**Partial failure.** DDL and DML are both transactional in SQLite, so there are exactly two outcomes: the whole collapse commits, or the database is byte-identical to before (legacy tables intact, guard key unset) and the next boot retries. The `VACUUM INTO` backup exists for the third case — a bug in *this* code that commits something wrong.

### 2.4 `backupBeforeCollapse()`

```js
if (this.filePath === ':memory:') return undefined;
const target = `${this.filePath}.pre-downloads-${Date.now()}.bak`;
this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
logger.info('database backed up before the downloads schema migration', { target });
```

Outside the transaction (probe (e)). Timestamped because `VACUUM INTO` refuses an existing target. It is never deleted automatically — a NAS user who discovers a problem a week later still has it. Say so in the release notes, including that it is safe to delete.

### 2.5 `migrateProfilesSchema()`

One rebuild does both profile changes; two rebuilds of the same table for one release is wasted risk. Guard key `profiles_schema_v2`, and a shape check (`rpc_path` still `notnull = 1` in `PRAGMA table_info`) so a DB that somehow has the key but not the shape is not left half-done.

Same bracket as §2.3 (`foreign_keys` off outside, one transaction inside), then:

1. **Ensure a default download profile exists.** On a DB predating `download_profiles`, every `download_profile_id` is null *and* the table is empty — `seedFromConfig` is what creates the default (`store.js:511`), and it runs *after* the constructor (`main.js:12-13`). So the migration must create it. Its policy comes from `downloadProfilePolicyFromConfigAndSettings(this, config)`, which needs the config the store does not currently have.

   **Change `StateStore`'s constructor to `constructor(filePath = ':memory:', { config } = {})`** and pass `config` from `main.js:12`. Without it, an upgrade from a pre-`download_profiles` database silently loses the `PUTIORR_SLOW_SPEED_*` environment settings, because `ensureDefaultDownloadProfile` returns the existing row without applying config (`store.js:553-561`). Tests constructing `new StateStore(':memory:')` get `DEFAULT_DOWNLOAD_POLICY`, which is what they get today.

2. `UPDATE profiles SET download_profile_id = <defaultId> WHERE download_profile_id IS NULL` (design rule 5), counted into a `profiles_schema_v2_report` settings key.
3. `UPDATE profiles SET rpc_path = NULL WHERE type = 'grab'` — the derived `/grab/<slug>/rpc` was only ever there to satisfy `NOT NULL UNIQUE`. Count it; the release notes need to say the endpoint is gone.
4. `CREATE TABLE profiles_new (…)` with the §1.3 DDL.
5. `INSERT INTO profiles_new (…) SELECT … FROM profiles` — explicit column list, ids preserved.
6. `DROP TABLE profiles;` then `ALTER TABLE profiles_new RENAME TO profiles;` — **never** the other order (probe (c)).
7. `CREATE UNIQUE INDEX idx_profiles_rpc_path ON profiles(rpc_path) WHERE rpc_path IS NOT NULL`.
8. `PRAGMA foreign_key_check` — this is what catches a `downloads.profile_id` pointing at a profile that step 5 lost. It returns rows (it does not throw), so the migration must read them and throw itself:
   ```
   H fk_check dangling: [ { table: 'd', rowid: 1, parent: 'p', fkid: 0 } ]
   ```
9. Write both guard keys, commit.

**Two rows could now collide on `rpc_path`** where they did not before? No — the old constraint was strictly stronger. But nulling grab paths *removes* rows from the index, which can never create a conflict. Safe in one direction only, which is the direction we go.

**The `NOT NULL` on `download_profile_id` can still fail** if step 1 cannot produce a default (`download_profiles` empty *and* `createDownloadProfile` throws). Then the whole transaction rolls back and putiorr fails to start with the real error rather than a corrupted DB. That is the right outcome; the message must say so.

---

## 3. The store API after the collapse

### 3.1 The row shape — the `transferSelect` landmine

Today `transferSelect` (`store.js:968-1006`) returns a synthetic row: `a.id AS id`, `a.transfer_id AS remote_id`, and columns cherry-picked from both tables. On upgraded databases `a.id` and `a.transfer_id` coincide (the association migration copies `id` into both, `store.js:384-385`), so the aliasing is invisible until a fresh install — which is exactly why it is a landmine.

**After the collapse there is no `remote_id`.** `SELECT * FROM downloads` is the row. `transferSelect` is deleted, not renamed; the `normalizeTransferRow` wrapper stays (it coerces `error` to a boolean) as `normalizeDownloadRow`.

Every consumer of `.remote_id` must be changed, and there is no compatibility shim — a shim would let a missed call site read `undefined` and pass it to `deleteRemoteTransferIfOrphaned(undefined)`, which deletes nothing and reports nothing. The call sites are listed in §4; there are eleven.

### 3.2 Function-by-function

**Renamed, same behaviour:**

| Before | After |
|---|---|
| `findTransferById(id)` | `findDownloadById(id)` |
| `findTransferByHash(hash, {profileId})` | `findDownloadByHash(hash, {profileId})` |
| `findTransferByPutioId(id, {profileId})` | `findDownloadByPutioTransferId(id, {profileId})` |
| `findTransfer(identifier, {profileId})` | `findDownload(identifier, {profileId})` |
| `listActiveTransfers({profileId})` | `listActiveDownloads({profileId})` |
| `listRemovedTransfers()` | `listRemovedDownloads()` |
| `markTransferRemoved(id)` | `markDownloadRemoved(id)` |
| `updateTransfer(id, patch)` | `updateDownload(id, patch)` |
| `upsertTransferFile(input)` | `upsertDownloadFile(input)` |
| `findTransferFileById(id)` | `findDownloadFileById(id)` |
| `listFilesForTransfer(id)` | `listFilesForDownload(id)` |
| `updateTransferFile(id, patch)` | `updateDownloadFile(id, patch)` |
| `markTransferFileDeleted(id)` | `markDownloadFileDeleted(id)` |
| `deleteTransferFile(id)` | `deleteDownloadFile(id)` |
| `getTransferFileStats(id)` | `getDownloadFileStats(id)` |
| `purgeDeletedFilesForProcessedTransfers()` | `purgeDeletedFilesForProcessedDownloads()` |

**Signatures that change:**

- `createOrUpdateTransfer(input)` → `upsertDownload(input)`.
  - Resolution is `findDownloadRowByPutioTransferId(input.putio_transfer_id)` **only**. The hash-first lookup (`store.js:776-777`) is deleted — with `UNIQUE(hash)` gone it would return an arbitrary row (D3).
  - Throws `'put.io transfer id is required'` when `putio_transfer_id` is missing (D2). Replaces the current `'transfer hash is required'` throw at `:775`.
  - Throws `'profile id is required'` when `profile_id` is missing on an insert.
  - On update, if the stored `profile_id` differs from a supplied `input.profile_id`, throws `` `Download ${row.name} already belongs to RR profile ${owner.name}` `` (D4). The poll path passes the row's own `profile_id` back in (`service.js:339`), so it never trips.
  - Returns the `downloads` row. The two-step insert (`transfers` then `transfer_associations`, `store.js:779-917`) becomes one insert and one update; the `remoteAllowed`/`associationAllowed` split in `updateTransfer` (`:923-949`) becomes one allow-list.
- `updateDownload(id, patch)` — one allow-list, one `UPDATE`. `profile_id` is **removed** from the allow-list: the owner is frozen (design rule 4). Nothing in `src/` patches it today.
- `findDownloadFileByPutioId(putioFileId, downloadId)` — unchanged shape, but the `downloadId == null` branch (`store.js:1228-1229`) becomes a lookup that can legitimately match several rows. Keep it (tests use it) with `ORDER BY id ASC LIMIT 1` and a comment saying it is a test/debug affordance.
- `listPendingFiles(limit)` — the two-table join collapses to one:
  ```sql
  SELECT f.*, d.category, d.name AS download_name, d.hash AS download_hash
  FROM download_files f
  JOIN downloads d ON d.id = f.download_id
  WHERE f.status IN ('pending','failed') AND d.removed_at IS NULL
  ORDER BY f.id ASC LIMIT ?
  ```
  The aliases `transfer_name`/`transfer_hash` become `download_name`/`download_hash`; `manager.js:400` reads `job.transfer_name`.
- `deleteProfile(id)` — the pre-check queries `downloads` instead of `transfer_associations` (`store.js:731-733`). Keep the explicit check: `ON DELETE RESTRICT` alone yields `FOREIGN KEY constraint failed`, and the current message ("RR profile cannot be deleted while downloads still reference it") is what the dashboard shows.
- `deleteDownloadProfile(id)` → `deleteDownloadProfile(id, { reassignTo })`. With `ON DELETE RESTRICT` the bare delete now throws whenever any profile references it. The endpoint's current sequence — delete, then `assignMissingProfileDownloadProfiles` (`server.js:740-743`) — is inverted and moved into the store so it is one transaction:
  ```js
  this.transaction(() => {
    if (reassignTo) this.db.prepare(
      'UPDATE profiles SET download_profile_id = ?, updated_at = ? WHERE download_profile_id = ?'
    ).run(reassignTo, nowIso(), id);
    this.db.prepare('DELETE FROM download_profiles WHERE id = ?').run(id);
  });
  ```
- `createProfile(input)` — resolves `download_profile_id ?? findDefaultDownloadProfile()?.id`, and throws `'a download profile is required'` if there is none. This is *not* owner-guessing: rule 4 is about which profile owns a download; the default download profile is an existing user-visible concept (`/api/settings.defaultDownloadProfileId`, `server.js:859`; preselected by the wizard, `web/profiles.js:505`). Without it, ~30 `createProfile` calls in tests and the `PUTIORR_PROFILES_JSON` seed path all hit `NOT NULL`.

**Deleted:**

| Function | Why |
|---|---|
| `transferSelect(where)` | No join left. |
| `findRemoteTransferById/ByHash/ByPutioId` | The remote row *is* the download row. |
| `findTransferAssociation(remoteId, profileId)` | One row per put.io transfer. |
| `listTransfersForRemote(remoteId, …)` | Same. |
| `hasOtherActiveAssociations(transfer)` | Structurally always false. |
| `allActiveAssociationsProcessed(remoteId)` | Structurally equals "this download is processed". |
| `deleteRemoteTransferIfOrphaned(remoteId)` | Merged into `deleteDownload(id)`. |
| `deleteRemoteTransferRecord(remoteId)` | Same. |
| `deleteTransfer(id)` | Renamed to `deleteDownload(id)`; now the only delete. |
| `assignMissingProfileDownloadProfiles(id)` | Column is `NOT NULL`; the only remaining caller is the download-profile delete, which now reassigns explicitly. Keep the *migration* it performs inside `migrateProfilesSchema`. |

---

## 4. Caller-by-caller change list

Line numbers are at `7c19341`. Exhaustive: this list plus §3 is every reference to the old API in `src/`.

### `src/transfer/service.js`

| Line | Now | Becomes |
|---|---|---|
| `84-119` | `putioTransferToStoreInput`, sets `download_dir` (`:97`) | `putioTransferToDownloadInput`; drop `download_dir`; keep `generatedHash()` for now (phase 4 removes it — D3) |
| `202-206` | `findTransferProfile` guards `profile_id != null` | `findDownloadProfileOwner(download)` → `this.store.findProfileById(download.profile_id)`; the null guard and its "until phase 3" comment go |
| `208-212` | `requireTransferProfile` | Keep as a defensive assert (D5); comment changes from "can still be null on rows written by older versions" to "FK RESTRICT guarantees this; a throw here means the DB was edited by hand" |
| `72-75` | `ownerlessDownloadMessage` | Delete (D5) |
| `256-265` | `store.createOrUpdateTransfer(…)` | `store.upsertDownload(…)`; add the D4 refusal path around it, with a test |
| `330-363` | `refreshRemoteTransfer`: `findRemoteTransferByPutioId` → `listTransfersForRemote` → loop | One lookup: `const existing = this.store.findDownloadByPutioTransferId(remote.id)`. If found, one `upsertDownload` and `if (!existing.removed_at) rows.push(updated)`. The `for` loop and `associations` array disappear |
| `355-362` | Adoption by `save_parent_id`; `folderProfiles.length !== 1` → silent skip | Unchanged in phase 3 (the log + dashboard notice is phase 4) — but it now supplies `profile_id`, which is mandatory, so the early `return` is load-bearing rather than cosmetic. Add the comment |
| `369-370` | `deleteTransfer(id)` + `deleteRemoteTransferIfOrphaned(remote_id)` | `deleteDownload(transfer.id)` |
| `387-388` | same pair | `deleteDownload(removed.id)` |
| `414-415` | `findTransfer` / `listActiveTransfers` | `findDownload` / `listActiveDownloads` |
| `427,434` | `findTransfer` | `findDownload` |
| `436` | `findTransferProfile(foreign)` | renamed |
| `445-447` | `hasOtherActiveAssociations` + `allActiveAssociationsProcessed` | Delete both; `const remoteDeleted = true` — inline it away |
| `451-452` | local delete path | Unchanged (phase 4 owns the path) |
| `454-458` | branch on `hasOtherAssociations` | `this.store.deleteDownload(transfer.id)` |
| `470` | `findTransfer` | `findDownload` |
| `475-478` | the same two predicates | `const remoteDeleted = deleteRemote` |
| `483` | `listFilesForTransfer` | `listFilesForDownload` |
| `488-489` | `requireTransferProfile` + `deleteLocalData` | Unchanged |
| `494-500` | three-way branch | `if (deleteRemote) this.store.deleteDownload(id); else this.store.markDownloadRemoved(id);` |
| `519,529` | `findTransfer`, `listFilesForTransfer` | renamed |
| `539-542` | the two predicates again | `const remoteDeleted = deleteRemote` |
| `550-557` | `deleteTransferFile` / `markTransferFileDeleted` | renamed |
| `587-606` | `findTransferById`, `getTransferFileStats`, `updateTransfer` | renamed |
| `631-634` | early-return guard in `removeRemoteTransfer` | Delete the guard entirely |
| `672-675` | `requireTransferProfile`, `getTransferFileStats`, `listFilesForTransfer` | renamed |
| `750` | `listActiveTransfers()` | `listActiveDownloads()` |
| `753-757` | `findTransferProfile` + `ownerError` | `const profile = this.store.findProfileById(row.profile_id)` — no `ownerError` (D5) |
| `758` | `findDownloadProfileById(...) ?? findDefaultDownloadProfile()` | The `??` can stay (a download profile can still be deleted out from under a stale in-memory row) — but note it is now unreachable under RESTRICT |
| `760-761` | stats/files | renamed |
| `788-794` | `profile?.id ?? null`, `'No RR profile'`, `downloadAt: profile ? … : ''` | Unconditional: `profile.id`, `profile.name`, `path.join(profile.download_at, row.category)` |
| `808` | `ownerError || row.error_string || fileError` | `row.error_string || fileError` |

### `src/download/manager.js`

| Line | Now | Becomes |
|---|---|---|
| `127` | `markTransferRemoved` | `markDownloadRemoved` |
| `140,150` | `findTransferById` | `findDownloadById` |
| `159` | `listFilesForTransfer` | `listFilesForDownload` |
| `178` | `updateTransfer` | `updateDownload` |
| `203` | `requireTransferProfile` | renamed |
| `209,237` | `updateTransfer` | `updateDownload` |
| `227-234` | `upsertTransferFile({ transfer_id: updated.id, … })` | `upsertDownloadFile({ download_id: updated.id, … })` |
| `242` | `listActiveTransfers()` | `listActiveDownloads()` |
| `246-250` | ownerless skip + `warnOwnerlessDownload` | Delete (D5); `const profile = this.store.findProfileById(transfer.profile_id)` |
| `276-277`, `299-300` | `deleteTransfer` + `deleteRemoteTransferIfOrphaned(remote_id)` | `deleteDownload(transfer.id)` — **the only two `remote_id` reads in this file besides `:797`** |
| `311` | `listActiveTransfers()` | `listActiveDownloads()` |
| `315-319` | ownerless skip | Delete (D5) |
| `325-327` | `autoRemoveProfileForTransfer` | Keep, delegating to the renamed lookup |
| `331-338` | `warnOwnerlessDownload` | Delete (D5) |
| `341` | `listFilesForTransfer` | `listFilesForDownload` |
| `382,390,419,447,469,522,569,706,733` | `updateTransferFile` | `updateDownloadFile` |
| `396,400` | `findTransferById(job.transfer_id)`, `job.transfer_name` | `findDownloadById(job.download_id)`, `job.download_name` |
| `399,409,717,720,743,746` | `job.transfer_id` / `file.transfer_id` | `.download_id` |
| `425,481` | `findTransferFileById` | `findDownloadFileById` |
| `429,479` | `findTransferById(file.transfer_id)` | `findDownloadById(file.download_id)` |
| `699-700` | `findTransferById(file.transfer_id)` → `findProfileById(transfer.profile_id)` | renamed; `transfer.profile_id` is now guaranteed |
| `750,753,761` | `findTransferById`, `getTransferFileStats`, `updateTransfer` | renamed |
| `772,775,779` | same | renamed |
| `794-798` | `cleanupRemoteFiles && putio_file_id && allActiveAssociationsProcessed(remote_id)` | `cleanupRemoteFiles && transfer.putio_file_id` — the third predicate is structurally always true |

### `src/transmission/server.js`

| Line | Now | Becomes |
|---|---|---|
| `441` | `findProfileByRpcPath(requestPath)` | Unchanged — but a grab profile now has `rpc_path IS NULL` and can never match |
| `451-454` | `pathProfile?.type === GRAB_PROFILE_TYPE` → `refuseGrabProfileRpc` | The condition becomes unreachable. Replace with a **static route guard** `/^\/grab\/[^/]+\/rpc$/` that returns the same Transmission-style refusal, so an *arr still pointed at the old derived endpoint gets a sentence instead of the SPA's `index.html` with HTTP 200 (`serveWeb`'s ENOENT fallback, `:880-886`). Message loses the profile name; make it name the extension instead |
| `474-483` | `refuseGrabProfileRpc(req, res, profile)` | `refuseGrabRpcPath(req, res)` — no profile argument |
| `732-746` | delete download profile, then `assignMissingProfileDownloadProfiles` | `store.deleteDownloadProfile(id, { reassignTo: defaultDownloadProfile.id })`; the post-hoc call goes. Without this the endpoint throws `FOREIGN KEY constraint failed` for every download profile that any RR profile uses |
| `769` | `store.deleteProfile(id)` | Unchanged; store-side pre-check retargeted |
| `1310-1317` | grab branch of `testClientSettings` returns before touching `rpc_path` | Unchanged — already correct |
| `1318` | `profile.rpc_path \|\| normalizeRpcPath(...)` | Unchanged for *arr presets |
| `1446` | `if (rpcPath !== undefined) output.rpc_path = normalizeRpcPath(rpcPath)` | Accept `null`/`''` as "clear it": `output.rpc_path = rpcPath == null \|\| rpcPath === '' ? null : normalizeRpcPath(rpcPath)` |
| `1467` | `for (const key of ['name','slug','putio_folder_name','download_at','rpc_path'])` | `rpc_path` moves out of the unconditional list and is required only when `output.type !== GRAB_PROFILE_TYPE` |
| `101-123` | `profileConflictError` | Unchanged — verified the partial index yields the same `UNIQUE constraint failed: profiles.rpc_path` |

### `src/web/`

| File:line | Now | Becomes |
|---|---|---|
| `profiles.js:574-576` | `grabRpcPathForName(name)` → `/grab/<slug>/rpc` | Delete |
| `profiles.js:578-580` | `rpcPathForType(type, name)` | Returns `null` for grab |
| `profiles.js:585-588` | `syncDerivedRpcPath()` | Delete (nothing to keep in sync) |
| `profiles.js:458` | `setWizardField(el.wizardRpcPath, profile.rpc_path \|\| rpcPathForType(...))` | Leave the field empty for grab |
| `profiles.js:505-506` | preset defaults set `rpc_path` | `null` for grab |
| `profiles.js:597-598` | `getWizardPayload` always sends `rpc_path` | Sends `null` for grab |
| `profiles.js:619` | required-fields check includes `payload.rpc_path` | Exempt grab |
| `profiles.js:388` | card fact `'rpc'`, `profile.rpc_path \|\| 'Not set'` | `'Not used'` for grab — "Not set" reads like a misconfiguration |
| `profiles.js:749` | `getClientSettingsFromProfile` derives a path | Only ever reached for *arr presets; assert that and drop the grab branch |
| `download-profiles.js:449` | `profile.rpc_path \|\| 'No RPC path'` | Unchanged (already null-safe) |
| `downloads.js` | reads `download.id` only | **Unchanged** — the dashboard is insulated from the collapse |

### `src/download/policy.js`

| Line | Now | Becomes |
|---|---|---|
| `86` | `store.findProfileById(profileId)?.download_profile_id` | Now always set; the `?? fallbackProfile` at `:93-95` becomes unreachable. Leave it (it also serves `profileId == null`) and note it |

### `src/main.js`

| Line | Now | Becomes |
|---|---|---|
| `12` | `new StateStore(config.statePath)` | `new StateStore(config.statePath, { config })` (§2.5 step 1) |

---

## 5. Test strategy

### 5.1 Migration-level — a new `test/state-migration.test.js`

Every fixture is built the way `test/state-store.test.js:101-127` and `:283-393` already do it: a raw `DatabaseSync` writing the legacy DDL by hand, closed, then reopened as a `StateStore`. Extract a `writeLegacyDb(dbPath, { era, rows })` helper in the test file so the six fixtures do not each carry 60 lines of `CREATE TABLE`.

| Fixture | Asserts |
|---|---|
| **F1 — fresh DB** | `downloads`/`download_files` exist with the target shape; `transfers`, `transfer_associations`, `transfer_files`, `association_files` are **not** created (`sqlite_master`); both guard keys set; `PRAGMA foreign_key_check` empty; a `profiles` insert without `download_profile_id` picks up the default |
| **F2 — association-era DB** (`transfers` + `transfer_associations` + `association_files`, 1:1) | Every association id survives as the same `downloads.id`; every `association_files.id` as the same `download_files.id`; column mapping per §1.1, including `total_size` coming from the association when set and from the transfer when null; legacy tables gone; report says `migrated: N` with empty drop lists |
| **F3 — pre-association DB** (`transfers` + `transfer_files`, no associations) | The **chain** runs: `migrateTransferAssociations` then the collapse, in one boot. `transfers.id` → association id → `downloads.id` unchanged. Owner comes from `transfers.profile_id` where set. `transfer_files` rows arrive in `download_files`. A row with `profile_id IS NULL` **and exactly one profile in the DB** is adopted (D1) and counted in `adoptedBySoleProfile` |
| **F4 — multi-association** (one transfer, two associations, files under both) | The oldest association's id is the `downloads.id`; the younger is absent from `downloads`, present in `report.extraAssociations` with `profileName` and `localPath`; the younger's `association_files` are **not** in `download_files`; a `logger.warn` names the profile and the path; `droppedFiles` counts them |
| **F5 — null put.io ids** (`putio_transfer_id IS NULL`, with files) | Row absent from `downloads`, present in `report.noPutioId`; warn logged; `UNIQUE(putio_transfer_id)` intact afterwards |
| **F6 — null `download_profile_id`** — two variants: (a) `download_profiles` populated, (b) empty | (a) profiles are assigned the existing default; (b) the migration creates the default and assigns it. In both, `PRAGMA table_info(profiles)` shows `download_profile_id notnull = 1` and a `DELETE FROM download_profiles` of that row now throws |
| **F7 — ownerless in a multi-profile DB** | A `profile_id IS NULL` association with two profiles present is dropped, recorded in `report.ownerless`, and **not** assigned to either profile — the direct regression test for the deleted `COALESCE` |
| **F8 — idempotency** | Open, close, reopen: report unchanged, row ids unchanged, no second backup written for the second open (the guard short-circuits before `VACUUM INTO`) |
| **F9 — atomicity** | Subclass `StateStore` and override `collapseTransfersIntoDownloads` to run the real one and then throw. Assert: the constructor throws, `transfers`/`transfer_associations`/`association_files` still exist **with all their rows**, `downloads` is empty, the guard key is unset. This is the test that proves a half-migrated DB is impossible |
| **F10 — grab profiles lose their derived path** | A grab profile with `rpc_path = '/grab/x/rpc'` reads back `rpc_path === null`; two grab profiles can coexist with null paths; an *arr profile keeps its path and a duplicate is still refused |
| **F11 — backup** | On a file-backed DB, `<path>.pre-downloads-*.bak` exists and opens as a database containing `transfer_associations`; on `:memory:` nothing is written |

### 5.2 Keeping the existing ~344 tests meaningful

**Mechanical (find-and-replace plus a `download_dir:` removal), no assertions change:**

- `test/download-resume.test.js` — 12 `upsertTransferFile({ transfer_id: … })` call sites (`:208, 248, 283, 324, 399, 438, 469, 502, 510`) plus the `createTransfer` helper at `:41`.
- `test/prowlarr-cleanup.test.js` — `:68, 81, 198`, and the `download_dir:` at `:285`.
- `test/api-grab.test.js` — two store calls; the four `rpc_path: '/grab/…/rpc'` profile fixtures (`:290, 836, 844, 931, 939`) become `rpc_path: null`.
- `test/putio-client.test.js` — one incidental reference.
- `test/transmission-rpc.test.js` — the bulk: ~92 matches, almost all `createOrUpdateTransfer`/`upsertTransferFile`/`transfer_id:`. Rename in one pass, then read the diff for the handful that are not mechanical (below).

**Genuine rewrites:**

- `test/state-store.test.js:640-664` — *"seeding never assigns an owner to a download that has none"* constructs a download with no `profile_id`. Under `NOT NULL` that is no longer expressible. Replace with: `upsertDownload` **throws** without a `profile_id`, and `seedFromConfig` never rewrites an existing `downloads.profile_id`. The phase-2 intent survives; the mechanism it tested is gone.
- `test/state-store.test.js:10-39` — *"matches later remote updates by put.io id"* asserts `second.hash === 'temporaryhash'`, i.e. hash is write-once and the row is found by put.io id. Keep the id-matching half; the hash half becomes phase 4's (correctable hash) and should be marked as such rather than silently inverted.
- `test/state-store.test.js:174-201` — *"profiles with linked downloads cannot be deleted"*: same message, now backed by both the pre-check and `ON DELETE RESTRICT`. Add a second assertion that the raw `DELETE` also fails.
- `test/state-store.test.js:280-408` — the magnet-hash migration fixture asserts `findTransferById(1).remote_id === 1`. `remote_id` is gone; assert `id === 1` and the file rows instead. This test is the closest thing the repo has to an F3 fixture — consider moving it into `state-migration.test.js` wholesale.
- `test/download-metrics.test.js:490-620` — the four phase-2 ownerless tests (`createOwnerlessTransfer` and its users). All four construct a state that phase 3 makes unrepresentable. Under D5 they are deleted and replaced by *one* test asserting `upsertDownload` refuses a download with no profile, plus the F7 migration fixture. **This is the single largest deliberate loss of coverage in the phase and needs to be called out in the commit message**, because a reviewer counting tests will see four regression tests disappear.
- `test/transmission-rpc.test.js:2507` — *"a Putiorr Grab derived RPC path refuses Transmission traffic"* — the mechanism changes from a profile lookup to a static route. Same assertion, different setup: create a grab profile (now with `rpc_path: null`), POST to `/grab/<slug>/rpc`, assert the refusal string. Without this test the path silently starts serving `index.html`.
- `test/web-profile-testids.test.js:163-173` — three source-shape assertions on `grabRpcPathForName` / `rpcPathForType` / `syncDerivedRpcPath`. Two of those functions are deleted; rewrite to assert the *absence* of a derived grab path and that the wizard omits the field.
- `test/web-util.test.js:377-415` — `rpcPathForType` for the grab preset; assert `null`.
- `test/download-metrics.test.js:266`, `test/transmission-rpc.test.js:1104, 1192, 1205, 1265, 1275` — `download_dir:` inputs to a column that no longer exists. `upsertDownload` should **throw on unknown keys**? No — that would be a behaviour change of its own. Just delete the keys, and note in the commit that the store silently ignores them as it always has.

**New tests outside the migration file:**

- `service.addTorrent` refuses a second profile's add of an already-owned put.io transfer, naming the owner (D4).
- `service.addTorrent` refuses an add whose put.io response has no transfer id (D2).
- `DELETE /api/download-profiles/:id` reassigns RR profiles to the default and succeeds (regression for the RESTRICT inversion) — and refuses to delete the default itself, as today.
- `POST /api/profiles` with `type: 'grab'` and no `rpc_path` succeeds; with an *arr type and no `rpc_path` still fails (`server.js:1467`).

**Coverage gate.** `pnpm test:coverage` enforces 90% lines over `src/**`. Deleting the ownerless branches removes covered lines; adding a migration adds a lot of lines that only the new fixtures reach. Run the gate at task 3 and task 7, not just at the end.

---

## 6. Risk register

Ranked by expected damage.

**R1 — Data loss during the collapse (highest).**
*Failure mode:* a mapping bug, or a `WHERE` clause that silently matches nothing, drops rows the user still needed. Unlike a crash, this commits.
*Mitigations:* (a) `VACUUM INTO` backup before the transaction, never auto-deleted, path logged (§2.4); (b) the migration touches no files on disk, ever — every "dropped" row leaves its downloads where they are; (c) every drop is counted and recorded in `downloads_schema_v1_report` **and** logged with the profile name and local path; (d) F2/F3/F4/F5/F7 assert both what survives and what is recorded; (e) run the migration once against a copy of a real NAS database before the release (`ssh nas`, copy the state file, run `node -e "new StateStore('/tmp/copy.sqlite')"`, diff the row counts). **I am not confident the fixtures alone are sufficient** — a real database is the only place the odd shapes live. Treat the NAS dry-run as a required step of task 3, not a nice-to-have.

**R2 — A half-migrated database.**
*Failure mode:* the process is killed (a NAS reboot, an OOM) mid-migration and the next boot sees a DB that is neither shape.
*Mitigations:* the collapse, the `foreign_key_check`, and both settings writes are in one transaction, so SQLite gives exactly two outcomes; the guard key can never be set without the work. F9 proves it by injecting a throw. The one hole is the `VACUUM INTO`, which runs before `BEGIN` — a kill there leaves a stray `.bak` and nothing else. *Residual risk:* the two migrations (`downloads_schema_v1`, `profiles_schema_v2`) are separate transactions, so a kill between them leaves the downloads collapsed but `profiles` unrebuilt. That state is *consistent* and the next boot finishes the job — but the running process in between would have `downloads.profile_id NOT NULL` pointing at a `profiles` table whose `download_profile_id` is still nullable. Harmless, and worth a comment saying so rather than merging them into one giant transaction.

**R3 — `NOT NULL` fails on real data.**
*Failure mode:* `downloads.profile_id`, `downloads.putio_transfer_id` or `profiles.download_profile_id` rejects a row the migration tried to insert, aborting the upgrade; putiorr fails to start.
*Mitigations:* every `NOT NULL` column is filtered *before* the insert, not caught after — nulls are routed to the report and dropped (§2.3 step 3), so the constraint can only fire on a bug. `profiles.download_profile_id` is backfilled before the rebuild, and the default is created if the table is empty (§2.5). The failure mode is loud and non-destructive (rollback), which is the right trade: a putiorr that will not start is recoverable; one that started on a mangled DB is not. *Residual risk:* a `.bak` file plus a failed boot is a bad Sunday for a NAS user. The error message must name the backup path and the exact row that failed.

**R4 — Id renumbering breaks the Transmission ids the *arr apps hold.**
*Failure mode:* Sonarr stores the id returned by `torrent-add` and polls `torrent-get` with it forever. If the collapse renumbers, every in-flight grab becomes invisible: the *arr never imports it, and re-grabs it on the next RSS cycle.
*Mitigations:* `downloads.id` is copied from `transfer_associations.id` explicitly, never generated (`INSERT INTO downloads (id, …)`). The chain preserves ids end to end because `migrateTransferAssociations` already copies `transfers.id` into both `id` and `transfer_id` (`store.js:384-385`). `AUTOINCREMENT` follows the copied maximum (probe (d)), so new downloads cannot collide with an id an *arr is still holding. F2 and F3 assert specific known ids survive. *Residual risk:* a download whose association is **dropped** (multi-association loser, null put.io id, ownerless) takes its id with it, and the *arr holding that id gets an empty `torrent-get`. That is unavoidable under rule 1 and is exactly what the report is for — the release note must tell users to check the dropped list against their *arr queues.

**R5 — WAL and transaction concerns.**
*Failure mode:* `PRAGMA foreign_keys = OFF` silently doing nothing (probe (b)); a `DROP TABLE` cascading through live data (probe (a)); a checkpoint interacting with the DDL.
*Mitigations:* the pragma toggle brackets the transaction and is in a `try/finally` so it is restored even on a throw — leaving foreign keys off for the process lifetime would turn `ON DELETE RESTRICT` into decoration and re-open the exact hole this phase closes. Add an assertion after `migrate()` that `PRAGMA foreign_keys` reads `1`. The drop order in §2.3 step 6 is dependency-first regardless. WAL itself needs no special handling — the transaction is atomic across the DDL, and putiorr is single-process (`main.js`), so there is no second writer. *Unverified:* whether a WAL checkpoint can interleave with a DDL-heavy transaction on a slow NAS filesystem in a way that matters. I believe it cannot (the write lock is held for the whole transaction), but the NAS dry-run in R1 is where this would show up.

**R6 — `ON DELETE RESTRICT` breaking working endpoints.**
*Failure mode:* `DELETE /api/download-profiles/:id` starts throwing `FOREIGN KEY constraint failed` because the current code deletes first and reassigns after (`server.js:740-743`). Likewise any future code that deletes a profile.
*Mitigation:* §3.2's `deleteDownloadProfile(id, { reassignTo })`, with a test. This one is easy to miss because no existing test deletes a download profile that is actually in use — write that test first.

**R7 — The derived `/grab/<slug>/rpc` becomes a 200 OK HTML page.**
*Failure mode:* after `rpc_path` is nulled, an *arr still pointed at that endpoint falls through to `serveWeb`, which serves `index.html` with HTTP 200 for any unknown path (`server.js:880-886`). The *arr sees "success" and garbage.
*Mitigation:* the static `/^\/grab\/[^/]+\/rpc$/` guard (§4), plus the rewritten test at `transmission-rpc.test.js:2507`.

**R8 — Downgrade.**
*Failure mode:* a user rolls back to 2.0.x against a migrated DB. The old code runs `CREATE TABLE IF NOT EXISTS transfers`, finds it empty, and shows zero downloads; anything it then adds lands in tables the new version ignores forever.
*Mitigation:* documentation only — the release notes name the backup file and say rollback requires restoring it. Optionally, on boot, warn loudly if `transfer_associations` exists while `downloads_schema_v1` is set (rows written by an older putiorr are being ignored). Cheap; recommended.

**R9 — The upsert refusal (D4) fires on a path we did not expect.**
*Failure mode:* `upsertDownload` throws "already belongs to RR profile X" during the poll, and one row stops the tick. Phase 1 wrapped `refreshRemoteTransfer` in a per-row try/catch (`service.js:310-321`), so the blast radius is one row and a warn line — but a *permanently* failing row warns on every tick forever.
*Mitigation:* the poll path passes the row's own `profile_id` back (`service.js:339`), so it cannot trip. Assert that with a test that polls a download twice and checks no warn is logged.

---

## 7. Commit sequence

Seven commits, each with the full suite green. Tasks 3 and 4 are deliberately split into "semantics" and "names" so the review of the risky one is not buried in 600 lines of find-and-replace.

---

### Task 1: Guard the legacy migrations and add the fixture harness

**Files:** `src/state/store.js`; new `test/state-migration.test.js`

- [ ] **Step 1:** Write `test/state-migration.test.js` with the `writeLegacyDb` helper and fixtures **F1** (fresh) and **F2** (association-era) asserting only today's behaviour — legacy tables present, ids as they are. These pass now and become the before/after anchor.
- [ ] **Step 2:** Add `hasTable(name)` to `StateStore` and gate `migrateTransferAssociations`, `migrateMagnetTransferHashes`, and the `transfers`/`transfer_files` `ensureColumn` calls (`store.js:364-369`) on it.
- [ ] **Step 3:** Full suite + lint.
- [ ] **Step 4:** Commit — `Guard the legacy transfer migrations behind a table check (#67)`.

### Task 2: Stop the association migration guessing an owner

**Files:** `src/state/store.js:377-403`; `test/state-migration.test.js`

- [ ] **Step 1:** Add fixture **F3** (pre-association DB) asserting that a `profile_id IS NULL` transfer does **not** come out owned by the first profile.
- [ ] **Step 2:** Replace the `COALESCE(...)` at `:386-389` with plain `profile_id`. Comment why, citing D1 and the audit's finding 2.
- [ ] **Step 3:** Suite + lint. Expect nothing else to move — this migration only runs on DBs that never ran it.
- [ ] **Step 4:** Commit — `Stop the association migration assigning a guessed owner (#67)`.

### Task 3: The collapse — `downloads` and `download_files`

**Files:** `src/state/store.js`, `src/transfer/service.js`, `src/download/manager.js`; `test/state-migration.test.js`, `test/state-store.test.js`, `test/download-metrics.test.js`, `test/download-resume.test.js`, `test/prowlarr-cleanup.test.js`, `test/transmission-rpc.test.js`

The big one. Method names stay as they are (`createOrUpdateTransfer`, `findTransferById`, …) so this diff is purely about semantics; task 4 renames.

- [ ] **Step 1:** Write fixtures **F4–F9** and **F11**. Watch them fail.
- [ ] **Step 2:** Add the `downloads` / `download_files` DDL (§1.1, §1.2) to the `CREATE TABLE IF NOT EXISTS` block and **remove** `transfers`, `transfer_files`, `transfer_associations`, `association_files` from it.
- [ ] **Step 3:** Implement `backupBeforeCollapse()` and `migrateDownloadsCollapse()` per §2.3.
- [ ] **Step 4:** Rewrite the store's download and file API onto the single table (§3): delete `transferSelect`, the `remote*` finders, `findTransferAssociation`, `listTransfersForRemote`, `hasOtherActiveAssociations`, `allActiveAssociationsProcessed`, `deleteRemoteTransfer*`; fold the two-step upsert into one; key it on `putio_transfer_id` (D2, D3, D4); retarget `deleteProfile`'s pre-check.
- [ ] **Step 5:** Update `service.js` and `manager.js` per §4 — every `remote_id` read, every collapsed predicate. Do **not** touch the ownerless surface yet (task 7).
- [ ] **Step 6:** Mechanically fix the test files' `transfer_id:` → `download_id:` and drop `download_dir:`.
- [ ] **Step 7:** Suite + lint + `pnpm test:coverage`.
- [ ] **Step 8:** **Dry-run against a copy of the real NAS database** (R1). Record the report JSON in the commit message.
- [ ] **Step 9:** Commit — `Collapse transfers and associations into one downloads table (#67)`.

### Task 4: Rename transfer → download across the store and its callers

**Files:** `src/state/store.js`, `src/transfer/service.js`, `src/download/manager.js`, `src/download/policy.js`, and every test that names a store method

- [ ] **Step 1:** Apply the rename table in §3.2. No behaviour changes; the diff should be reviewable by reading the table.
- [ ] **Step 2:** `listPendingFiles`' aliases become `download_name`/`download_hash`; fix `manager.js:400`.
- [ ] **Step 3:** Suite + lint. Grep for `Transfer` in `src/state/` and `src/download/` to catch stragglers.
- [ ] **Step 4:** Commit — `Rename the store's transfer API to downloads (#67)`.

### Task 5: Rebuild `profiles`

**Files:** `src/state/store.js`, `src/main.js`, `src/transmission/server.js:732-746`; `test/state-migration.test.js`, `test/state-store.test.js`

- [ ] **Step 1:** Write fixture **F6** (both variants) and **F10**, plus the download-profile-delete regression test (R6). Watch them fail.
- [ ] **Step 2:** `StateStore(filePath, { config })`; thread it from `main.js:12`.
- [ ] **Step 3:** Implement `migrateProfilesSchema()` per §2.5, including the `PRAGMA foreign_key_check` read-and-throw.
- [ ] **Step 4:** Update the `CREATE TABLE IF NOT EXISTS profiles` block to §1.3 and add the partial unique index.
- [ ] **Step 5:** `createProfile` defaults `download_profile_id`; `deleteDownloadProfile(id, { reassignTo })`; the endpoint reassigns first; `assignMissingProfileDownloadProfiles` is deleted from the public API.
- [ ] **Step 6:** Suite + lint. Assert `PRAGMA foreign_keys` is back to `1` after `migrate()`.
- [ ] **Step 7:** Commit — `Make a profile's download profile mandatory and its RPC path optional (#67)`.

### Task 6: Retire the derived grab RPC path

**Files:** `src/transmission/server.js`, `src/web/profiles.js`; `test/transmission-rpc.test.js`, `test/web-profile-testids.test.js`, `test/web-util.test.js`, `test/api-grab.test.js`

- [ ] **Step 1:** Rewrite `transmission-rpc.test.js:2507` against the static route, and the three web source-shape assertions.
- [ ] **Step 2:** Replace `refuseGrabProfileRpc` with the static `/^\/grab\/[^/]+\/rpc$/` guard (R7).
- [ ] **Step 3:** `normalizeProfileInput` accepts a null `rpc_path` and stops requiring it for grab profiles.
- [ ] **Step 4:** Delete `grabRpcPathForName` and `syncDerivedRpcPath`; `rpcPathForType` returns `null` for grab; the wizard sends `null` and stops validating the field for grab; the card fact reads "Not used".
- [ ] **Step 5:** Suite + lint.
- [ ] **Step 6:** Commit — `Stop deriving a Transmission RPC path for grab profiles (#67)`.

### Task 7: Delete the unreachable ownerless surface, surface the migration report

**Files:** `src/transfer/service.js`, `src/download/manager.js`, `src/transmission/server.js` (settings response); `test/download-metrics.test.js`, `test/state-store.test.js`

- [ ] **Step 1:** Delete `ownerlessDownloadMessage`, the `ownerError` branch in `listDownloads` (`:753-757`, `:788-794`, `:808`), `warnOwnerlessDownload`, and the two sweep skips (D5). Keep `requireTransferProfile` as a defensive assert with a rewritten comment.
- [ ] **Step 2:** Delete the four phase-2 ownerless tests; add the one test that `upsertDownload` refuses a download with no profile. Say so explicitly in the commit message.
- [ ] **Step 3:** Surface the migration reports: add `schemaMigrations: { downloads, profiles }` to `GET /api/settings` (reading the two report settings keys) so the dashboard *can* show what an upgrade dropped, even if rendering it is phase 5's job.
- [ ] **Step 4:** Add the R8 downgrade warning on boot if `transfer_associations` exists with the guard key set.
- [ ] **Step 5:** Update the design doc's third breaking-change bullet (D5) and add the phase-3 entries to the changelog draft: the dropped-row report, the backup file, the removed `/grab/<slug>/rpc`, the mandatory download profile.
- [ ] **Step 6:** Full suite + lint + `pnpm test:coverage`.
- [ ] **Step 7:** Commit — `Delete the ownerless download state the schema now forbids (#67)`.

---

## 8. What I am not sure about

- **Whether the fixtures cover the real database's shapes.** They cover the shapes I can read out of the migration history in `store.js`. A database that has been through every release since the first one may carry a combination none of them produce. The only way to find out is the NAS dry-run in task 3 step 8, and it should happen before task 5 rather than after.
- **Whether `hash` should stay `NOT NULL DEFAULT ''` (D3).** It keeps every consumer null-free, but it also means "no hash yet" and "hash is the empty string" are the same value — which phase 4's "corrected on any later refresh that reports a different one" rule has to live with. If phase 4 wants to distinguish them, it should make the column nullable then, when it is also rewriting every hash consumer.
- **Whether the D4 refusal is right for `/api/grab`.** Two *arr apps grabbing one infohash is rare; a user grabbing the same magnet twice from the browser is not. The refusal will be the first thing they see, and "already belongs to RR profile X" is only helpful if the dashboard shows them where X is. Worth checking with the owner whether a browser grab of an already-owned transfer should instead return the existing download's id with an `alreadyGrabbed: true` flag.
- **Whether merging the two migrations into one transaction is worth it (R2 residual).** I have left them separate because one transaction that drops four tables *and* rebuilds a fifth is harder to reason about and harder to test in isolation. If the owner would rather have a single atomic upgrade, F9's injected-throw test should be extended to cover a failure in the second half.
agentId: acff353da9b51be6f (use SendMessage with to: 'acff353da9b51be6f', summary: '<5-10 word recap>' to continue this agent)
<usage>subagent_tokens: 212352
tool_uses: 36
duration_ms: 922888</usage>