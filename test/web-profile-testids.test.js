import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('profile wizard exposes stable data-testid hooks for frontend tests', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');

  assert.match(html, /data-testid=["']profile-auto-remove-completed["']/);
});
