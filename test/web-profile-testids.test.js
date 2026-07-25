import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// profiles.js reaches the DOM through state.js, so the wizard itself is pinned
// by reading its source; the parts that are only strings and values live in
// util.js, which imports nothing but constants and runs here.
import { browserDomainsPayload, grabProfileSummary } from '../src/web/util.js';

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
  assert.match(
    profilesJs,
    /\.\.\.browserDomainsPayload\(el\.wizardBrowserStep\.hidden, fieldValue\(el\.wizardBrowserDomains\)\.trim\(\)\)/,
  );

  // The save response carries the warnings under the snake_case key only, and
  // both messages that report a completed save have to pass through them. They
  // get their own heading: appended bare, a warning reads as one more entry in
  // the dash-list of checks the failure message ends with.
  assert.match(profilesJs, /profile\?\.browser_domain_warnings/);
  assert.match(profilesJs, /\[message, '', 'Browser sites:', \.\.\.warnings\]\.join\('\\n'\)/);
  assert.match(profilesJs, /upsertProfileState\(withoutBrowserDomainWarnings\(savedProfile\)\)/);
  assert.match(profilesJs, /withBrowserDomainWarnings\('Profile tested and saved successfully!', savedProfile\)/);
  assert.match(profilesJs, /withBrowserDomainWarnings\(formatClientTestFailureMessage\(error, savedProfile\), savedProfile\)/);

  // The card ellipsizes its facts, so the joined list is only fully readable
  // through the title setProfileFact writes.
  assert.match(profilesJs, /setProfileFact\(card, 'browser-domains', browserDomainsText\(profile\)\)/);
  assert.match(utilJs, /export function setProfileFact[\s\S]*?setAttribute\(element, 'title', value\)/);
});

test('the Putiorr Grab preset is offered by the wizard and defaults to auto-remove', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const constantsJs = readFileSync(new URL('../src/web/constants.js', import.meta.url), 'utf8');

  assert.match(html, /<wa-option value="grab">Putiorr Grab<\/wa-option>/);
  assert.match(constantsJs, /export const GRAB_PROFILE_TYPE = 'grab';/);
  // Nothing imports a browser grab, so completed transfers leave putiorr on
  // their own; the note has to speak about the extension, not an *arr app.
  assert.match(
    constantsJs,
    /grab: \{\s*label: 'Putiorr Grab',\s*root: '',\s*autoRemoveCompleted: true,\s*note: '[^']*extension[^']*',\s*\}/,
  );
});

test('the wizard swaps the *arr RPC step for the browser step on Putiorr Grab profiles', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const stateJs = readFileSync(new URL('../src/web/state.js', import.meta.url), 'utf8');
  const baseCss = readFileSync(new URL('../src/web/styles/02-base.css', import.meta.url), 'utf8');

  // Every toggled section is a `display: grid` box, so the UA [hidden] rule
  // alone would lose; the layout only collapses because of this override.
  assert.match(baseCss, /\[hidden\] \{\s*display: none !important;\s*\}/);

  assert.match(html, /<div class="wizard-questions" id="profileWizardSteps">/);
  assert.match(html, /<section class="wizard-step" id="wizardRpcStep">/);
  assert.match(html, /<section class="wizard-step" id="wizardBrowserStep" hidden>/);
  assert.match(html, /<section class="wizard-step" id="wizardOptionsStep">/);
  // Enabled and auto-remove apply to grab profiles too, so they cannot stay
  // inside the RPC step that grab profiles hide.
  assert.match(
    html,
    /id="wizardOptionsStep">[\s\S]*?id="wizardEnabled"[\s\S]*?id="wizardAutoRemoveCompleted"[\s\S]*?<\/section>/,
  );

  for (const handle of [
    /profileWizardSteps: document\.querySelector\('#profileWizardSteps'\)/,
    /wizardRpcStep: document\.querySelector\('#wizardRpcStep'\)/,
    /wizardBrowserStep: document\.querySelector\('#wizardBrowserStep'\)/,
    /wizardAppStepHelp: document\.querySelector\('#wizardAppStepHelp'\)/,
    /wizardStorageStepHelp: document\.querySelector\('#wizardStorageStepHelp'\)/,
  ]) {
    assert.match(stateJs, handle);
  }

  assert.match(profilesJs, /export function applyProfileTypeLayout/);
  assert.match(profilesJs, /setHidden\(el\.wizardRpcStep, isGrab\)/);
  assert.match(profilesJs, /setHidden\(el\.wizardBrowserStep, !isGrab\)/);
  // No *arr app copies settings out of a grab profile, and the intro and the
  // two field-help lines are written for one.
  assert.match(profilesJs, /setHidden\(el\.copyClientSettingsButton, isGrab\)/);
  assert.match(profilesJs, /setText\(el\.profileWizardIntro, isGrab \? GRAB_WIZARD_INTRO : ARR_WIZARD_INTRO\)/);
  assert.match(profilesJs, /setText\(el\.wizardAppStepHelp, isGrab \? GRAB_APP_STEP_HELP : ARR_APP_STEP_HELP\)/);
  assert.match(profilesJs, /setText\(el\.wizardStorageStepHelp, isGrab \? GRAB_STORAGE_STEP_HELP : ARR_STORAGE_STEP_HELP\)/);
  // The auto-remove checkbox is shown for both presets, so its label is
  // swapped rather than hidden: no app signals import for a browser grab.
  assert.match(profilesJs, /setText\(el\.wizardAutoRemoveCompleted, isGrab \? GRAB_AUTO_REMOVE_LABEL : ARR_AUTO_REMOVE_LABEL\)/);
  assert.match(html, /id="wizardAutoRemoveCompleted"[^>]*>App will not signal import completion; remove from putiorr once files download locally</);

  // The wizard element is reused across opens, so both the open and the preset
  // change have to re-apply the layout or a grab profile leaves it stale.
  assert.match(profilesJs, /export function openProfileWizard[\s\S]*?applyProfileTypeLayout\(type\)/);
  assert.match(profilesJs, /export function syncWizardDefaultsForType[\s\S]*?applyProfileTypeLayout\(nextType\)/);

  // Numbers come from what is visible, so the same markup reads 1..N for both
  // presets instead of skipping the hidden step's number.
  assert.match(html, /class="step-label" data-step-title="App"/);
  assert.match(html, /class="step-label" data-step-title="RPC endpoint"/);
  assert.match(html, /class="step-label" data-step-title="Browser grabs"/);
  assert.match(
    profilesJs,
    /export function renumberWizardSteps[\s\S]*?\.wizard-step[\s\S]*?filter\(\(step\) => !step\.hidden\)[\s\S]*?\$\{index \+ 1\}\. \$\{[\s\S]*?stepTitle\}/,
  );
});

