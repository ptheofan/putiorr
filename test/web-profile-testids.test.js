import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// profiles.js reaches the DOM through state.js, so the wizard itself is pinned
// by reading its source; the parts that are only strings and values live in
// util.js, which imports nothing but constants and runs here.
import { browserCatchAllPayload, browserDomainsPayload, grabProfileSummary } from '../src/web/util.js';

test('profile wizard exposes stable data-testid hooks for frontend tests', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const source = `${html}\n${profilesJs}`;

  for (const testId of [
    'profile-auto-remove-completed',
    'profile-browser-domains',
    'profile-browser-catch-all',
    'profile-card-browser-domains',
    'profile-card-browser-catch-all',
  ]) {
    assert.match(source, new RegExp(`data-testid=["']${testId}["']|['"]data-testid['"], ['"]${testId}['"]`));
  }
});

test('profile wizard sends Browser sites as typed and surfaces the server response', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const utilJs = readFileSync(new URL('../src/web/util.js', import.meta.url), 'utf8');

  assert.match(html, /id="wizardBrowserDomains"[^>]*placeholder="x\.example, \*\.z\.example"/);
  // Both forms and an example of each: "subdomains match automatically" was
  // true of the old rule and is now false of the plain form, which is exactly
  // the kind of wrong a help line has to not be.
  assert.match(
    html,
    /Browser grabs from these sites use this profile\. x\.example matches that host alone;/,
  );
  assert.match(html, /\*\.x\.example matches it and every subdomain\. Leave empty for none\./);
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
  assert.match(profilesJs, /withBrowserDomainWarnings\(\s*wizardIsGrabPreset\(\) \? GRAB_SAVE_SUCCESS_MESSAGE : ARR_SAVE_SUCCESS_MESSAGE,\s*savedProfile,\s*\)/);
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

  // The submit button promises what the server actually runs for this preset:
  // a grab profile is saved and its folder is checked, and nothing connects to
  // a download client that does not exist.
  assert.match(profilesJs, /export const ARR_SAVE_BUTTON_LABEL = 'Save & test';/);
  assert.match(profilesJs, /export const GRAB_SAVE_BUTTON_LABEL = 'Save & check folder';/);
  assert.match(profilesJs, /setText\(el\.saveProfileButton, saveButtonLabel\(type\)\)/);
  // Two other places reset that label after a save, and both have to ask the
  // same question instead of hard-coding the *arr wording back onto it.
  assert.doesNotMatch(profilesJs, /el\.saveProfileButton\.textContent = 'Save & test'/);
  assert.match(profilesJs, /export function saveButtonLabel[\s\S]*?GRAB_SAVE_BUTTON_LABEL : ARR_SAVE_BUTTON_LABEL/);

  // A grab profile can only fail its folder check, so the failure reports the
  // folder — not the host, port, SSL and endpoint the *arr dump lists, which
  // this preset does not even show.
  assert.match(
    profilesJs,
    /export function formatClientTestFailureMessage[\s\S]*?if \(isGrabProfile\(profile\)\) \{[\s\S]*?'Profile saved, but the download folder check failed\.'[\s\S]*?clientTestFailureChecks\(error\.message, \{ grab: true \}\)/,
  );
  assert.match(profilesJs, /export function clientTestFailureChecks\(message = '', \{ grab = false \} = \{\}\)/);
  // Nothing connects to a grab profile, so no connection or credential advice
  // may reach it — and 401 is matched as a word, because the write-test file
  // putiorr creates carries a uuid that can contain those three digits.
  assert.match(profilesJs, /if \(!grab && \(lowerMessage\.includes\('username'\)[\s\S]*?\/\\b401\\b\/\.test\(lowerMessage\)\)\)/);
  assert.match(profilesJs, /if \(\s*!grab\s*&& \(\s*lowerMessage\.includes\('fetch failed'\)/);
  // The advice that ends every failure names the button the user will click.
  assert.match(profilesJs, /`After fixing the folder, click \$\{GRAB_SAVE_BUTTON_LABEL\} again\.`/);
  assert.match(profilesJs, /`After fixing the value, click \$\{ARR_SAVE_BUTTON_LABEL\} again\.`/);
  assert.match(html, /id="wizardAutoRemoveCompleted"[^>]*>App will not signal import completion; remove from putiorr once files download locally</);

  // Switching preset must not rename a profile the user named: the 400 that a
  // grab aimed at an *arr profile returns asks for exactly this switch.
  assert.match(
    profilesJs,
    /setWizardField\(el\.wizardProfileName, presetDisplayName\(\s*fieldValue\(el\.wizardProfileName\),\s*previousDetail\.label,\s*nextDetail\.label,\s*\)\)/,
  );

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

test('grab profiles carry no RPC path at all', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  // Nothing derives one any more. profiles.rpc_path is nullable, so a grab
  // profile simply has none — the derived /grab/<slug>/rpc was an artefact of
  // the column being NOT NULL UNIQUE, and it doubled as a live Transmission
  // endpoint an *arr could add into.
  assert.doesNotMatch(profilesJs, /grabRpcPathForName/);
  assert.doesNotMatch(profilesJs, /syncDerivedRpcPath/);
  assert.match(
    profilesJs,
    /export function rpcPathForType\(type\) \{\s*return type === GRAB_PROFILE_TYPE \? null : defaultRpcPathForType\(type\);/,
  );
  // The wizard sends the null explicitly, so switching an *arr profile to the
  // grab preset clears the path it used to hold.
  assert.match(profilesJs, /rpc_path: \(fieldValue\(el\.wizardProfileType\)[\s\S]*?=== GRAB_PROFILE_TYPE\s*\?\s*null/);
  // ...and stops demanding it before saving.
  assert.match(profilesJs, /const needsRpcPath = payload\.type !== GRAB_PROFILE_TYPE;/);
  // The client-settings preview is only ever reached for the *arr presets.
  assert.match(
    profilesJs,
    /export function getClientSettingsFromProfile[\s\S]*?defaultRpcPathForType\(profile\.type\)/,
  );
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

  // Taking the rest is the other half of the same sentence: a profile can list
  // sites and take everything unlisted, and the card has to say both.
  assert.equal(
    grabProfileSummary(['x.example'], true),
    'Browser grabs from x.example, and from any site no other profile claims.',
  );
  assert.equal(grabProfileSummary([], true), 'Browser grabs from any site no other profile claims.');

  // A grab profile never reaches the category sentence below it: it has no
  // download client, so "Uses category movies-grab." would describe nothing.
  assert.match(
    profilesJs,
    /export function profileSummary[\s\S]*?if \(isGrabProfile\(profile\)\) return grabProfileSummary\(\s*browserDomainsList\(profile\),\s*browserCatchAll\(profile\),\s*\);/,
  );
});

test('the catch-all checkbox sits with the sites it complements and is sent with them', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const stateJs = readFileSync(new URL('../src/web/state.js', import.meta.url), 'utf8');

  // Same step as Browser sites: listing sites and taking the rest are two
  // answers to one question, and the preset that hides one hides both.
  assert.match(
    html,
    /id="wizardBrowserStep"[\s\S]*?id="wizardBrowserDomains"[\s\S]*?id="wizardBrowserCatchAll"[\s\S]*?<\/section>/,
  );
  assert.match(html, /id="wizardBrowserCatchAll"[^>]*>Take grabs from any site no other profile claims</);
  assert.match(stateJs, /wizardBrowserCatchAll: document\.querySelector\('#wizardBrowserCatchAll'\)/);
  assert.match(
    profilesJs,
    /\.\.\.browserCatchAllPayload\(el\.wizardBrowserStep\.hidden, fieldChecked\(el\.wizardBrowserCatchAll\)\)/,
  );
  assert.match(profilesJs, /setWizardChecked\(el\.wizardBrowserCatchAll, browserCatchAll\(profile\)\)/);

  // Present but false is still an answer — the user cleared the box, and the
  // server has to store that. Absent is the preset never having asked.
  assert.deepEqual(browserCatchAllPayload(false, true), { browserCatchAll: true });
  assert.deepEqual(browserCatchAllPayload(false, false), { browserCatchAll: false });
  assert.deepEqual(browserCatchAllPayload(true, true), {});
  assert.ok(!('browserCatchAll' in browserCatchAllPayload(true, true)));
});

test('a grab profile card states where an unlisted site would land', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  assert.match(profilesJs, /setProfileFact\(card, 'browser-catch-all', browserCatchAllText\(profile\)\)/);
  // Neither fact means anything on a preset that never serves a grab.
  assert.match(profilesJs, /toggleProfileFact\(card, 'browser-catch-all', !isGrab\)/);
  assert.match(profilesJs, /export function browserCatchAllText[\s\S]*?'Only the sites listed'/);
});

test('the field guide calls the catch-all a fallback rather than a wildcard', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  const entry = profilesJs.slice(
    profilesJs.indexOf('wizardBrowserCatchAll: {'),
    profilesJs.indexOf('};', profilesJs.indexOf('wizardBrowserCatchAll: {')),
  );
  assert.ok(entry.length > 0, 'the catch-all help entry must exist');
  // The one misreading worth pre-empting: it does not out-rank a profile that
  // asked for a site by name.
  assert.match(entry, /fallback, not a wildcard/);
  assert.match(entry, /still wins/);
  // And the two rules a user meets next: one holder, and switching it off does
  // not release the role.
  assert.match(entry, /Only one profile/);
  assert.match(entry, /refused by name/);
});

// The extension no longer holds a Default profile, so every line of the guide
// that sent the user there is now directions to a control that is not on the
// page. The catch-all checkbox is what those lines have to name.
test('the wizard help no longer sends users to an extension default profile', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  assert.doesNotMatch(profilesJs, /default profile/i);
  assert.match(profilesJs, /any site no other profile claims/);
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
  assert.match(appPreset, /putiorr URL/);

  // Every field the grab wizard shows reads as a grab field. The put.io folder
  // entry used to answer with the category folder story that the storage help
  // two fields away says grab profiles do not have.
  const putioFolder = profilesJs.slice(
    profilesJs.indexOf('wizardPutioFolder: {'),
    profilesJs.indexOf('wizardDownloadAt: {'),
  );
  assert.ok(putioFolder.length > 0, 'the put.io folder help entry must still exist');
  assert.match(putioFolder, /paragraphs: \(profile\) => isGrabProfile\(profile\)/);
  assert.match(putioFolder, /tips: \(profile\) => isGrabProfile\(profile\)/);
  assert.match(putioFolder, /browser grabs/i);
  // The *arr wording that contradicts it stays, on the other arm of the branch.
  assert.match(putioFolder, /It is not the local folder Sonarr or Radarr imports from\./);

  // The label above the value line is *arr wording ("Download-client
  // Category") on fields a grab profile reads differently, so it resolves like
  // the rest of the entry.
  assert.match(profilesJs, /setText\(el\.wizardHelpValueLabel, resolveWizardHelpContent\(help\.valueLabel, profile, settings\) \|\| 'Current effect'\)/);
});

// Phase 2 deleted category routing. These wizard tips were still teaching it,
// which walked users into the one configuration that now hard-fails: two *arr
// apps on the shared endpoint, told no change was needed because their
// Categories matched their profile names.
//
// The replacement text has to teach the shared endpoint as it now works, not as
// the middle of this branch left it. The User-Agent came back — it is what lets
// all five *arr apps share one endpoint — so help that still said the shared
// path serves one profile and refuses once there are two would send every
// multi-app user to change a URL Base none of them needs.
test('the RPC endpoint wizard help no longer teaches category routing', () => {
  const profiles = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');

  assert.doesNotMatch(profiles, /links new downloads by their category folder/);
  assert.doesNotMatch(profiles, /No \*arr change is required when its Category matches/);
  assert.doesNotMatch(profiles, /request path is the only thing that tells putiorr which profile/);
  assert.doesNotMatch(profiles, /only while one RR profile could have meant it/);
  // What replaces them: the path is the override and always wins, the app's own
  // name is what makes the shared endpoint work, and the category is a folder.
  assert.match(profiles, /that answer wins over every other way a request can be attributed/);
  assert.match(profiles, /identified by the name it puts in its own User-Agent/);
  assert.match(profiles, /never overruled by the User-Agent/);
  assert.match(profiles, /Category then only names the subfolder/);
});

// Deleting a profile used to fire the moment the button was clicked, with no
// confirmation at all, while the server refused it outright for any profile
// that owned a download. The dialog is the prompt design decision 5 asks for,
// plus the project owner's third answer.
test('the profile delete dialog offers move, remove, and the two delete options', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');

  for (const testId of [
    'profile-delete-dialog',
    'profile-delete-summary',
    'profile-delete-mode-move',
    'profile-delete-mode-delete',
    'profile-delete-target',
    'profile-delete-remote',
    'profile-delete-local',
    'profile-delete-outcome',
    'profile-delete-submit',
  ]) {
    assert.match(html, new RegExp(`data-testid="${testId}"`));
  }

  // Neither flag defaults to true, and the dialog opens with no answer chosen
  // so nothing is committed by pressing Enter.
  assert.match(profilesJs, /setCheckboxChecked\(el\.profileDeleteRemote, false\)/);
  assert.match(profilesJs, /setCheckboxChecked\(el\.profileDeleteLocal, false\)/);
  assert.match(profilesJs, /el\.profileDeleteMode\.value = '';/);
  assert.doesNotMatch(html, /id="profileDeleteRemote"[^>]*\schecked/);
  assert.doesNotMatch(html, /id="profileDeleteLocal"[^>]*\schecked/);

  // The counts come from the server, not from the downloads list: tombstoned
  // downloads are not in that list and still block the delete.
  assert.match(profilesJs, /api\(`\/api\/profiles\/\$\{id\}\/deletion-preview`\)/);
  // One intent per request: moving sends only reassignTo, removing sends only
  // the delete flags.
  assert.match(profilesJs, /profileDeletionRequest\(pending\.preview, profileDeleteChoice\(\)\)/);
  assert.match(appJs, /el\.profileDeleteForm\.addEventListener\('submit'/);
});

// A download moved to a profile that auto-removes completed downloads leaves
// putiorr the moment it finishes, taking the *arr's queue item with it before
// the import runs. The picker names the preset and the confirmation names the
// consequence, so the choice is not offered blind.
test('the move picker names the preset it would hand the downloads to', () => {
  const profilesJs = readFileSync(new URL('../src/web/profiles.js', import.meta.url), 'utf8');
  const utilJs = readFileSync(new URL('../src/web/util.js', import.meta.url), 'utf8');

  assert.match(profilesJs, /option\.textContent = `\$\{target\.name\} \(\$\{profileType\(target\.type\)\.label\}\)`/);
  assert.match(utilJs, /target\.autoRemoveCompleted && !preview\?\.profile\?\.autoRemoveCompleted/);
});
