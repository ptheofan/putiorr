import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

// Long enough to stay legible, short enough that the folder name plus the id
// prefix clears the 255-byte limit ext4, APFS and SMB all impose.
const MAX_FOLDER_NAME_LENGTH = 120;

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

export function resolveInside(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`resolved path ${resolved} is outside ${resolvedRoot}`);
  }
  return resolved;
}

// put.io names are free text and end up as one path segment, so anything that
// could make them more than one — or make them name the parent, or hide the
// folder — is flattened. It never rejects: the download still has to land
// somewhere, and the id prefix in front of this is what identifies it.
export function sanitizeDownloadName(value) {
  const flattened = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[\\/:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.]+/, '')
    .replace(/[. ]+$/, '')
    .trim();
  return flattened.slice(0, MAX_FOLDER_NAME_LENGTH).replace(/[. ]+$/, '') || 'download';
}

// `<download.id>-<sanitised put.io name>`. The id is what makes it unique: the
// put.io name is remote-mutable and put.io does not deduplicate it, so two
// profiles sharing a folder and category used to resolve to the same directory
// — and `deleteLocalData` was an rm -rf on it.
export function downloadFolderName(download) {
  const id = Number(download?.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('a download id is required to resolve its local folder');
  }
  return `${id}-${sanitizeDownloadName(download?.name)}`;
}

export function downloadCategoryDir(profile, download) {
  return resolveInside(profile?.download_at, download?.category ?? '');
}

export function downloadLocalRoot(profile, download) {
  return resolveInside(downloadCategoryDir(profile, download), downloadFolderName(download));
}

// Where the files of an install that predates the id prefix are. Undefined
// when the name cannot name a folder of its own: without it the "legacy root"
// would be the category directory, which holds every other download the
// profile has.
export function legacyDownloadLocalRoot(profile, download) {
  const name = sanitizeSegment(download?.name);
  if (!name) return undefined;
  const parent = downloadCategoryDir(profile, download);
  const resolved = resolveInside(parent, name);
  return resolved === parent ? undefined : resolved;
}

function sanitizeSegment(value) {
  const text = String(value ?? '').trim();
  if (!text || text === '.' || text === '..') return '';
  return text.split(/[\\/]+/).filter(Boolean).join(path.sep);
}

// The directory this download is actually using, which is not always the one
// its current name spells: put.io renames transfers, and a rename must not
// strand the files already on disk. The id prefix is the stable part, so an
// existing folder claiming it wins over a freshly spelled one.
export async function resolveDownloadRoot(profile, download) {
  const desired = downloadLocalRoot(profile, download);
  if (await directoryExists(desired)) return desired;

  const parent = downloadCategoryDir(profile, download);
  const prefix = `${Number(download.id)}-`;
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return desired;
    throw error;
  }
  const claimed = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => entry.name)
    .sort();
  return claimed.length > 0 ? path.join(parent, claimed[0]) : desired;
}

async function directoryExists(dirPath) {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
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

// Takes the download's own directory, already resolved, rather than a folder
// and a name to join: the folder a download is using is not always the one its
// current name spells, and re-deriving it here from a remote-mutable name is
// how an rm -rf ends up pointed at a directory somebody else is filling.
export async function deleteLocalData(downloadRoot) {
  await rm(requireDownloadRoot(downloadRoot), { recursive: true, force: true });
}

export async function deleteLocalFileData(downloadRoot, relativePath) {
  const transferRoot = requireDownloadRoot(downloadRoot);
  const localPath = resolveInside(transferRoot, relativePath);
  await rm(localPath, { force: true });
  await rm(`${localPath}.part`, { force: true });
  await removeEmptyParents(path.dirname(localPath), transferRoot);
}

function requireDownloadRoot(downloadRoot) {
  const resolved = String(downloadRoot ?? '');
  if (!path.isAbsolute(resolved)) {
    throw new Error(`refusing to delete ${resolved || '(nothing)'}: a download folder must be an absolute path`);
  }
  return resolved;
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
