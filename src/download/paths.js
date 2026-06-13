import { rm, stat } from 'node:fs/promises';
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

export function resolveInside(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`resolved path ${resolved} is outside ${resolvedRoot}`);
  }
  return resolved;
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

export async function deleteLocalData(targetDir, transferName) {
  const localPath = resolveInside(targetDir, transferName);
  await rm(localPath, { recursive: true, force: true });
}
