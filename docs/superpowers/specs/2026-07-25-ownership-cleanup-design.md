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

Ruled by the project owner during phase 4, overriding an earlier draft of this
section that prefixed the download id onto the folder name: **"no id no
nothing. As it was. Exactly as it was downloaded."**

```text
<profile.download_at>/<category>/<put.io name>/<relative_path>
```

The name is the one put.io reports, untouched, and `torrent-get` reports that
same name. The two are one decision, not two: every *arr resolves a completed
download as `downloadDir + name` (Sonarr's `TransmissionBase.GetOutputPath`,
which Radarr and Lidarr share), so a folder spelled differently from the
reported name is a download that never imports. Nothing rewrites the name on
the way to the path: only `/` separates, nothing is trimmed, and a name whose
segment does not fit in a filesystem's 255 bytes is refused on the download
rather than truncated into a folder the *arr cannot compute.

**The folder is frozen the first time the download is staged**, and recorded on
the row. This is the other half of audit finding 8: put.io renames transfers,
`name` follows the rename because that is what the user sees, and without a
frozen folder the next sweep looks for the files under the new name, finds
nothing, and reads that as the user having deleted them — deleting the download
and cancelling its put.io transfer, with the files left orphaned at the old
path and no remote copy to re-fetch. Freezing needs no id, moves nothing on
disk, and is the same rule ownership already follows: resolved once, at the
moment it first matters, and never re-derived. It is still "exactly as it was
downloaded" — the name at the time it was downloaded.

The collision this section once existed to prevent — two profiles staging one
release into one directory — is unrepresentable after phase 3: one put.io
transfer is one download of one profile, and a second profile grabbing an
already-owned release is refused. What remains is two *distinct* put.io
transfers with the same name under one profile and category. Those are not
interleaved: the second one to reach the downloader is refused, logged, and
surfaced in the dashboard, so no two downloads ever write the same `.part`.

`deleteLocalData` asserts the resolved path belongs to exactly one download
before removing anything — where a download claims its own folder, any folder
holding it (put.io names can spell nested paths) and any directory above it —
and refuses any path at or above a profile's staging root whatever the answer.
The assertion runs before the first irreversible step of a delete, not at the
last one, so a refusal never leaves a cancelled put.io transfer behind it.

One residual case is inherent rather than fixed: a quarantined row whose put.io
name happens to match a directory a user created inside a staging folder can
still have that directory deleted, because nothing distinguishes it from the
folder the row's own files went into. Quarantined rows are the only deletion
target putiorr did not compute itself, and the user is the one asking.

## Profile deletion

`DELETE /api/profiles/:id` gains two flags, surfaced in the dashboard as
checkboxes:

- `deleteRemote` — cancel/delete the profile's active items on put.io.
- `deleteLocal` — delete the downloaded files from disk.

With `ON DELETE RESTRICT`, the delete is refused while downloads remain, so
the endpoint performs the requested cleanup first and reports what it did.
Neither flag defaults to true.

Ruled by the project owner during phase 5: a third answer, **move these
downloads to another profile**, sits alongside the two flags. Moving and
deleting are different fates for the same row, so the endpoint takes one
intent — `reassignTo`, or `deleteDownloads` with its two flags — and refuses a
request carrying both. A profile that still owns downloads and was sent
neither is refused by count, naming both options, rather than having them
removed by implication.

The move target is restricted to profiles that stage into the same
`download_at`, and the refusal says why. Nothing moves on disk, and the path
is still `<download_at>/<category>/<frozen folder>`, so a target that stages
elsewhere points putiorr at an empty directory — and a finished download whose
files are missing is deleted and its put.io transfer cancelled. Freezing the
staging folder made a put.io *rename* safe; it says nothing about a change of
owner.

The download rows themselves always go, whatever the flags: `profile_id` is
`NOT NULL`, so there is no owner left to keep them under, and a tombstone
would only block the profile's deletion. put.io transfers the user chose to
keep surface in the adoption notice on the next poll, and the confirmation
says so before the user commits.

`GET /api/profiles/:id/deletion-preview` serves the counts the confirmation
states. It reads the database rather than the dashboard's list: tombstoned
downloads are not in that list and hold put.io transfers, hold files, and
block the delete like any other row. The local counts are measured off the
disk, not off the file rows: `deleteLocal` is `rm(recursive)` on the whole
staging folder, so it takes the `.part` of anything still running and whatever
else is in there, none of which putiorr has a row for. A folder it cannot read
is reported rather than dropped from the total.

## Disabled profiles

Ruled by the project owner during phase 5, resolving the audit's "a disabled
profile means four different things". **`enabled = 0` means the profile
accepts no new work. It is a refusal, never an absence.**

Routing resolves a disabled profile exactly like an enabled one: it still
holds its RPC path, still claims its browser sites, is still counted when the
shared endpoint asks how many \*arr profiles could have meant it, and still
owns its put.io folder. Whether it accepts work is asked once, where work is
created — `torrent-add`, `/api/grab` through all three of its resolution
paths, and the adoption of a transfer putiorr did not create — with one
sentence naming the profile.

It is not asked on `torrent-get`, `torrent-remove` or `session-get`: the
downloads already in the queue keep downloading and stay listable, importable
and removable. Refusing those stranded in-flight work and made an \*arr
re-grab everything it could no longer see.

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
- **A disabled RR profile now refuses instead of disappearing.** Its RPC path
  answers with a refusal naming it rather than the dashboard's HTML; it still
  claims its browser sites, so a grab from one is refused instead of falling
  through to the extension's default profile; and it is still counted when the
  shared endpoint decides whether it is ambiguous, so switching a profile off
  no longer hands that endpoint to another one. Its existing downloads are
  unaffected: they keep downloading and `torrent-get`/`torrent-remove` still
  work on them. Fix, for anyone who was using "disabled" to free up the shared
  endpoint or a site: delete the profile instead.
- **`DELETE /api/profiles/:id` no longer deletes a profile that owns
  downloads without being told what happens to them.** Send `reassignTo`, or
  `deleteDownloads: true` with the optional `deleteRemote` / `deleteLocal`
  flags. A profile that owns nothing still deletes with no body at all. A
  delete that stops part-way through answers 400 with the same `downloads`
  counts a success carries, naming what it had already cancelled on put.io and
  removed from disk.
- **The `rpc request failed` log names `profiles` where it named
  `enabledProfiles`,** and each entry carries `enabled`. Anything scraping that
  log line needs the new key; a disabled profile is one of the likelier reasons
  a request is in there at all, and the old shape left it out.
- **Profiles created through `POST /api/profiles` or `PUTIORR_PROFILES_JSON`
  with the Putiorr Grab preset now default to auto-removing completed
  downloads**, as the wizard and four documents already said they did. Send
  `auto_remove_completed: false` to keep the old behaviour.
- **Every RR profile must have a download profile.** The upgrade assigns the
  default to any profile that had none, and a download profile that is in use
  can no longer be deleted without reassigning the profiles that reference it —
  which `DELETE /api/download-profiles/:id` now does automatically, to the
  default.
