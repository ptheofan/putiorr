# Prowlarr Profile Auto-Cleanup

## Summary

When a transfer belonging to a `prowlarr`-type profile finishes downloading,
putiorr automatically removes it from the dashboard list and deletes it from
put.io, while leaving the downloaded files on local disk untouched.

Prowlarr profiles have no downstream *arr import step, so completed transfers
otherwise linger in the list and on put.io until the user deletes them by hand.
This change automates that cleanup.

## Background

- Profile `type` is an existing concept. `prowlarr` is already a recognised
  type (see `src/web/app.js` `PROFILE_TYPES`), stored on the profile row and
  surfaced via `TransferService.listDownloads()` as `profileType`.
- `DownloadManager.finalizeTransferIfComplete()`
  (`src/download/manager.js:639`) is the single point where a transfer becomes
  `processed` after all its files are local. By this point every file has
  already been renamed from its `<name>.part` working name to the final name,
  so "keep files on disk" is clean and complete.
- `TransferService.deleteDownloadBucket(transferId, { deleteRemote, deleteLocal })`
  (`src/transfer/service.js:303`) already implements exactly the action we
  need: with `deleteRemote: true` it deletes the put.io file + transfer and
  hard-removes the local DB row (so it leaves the list); with
  `deleteLocal: false` it leaves disk files alone.

Feature 2 from the original request (`.partial` suffix for in-progress files)
was dropped: the download manager already writes in-progress files as
`<name>.part` and renames them to the final name on completion
(`src/download/manager.js:362,398`). No change needed.

## Behavior

In `finalizeTransferIfComplete()`, after the transfer is marked `processed`:

1. Resolve the profile:
   `store.findProfileById(transfer.profile_id) ?? service.getDefaultProfile()`.
2. If `profile?.type === 'prowlarr'`:
   - Call
     `await service.deleteDownloadBucket(transferId, { deleteRemote: true, deleteLocal: false })`.
   - This deletes the put.io file + transfer, removes the local row from the
     list, and leaves disk files untouched.
   - `return` — skip the normal `cleanupRemoteFiles` source-file deletion, since
     the bucket delete already removed everything on put.io.
   - Runs regardless of `config.cleanupRemoteFiles`: prowlarr auto-cleanup is
     its own behavior, not gated by that flag.
3. Otherwise: existing behavior unchanged (best-effort `cleanupRemoteFiles`
   source-file deletion, then the "transfer processed locally" log).

## Error handling

- Wrap the prowlarr cleanup in `try/catch`; log a warning on failure and leave
  the transfer as `processed`. This mirrors the existing best-effort
  `cleanupRemoteFiles` block — a failed cleanup never throws out of finalize.
- Concurrent double-finalize (two workers completing the last file near
  simultaneously) is safe: the early guard
  `if (!transfer || transfer.lifecycle === 'processed') return;` plus the
  hard-deleted row mean the second call returns early, and the catch absorbs a
  `Download bucket not found` race.

## Non-goals / trade-offs

- **No config, schema, or UI changes.** Trigger is purely `profile.type ===
  'prowlarr'`.
- **Resurrection:** because the put.io transfer is deleted,
  `refreshRemoteTransfers()` will not re-list it, so the row will not reappear.
  This accepts the same eventual-consistency trade-off the dashboard's existing
  hard-delete already accepts.
- Behavior for non-prowlarr profiles is unchanged.

## Testing

Add `DownloadManager` finalize coverage:

1. **Prowlarr auto-cleanup:** a transfer on a `prowlarr`-type profile, once all
   files are local, results in the put.io transfer being deleted, the DB row
   removed from the list, and the local file still present on disk.
2. **Non-prowlarr unchanged:** a transfer on a non-prowlarr profile finalizes to
   `processed` with its row retained (no bucket delete).

## Affected files

- `src/download/manager.js` — `finalizeTransferIfComplete()` (~10 lines added).
- `test/` — new/extended manager finalize test.
