import { rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

export function extractCategory(targetDir: string, downloadDir: string): string {
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

export function normalizeRelativePath(value: string): string {
  return String(value)
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(path.sep);
}

export function resolveInside(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`resolved path ${resolved} is outside ${resolvedRoot}`);
  }
  return resolved;
}

export async function fileExistsWithSize(filePath: string, size: number): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size === size;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function deleteLocalData(targetDir: string, transferName: string): Promise<void> {
  const localPath = resolveInside(targetDir, transferName);
  await rm(localPath, { recursive: true, force: true });
}

export async function deleteLocalFileData(
  targetDir: string,
  transferName: string,
  relativePath: string,
): Promise<void> {
  const transferRoot = resolveInside(targetDir, transferName);
  const localPath = resolveInside(transferRoot, relativePath);
  await rm(localPath, { force: true });
  await rm(`${localPath}.part`, { force: true });
  await removeEmptyParents(path.dirname(localPath), transferRoot);
}

async function removeEmptyParents(startDir: string, stopDir: string): Promise<void> {
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
