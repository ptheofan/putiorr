import { readFileSync } from 'node:fs';
import process from 'node:process';
import semver from 'semver';

const LATEST_RELEASE_API_URL = 'https://api.github.com/repos/ptheofan/putiorr/releases/latest';

type PackageJson = {
  version?: string;
};

type LatestReleaseBody = {
  tag_name?: string;
};

function readText(path: string): string {
  const override = process.env[`RELEASE_GATE_${path.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`];
  if (override) return readFileSync(override, 'utf8');
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function errorMessage(error: Error): string {
  return error.message;
}

async function latestReleaseTag(): Promise<string> {
  const override = String(process.env.RELEASE_GATE_LATEST_RELEASE_TAG ?? '').trim();
  if (override) return override;

  const response = await fetch(LATEST_RELEASE_API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'putiorr-release-gate',
    },
  });
  if (response.status === 404) return '';
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const body = await response.json() as LatestReleaseBody;
  return String(body.tag_name ?? '').trim();
}

const packageJson = JSON.parse(readText('package.json')) as PackageJson;
const packageVersion = semver.valid(String(packageJson.version ?? '').trim());
const releaseTag = String(process.env.RELEASE_TAG || process.argv[2] || '').trim();

if (!packageVersion) {
  fail(`package.json version must be semver. Received: ${packageJson.version}`);
  process.exit(process.exitCode);
}

const expectedTag = `v${packageVersion}`;

if (releaseTag && releaseTag !== expectedTag) {
  fail(`Release tag ${releaseTag} does not match package.json version ${packageVersion}. Use ${expectedTag}.`);
}

try {
  const latestTag = await latestReleaseTag();
  const latestVersion = latestTag ? semver.clean(latestTag) : '';
  if (latestTag && !latestVersion) {
    fail(`Latest GitHub release tag must be semver. Received: ${latestTag}`);
  }
  if (latestVersion && semver.lt(packageVersion, latestVersion)) {
    fail(
      `package.json version ${packageVersion} is older than latest GitHub release ${latestTag}. `
      + `Update package.json and release documentation before running the release gate.`,
    );
  }
} catch (error) {
  fail(`Could not check latest GitHub release: ${errorMessage(error)}`);
}

const releaseContainerWorkflow = readText('.github/workflows/release-container.yml');

const requirements = [
  {
    file: '.github/workflows/release-container.yml',
    text: releaseContainerWorkflow,
    label: 'release workflow gate command',
    value: 'pnpm release:gate',
  },
];

for (const requirement of requirements) {
  if (!requirement.text.includes(requirement.value)) {
    fail(`${requirement.file} is missing ${requirement.label}: ${requirement.value}`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`Release gate passed for ${expectedTag}.`);
