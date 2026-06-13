import { readFileSync } from 'node:fs';
import process from 'node:process';

function readText(path) {
  const override = process.env[`RELEASE_GATE_${path.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`];
  if (override) return readFileSync(override, 'utf8');
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const packageJson = JSON.parse(readText('package.json'));
const packageVersion = String(packageJson.version ?? '').trim();
const releaseTag = String(process.env.RELEASE_TAG || process.argv[2] || '').trim();
const semverMatch = packageVersion.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);

if (!semverMatch) {
  fail(`package.json version must be semver. Received: ${packageVersion}`);
}

const [, major, minor] = semverMatch ?? [];
const expectedTag = `v${packageVersion}`;
const expectedMinor = `${major}.${minor}`;
const previousPatch = Number(semverMatch?.[3] ?? 0) > 0
  ? `${major}.${minor}.${Number(semverMatch[3]) - 1}`
  : '';
const staleCandidates = [
  ...(previousPatch ? [previousPatch, `v${previousPatch}`] : []),
];

if (releaseTag && releaseTag !== expectedTag) {
  fail(`Release tag ${releaseTag} does not match package.json version ${packageVersion}. Use ${expectedTag}.`);
}

const readme = readText('README.md');
const releaseGateWorkflow = readText('.github/workflows/release-gate.yml');
const releaseContainerWorkflow = readText('.github/workflows/release-container.yml');

const requirements = [
  {
    file: 'README.md',
    text: readme,
    label: 'example release tag',
    value: `\`${expectedTag}\``,
  },
  {
    file: 'README.md',
    text: readme,
    label: 'versioned GHCR tag',
    value: `ghcr.io/ptheofan/putiorr:${expectedTag}`,
  },
  {
    file: 'README.md',
    text: readme,
    label: 'plain semver GHCR tag',
    value: `ghcr.io/ptheofan/putiorr:${packageVersion}`,
  },
  {
    file: 'README.md',
    text: readme,
    label: 'minor GHCR tag',
    value: `ghcr.io/ptheofan/putiorr:${expectedMinor}`,
  },
  {
    file: 'README.md',
    text: readme,
    label: 'package version instruction',
    value: `package version \`${packageVersion}\``,
  },
  {
    file: '.github/workflows/release-gate.yml',
    text: releaseGateWorkflow,
    label: 'manual workflow release tag example',
    value: `for example ${expectedTag}`,
  },
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

const staleChecks = [
  {
    file: 'README.md',
    text: readme,
    description: 'README release section',
  },
  {
    file: '.github/workflows/release-gate.yml',
    text: releaseGateWorkflow,
    description: 'release gate workflow',
  },
];

for (const stale of staleCandidates) {
  for (const check of staleChecks) {
    if (check.text.includes(stale)) {
      fail(`${check.description} still mentions stale release value ${stale} in ${check.file}.`);
    }
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`Release gate passed for ${expectedTag}.`);
