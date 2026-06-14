#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import semver from 'semver';

function usage() {
  return `Usage: pnpm release:create -- <release-tag> [options]

Prepares release metadata and creates a guarded GitHub release with gh CLI.

The release tag may be v-prefixed or plain semver, for example v1.3.0.
When package.json needs to change, the script updates it and stops before
creating the GitHub release so that metadata can be committed first.

Options:
  --yes                 Create the release when metadata is already committed.
  --publish             Publish the release instead of creating a draft.
  --prerelease          Mark the release as a prerelease.
  --tag <tag>           Release tag. Same as the positional release tag.
  --title <title>       Release title. Defaults to the tag.
  --repo <owner/repo>   GitHub repo. Defaults to gh repo view.
  --notes <text>        Release notes text.
  --notes-file <path>   Release notes file.
  --skip-checks         Skip release gate, lint, and tests.
  --skip-fetch          Skip git fetch --tags origin main.
  --allow-dirty         Allow a dirty working tree.
  --allow-non-main      Allow running outside main.
  --allow-unpushed      Allow HEAD to differ from origin/main.
  --help                Show this help.
`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    allowDirty: false,
    allowNonMain: false,
    allowUnpushed: false,
    notes: undefined,
    notesFile: undefined,
    prerelease: false,
    publish: false,
    repo: undefined,
    skipChecks: false,
    skipFetch: false,
    tag: undefined,
    title: undefined,
    yes: false,
    dryRun: false,
    releaseTag: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a value.`);
      return argv[index];
    };

    if (arg === '--') {
      continue;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--publish') {
      options.publish = true;
    } else if (arg === '--prerelease') {
      options.prerelease = true;
    } else if (arg === '--tag') {
      options.tag = next();
    } else if (arg === '--title') {
      options.title = next();
    } else if (arg === '--repo') {
      options.repo = next();
    } else if (arg === '--notes') {
      options.notes = next();
    } else if (arg === '--notes-file') {
      options.notesFile = next();
    } else if (arg === '--skip-checks') {
      options.skipChecks = true;
    } else if (arg === '--skip-fetch') {
      options.skipFetch = true;
    } else if (arg === '--allow-dirty') {
      options.allowDirty = true;
    } else if (arg === '--allow-non-main') {
      options.allowNonMain = true;
    } else if (arg === '--allow-unpushed') {
      options.allowUnpushed = true;
    } else if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}`);
    } else if (!options.releaseTag) {
      options.releaseTag = arg;
    } else {
      fail(`Unexpected extra argument: ${arg}`);
    }
  }

  if (options.releaseTag && options.tag) {
    fail('Pass the release tag either positionally or with --tag, not both.');
  }

  return options;
}

function commandText(command, args) {
  return [command, ...args].map((part) => (
    /^[A-Za-z0-9_./:=@+-]+$/.test(part)
      ? part
      : JSON.stringify(part)
  )).join(' ');
}

function run(command, args, { allowFailure = false, capture = false, env = {} } = {}) {
  console.log(`$ ${commandText(command, args)}`);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (!allowFailure && result.status !== 0) {
    if (capture) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

function output(command, args) {
  return run(command, args, { capture: true }).stdout.trim();
}

function packageJsonPath() {
  return process.env.RELEASE_CREATE_PACKAGE_JSON || new URL('../package.json', import.meta.url);
}

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath(), 'utf8'));
}

function readPackageVersion() {
  const packageJson = readPackageJson();
  const version = semver.valid(String(packageJson.version ?? '').trim());
  if (!version) fail(`package.json version must be valid semver. Received: ${packageJson.version}`);
  return version;
}

function writePackageVersion(version) {
  const packageJson = readPackageJson();
  const previousVersion = String(packageJson.version ?? '').trim();
  if (previousVersion === version) return false;

  packageJson.version = version;
  writeFileSync(packageJsonPath(), `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Updated package.json version ${previousVersion || '(empty)'} -> ${version}.`);
  return true;
}

function checkCleanGit({ allowDirty }) {
  const status = output('git', ['status', '--porcelain']);
  if (status && !allowDirty) {
    fail('Working tree is dirty. Commit or stash changes, or pass --allow-dirty for a dry-run/debug invocation.');
  }
}

function checkMain({ allowNonMain }) {
  const branch = output('git', ['branch', '--show-current']);
  if (branch !== 'main' && !allowNonMain) {
    fail(`Release must run from main. Current branch: ${branch || '(detached)'}.`);
  }
}

function checkUpToDate({ allowUnpushed }) {
  const head = output('git', ['rev-parse', 'HEAD']);
  const originMain = output('git', ['rev-parse', 'origin/main']);
  if (head !== originMain && !allowUnpushed) {
    fail(`HEAD ${head} does not match origin/main ${originMain}. Push or pull main before releasing.`);
  }
  return head;
}

function resolveRepo(explicitRepo) {
  if (explicitRepo) return explicitRepo;
  const result = output('gh', ['repo', 'view', '--json', 'nameWithOwner']);
  return JSON.parse(result).nameWithOwner;
}

function checkReleaseDoesNotExist({ repo, tag }) {
  const result = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName'], {
    allowFailure: true,
    capture: true,
  });
  if (result.status === 0) {
    fail(`GitHub release ${tag} already exists in ${repo}.`);
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const initialPackageVersion = readPackageVersion();
const tagInput = options.tag ?? options.releaseTag ?? `v${initialPackageVersion}`;
const tagVersion = semver.clean(tagInput);
if (!tagVersion) fail(`Release tag must be semver with optional leading v. Received: ${tagInput}`);
const tag = `v${tagVersion}`;

const title = options.title ?? tag;
const draft = !options.publish;
const prerelease = options.prerelease || semver.prerelease(tagVersion) !== null;

checkCleanGit(options);
checkMain(options);
if (!options.skipFetch) run('git', ['fetch', '--tags', 'origin', 'main']);
const head = checkUpToDate(options);
const metadataChanged = writePackageVersion(tagVersion);

if (!options.skipChecks) {
  run('pnpm', ['release:gate'], { env: { RELEASE_TAG: tag } });
  run('pnpm', ['lint']);
  run('pnpm', ['test']);
}

if (metadataChanged) {
  console.log('');
  console.log(`Release metadata is prepared for ${tag}.`);
  console.log('Commit and merge the metadata change to main, then rerun this command to create the GitHub release.');
  process.exit(0);
}

run('gh', ['auth', 'status']);
const repo = resolveRepo(options.repo);
checkReleaseDoesNotExist({ repo, tag });

const createArgs = [
  'release',
  'create',
  tag,
  '--repo',
  repo,
  '--title',
  title,
  '--target',
  head,
];

if (draft) createArgs.push('--draft');
if (prerelease) createArgs.push('--prerelease');
if (options.notesFile) createArgs.push('--notes-file', options.notesFile);
else if (options.notes) createArgs.push('--notes', options.notes);
else createArgs.push('--generate-notes');

if (!options.yes || options.dryRun) {
  console.log('');
  console.log('Dry run complete. This command would create the release:');
  console.log(commandText('gh', createArgs));
  console.log('');
  console.log('Re-run with --yes to create a draft release, or --yes --publish to publish immediately.');
  process.exit(0);
}

run('gh', createArgs);
console.log(`Created ${draft ? 'draft ' : ''}release ${tag} in ${repo}.`);
