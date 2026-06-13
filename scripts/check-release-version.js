import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageVersion = String(packageJson.version ?? '').trim();
const releaseTag = String(process.env.RELEASE_TAG || process.argv[2] || '').trim();

if (!releaseTag) {
  console.error('Release tag is required. Set RELEASE_TAG or pass it as an argument.');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageVersion)) {
  console.error(`package.json version must be semver. Received: ${packageVersion}`);
  process.exit(1);
}

const expectedTags = new Set([packageVersion, `v${packageVersion}`]);

if (!expectedTags.has(releaseTag)) {
  console.error(
    `Release tag ${releaseTag} does not match package.json version ${packageVersion}. `
    + `Use v${packageVersion}.`,
  );
  process.exit(1);
}

console.log(`Release tag ${releaseTag} matches package.json version ${packageVersion}.`);
