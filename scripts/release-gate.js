import { readFileSync } from 'node:fs';

function readText(path) {
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

if (releaseTag && releaseTag !== expectedTag) {
  fail(`Release tag ${releaseTag} does not match package.json version ${packageVersion}. Use ${expectedTag}.`);
}

const readme = readText('README.md');
const readmeRequirements = [
  {
    label: 'example release tag',
    value: `\`${expectedTag}\``,
  },
  {
    label: 'versioned GHCR tag',
    value: `ghcr.io/ptheofan/putiorr:${expectedTag}`,
  },
  {
    label: 'plain semver GHCR tag',
    value: `ghcr.io/ptheofan/putiorr:${packageVersion}`,
  },
  {
    label: 'minor GHCR tag',
    value: `ghcr.io/ptheofan/putiorr:${expectedMinor}`,
  },
  {
    label: 'package version instruction',
    value: `package version \`${packageVersion}\``,
  },
];

for (const requirement of readmeRequirements) {
  if (!readme.includes(requirement.value)) {
    fail(`README release section is missing ${requirement.label}: ${requirement.value}`);
  }
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`Release gate passed for ${expectedTag}.`);
