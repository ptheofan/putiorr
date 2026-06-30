# Prowlarr Profile Auto-Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a transfer on a `prowlarr`-type profile finishes downloading, automatically delete it from put.io and remove it from the putiorr list, while leaving the downloaded files on local disk untouched.

**Architecture:** Add a single branch to `DownloadManager.finalizeTransferIfComplete()` (the one place a transfer becomes `processed`). For prowlarr profiles it calls the existing `TransferService.deleteDownloadBucket(id, { deleteRemote: true, deleteLocal: false })`, which already deletes the put.io file + transfer and hard-removes the local row. Best-effort with try/catch so a cleanup failure never throws out of finalize.

**Tech Stack:** Node.js (ESM), `node:test` + `node:assert/strict`, better-sqlite3-backed `StateStore`.

---

### Task 1: Prowlarr auto-cleanup on finalize

**Files:**
- Modify: `/.ts` — `finalizeTransferIfComplete()` (insert after the `updateTransfer(... processed ...)` call at `/.ts:647-654`, before the `cleanupRemoteFiles` block at `:656`)
- Test: `/.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `/.ts` with this exact content:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } .ts;
import { DownloadManager } .ts;
import { StateStore } .ts;
import { TransferService } .ts;

class FakePutio {
  constructor() {
    this.deletedFiles = [];
    this.deletedTransfers = [];
  }

  async deleteFile(fileId) {
    this.deletedFiles.push(fileId);
  }

  async deleteTransfer(transferId) {
    this.deletedTransfers.push(transferId);
  }
}

async function createHarness(env = {}, putio = new FakePutio()) {
  const root = await mkdtemp(path.join(tmpdir(), 'putiorr-prowlarr-cleanup-'));
  const config = loadConfig({
    PUTIORR_TARGET_DIR: path.join(root, 'downloads'),
    PUTIORR_STATE_PATH: ':memory:',
    PUTIORR_PUTIO_TOKEN: 'test-token',
    ...env,
  }, root);
  const store = new StateStore(':memory:');
  store.seedFromConfig(config);
  const service = new TransferService({
    config,
    store,
    putioFactory: () => putio,
  });
  return { root, config, store, service, putio };
}

// Creates a complete transfer (one fully-downloaded file) attached to `profile`,
// with the file written to disk so "kept on disk" can be asserted.
async function seedCompleteTransfer(harness, profile) {
  const transfer = harness.store.createOrUpdateTransfer({
    profile_id: profile.id,
    putio_transfer_id: 10,
    putio_file_id: 20,
    save_parent_id: profile.putio_folder_id ?? 42,
    hash: 'prowlarrcleanuphash',
    name: 'Prowlarr.Release',
    lifecycle: 'downloading',
    putio_status: 'COMPLETED',
    percent_done: 100,
    total_size: 10,
  });
  harness.store.upsertTransferFile({
    transfer_id: transfer.id,
    putio_file_id: 20,
    relative_path: 'movie.mkv',
    size: 10,
    downloaded_bytes: 10,
    status: 'complete',
  });
  const filePath = path.join(profile.download_at, transfer.name, 'movie.mkv');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'downloaded!!');
  return { transfer, filePath };
}

test('finalize auto-removes a prowlarr transfer from put.io and the list, keeping disk files', async () => {
  const harness = await createHarness();
  try {
    const profile = harness.store.createProfile({
      name: 'Prowlarr',
      type: 'prowlarr',
      slug: 'prowlarr',
      putio_folder_name: 'prowlarr',
      downloadAt: path.join(harness.config.targetDir, 'prowlarr'),
      rpc_path: '/prowlarr/transmission/rpc',
      enabled: true,
    });
    const { transfer, filePath } = await seedCompleteTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.finalizeTransferIfComplete(transfer.id);

    // Deleted from put.io (both the file and the transfer entry).
    assert.deepEqual(harness.putio.deletedFiles, [20]);
    assert.deepEqual(harness.putio.deletedTransfers, [10]);
    // Removed from the list entirely (hard-deleted, not just tombstoned).
    assert.equal(harness.store.findTransferById(transfer.id), undefined);
    assert.deepEqual(harness.store.listActiveTransfers(), []);
    // Files left on disk untouched.
    assert.equal(await readFile(filePath, 'utf8'), 'downloaded!!');
  } finally {
    harness.store.close();
  }
});

test('finalize leaves a non-prowlarr transfer in the list as processed', async () => {
  const harness = await createHarness({ PUTIORR_CLEANUP_REMOTE_FILES: 'false' });
  try {
    const profile = harness.store.findProfileBySlug('default');
    const { transfer } = await seedCompleteTransfer(harness, profile);

    const manager = new DownloadManager({
      config: harness.config,
      store: harness.store,
      service: harness.service,
    });
    await manager.finalizeTransferIfComplete(transfer.id);

    // No bucket delete: nothing removed from put.io, row retained as processed.
    assert.deepEqual(harness.putio.deletedFiles, []);
    assert.deepEqual(harness.putio.deletedTransfers, []);
    assert.equal(harness.store.findTransferById(transfer.id)?.lifecycle, 'processed');
  } finally {
    harness.store.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --disable-warning=ExperimentalWarning --test /.ts`
