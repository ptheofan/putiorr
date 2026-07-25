import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('profile wizard exposes stable data-testid hooks for frontend tests', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const source = `${html}\n${profilesJs}`;

  for (const testId of [
    'profile-auto-remove-completed',
    'profile-browser-domains',
    'profile-card-browser-domains',
  ]) {
    assert.match(source, new RegExp(`data-testid=["']${testId}["']|['"]data-testid['"], ['"]${testId}['"]`));
  }
});

test('profile wizard sends Browser sites as typed and surfaces the server response', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const utilJs = readFileSync(new URL('../src/web/util.js', import.meta.url), 'utf8');

  assert.match(html, /id="wizardBrowserDomains"[^>]*placeholder="x\.example, z\.example"/);
  assert.match(html, /Browser grabs from these sites use this profile; subdomains match automatically\. Leave empty for none\./);
  assert.match(profilesJs, /browserDomains: fieldValue\(el\.wizardBrowserDomains\)\.trim\(\)/);

  // The save response carries the warnings under the snake_case key only, and
  // both messages that report a completed save have to pass through them.
  assert.match(profilesJs, /profile\?\.browser_domain_warnings/);
  assert.match(profilesJs, /withBrowserDomainWarnings\('Profile tested and saved successfully!', savedProfile\)/);
  assert.match(profilesJs, /withBrowserDomainWarnings\(formatClientTestFailureMessage\(error, savedProfile\), savedProfile\)/);

  // The card ellipsizes its facts, so the joined list is only fully readable
  // through the title setProfileFact writes.
  assert.match(profilesJs, /setProfileFact\(card, 'browser-domains', browserDomainsText\(profile\)\)/);
  assert.match(utilJs, /export function setProfileFact[\s\S]*?setAttribute\(element, 'title', value\)/);
});
