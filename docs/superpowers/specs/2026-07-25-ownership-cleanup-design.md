# Ownership Cleanup Design

Follow-up to the ownership audit (`2026-07-25-ownership-model-audit.md`,
issue #66). The audit found 15 representations of "which profile owns this",
11 read as authoritative. This design collapses them to one.

## The rules

Given by the project owner, and non-negotiable:

1. **One download item belongs to one profile.**
2. **One profile has one download profile.**
3. **One put.io transfer/download belongs to one download item.** put.io
   rejects duplicates, so put.io's own generated ids are the identity.

Two rules carried over from the audit:

4. The owner is resolved once, at ingestion, and frozen.
5. Deleting a profile prompts the user: delete the linked active put.io
   items, and/or delete the downloaded files from disk.

## Consequences

Rule 1 plus rule 3 means the split between `transfers` (remote identity) and
`transfer_associations` (per-profile item) has nothing left to express. They
collapse into one table.

Rule 3 means **put.io's transfer id is the primary key of a download's
identity**, not the infohash. The hash becomes informational: recorded when
known, correctable when put.io later reports it, never unique, never used to
resolve a row.

Rule 2 means `profiles.download_profile_id` becomes `NOT NULL`.

Rule 4 means every fallback that guesses an owner is deleted, not fixed.

## Target schema

```sql
profiles
  id                    INTEGER PK
  name, type, slug      slug UNIQUE
  download_profile_id   INTEGER NOT NULL REFERENCES download_profiles(id)
                        ON DELETE RESTRICT          -- rule 2
  rpc_path              TEXT NULL                   -- *arr ingress only
                        UNIQUE INDEX WHERE rpc_path IS NOT NULL
  browser_domains       TEXT                        -- grab ingress only
  putio_folder_name, putio_folder_id
  download_at, auto_remove_completed, enabled
  created_at, updated_at

downloads                                           -- was transfers + transfer_associations
  id                    INTEGER PK
  profile_id            INTEGER NOT NULL REFERENCES profiles(id)
                        ON DELETE RESTRICT          -- rules 1 and 4
  putio_transfer_id     INTEGER NOT NULL UNIQUE     -- rule 3: put.io owns identity
  putio_file_id         INTEGER                     -- root result file/folder
  save_parent_id        INTEGER                     -- the folder put.io placed it in
  hash                  TEXT                        -- informational, NOT unique, correctable
  name, source, source_type
  category              TEXT NOT NULL DEFAULT ''    -- output of resolution, never an input
  lifecycle             TEXT NOT NULL DEFAULT 'remote'
  putio_status, putio_status_message, percent_done, total_size, …
  downloaded_ever, download_speed, eta, error, error_string, retry_count
  removed_at            TEXT NULL
  created_at, updated_at

download_files                                      -- was association_files
  id                    INTEGER PK
  download_id           INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE
  putio_file_id         INTEGER NOT NULL
  UNIQUE(download_id, putio_file_id)
  relative_path, size, downloaded_bytes, download_speed, status, attempts, error_string
```

Deleted outright: the `transfers`/`transfer_associations` split, every shadow
column (`transfers.profile_id`, `.category`, `.download_dir`, `.lifecycle` and
the frozen progress columns), `idx_transfers_profile_id`,
`transfer_associations.download_dir` (written, never read), and the
`transfer_files` table (created on every fresh DB, always empty).

Renamed so the schema stops lying: `association_files.transfer_id` →
`download_files.download_id`.

## Ownership resolution — the only mechanism

```text
ingress                          →  owner
─────────────────────────────────────────────────────────────────────
RPC on a profile's unique path   →  that profile
RPC on the shared path           →  the single *arr profile, else refuse
                                    with the path to use
/api/grab, explicit pick         →  that grab profile
/api/grab, site match            →  the grab profile claiming the page host
/api/grab, no match              →  the configured default grab profile,
                                    else refuse
```

Deleted: `profileMatchesCategory`, `findProfilesByCategory`,
`findProfileByCategory`, `findProfileByUserAgent`, `validateCategoryLabels`,
the Prowlarr User-Agent bypass, `getDefaultProfile()` and all nine
`?? getDefaultProfile()` fallbacks, and `assignMissingTransferProfiles()`.

`category` is computed once, **after** the owner is known, from the requested
download-dir relative to that profile's folder. It never selects or vetoes.

A download whose profile cannot be resolved is refused at ingestion. There is
no state in which a stored download has no owner, so nothing needs to guess
one later.

## put.io linking

- Resolution is `findByPutioTransferId(id)`. The hash is never used to
  resolve a row.
- An add whose put.io response carries no transfer id is an error, not a row
  with a generated identity. This removes the random-20-byte fake hashes and
  the un-prunable `putio_transfer_id IS NULL` zombies.
- The hash is written when put.io reports it and corrected on any later
  refresh that reports a different one.
- Adoption of transfers putiorr did not create keeps working off
  `save_parent_id`, but when a folder maps to more than one profile it logs
  and surfaces a dashboard notice instead of skipping in silence.

## Local paths

The destination gains a component unique to the download so two profiles can
never resolve to the same directory:

```text
<profile.download_at>/<category>/<download.id>-<sanitised put.io name>/<relative_path>
```

The id prefix is what makes it collision-proof and rename-stable; the name is
kept for human legibility. `deleteLocalData` asserts the resolved path belongs
to exactly one download before removing anything.

## Profile deletion

`DELETE /api/profiles/:id` gains two flags, surfaced in the dashboard as
checkboxes:

- `deleteRemote` — cancel/delete the profile's active items on put.io.
- `deleteLocal` — delete the downloaded files from disk.

With `ON DELETE RESTRICT`, the delete is refused while downloads remain, so
the endpoint performs the requested cleanup first and reports what it did.
Neither flag defaults to true.

## Migration

Existing databases carry `transfers` + `transfer_associations`. The migration
is one-way and non-destructive on disk:

1. For each `transfers` row with a non-null `putio_transfer_id`, create one
   `downloads` row from the transfer's remote fields and the **oldest**
   association's owner, category, lifecycle and progress.
2. If a transfer has more than one association, keep the oldest and record
   the others in a `settings` key plus a warning log naming the profile and
   local path. Their files on disk are left untouched. (Rule 1 makes the
   extra associations unrepresentable; in practice the paths that create them
   are the ones the audit found already dead.)
3. Rows with `putio_transfer_id IS NULL` cannot be identified under rule 3 —
   record them the same way and drop the row; their files are left on disk.
4. `association_files` rows follow their surviving association into
   `download_files`.
5. Profiles with a null `download_profile_id` are assigned the default
   download profile before the `NOT NULL` constraint is applied.
6. Drop `transfers`, `transfer_associations`, `transfer_files`.

The migration runs once, guarded by a settings key, and logs a summary of
everything it dropped.

## What this does not change

The Transmission RPC surface (`torrent-add`/`get`/`remove`/`session-get`), the
`/api/grab` contract, the extension, the dashboard's shape, and the download
worker's behaviour. This is an ownership and identity cleanup; the product
surface stays put except where the audit found it lying (unscoped
`torrent-get`, User-Agent routing, grab profiles answering RPC).

## Delivery

Branch `refactor/download-ownership`, stacked on `feat/putiorr-grab-preset`.
Phased per the audit's plan, each phase independently shippable:

1. Stop the bleeding — User-Agent removed as selector and veto, `torrent-get`
   scoped, RPC path lookup type-filtered, poll loop guarded per row.
2. One frozen owner — delete the inference layer and every fallback.
3. Schema collapse + migration.
4. put.io identity keyed on put.io ids; local path made collision-proof.
5. Profile-delete prompt; lifecycle fixes (sticky `complete`, disabled
   profiles, grab auto-remove default server-side).
6. Docs and the tests that currently pin the deleted behaviour as contracts.

## Breaking changes to carry into the changelog

Phase 6 turns these into release notes. Each is a setup that works today and
stops working on upgrade, so each needs the fix spelled out.

- **Prowlarr on the shared endpoint with mapped categories.** The User-Agent
  bypass that let anything calling itself Prowlarr claim an add is gone
  (phase 1), and so is category routing (phase 2). Fix: point Prowlarr at its
  own RPC path, `/prowlarr/transmission/rpc`.
- **Any multi-profile setup where the *arr apps share `/transmission/rpc`.**
  The shared endpoint now serves exactly one *arr profile and refuses
  otherwise, naming each profile's path in the refusal. Fix: give each *arr
  its own RPC path, including the seeded profile that still holds the shared
  one. A single-profile install is unaffected.
- **Downloads with no owning profile no longer acquire one at boot.** They
  appear in the dashboard's **Needs attention** section rather than in the
  downloads list, and are skipped by the sweeps rather than being handed to
  whichever profile sorted first. Fix: assign each one to a profile, or delete
  it. Their files are untouched on disk either way.
- **The schema upgrade rewrites the database once, in place** (phase 3). Before
  it starts it writes `<state>.pre-downloads-<timestamp>.bak` next to the state
  file and logs the path. The backup is never deleted automatically and is safe
  to delete once the upgrade looks right; **restoring it is the only way to roll
  back to 2.0.x**, because the older version recreates the legacy tables and
  writes into storage the new version does not read.
  - Downloads the upgrade could not attach to a profile, could not identify (no
    put.io transfer id), or whose put.io transfer an older sibling already
    claimed, are moved to the Needs attention section. A machine-readable record
    of everything it did is kept in the `downloads_schema_v1_report` and
    `profiles_schema_v2_report` settings keys and returned by
    `GET /api/settings` as `schemaMigrations`. Check the list against the *arr
    queues: an *arr holding the Transmission id of a quarantined download gets
    an empty `torrent-get` until it is reassigned. Reassigning gives the
    download its original Transmission id back, so the *arr's queue item
    recovers — unless something has taken that id in the meantime, in which case
    the *arr re-grabs on its next RSS cycle.
- **Downloaded files move into a folder per download** (phase 4). Staging is
  `<download_at>/<category>/<download.id>-<put.io name>/…` instead of
  `<download_at>/<category>/<put.io name>/…`. The first poll after the upgrade
  moves each download's existing files into its new folder and logs every move;
  anything it cannot move — no owner, both layouts populated, a failed rename —
  is named in the log and left untouched on disk, and the "local data
  disappeared" sweep keeps looking in both layouts so nothing is deleted over a
  move that did not happen. Fix for a folder left behind: move it by hand, or
  delete the copy you do not want.
- **`torrent-get` reports the staging folder as the torrent name** (phase 4).
  Every *arr resolves a download's files as `downloadDir + name`, so the name
  has to be the folder the files are in — `17-Example.Release`, not
  `Example.Release`. Queues show the prefixed name. Nothing needs fixing; a
  download grabbed before the upgrade keeps its id, so its folder and its
  reported name change together.
- **Putiorr Grab profiles lose their `/grab/<slug>/rpc` endpoint.** It only
  existed because `profiles.rpc_path` was `NOT NULL UNIQUE`, and it doubled as a
  live Transmission endpoint. The path now answers every request with a refusal.
  Fix: nothing — grab profiles are reached through the browser extension.
- **`GET /api/downloads` answers `{ downloads, orphaned }` instead of a bare
  array.** The quarantine is a separate list so the dashboard can render it as
  its own needs-attention section rather than interleaving rows that need a
  decision with rows that are making progress. The WebSocket downloads payload
  carries the same two arrays. Anything scripted against the old shape needs
  `.downloads`.
- **Every RR profile must have a download profile.** The upgrade assigns the
  default to any profile that had none, and a download profile that is in use
  can no longer be deleted without reassigning the profiles that reference it —
  which `DELETE /api/download-profiles/:id` now does automatically, to the
  default.
