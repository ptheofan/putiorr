import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  version: string;
};

type VersionResult = {
  checkedAtMs: number;
  checkedAt: string;
  currentVersion: string;
  latestVersion?: string;
  latestTag?: string;
  updateAvailable: boolean;
  releaseUrl: string;
  status: string;
  error?: string;
};

const PACKAGE_JSON_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
const DEFAULT_RELEASE_API_URL = 'https://api.github.com/repos/ptheofan/putiorr/releases/latest';
const DEFAULT_RELEASE_URL = 'https://github.com/ptheofan/putiorr/releases/latest';
const DEFAULT_CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 3_000;

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return String(packageJson.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export const CURRENT_VERSION = readPackageVersion();

export function normalizeSemver(value: string | undefined): string | undefined {
  return semver.clean(String(value ?? '').trim()) ?? undefined;
}

export function parseSemver(value: string | undefined): ParsedSemver | undefined {
  const normalized = normalizeSemver(value);
  if (!normalized) return undefined;
  const parsed = semver.parse(normalized);
  if (!parsed) return undefined;
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
    version: parsed.version,
  };
}

export function compareSemver(left: string | ParsedSemver | undefined, right: string | ParsedSemver | undefined): number {
  const leftVersion = normalizeSemver(typeof left === 'string' ? left : left?.version);
  const rightVersion = normalizeSemver(typeof right === 'string' ? right : right?.version);
  if (!leftVersion || !rightVersion) return 0;
  return semver.compare(leftVersion, rightVersion);
}

export class VersionChecker {
  currentVersion: string;
  fetch: typeof globalThis.fetch | undefined;
  releaseApiUrl: string;
  releaseUrl: string;
  ttlMs: number;
  timeoutMs: number;
  now: () => number;
  cache: VersionResult | undefined;

  constructor({
    currentVersion = CURRENT_VERSION,
    fetch: fetchImpl = globalThis.fetch,
    releaseApiUrl = DEFAULT_RELEASE_API_URL,
    releaseUrl = DEFAULT_RELEASE_URL,
    ttlMs = DEFAULT_CHECK_TTL_MS,
    timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    now = () => Date.now(),
  }: {
    currentVersion?: string;
    fetch?: typeof globalThis.fetch;
    releaseApiUrl?: string;
    releaseUrl?: string;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  } = {}) {
    this.currentVersion = currentVersion;
    this.fetch = fetchImpl;
    this.releaseApiUrl = releaseApiUrl;
    this.releaseUrl = releaseUrl;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.cache = undefined;
  }

  async check(): Promise<Omit<VersionResult, 'checkedAtMs'>> {
    const now = this.now();
    if (this.cache && now - this.cache.checkedAtMs < this.ttlMs) {
      return this.publicResponse(this.cache);
    }

    const result = await this.fetchLatest(now);
    this.cache = result;
    return this.publicResponse(result);
  }

  publicResponse(result: VersionResult): Omit<VersionResult, 'checkedAtMs'> {
    const { checkedAtMs: _checkedAtMs, ...response } = result;
    return response;
  }

  baseResponse(checkedAtMs: number): VersionResult {
    return {
      checkedAtMs,
      checkedAt: new Date(checkedAtMs).toISOString(),
      currentVersion: this.currentVersion,
      latestVersion: undefined,
      latestTag: undefined,
      updateAvailable: false,
      releaseUrl: this.releaseUrl,
      status: 'unknown',
    };
  }

  async fetchLatest(checkedAtMs: number): Promise<VersionResult> {
    const base = this.baseResponse(checkedAtMs);
    if (!this.fetch) {
      return {
        ...base,
        status: 'error',
        error: 'Version check is not supported by this runtime.',
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(this.releaseApiUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'putiorr-version-checker',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}`);
      }

      const body = await response.json() as Record<string, string | undefined>;
      const latestTag = String(body.tag_name ?? '').trim();
      const latestVersion = parseSemver(latestTag);
      if (!latestVersion) {
        throw new Error('Latest release tag is not semver.');
      }

      const currentVersion = normalizeSemver(this.currentVersion);
      return {
        ...base,
        status: 'ok',
        latestVersion: latestVersion.version,
        latestTag,
        updateAvailable: currentVersion
          ? semver.gt(latestVersion.version, currentVersion)
          : false,
        releaseUrl: String(body.html_url || this.releaseUrl),
      };
    } catch (error) {
      return {
        ...base,
        status: 'error',
        error: error.name === 'AbortError'
          ? 'Version check timed out.'
          : error.message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
