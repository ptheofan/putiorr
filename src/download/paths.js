import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_FOLDER_SEGMENT_BYTES = 255;

// How TransferService.localPathOwners spells a quarantined owner. Shared rather
// than repeated, because the refusal below has different advice to give when one
// of the contenders is a row the user can simply dismiss.
export const QUARANTINED_OWNER_PREFIX = 'quarantined download ';

export function extractCategory(targetDir, downloadDir) {
  if (!downloadDir) return '';

  const target = path.resolve(targetDir);
  const requested = path.resolve(downloadDir);
  const relative = path.relative(target, requested);

  if (!relative || relative === '.') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`download-dir ${downloadDir} is outside target directory ${targetDir}`);
  }

  return normalizeRelativePath(relative);
}

export function normalizeRelativePath(value) {
  return String(value)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(path.sep);
}

// The containment check below is only worth anything when the root is
// absolute: a relative one resolves against process.cwd(), so everything is
// "inside" it and the resulting path names whatever happens to sit next to the
// process. Asserted here rather than at the call sites because this is the
// only place that can guarantee every caller pays it.
export function resolveInside(root, ...parts) {
  if (!path.isAbsolute(String(root ?? ''))) {
    throw new Error(`cannot resolve a path inside ${root || '(nothing)'}: the root must be absolute`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`resolved path ${resolved} is outside ${resolvedRoot}`);
  }
  return resolved;
}

// `<download_at>/<category>/<put.io name>` — the name exactly as put.io named
// it, which is what the *arr apps resolve their import path against
// (`downloadDir + name`) and what the user sees when they open the folder.
// Uniqueness is not spelled into the name: after the schema collapse one
// put.io transfer is one download of one profile, and two downloads that would
// share this path are refused rather than interleaved (see
// TransferService.assertSoleStagingClaim).
//
// Undefined when the name cannot name a folder of its own: without it this
// would be the category directory, which holds every other download the
// profile has, and every caller of this either writes into it or deletes it.
export function downloadLocalRoot(profile, download) {
  const name = downloadFolderSegments(stagingFolderName(download));
  if (!name) return undefined;
  const parent = downloadCategoryDir(profile, download);
  const resolved = resolveInside(parent, name);
  return resolved === parent ? undefined : resolved;
}

// The name the download's folder is spelled with: the one frozen when it was
// first staged, and until then the one put.io currently reports. put.io renames
// transfers, and a rename must not move where putiorr looks for files it has
// already written — that is read as the user having deleted them, and the sweep
// deletes the download and cancels the put.io transfer over it.
export function stagingFolderName(download) {
  return download?.staging_folder || download?.name;
}

export function downloadCategoryDir(profile, download) {
  return resolveInside(profile?.download_at, download?.category ?? '');
}

// put.io names are free text, so this is the one place a name becomes a path,
// and it changes as little as it possibly can: whatever the *arr is told the
// download is called is what it will join onto the download directory to find
// the files. Only the separator splits — a backslash is an ordinary character
// in a Linux filename, and trailing spaces are ordinary in torrent metadata —
// and only segments that name nothing ('' and '.') are dropped. A '..' segment
// survives to be refused by resolveInside rather than rewritten into a path
// that stages somewhere else without saying so.
export function downloadFolderSegments(value) {
  return String(value ?? '')
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join(path.sep);
}

// Every filesystem putiorr stages onto — ext4, APFS, SMB — caps one path
// segment at 255 bytes, and it is bytes, not characters: 120 CJK characters
// are 360 of them. Reported rather than truncated, because a truncated folder
// no longer matches the name torrent-get gives the *arr, and that mismatch
// fails silently at import time. The refusal is the caller's to make.
export function oversizedFolderSegment(value) {
  return downloadFolderSegments(value)
    .split(path.sep)
    .find((segment) => Buffer.byteLength(segment, 'utf8') > MAX_FOLDER_SEGMENT_BYTES) ?? '';
}

