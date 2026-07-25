# Download Ownership Model — Audit And Remediation Plan

Audit of how a download is linked to a profile, to its put.io transfer, and to
its local files. Commissioned because the intended model is simple and the
code was suspected of diverging from it.

Audited at `feat/putiorr-grab-preset` (tip of the #59 → #62 → #64 stack).
Every finding below was reproduced against a live server or a real store, not
inferred from reading.

## The intended model

Something arrives → it is matched to exactly one profile → a download item is
created and linked to that profile by relationship. Two front doors:

- **Transmission RPC** (*arr apps) — the established mechanism: the unique RPC
  path identifies the profile.
- **`POST /api/grab`** (browser extension) — the page's site is matched
  against the browser sites configured on Putiorr Grab profiles.

A separate, existing mechanism links the item to its put.io transfer and
files.

Decisions taken by the project owner during this audit:

1. **One profile per download.** put.io rejects duplicates, so the same
   download cannot legitimately belong to two profiles.
2. **The link is frozen at creation.** Later edits to sites, categories, or
   RPC paths never move an existing download.
3. **Deleting a profile prompts the user**, with two checkboxes: delete the
   linked active items on put.io, and delete the downloaded files from disk.

## Verdict

The storage layer can express the model. Everything above it decides ownership
a different way per door, and several of those ways are guesses.

There are **15 distinct representations of "which profile owns this"**, 11 of
which are read as authoritative somewhere. Only two of them — the RPC path and
the browser-site match — are the intended mechanisms.

The three-PR stack is not the cause. It extended an inference layer that was
already there, and added exemptions to it rather than removing it.

## Critical findings

### 1. A spoofable header can delete another profile's put.io transfer

`torrent-remove` on the shared endpoint resolves the profile from the
`User-Agent` (`src/transmission/server.js:466-469` → `:1137`). Reproduced: the
same request with `User-Agent: Deluge/2.0` is refused, and with
`User-Agent: Sonarr/5.0` succeeds and cancels the shared transfer on put.io.
RPC auth is off by default, so any client on the LAN can do this.

### 2. `getDefaultProfile()` silently re-owns downloads

`findProfileById(transfer.profile_id) ?? getDefaultProfile()` appears at nine
call sites that compute a filesystem path (`src/transfer/service.js:459, 492,
568, 676, 755`; `src/download/manager.js:201, 245, 290, 384`).
`getDefaultProfile()` is slug `default`, else `listProfiles()[0]` — row order.
It is not type-filtered, so a Putiorr Grab profile can become the fallback
owner of an *arr download; reproduced, files stage into the grab profile's
folder with no error and no log line.

Worse, the same rule *writes* ownership in two places:
`assignMissingTransferProfiles()` (`src/state/store.js:572-580`), which runs on
**every boot** and hands every null-owner association to the first profile, and
the one-shot migration `COALESCE` (`:386-389`).

This directly violates decision 2 (frozen link) and is the finding most likely
to lose files quietly.

### 3. Adding a second *arr profile breaks the first one

The shared endpoint stops resolving by path once more than one *arr profile
exists (`src/transmission/server.js:440-443`), even for the profile that
literally owns `rpc_path = '/transmission/rpc'` — which is what every fresh
install seeds. Reproduced: a working Sonarr add starts failing with
`No enabled RR profile matches download-dir category (none)` the moment a
Radarr profile is created, while `session-get` on the same connection still
advertises the download dir it just refused.

### 4. Category and User-Agent select the profile

On the shared endpoint the profile is chosen by matching the first segment of
the download-dir category against the profile's **slug, type, or name**
(`src/transfer/service.js:159-164, 215-238`), with the User-Agent as a veto —
and, for anything claiming to be Prowlarr, as the selector
(`:240-245`, reproduced with a spoofed agent). Issue #50 lists both as
non-goals. They are, however, currently documented as the design in
`README.md:309-313` and `docs/configuration.html:61-63`, and pinned by tests.

### 5. `torrent-get` on the shared endpoint is not scoped

With no resolved profile, the profile filter is skipped
(`src/transfer/service.js:427, 439` → `src/state/store.js:1082-1088`).
Reproduced: an unrecognised User-Agent returns **every** profile's downloads,
each reporting another profile's `downloadDir`. Add, get, and remove use three
different resolution rules on the same endpoint.

### 6. Grab profiles are reachable over Transmission RPC

`server.js:443` looks the path up without a type filter, so the derived
`/grab/<slug>/rpc` accepts *arr `torrent-add` (reproduced). The code comment
at `src/transfer/service.js:139-146` claims the opposite, and so do the docs.
The derived path exists only to satisfy `rpc_path NOT NULL UNIQUE` — a
database constraint being paid for with a live, guessable endpoint.

### 7. The put.io link is keyed on the hash, not the put.io id

`createOrUpdateTransfer` resolves by hash first (`src/state/store.js:787-788`).
Reproduced: re-adding a magnet whose remote transfer was replaced silently
re-points the row to a different `putio_transfer_id` and orphans the old one on
put.io. The mirror case throws `UNIQUE constraint failed` out of
`refreshRemoteTransfers`, which is not guarded per row — one bad row stops
polling, and therefore all downloads, on every tick.

`hash` is also write-once: a torrent upload whose put.io response carries no
hash gets 20 random bytes as its permanent identity.

### 8. Local paths are not unique per download

The destination is recomputed on every access as
`profile.download_at + association.category + transfers.name + relative_path`
(`src/download/manager.js:218-223, 386-391`). `transfers.name` is the put.io
transfer name, refreshed from put.io on every poll, and put.io does not
deduplicate transfer names.

Consequences, all reachable: a remote rename orphans in-flight files and then
trips the "local data disappeared" sweep into deleting the bucket *and* the
put.io transfer; two profiles sharing a download folder and category resolve to
the same directory, and `deleteLocalData` is an `rm -rf` on that shared path;
two workers can write the same `.part` file.

### 9. Recovery by folder is dead in the recommended configuration

Unknown put.io transfers are adopted by mapping `saveParentId` to a profile,
and skipped unless exactly one profile owns that folder
(`src/transfer/service.js:380-382`). Every profile defaults to the same put.io
folder (`putiorr`), which the README recommends — so in the documented setup
**nothing is ever adopted**, silently. `save_parent_id` is also last-writer-
wins across profiles, so the stored value can name a folder the transfer is not
in.

### 10. Remote cleanup runs while another profile still points at the transfer

`!hasOtherAssociations || allActiveAssociationsProcessed(...)`
(`src/transfer/service.js:454-457`) deletes the put.io file and transfer while
another association survives holding its `putio_file_id`. The follow-on 404
propagates out of `pollOnce` and aborts the whole cycle.

## Structural findings

- **Shadow ownership columns.** `transfers.profile_id`, `.category`,
  `.download_dir`, `.lifecycle` and the progress columns are written on insert
  and **never updated or read** (`src/state/store.js:255, 263-264, 802,
  810-811`), while `idx_transfers_profile_id` indexes one of them. Anyone
  querying the database gets the wrong owner. The `transfer_files` table is
  created on every fresh DB, holds zero rows forever, and carries a global
  `putio_file_id UNIQUE` that contradicts the association model.
- **Naming landmine.** `association_files.transfer_id` references
  `transfer_associations(id)`, and `transferSelect` aliases `a.id → id`,
  `a.transfer_id → remote_id`. On upgraded DBs the two ids coincide, so the
  confusion is invisible until a fresh install.
- **`complete` is sticky.** A file row never leaves `complete`
  (`src/state/store.js:1214-1217`), and `prepareTransfer` only consults the
  disk on insert — so re-adding a release whose local files were deleted
  finalises immediately and downloads nothing.
- **A disabled profile means four different things** depending on the door:
  HTML dashboard with HTTP 200 (RPC), 400 "RR profile X is disabled" (explicit
  grab), invisible-and-fall-through (site match), or not scanned (adoption).
  Its downloads keep downloading regardless.
- **Ambiguity policy is inconsistent.** Two profiles claiming one category is a
  hard refusal; two grab profiles claiming one site is a silent lowest-id win.
- **The grab preset's auto-remove default lives only in the browser**
  (`src/web/constants.js:35`), so profiles created via the API or
  `PUTIORR_PROFILES_JSON` never get it, contradicting four documents.

## Target model

One authoritative owner, resolved once, from an authoritative signal:

```text
ingress                        →  owner (exactly one, frozen)
──────────────────────────────────────────────────────────────
RPC on a profile's unique path →  that profile
RPC on the shared path         →  the single *arr profile, else a hard error
                                  naming the path to use
POST /api/grab, explicit pick  →  that grab profile
POST /api/grab, site match     →  the grab profile claiming the page host
POST /api/grab, otherwise      →  the configured default grab profile, else a
                                  hard error
```

Nothing else may select an owner. Category becomes a pure output, computed
once after the owner is known, and used only for the staging subdirectory.

Everything else follows: `profile_id` becomes `NOT NULL` with a restricting
foreign key, `getDefaultProfile()` is deleted, the put.io link is keyed on
put.io's ids with the hash as a secondary lookup and a conflict as an error,
and the local path gets a component that is unique per download.

## Remediation plan

Phased so each phase is independently shippable and testable. Phase 1 is
security-and-data-loss; the rest is the model.

### Phase 1 — stop the bleeding

1. Remove `User-Agent` as a selector and a veto: `torrent-remove` and
   `torrent-get` on the shared endpoint resolve by path only, and refuse
   rather than guess. Keep the refusal message actionable (name the profile's
   path).
2. Scope `torrent-get` to the resolved profile; never return all profiles.
3. Type-filter the RPC path lookup so a grab profile's derived path stops
   accepting *arr traffic.
4. Guard `refreshRemoteTransfers` per row so one bad row cannot stop polling.

### Phase 2 — one owner, frozen

5. Delete `getDefaultProfile()` and every `?? getDefaultProfile()` fallback;
   an item with no resolvable profile is an error surfaced in the UI, not a
   guess.
6. Delete `assignMissingTransferProfiles()`; make `profile_id` `NOT NULL`
   with `ON DELETE RESTRICT`, migrating existing null owners into an explicit
   "needs attention" state rather than silently assigning them.
7. Delete the inference layer: `profileMatchesCategory`,
   `findProfilesByCategory`, `findProfileByCategory`, `findProfileByUserAgent`,
   `validateCategoryLabels`, and the Prowlarr bypass. Category is computed
   after resolution, never before.
8. Make the shared endpoint a hard error above one *arr profile instead of
   degrading into inference.

### Phase 3 — honest ingress identity

9. Give grab profiles an ingress descriptor that is not a Transmission RPC
   path: make `rpc_path` nullable with a partial unique index, or move ingress
   into its own table keyed by kind. Delete the derived `/grab/<slug>/rpc`.

### Phase 4 — the put.io and disk links

10. Key the upsert on `putio_transfer_id`, hash second; a disagreement between
    them is an error, not a merge. Allow the hash to be corrected once put.io
    reports the real one.
11. Give the local path a component unique to the download so two profiles
    cannot collide, and stop rooting it on the remote-mutable transfer name.
    Verify `deleteLocalData` can only remove a path owned by exactly one item.
12. Re-key adoption on something that survives a shared put.io folder, or
    accept that adoption requires per-profile folders and say so loudly
    (log + dashboard notice) instead of skipping in silence.
13. Fix remote cleanup to run only when no association depends on the
    transfer, and reap stale `association_files`.

### Phase 5 — schema honesty and lifecycle

14. Drop the shadow columns, the dead index, and the `transfer_files` table;
    rename `association_files.transfer_id` to `association_id`.
15. Implement the profile-delete prompt (delete active put.io items / delete
    downloaded files) per decision 3.
16. Unstick `complete` so re-adding after a local delete downloads again.
17. Make a disabled profile mean one thing everywhere.
18. Move the grab auto-remove default server-side so API and seed paths get
    it.

### Phase 6 — documentation and tests

19. Rewrite the parts of `README.md`, `docs/configuration.html`, and
    `extension/README.md` that document category/User-Agent routing as the
    design, and mark the superseded superpowers specs.
20. Replace the tests that pin the non-goals as regression contracts —
    notably `test/transmission-rpc.test.js`'s category-routing and
    User-Agent-driven multi-profile tests.

## Open decision

put.io deduplicates, so when a second profile grabs a release the first
profile already owns, putiorr gets the same transfer back. With one owner per
download, the second request needs an answer. The recommendation is to refuse
it and name the owning profile, which is honest and rare in practice (two
apps grabbing the same infohash is unusual). The alternative — letting the
second app silently share the first's item — reintroduces the multi-owner
model that decision 1 removed.

## Scope note

This is not a storage rewrite. The association schema is the part that already
matches the intent. What needs deleting is the layer above it: four
independent resolution functions and eleven authoritative ownership signals,
where the model calls for one of each.
