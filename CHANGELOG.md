# Changelog

All notable changes to putiorr are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and putiorr follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts at 3.0.0. Releases before it shipped without a changelog, and
their notes — GitHub's generated list of merged pull requests — remain on the
[releases page](https://github.com/ptheofan/putiorr/releases).

## [Unreleased]

### Added

- **Sonarr and Radarr profiles can reject a release put.io delivered as junk,
  before downloading it.** ([#111](https://github.com/ptheofan/putiorr/issues/111))
  When put.io finishes a transfer, putiorr already knows every filename and size
  in it — and until now it downloaded a passworded archive, a folder of `.exe`
  and `.txt`, or a release that arrived a fraction of its announced size just
  like any other. The import then failed and the queue item sat in Activity
  blocking that episode or movie until someone clicked blocklist by hand.

  Put an app URL and API key on a Sonarr or Radarr profile, tick **Reject
  releases put.io delivers with nothing importable**, and putiorr calls the
  app's queue API to blocklist the release and search again, then drops it from
  put.io. Nothing is ever staged or downloaded.

  This cannot be done over Transmission. putiorr already sets the torrent's
  `errorString`, and Sonarr maps that to a *warning*, never a failure — so
  Failed Download Handling never fires and the item stays in the queue. The
  blocklist only exists in the REST API, which is why it needs a key.

  **Off by default, and it stays off after upgrading.** Three things count as
  junk: nothing importable in the release at all, put.io delivering less than
  half the announced size, and an optional per-profile minimum size. The
  minimum is off by default on purpose — a half-hour SD episode is 150–250 MB
  and 720p anime runs 200–350 MB, so any figure safe for movies would silently
  blocklist a whole anime library.

  What counts as importable is decided by the preset, not by one list shared
  across all of them: on a Sonarr or Radarr profile a release of nothing but
  `.flac`, or a lone `.pdf`, is rejected too — importable to *some* app, and to
  these two exactly as useless as a folder of `.exe`. Within that, the rule is
  deliberately conservative: rar'd scene releases, `VIDEO_TS`/`BDMV` disc rips,
  and multipart archives all pass. A wrongly blocklisted release is invisible
  and permanent; a missed bad one costs the one manual click that happens today.

  Only Sonarr and Radarr — Lidarr and Readarr serve a different API version
  putiorr does not speak, so the step is not offered there. The API key is
  write-only over HTTP: `GET /api/profiles` reports only whether one is stored,
  never its value.

## [3.0.6] — 2026-07-27

### Changed

- **A put.io transfer putiorr cannot place is now ignored quietly.** The
  dashboard used to report it and tell you to give each RR profile its own
  put.io folder — advice that contradicted the recommended setup, where every
  profile shares one folder, and that asked for a whole put.io reorganisation
  over a single stray transfer. The notice, its stored state and its per-poll
  warning are gone.

  Nothing about what gets downloaded changed: a transfer whose folder maps to
  exactly one enabled profile is still adopted, and one that does not is still
  left alone on put.io — now without the noise. Set `PUTIORR_LOG_LEVEL=debug` if
  you ever need to ask why a particular transfer was skipped.

  Installs carrying the old notice have it cleared on first start.

## [3.0.5] — 2026-07-27

### Fixed

- **Sending a `.torrent` file to put.io always failed with a 401.** put.io serves
  uploads from a host of its own, `upload.put.io`, and putiorr posted them to
  the API host instead. Magnet links were never affected — they go to a
  different endpoint — so a working put.io connection would add magnets happily
  and reject every `.torrent`, reporting a credentials error against a token
  that was perfectly valid. Uploading metainfo had never worked by any route:
  not from the browser extension, and not from an *arr sending base64 metainfo
  over `torrent-add`.

  The 401 was hard to read because put.io answers a rejected token with the same
  sentence on every endpoint, so the message pointed at the credentials while
  the credentials were fine.

## [3.0.4] — 2026-07-27

### Security

- **Cross-site requests can no longer change putiorr's state.** Only
  `POST /api/grab` was protected; every other state-changing `/api` endpoint —
  settings, profiles, download profiles, starting and deleting downloads, the
  orphan routes, the OAuth routes and `POST /api/poll` — could be driven by any
  page the user happened to visit. No credentials were needed, because putiorr
  has none to steal: the attacker only needed the victim's browser to reach a
  putiorr on their network.

  A request is now refused when the browser reports it was started by another
  site. Nothing else changes: the dashboard, `curl` and scripts, the browser
  extension, and the *arr apps on the Transmission RPC endpoints are all
  unaffected, and reads are untouched. Refusals are logged with the path and
  method behind them.

  This is a mitigation, not a boundary. A caller that is not a browser is
  deliberately still allowed through — refusing those would break every
  scripted setup and would not stop the attack it is aimed at.

## [3.0.3] — 2026-07-27

### Fixed

- **Changing a profile's download folder no longer destroys its downloads.**
  Editing **Shared download folder** on a profile that owned downloads was
  accepted silently, and the next poll then read every one of them as
  user-deleted: it cancelled the put.io transfer, deleted the put.io file and
  removed the row, leaving the files orphaned on disk. A download's path is
  derived from its profile's current folder, so moving the folder pointed
  putiorr at a location the files were never in.

  The change is now refused while the profile owns downloads, naming how many
  and what to do instead — let them finish and leave putiorr, or delete them
  from the dashboard. Nothing is moved on disk. Saving a profile without
  touching the folder still works, and `/downloads` and `/downloads/` count as
  the same folder. The wizard offers to put the folder back so a refused value
  cannot sit in the form blocking every later save.

## [3.0.2] — 2026-07-27

### Changed

- **The database upgrade summary can now be dismissed.** `The last database
  upgrade migrated N downloads. Files on disk were not touched.` was written
  once and never cleared, so it stayed on the dashboard for the life of the
  database. It now carries a dismiss control, recorded on the server so it
  survives a reload, a restart and a different browser. The migration reports
  themselves are kept — they remain in `GET /api/settings` as the record of the
  run — and the dismissal is keyed to the upgrade it was read for, so a later
  migration shows its own summary again.

  The quarantine warning beside it has no dismiss control and never will: those
  downloads stay invisible until someone acts on them, so the panel stays up
  for the warning even once the summary is gone.

## [3.0.1] — 2026-07-26

### Fixed

- **Empty legacy tables no longer raise a data-loss alarm.** An install that had
  briefly run an older putiorr — which a stale `:latest` pull does — was told
  `An older putiorr has written 0 downloads into storage this version cannot
  read`, and pointed at restoring a `.pre-downloads-*.bak`. Nothing had been
  written and nothing was missing; following the advice would have discarded
  every download made since the upgrade. Starting an older putiorr is enough to
  recreate the tables the 3.0.0 migration dropped, so their presence was never
  evidence of anything. They are now dropped again on boot when they hold no
  rows, and the warning is raised only when rows really are stranded — in which
  case it names how many.

## [3.0.0] — 2026-07-26

A major release, because it changes how a download's owning profile is decided
and rewrites the database to enforce it. Existing setups need attention before
and after the upgrade; read the breaking changes first.

The short version: the category no longer picks a profile, ownership is decided
once when a download is created and never re-derived, and a browser extension
can now grab magnet links and `.torrent` files straight into putiorr.

### Breaking changes

- **The download-client category no longer selects a profile.** It names the
  staging subfolder under the owning profile's download folder, and nothing
  else — it cannot pick a profile and cannot veto one. If you used mapped
  categories to steer grabs from a single app into different putiorr profiles,
  that stops working: everything from that app now lands in the profile its
  request resolved to. Give each destination its own RPC path and point the app
  at the right one. If you used mapped categories the ordinary way — Prowlarr
  labelling releases — nothing changes, and the User-Agent bypass they used to
  need to get past the category check is gone with the check.

- **On a multi-profile install, the shared `/transmission/rpc` endpoint needs
  the caller to identify itself.** Sonarr, Radarr, Lidarr, Readarr and Prowlarr
  put their own name in the `User-Agent` and need no change. Anything else — a
  script, a generic Transmission client — resolves to no profile, and
  `torrent-add` and `torrent-remove` are refused with each profile's RPC path
  named in the refusal. The same applies to two profiles that answer to one
  name, such as a second Sonarr. **Action:** give that client the RPC path of
  the profile it means; the path always wins over the header. `session-get` and
  `torrent-get` still answer, so a connection test passes and existing
  downloads keep importing, but new grabs stop until the path is set.

- **The database is rewritten once, in place, on first start.** `transfers` and
  `transfer_associations` collapse into one `downloads` table, and
  `association_files` becomes `download_files`. The upgrade runs automatically
  in a single transaction, verifies foreign keys before committing, and rolls
  back and refuses to start if anything is wrong. It writes a
  `VACUUM INTO` backup — `<state-file>.pre-downloads-<timestamp>.bak`, beside
  the state file, logged with its path — before it touches anything, and never
  deletes it. **Files on disk are never touched by the upgrade.** **Action:**
  rehearse it on a copy of your database first, and keep the backup. Restoring
  that backup is the only way back to 2.0.x, because 2.0.x recreates the legacy
  tables and writes into storage 3.0.0 does not read.

- **Rows the upgrade cannot place are quarantined rather than guessed at.** A
  download with no owning profile, none identifying a put.io transfer, or a
  second association to a transfer an older sibling already owns, moves to a
  **Needs attention** list in the dashboard with a profile picker. Its files
  stay exactly where they are. On a database with exactly one profile,
  ownerless rows are adopted by it rather than quarantined. **Action:**
  reconcile that list against the *arr queues before adding new downloads — an
  *arr holding a quarantined download's Transmission id gets an empty
  `torrent-get` until it is reassigned. Reassigning restores the original
  Transmission id, so the queue item recovers. What the upgrade did is recorded
  in `GET /api/settings` under `schemaMigrations`.

- **Downloads with no owning profile are no longer adopted at boot.** The
  boot-time sweep that handed them to whichever profile sorted first is gone.
  They appear under Needs attention instead, and the sweeps skip them.

- **`GET /api/downloads` answers `{ downloads, orphaned }` instead of a bare
  array.** The WebSocket downloads payload carries the same two arrays.
  **Action:** anything scripted against the old shape needs `.downloads`.

- **`DELETE /api/profiles/:id` refuses to delete a profile that owns downloads
  until it is told what happens to them.** Send `reassignTo`, or
  `deleteDownloads: true` with the optional `deleteRemote` and `deleteLocal`
  flags — neither of which defaults to true. A profile that owns nothing still
  deletes with no body. The dashboard asks with a dialog that shows the counts
  first; `GET /api/profiles/:id/deletion-preview` is the same data.

- **A disabled profile refuses new work by name instead of disappearing.** Its
  RPC path used to serve the dashboard's HTML with HTTP 200, which every *arr
  reads as a successful grab. It now answers with a refusal naming the profile,
  it still claims its browser sites, and it is still counted when the shared
  endpoint decides whether it is ambiguous. Existing downloads keep running.
  **Action:** if you were disabling a profile to free up the shared endpoint or
  release a site, delete it instead.

- **Putiorr Grab profiles have no Transmission RPC endpoint.** The
  `/grab/<slug>/rpc` path only ever existed because the column was `NOT NULL
  UNIQUE`; it now answers every request with a refusal. Browser grabs reach a
  grab profile through `POST /api/grab`. Nothing to do — no download client
  connects to a grab profile.

- **Every RR profile must have a download profile.** The upgrade assigns the
  default to any profile that had none. A download profile still in use can no
  longer be orphaned: `DELETE /api/download-profiles/:id` moves the profiles
  referencing it to the default.

- **Grab profiles created through `POST /api/profiles` or
  `PUTIORR_PROFILES_JSON` now default to auto-removing completed downloads,**
  matching what the wizard and the documentation already claimed. Nothing
  imports a browser grab, so the finished transfer is dropped from putiorr and
  from put.io while the files stay on disk. **Action:** send
  `auto_remove_completed: false` to keep the old behaviour.

- **The `rpc request failed` log line names `profiles` where it named
  `enabledProfiles`,** and each entry carries `enabled`. **Action:** anything
  scraping that line needs the new key.

### Added

- **A Chrome browser extension** (`extension/`, Manifest V3, loaded unpacked)
  that captures `magnet:` links, `.torrent` downloads, and links carrying a
  magnet in their query on any site, and sends them to putiorr, which adds them
  to put.io and downloads them locally. `.torrent` files are fetched from
  inside the page, so private-tracker session cookies apply. Right-click →
  **Send to putiorr → *profile*** overrides the profile for one grab and covers
  trackers whose download URLs do not end in `.torrent`. Every grab reports
  itself on the page and again as a Chrome notification. Install instructions
  are in the [extension guide](https://ptheofan.github.io/putiorr/extension.html).
- **A Putiorr Grab profile preset.** Browser grabs get their own preset instead
  of borrowing the *arr ones: the wizard drops the RPC endpoint step entirely,
  shows the fields a grab actually needs, and turns auto-remove on by default.
- **Per-profile browser sites.** Which site routes to which profile is
  configured in putiorr, on the profile, not in the extension. A plain entry
  matches that host exactly; `*.x.example` matches the domain and every
  subdomain, longest base wins. One profile may additionally be set to take
  every site no other profile claims; without one, an unclaimed grab is refused
  rather than guessed at.
- **`POST /api/grab`** — server-side profile resolution, bencode-validated
  uploads, and an `X-Putiorr-Grab` header required as an anti-CSRF measure.
- **`POST /api/profiles/:id/browser-sites`** — appends one site to one grab
  profile, which is what the extension's toolbar popup writes when it claims the
  current page's site.
- **A Needs attention section in the dashboard** for downloads no profile owns,
  with a profile picker and a delete that says what it will remove.
- **A profile deletion dialog** that measures the downloads off disk and states
  what each answer would do, plus `GET /api/profiles/:id/deletion-preview`.
- **`schemaMigrations` in `GET /api/settings`** — what each schema upgrade
  migrated, adopted, and quarantined, and whether legacy tables have reappeared
  because an older putiorr wrote to the database.

### Fixed

Several of these were silent data loss.

- **A put.io rename deleted the download and cancelled its put.io transfer.**
  The sweep looked under the new name, found nothing, read that as the user
  deleting the files, and destroyed the download while its files sat orphaned
  at the old path. A download's staging folder is now frozen the first time it
  is staged, and already-staged rows are backfilled.
- **put.io folder listings only ever read the first page.** Latent for years;
  with file reaping it became data loss — files beyond page one were reaped and
  the download finalised incomplete.
- **A quarantined download's "delete local files" could `rm -rf` the profile's
  download root, or a directory above it,** via a transfer named `..`, which
  comes from torrent metadata. Deleting one download could also delete a nested
  download's files. Files are now deleted only when exactly one download owns
  them, never from a folder holding another download, and never resolved
  against the working directory.
- **A spoofable `User-Agent` header could delete another profile's put.io
  transfer.** RPC auth is off by default, so the header was the only barrier.
- **Ownership was re-derived at boot.** `getDefaultProfile()` — "slug
  `default`, else whatever row is first" — was the fallback at nine sites that
  decide where files get written, and a boot-time sweep rewrote ownership on
  every start, so an *arr download could silently stage into a grab profile's
  folder.
- **Adding a second *arr profile broke the first one:** the shared endpoint
  stopped resolving by path, including for the profile that owned
  `/transmission/rpc`.
- **`torrent-get` on the shared endpoint returned every profile's queue** to
  whoever asked.
- **A disabled profile's RPC path returned the dashboard's HTML with HTTP 200,**
  which every *arr reads as a successful grab. It also could not answer
  `session-get`, so a connection test failed.
- **A partial profile delete reported "Deleted 0 downloads" after cancelling the
  put.io copy,** and could never be retried. It now reports what it destroyed
  before it stopped, and can be run again.
- **`torrent-remove` cancelled the put.io transfer before checking whether it
  was allowed to,** leaving a cancelled transfer behind a refusal.
- **Two downloads could stage into one folder** and write the same `.part` file.
- **Completed downloads did not import** because the reported folder was not the
  one the *arr apps look in.
- **Hashes were invented** when put.io had not supplied one, producing zombie
  entries that could never be pruned. The hash is now corrected from put.io.
- **A failing file retried forever,** a 404 in the processed-transfer prune
  retried forever, and a per-file delete could not finish when put.io had
  already lost the file.

### Removed

- `getDefaultProfile()`, every category matcher, and the boot-time ownership
  reassigner — deleted, not disabled.
- Every shadow ownership column (written on insert, never updated, never read),
  a dead index, and the `transfer_files` table that was created on every fresh
  database and was always empty.
- The extension's Default profile setting: where an unclaimed grab lands is now
  a setting on the putiorr profile.