// What `deleteLocalData` would actually remove, measured rather than inferred.
// The file rows are not that answer: they carry completed downloads only, so an
// in-flight download reads as zero while its `.part` holds tens of gigabytes,
// and nothing records a file the user dropped in beside it. Both go to
// rm(recursive), so both are counted here.
//
// An unreadable folder is reported, never guessed at: a confirmation that
// silently omits what it could not see is the failure this replaces.
export async function measureDownloadFolder(root) {
  const empty = { files: 0, bytes: 0, unreadable: false };
  if (!root) return empty;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (error) {
    // Nothing staged yet is a real answer; anything else is one we do not have.
    if (error.code === 'ENOENT') return empty;
    return { ...empty, unreadable: true };
  }
  let files = 0;
  let bytes = 0;
  let unreadable = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    try {
      bytes += (await stat(path.join(entry.parentPath ?? root, entry.name))).size;
    } catch {
      unreadable = true;
    }
  }
  return { files, bytes, unreadable };
}

export async function fileExistsWithSize(filePath, size) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size === size;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Takes the download's own directory rather than a folder and a name to join:
// the one caller that does not have a download to resolve it from — the
// quarantine — carries a path recorded years ago, and joining a name onto a
// directory here would hide which of the two the refusal is about.
export async function deleteLocalData(downloadRoot, { ownersOfPath } = {}) {
  const localPath = assertSoleOwnedDownloadRoot(downloadRoot, { ownersOfPath });
  await rm(localPath, { recursive: true, force: true });
}

export async function deleteLocalFileData(downloadRoot, relativePath, { ownersOfPath } = {}) {
  const transferRoot = assertSoleOwnedDownloadRoot(downloadRoot, { ownersOfPath });
  const localPath = resolveInside(transferRoot, relativePath);
  await rm(localPath, { force: true });
  await rm(`${localPath}.part`, { force: true });
  await removeEmptyParents(path.dirname(localPath), transferRoot);
}

// Every recursive delete putiorr performs goes through here, and it performs
// them on directories full of files a user cannot get back. Two questions have
// to have answers first: is this an absolute path putiorr chose, and does it
// belong to exactly one download? A caller that cannot say who owns the path
// has not established that it is putiorr's to delete, so silence is refused
// the same way a shared directory is.
// Exported because the answer is needed before the first irreversible step of
// a delete, not at the last one: a caller that cancels the put.io transfer and
// only then finds the path contested has destroyed the remote copy for a
// deletion it refuses to perform. The delete helpers still ask again — this is
// the one function standing between a user's files and rm(recursive), and it
// costs nothing to be sure twice.
export function assertSoleOwnedDownloadRoot(downloadRoot, { ownersOfPath } = {}) {
  const resolved = String(downloadRoot ?? '');
  if (!path.isAbsolute(resolved)) {
    throw new Error(`refusing to delete ${resolved || '(nothing)'}: a download folder must be an absolute path`);
  }
  if (typeof ownersOfPath !== 'function') {
    throw new Error(`refusing to delete ${resolved}: nothing established which download owns it`);
  }
  const owners = ownersOfPath(resolved) ?? [];
  if (owners.length === 1) return resolved;
  if (owners.length === 0) {
    throw new Error(`refusing to delete ${resolved}: no download owns it`);
  }
  // The commonest way to reach this is the upgrade: a quarantined row records
  // the folder a surviving download still stages into, so both claim it and
  // neither can be deleted with its files. That is the right answer and a dead
  // end without the next sentence — the quarantine entry is dismissable on its
  // own, and doing that leaves one owner behind.
  const dismissable = owners.some((owner) => String(owner).startsWith(QUARANTINED_OWNER_PREFIX));
  throw new Error(
    `refusing to delete ${resolved}: ${owners.length} downloads own it — ${owners.join('; ')}`
    + (dismissable
      ? '. Dismiss the quarantined entry without the local-files option first; the files stay where they are'
        + ' and the download that is still using them keeps them'
      : ''),
  );
}

async function removeEmptyParents(startDir, stopDir) {
  const stop = path.resolve(stopDir);
  let current = path.resolve(startDir);

  while (current !== stop && current.startsWith(stop + path.sep)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return;
      throw error;
    }
    current = path.dirname(current);
  }
}
