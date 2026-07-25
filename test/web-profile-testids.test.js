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

  assert.match(html, /id="wizardBrowserDomains"[^>]*placeholder="x\.example, z\.example"/);
  assert.match(html, /Browser grabs from these sites use this profile; subdomains match automatically\. Leave empty for none\./);
  assert.match(profilesJs, /browserDomains: fieldValue\(el\.wizardBrowserDomains\)\.trim\(\)/);
  assert.match(profilesJs, /browser_domain_warnings/);
  assert.match(profilesJs, /setProfileFact\(card, 'browser-domains', browserDomainsText\(profile\)\)/);
});