Expected: The first test FAILS — `deletedTransfers` is `[]` (and the row still exists) because finalize does not yet do the bucket delete. The second test passes (it already matches current behavior with cleanup disabled).

- [ ] **Step 3: Write the implementation**

In `/.ts`, in `finalizeTransferIfComplete()`, immediately after the `this.store.updateTransfer(transferId, { lifecycle: 'processed', ... })` call (currently ending at line 654) and BEFORE the `if (this.config.cleanupRemoteFiles && transfer.putio_file_id) {` block, insert:

```javascript
    const profile = this.store.findProfileById(transfer.profile_id) ?? this.service.getDefaultProfile();
    if (profile?.type === 'prowlarr') {
      // Prowlarr has no downstream *arr import, so a completed transfer would
      // otherwise linger forever. Delete it from put.io and drop it from the
      // list, but keep the downloaded files on disk. Best-effort: a failure is
      // logged and the transfer stays as `processed` (same as cleanupRemoteFiles).
      try {
        await this.service.deleteDownloadBucket(transferId, {
          deleteRemote: true,
          deleteLocal: false,
        });
        logger.info('prowlarr transfer auto-removed after download; kept files on disk', {
          transferId,
          name: transfer.name,
        });
      } catch (error) {
        logger.warn('failed to auto-remove prowlarr transfer', {
          transferId,
          name: transfer.name,
          error: error.message,
        });
      }
      return;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --disable-warning=ExperimentalWarning --test /.ts`
Expected: Both tests PASS.

- [ ] **Step 5: Run the full test suite + lint to check for regressions**

Run: `pnpm test`
Expected: All tests pass.

Run: `pnpm lint`
Expected: No lint errors.

- [ ] **Step 6: Commit**

```bash
git add /.ts /.ts
git commit -m "feat: auto-remove completed prowlarr transfers, keep disk files

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Document the behavior in the README

**Files:**
- Modify: `README.md` (the Status / feature list section)

- [ ] **Step 1: Add a bullet describing the behavior**

In `README.md`, under the Version 1 feature list (the bulleted list that includes "safe handling of `delete-local-data`"), add a bullet:

```markdown
- automatic cleanup of completed `prowlarr`-profile transfers (removed from the
  list and put.io, downloaded files kept on disk)
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note prowlarr auto-cleanup in README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- `deleteDownloadBucket` lives at `/.ts:303`. With
  `deleteRemote: true` it calls `removeRemoteTransfer(transfer, { throwOnError: true })`
  (deletes `putio_file_id` then `putio_transfer_id`) and then `deleteTransfer(row.id)`;
  with `deleteLocal: false` it never touches disk. Do not reimplement this logic.
- The branch must `return` so the existing `cleanupRemoteFiles` source-file delete
  does not also run — the bucket delete already removed everything on put.io.
- It runs regardless of `config.cleanupRemoteFiles`: prowlarr auto-cleanup is its
  own behavior.
- `profile.type` for prowlarr is the literal string `'prowlarr'` (see
  `/.ts` `PROFILE_TYPES`).
