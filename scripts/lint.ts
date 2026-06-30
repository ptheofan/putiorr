import { spawnSync } from 'node:child_process';

const result = spawnSync('tsc', ['--noEmit'], {
  encoding: 'utf8',
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
