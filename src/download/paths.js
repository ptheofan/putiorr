import { rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

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
  const name = downloadFolderSegments(download?.name);
  if (!name) return undefined;
  const parent = downloadCategoryDir(profile, download);
  const resolved = resolveInside(parent, name);
  return resolved === parent ? undefined : resolved;
}

export function downloadCategoryDir(profile, download) {
  return resolveInside(profile?.download_at, download?.category ?? '');
}

// put.io names are free text, so this is the one place a name becomes a path.
// Separators are kept — a put.io name that reads like a path nests, which is
// what it did before and what keeps `downloadDir + name` resolving for the
// *arr apps — while '.' and '..' name no folder at all. Anything that escapes
// the category directory is refused by resolveInside rather than rewritten
// into something that silently stages elsewhere.
function downloadFolderSegments(value) {
  const segments = String(value ?? '')
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.');
  return segments.length > 0 ? segments.join(path.sep) : '';
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
  const localPath = requireSoleOwnedDownloadRoot(downloadRoot, ownersOfPath);
  await rm(localPath, { recursive: true, force: true });
}

export async function deleteLocalFileData(downloadRoot, relativePath, { ownersOfPath } = {}) {
  const transferRoot = requireSoleOwnedDownloadRoot(downloadRoot, ownersOfPath);
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
function requireSoleOwnedDownloadRoot(downloadRoot, ownersOfPath) {
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
  throw new Error(`refusing to delete ${resolved}: ${owners.length} downloads own it — ${owners.join('; ')}`);
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