test('grab profiles derive a hidden RPC path from the display name', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  assert.match(profilesJs, /export function grabRpcPathForName[\s\S]*?`\/grab\/\$\{slugify\(name\)\}\/rpc`/);
  // The field is hidden for grab profiles, so nothing else would refresh it;
  // every preview pass realigns it with the name the way a preset switch does.
  assert.match(profilesJs, /export function syncDerivedRpcPath[\s\S]*?grabRpcPathForName\(fieldValue\(el\.wizardProfileName\)\)/);
  assert.match(profilesJs, /export function updateWizardPreview\(\) \{\s*syncDerivedRpcPath\(\);/);
});

test('a grab profile card trades the RPC endpoint fact for its browser sites', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  assert.match(profilesJs, /export function createProfileCard[\s\S]*?const isGrab = isGrabProfile\(profile\)/);
  assert.match(profilesJs, /toggleProfileFact\(card, 'rpc', isGrab\)/);
  assert.match(profilesJs, /toggleProfileFact\(card, 'browser-domains', !isGrab\)/);
  assert.match(profilesJs, /export function isGrabProfile[\s\S]*?=== GRAB_PROFILE_TYPE/);
});

test('the wizard sends browser sites only while the step that owns them is shown', () => {
  // Present but empty is still an answer: the user cleared the field and the
  // server has to store that. Absent is the preset never having asked.
  assert.deepEqual(browserDomainsPayload(false, 'x.example, z.example'), { browserDomains: 'x.example, z.example' });
  assert.deepEqual(browserDomainsPayload(false, ''), { browserDomains: '' });
  assert.ok('browserDomains' in browserDomainsPayload(false, ''));

  // Switching a grab profile to an *arr preset leaves its sites in the hidden
  // field. Sending them would persist sites onto a profile that never claims
  // one, and a bad entry would fail the save over a field nobody can see.
  assert.deepEqual(browserDomainsPayload(true, 'x.example'), {});
  assert.ok(!('browserDomains' in browserDomainsPayload(true, 'x.example')));
});

test('a grab profile card is summarized by its sites, not by a category', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  assert.equal(grabProfileSummary(['x.example', 'z.example']), 'Browser grabs from x.example, z.example.');
  assert.equal(grabProfileSummary([]), 'Browser grabs sent here by the extension.');
  assert.equal(grabProfileSummary(), 'Browser grabs sent here by the extension.');

  // A grab profile never reaches the category sentence below it: it has no
  // download client, so "Uses category movies-grab." would describe nothing.
  assert.match(
    profilesJs,
    /export function profileSummary[\s\S]*?if \(isGrabProfile\(profile\)\) return grabProfileSummary\(browserDomainsList\(profile\)\);/,
  );
});

test('the field guide explains the browser extension and how to install it', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  const appPreset = profilesJs.slice(
    profilesJs.indexOf('wizardProfileType: {'),
    profilesJs.indexOf('wizardProfileName: {'),
  );
  assert.ok(appPreset.length > 0, 'the App preset help entry must still exist');
  assert.match(appPreset, /paragraphs: \(profile\) => isGrabProfile\(profile\)/);
  assert.match(appPreset, /magnet/);
  assert.match(appPreset, /\.torrent/);
  assert.match(appPreset, /sites listed on this profile/);
  assert.match(appPreset, /Chrome Web Store/);
  assert.match(appPreset, /chrome:\/\/extensions/);
  assert.match(appPreset, /Developer mode/);
  assert.match(appPreset, /Load unpacked/);
  assert.match(appPreset, /extension\/ folder/);
  assert.match(appPreset, /putiorr URL and a default profile/);

  // The label above the value line is *arr wording ("Download-client
  // Category") on fields a grab profile reads differently, so it resolves like
  // the rest of the entry.
  assert.match(profilesJs, /setText\(el\.wizardHelpValueLabel, resolveWizardHelpContent\(help\.valueLabel, profile, settings\) \|\| 'Current effect'\)/);
});
