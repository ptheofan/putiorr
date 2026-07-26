import assert from 'node:assert/strict';
import test from 'node:test';
import {
  profileDeletionSummary,
  profileDeletionOutcome,
  profileDeletionRequest,
  fieldValue,
  fieldChecked,
  numericSelectValue,
  setNumberInput,
  numberInputValue,
  integerInputValue,
  setByteInput,
  setTimeInput,
  splitBytesForInput,
  byteInputValue,
  timeInputValue,
  syncByteInput,
  syncTimeInput,
  updateByteInputDisabledState,
  setText,
  setAttribute,
  setDataValue,
  setHidden,
  placeChildAt,
  clampPercent,
  formatBytes,
  formatWholeBytes,
  formatSpeed,
  formatWholeSpeed,
  formatEta,
  slugify,
  statusLabel,
  normalizeRpcPath,
  joinPathParts,
  defaultRpcPathForType,
  presetDisplayName,
  setProfileFact,
  escapeSvgText,
  truncateLabel,
  adoptionNoticeSummary,
  schemaMigrationSummary,
  stagingCollisionSummary,
  remoteAlreadyGoneNotice,
  schemaMigrationWarning,
} from '../src/web/util.js';

// util.js takes every element it touches as an argument and reads only a
// handful of properties off it, so these stand-ins are the whole environment it
// needs. The one exception is syncByteInput, which asks the document who has
// focus; that single property is stubbed where it is used.
function fakeInput(properties = {}) {
  return {
    value: '',
    checked: false,
    disabled: false,
    attributes: new Map(),
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    ...properties,
  };
}

function fakeByteInputs() {
  const classes = new Set();
  const wrapper = {
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  return {
    classes,
    hidden: fakeInput(),
    disabled: fakeInput({ closest: () => wrapper }),
    amount: fakeInput(),
    unit: fakeInput({ value: 'bytes' }),
  };
}

test('field readers survive the empty values Web Awesome inputs report', () => {
  assert.equal(fieldValue(fakeInput({ value: 'sonarr' })), 'sonarr');
  // wa-input reports null until it is touched, so the attribute is the value.
  assert.equal(fieldValue(fakeInput({ value: null, attributes: new Map([['value', '/movies']]) })), '/movies');
  assert.equal(fieldValue(fakeInput({ value: null })), '');
  assert.equal(fieldValue(undefined), '');
  assert.equal(fieldValue({}), '');

  assert.equal(fieldChecked(fakeInput({ checked: true })), true);
  assert.equal(fieldChecked(fakeInput({ attributes: new Map([['checked', '']]) })), true);
  assert.equal(fieldChecked(fakeInput()), false);
  assert.equal(fieldChecked(undefined), false);
});

test('numeric field readers reject everything that is not a positive number', () => {
  assert.equal(numericSelectValue('3'), 3);
  assert.equal(numericSelectValue(7), 7);
  assert.equal(numericSelectValue('0'), null);
  assert.equal(numericSelectValue('-2'), null);
  assert.equal(numericSelectValue('none'), null);
  assert.equal(numericSelectValue(''), null);

  assert.equal(numberInputValue(fakeInput({ value: '42' })), 42);
  assert.equal(numberInputValue(fakeInput({ value: '0' })), 0);
  assert.equal(numberInputValue(fakeInput({ value: 'twelve' })), 0);
  assert.equal(integerInputValue(fakeInput({ value: '12.9' })), 12);
  assert.equal(integerInputValue(fakeInput({ value: '-4' })), 0);
});

test('setNumberInput clamps to a whole non-negative number and skips equal writes', () => {
  const input = fakeInput({ value: '5' });
  let writes = 0;
  Object.defineProperty(input, 'value', {
    get: () => input.stored ?? '5',
    set: (next) => {
      writes += 1;
      input.stored = next;
    },
  });

  setNumberInput(input, '5');
  assert.equal(writes, 0, 'an unchanged value must not be written back');

  setNumberInput(input, '9.7');
  assert.equal(input.value, '9');
  setNumberInput(input, -3);
  assert.equal(input.value, '0');
  setNumberInput(input, undefined);
  assert.equal(input.value, '0');
  // Three calls, two writes: undefined lands on the '0' that -3 already wrote.
  assert.equal(writes, 2);
});

test('byte inputs split into the largest whole unit and read back the same bytes', () => {
  assert.deepEqual(splitBytesForInput(3 * 1024 * 1024 * 1024), { amount: 3, unit: 'gb' });
  assert.deepEqual(splitBytesForInput(5 * 1024 * 1024), { amount: 5, unit: 'mb' });
  assert.deepEqual(splitBytesForInput(1500), { amount: 1500, unit: 'bytes' });
  assert.deepEqual(splitBytesForInput(0), { amount: 0, unit: 'bytes' });

  const fields = fakeByteInputs();
  setByteInput(fields.hidden, fields.disabled, fields.amount, fields.unit, 100 * 1024 * 1024);
  assert.equal(fields.hidden.value, String(100 * 1024 * 1024));
  assert.equal(fields.disabled.checked, false);
  assert.equal(fields.amount.value, '100');
  assert.equal(fields.unit.value, 'mb');
  assert.equal(fields.classes.has('is-disabled'), false);
  assert.equal(byteInputValue(fields.disabled, fields.amount, fields.unit), 100 * 1024 * 1024);

  // Zero is how the form spells "off", so the amount is emptied and the row is
  // greyed out rather than showing a meaningless 0.
  setByteInput(fields.hidden, fields.disabled, fields.amount, fields.unit, 0);
  assert.equal(fields.hidden.value, '0');
  assert.equal(fields.disabled.checked, true);
  assert.equal(fields.amount.value, '');
  assert.equal(fields.amount.disabled, true);
  assert.equal(fields.classes.has('is-disabled'), true);
  assert.equal(byteInputValue(fields.disabled, fields.amount, fields.unit), 0);
});

test('byteInputValue falls back to bytes for a unit it does not know', () => {
  const fields = fakeByteInputs();
  fields.amount.value = '12';
  fields.unit.value = 'furlongs';
  assert.equal(byteInputValue(fields.disabled, fields.amount, fields.unit), 12);
});

test('time inputs store seconds and multiply the chosen unit back out', () => {
  const hidden = fakeInput();
  const amount = fakeInput();
  const unit = fakeInput();

  setTimeInput(hidden, amount, unit, 90);
  assert.equal(hidden.value, '90');
  assert.equal(amount.value, '90');
  assert.equal(unit.value, 'seconds');
  assert.equal(timeInputValue(amount, unit), 90);

  unit.value = 'minutes';
  amount.value = '3';
  assert.equal(timeInputValue(amount, unit), 180);
  unit.value = 'fortnights';
  assert.equal(timeInputValue(amount, unit), 3);

  setTimeInput(hidden, amount, unit, -5);
  assert.equal(hidden.value, '0');
});

test('sync helpers strip non-digits before recomputing the hidden value', () => {
  const fields = fakeByteInputs();
  fields.amount.value = '1a2b3';
  fields.unit.value = 'mb';
  syncByteInput(fields.hidden, fields.disabled, fields.amount, fields.unit);
  assert.equal(fields.amount.value, '123');
  assert.equal(fields.hidden.value, String(123 * 1024 * 1024));

  const hidden = fakeInput();
  const amount = fakeInput({ value: '4 5m' });
  const unit = fakeInput({ value: 'minutes' });
  syncTimeInput(hidden, amount, unit);
  assert.equal(amount.value, '45');
  assert.equal(hidden.value, String(45 * 60));
});

test('clearing the amount while the disable checkbox has focus refills it with 1', () => {
  // The only line in util.js that reads the document: emptying the field is
  // what re-enabling the row looks like, and an empty amount would read back as
  // "off" again the moment it is saved.
  const previousDocument = globalThis.document;
  const fields = fakeByteInputs();
  globalThis.document = { activeElement: fields.disabled };
  try {
    fields.amount.value = '';
    fields.unit.value = 'bytes';
    syncByteInput(fields.hidden, fields.disabled, fields.amount, fields.unit);
    assert.equal(fields.amount.value, '1');
    assert.equal(fields.hidden.value, '1');

    // The same empty field with the focus elsewhere is left as the user typed it.
    globalThis.document = { activeElement: undefined };
    fields.amount.value = '';
    syncByteInput(fields.hidden, fields.disabled, fields.amount, fields.unit);
    assert.equal(fields.amount.value, '');
    assert.equal(fields.hidden.value, '0');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('updateByteInputDisabledState mirrors the checkbox onto the row it owns', () => {
  const fields = fakeByteInputs();
  fields.disabled.checked = true;
  updateByteInputDisabledState(fields.disabled, fields.amount, fields.unit);
  assert.equal(fields.amount.disabled, true);
  assert.equal(fields.unit.disabled, true);
  assert.equal(fields.classes.has('is-disabled'), true);

  fields.disabled.checked = false;
  updateByteInputDisabledState(fields.disabled, fields.amount, fields.unit);
  assert.equal(fields.amount.disabled, false);
  assert.equal(fields.unit.disabled, false);
  assert.equal(fields.classes.has('is-disabled'), false);

  // A checkbox outside a .byte-input wrapper still toggles its two fields.
  const orphan = fakeInput({ checked: true, closest: () => null });
  updateByteInputDisabledState(orphan, fields.amount, fields.unit);
  assert.equal(fields.amount.disabled, true);
});

test('DOM writers only touch a property that is actually changing', () => {
  const element = { textContent: 'Sonarr' };
  let writes = 0;
  Object.defineProperty(element, 'textContent', {
    get: () => element.stored ?? 'Sonarr',
    set: (next) => {
      writes += 1;
      element.stored = next;
    },
  });
  setText(element, 'Sonarr');
  assert.equal(writes, 0);
  setText(element, 'Radarr');
  assert.equal(element.textContent, 'Radarr');
  setText(element, undefined);
  assert.equal(element.textContent, '');
  assert.equal(writes, 2);

  const attributed = fakeInput();
  let attributeWrites = 0;
  attributed.setAttribute = function setAttributeSpy(name, value) {
    attributeWrites += 1;
    this.attributes.set(name, value);
  };
  setAttribute(attributed, 'title', '/putiorr/sonarr');
  setAttribute(attributed, 'title', '/putiorr/sonarr');
  assert.equal(attributed.getAttribute('title'), '/putiorr/sonarr');
  assert.equal(attributeWrites, 1);

  const dataElement = { dataset: { tone: 'info' } };
  setDataValue(dataElement, 'tone', 'info');
  setDataValue(dataElement, 'tone', 'warn');
  assert.equal(dataElement.dataset.tone, 'warn');

  const hideable = { hidden: false };
  setHidden(hideable, true);
  assert.equal(hideable.hidden, true);
  setHidden(hideable, true);
  assert.equal(hideable.hidden, true);
  setHidden(hideable, false);
  assert.equal(hideable.hidden, false);
});

test('placeChildAt moves a child only when it is not already in that slot', () => {
  const first = { id: 'first' };
  const second = { id: 'second' };
  const moved = [];
  const parent = {
    children: [first, second],
    insertBefore(child, before) {
      moved.push([child.id, before?.id ?? null]);
    },
  };

  placeChildAt(parent, first, 0);
  assert.deepEqual(moved, [], 'a child already in place is left alone');

  placeChildAt(parent, second, 0);
  assert.deepEqual(moved, [['second', 'first']]);

  // Past the end there is nothing to insert before, which appends.
  placeChildAt(parent, first, 5);
  assert.deepEqual(moved.at(-1), ['first', null]);
});

test('clampPercent keeps progress inside 0..100 and rounds it', () => {
  assert.equal(clampPercent(-12), 0);
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(41.6), 42);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(180), 100);
  assert.equal(clampPercent(undefined), 0);
});

test('byte and speed formatters pick a unit and keep zero readable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5 GB');

  assert.equal(formatWholeBytes(0), '0 B');
  assert.equal(formatWholeBytes(900), '900 B');
  assert.equal(formatWholeBytes(1536), '2 KB');
  assert.equal(formatWholeBytes(3 * 1024 * 1024), '3 MB');
  assert.equal(formatWholeBytes(4 * 1024 * 1024 * 1024), '4 GB');

  // Idle is the state, not a rate: a download waiting on put.io shows no 0 B/s.
  assert.equal(formatSpeed(0), 'Idle');
  assert.equal(formatSpeed(700), '700 B/s');
  assert.equal(formatSpeed(2048), '2.0 KB/s');
  assert.equal(formatSpeed(6 * 1024 * 1024), '6.0 MB/s');
  assert.equal(formatSpeed(1.5 * 1024 * 1024 * 1024), '1.5 GB/s');

  assert.equal(formatWholeSpeed(0), 'Idle');
  assert.equal(formatWholeSpeed(800), '800 B/s');
  assert.equal(formatWholeSpeed(2048), '2 KB/s');
  assert.equal(formatWholeSpeed(6 * 1024 * 1024), '6 MB/s');
  assert.equal(formatWholeSpeed(2 * 1024 * 1024 * 1024), '2 GB/s');
});

test('formatEta reports seconds, minutes, hours, and an unknown remainder', () => {
  assert.equal(formatEta(-1), 'ETA unavailable');
  assert.equal(formatEta(undefined), 'ETA unavailable');
  assert.equal(formatEta(45), '45s');
  assert.equal(formatEta(150), '3m');
  assert.equal(formatEta(3 * 3600), '3h');
});

test('slugify produces the category an *arr app matches on', () => {
  assert.equal(slugify('Sonarr'), 'sonarr');
  assert.equal(slugify('Sonarr 4K!'), 'sonarr-4k');
  assert.equal(slugify('  --Movies Grab--  '), 'movies-grab');
  assert.equal(slugify(''), 'profile');
  assert.equal(slugify('***'), 'profile');
  assert.equal(slugify(undefined), 'profile');
});

test('statusLabel names every download state it is given', () => {
  assert.equal(statusLabel('complete'), 'Complete');
  assert.equal(statusLabel('downloading'), 'Active');
  assert.equal(statusLabel('failed'), 'Failed');
  assert.equal(statusLabel('queued'), 'Pending');
  assert.equal(statusLabel(undefined), 'Pending');
});

test('RPC paths are rooted and derived per preset', () => {
  assert.equal(normalizeRpcPath('/sonarr/transmission/rpc'), '/sonarr/transmission/rpc');
  assert.equal(normalizeRpcPath('sonarr/transmission/rpc'), '/sonarr/transmission/rpc');
  assert.equal(normalizeRpcPath('  /radarr/rpc  '), '/radarr/rpc');
  assert.equal(normalizeRpcPath(''), '', 'an empty path stays empty so the wizard can refuse it');
  assert.equal(normalizeRpcPath(undefined), '');

  assert.equal(defaultRpcPathForType('sonarr'), '/sonarr/transmission/rpc');
  assert.equal(defaultRpcPathForType('Putiorr Grab'), '/putiorr-grab/transmission/rpc');
  assert.equal(defaultRpcPathForType(''), '/sonarr/transmission/rpc');
  assert.equal(defaultRpcPathForType(undefined), '/sonarr/transmission/rpc');
});

test('joinPathParts builds the category folder without doubling separators', () => {
  assert.equal(joinPathParts('/putiorr', 'sonarr'), '/putiorr/sonarr');
  assert.equal(joinPathParts('/putiorr/', '/sonarr'), '/putiorr/sonarr');
  assert.equal(joinPathParts('/putiorr', ''), '/putiorr');
  assert.equal(joinPathParts('', 'sonarr'), '/sonarr');
  assert.equal(joinPathParts('', ''), '');
});

test('presetDisplayName keeps a name the user typed and follows the preset otherwise', () => {
  // The 400 a grab aimed at an *arr profile returns tells the user to switch
  // that profile's preset; doing so must not rename their profile.
  assert.equal(presetDisplayName('Movies 4K', 'Sonarr', 'Putiorr Grab'), 'Movies 4K');
  assert.equal(presetDisplayName('Sonarr', 'Sonarr', 'Putiorr Grab'), 'Putiorr Grab');
  assert.equal(presetDisplayName('  Sonarr  ', 'Sonarr', 'Radarr'), 'Radarr');
  assert.equal(presetDisplayName('', 'Sonarr', 'Radarr'), 'Radarr');
  assert.equal(presetDisplayName(undefined, 'Sonarr', 'Radarr'), 'Radarr');
  assert.equal(presetDisplayName('sonarr', 'Sonarr', 'Radarr'), 'sonarr', 'the match is exact, not case-folded');
});

test('setProfileFact writes the fact and the title that reveals the ellipsized rest', () => {
  const dd = fakeInput({ textContent: '' });
  const card = { querySelector: (selector) => (selector === '[data-role="rpc"]' ? dd : null) };

  setProfileFact(card, 'rpc', '/grab/movies-grab/rpc');
  assert.equal(dd.textContent, '/grab/movies-grab/rpc');
  assert.equal(dd.getAttribute('title'), '/grab/movies-grab/rpc');
});

test('escapeSvgText and truncateLabel keep topology labels safe and short', () => {
  assert.equal(escapeSvgText('Movies & <Grab>'), 'Movies &amp; &lt;Grab&gt;');
  assert.equal(escapeSvgText(undefined), '');

  assert.equal(truncateLabel('Sonarr', 10), 'Sonarr');
  assert.equal(truncateLabel('Sonarr Anime 4K', 10), 'Sonarr An…');
  assert.equal(truncateLabel('Sonarr', 6), 'Sonarr');
  assert.equal(truncateLabel(undefined, 5), '');
});

// The upgrade's fallout has to reach the dashboard, not just the log: a NAS
// user never reads the log, and "nothing happened" and "seven downloads were
// quarantined" look identical without it.
test('the schema migration summary names what the upgrade actually did', () => {
  assert.equal(schemaMigrationSummary(undefined), '');
  assert.equal(schemaMigrationSummary({}), '');
  // A clean upgrade of a database with nothing unusual in it says nothing.
  assert.equal(schemaMigrationSummary({
    downloads: { migrated: 0, adoptedBySoleProfile: 0, ownerless: [], noPutioId: [], extraAssociations: [] },
    profiles: { downloadProfilesAssigned: 0, grabRpcPathsCleared: 0 },
  }), '');

  assert.equal(
    schemaMigrationSummary({ downloads: { migrated: 1, ownerless: [], noPutioId: [], extraAssociations: [] } }),
    'The last database upgrade migrated 1 download. Files on disk were not touched.',
  );

  const busy = schemaMigrationSummary({
    downloads: {
      migrated: 42,
      adoptedBySoleProfile: 3,
      ownerless: [{}, {}],
      noPutioId: [{}],
      extraAssociations: [{}],
    },
    profiles: { downloadProfilesAssigned: 2, grabRpcPathsCleared: 1 },
  });
  assert.match(busy, /migrated 42 downloads/);
  assert.match(busy, /assigned 3 downloads to the only profile/);
  assert.match(busy, /quarantined 4 downloads/);
  assert.match(busy, /gave 2 profiles the default download profile/);
  assert.match(busy, /retired 1 Putiorr Grab RPC endpoint\./);
  assert.match(busy, /Files on disk were not touched\./);
});

test('the schema migration warning covers both ways downloads go missing', () => {
  assert.equal(schemaMigrationWarning(undefined), '');
  assert.equal(schemaMigrationWarning({ downloads: { migrated: 3 } }), '');

  // Rows the upgrade could not reach at all.
  assert.match(
    schemaMigrationWarning({ downloads: { strandedLegacyRows: 2 } }),
    /2 downloads could not be read by the upgrade and are not visible here/,
  );

  // Rows an older putiorr wrote after the upgrade, which is the downgrade
  // path: zero rows in a table nobody reads is a legal answer, so silence here
  // is indistinguishable from a healthy install.
  assert.match(
    schemaMigrationWarning({ legacyTablesPresent: 1 }),
    /An older putiorr has written 1 download into storage this version cannot read/,
  );
  assert.match(schemaMigrationWarning({ legacyTablesPresent: 0 }), /pre-downloads-\*\.bak/);
});

// Audit finding 9: in the configuration the README recommends, every profile
// shares one put.io folder and nothing is ever adopted. The dashboard is where
// that has to be visible — the alternative is transfers sitting on put.io
// forever with no explanation anywhere the user looks.
test('the adoption notice names the folder, the profiles and the cost', () => {
  assert.equal(adoptionNoticeSummary(undefined), '');
  assert.equal(adoptionNoticeSummary([]), '');

  const shared = adoptionNoticeSummary([{
    putioFolderId: 42,
    folderName: 'putiorr',
    profiles: ['Sonarr', 'Radarr'],
    transferCount: 3,
  }]);
  assert.match(shared, /3 put\.io transfers/);
  assert.match(shared, /putiorr/);
  assert.match(shared, /Sonarr and Radarr/);
  assert.match(shared, /own put\.io folder/);

  const unwatched = adoptionNoticeSummary([{
    putioFolderId: 99,
    folderName: '',
    profiles: [],
    transferCount: 1,
  }]);
  assert.match(unwatched, /1 put\.io transfer in put\.io folder 99 is not downloaded/);
  assert.match(unwatched, /no RR profile/);

  // A folder with one owner that is switched off is a different problem with a
  // different fix, so it does not borrow either of the other two sentences.
  const disabled = adoptionNoticeSummary([{
    putioFolderId: 42,
    folderName: 'putiorr',
    profiles: ['Sonarr'],
    disabled: true,
    transferCount: 2,
  }]);
  assert.match(disabled, /2 put\.io transfers in put\.io folder “putiorr” are not downloaded/);
  assert.match(disabled, /RR profile Sonarr is disabled and accepts no new downloads/);
  assert.match(disabled, /Enable it to adopt them/);
});

// put.io does not deduplicate transfer names and the staging folder is the
// name, so two distinct transfers can resolve to one folder. Only the older
// one stages; without this the other looks like a download that just stopped.
test('the staging collision notice names the folder and who is using it', () => {
  assert.equal(stagingCollisionSummary(undefined), '');
  assert.equal(stagingCollisionSummary([]), '');
  assert.equal(stagingCollisionSummary([{ localPath: '/downloads/x', downloads: [{ id: 1, name: 'x' }] }]), '');

  const summary = stagingCollisionSummary([{
    localPath: '/downloads/tv/Example.Release',
    downloads: [
      { id: 4, name: 'Example.Release', profile: 'Sonarr' },
      { id: 9, name: 'Example.Release', profile: 'Sonarr' },
    ],
  }]);
  assert.match(summary, /1 download cannot start/);
  assert.match(summary, /download 4 \(Example\.Release\)/);
  assert.match(summary, /\/downloads\/tv\/Example\.Release/);
  assert.match(summary, /Rename one of them on put\.io/);
  // "Delete the one you do not want" walks into the trap on its own: a deleted
  // download that keeps its files leaves the folder full, and the survivor
  // would adopt them as its own.
  assert.match(summary, /along with its files/);

  const removed = stagingCollisionSummary([{
    localPath: '/downloads/tv/Example.Release',
    downloads: [
      { id: 4, name: 'Example.Release', removed: true },
      { id: 9, name: 'Example.Release' },
    ],
  }]);
  assert.match(removed, /deleted but still has its files in/);
});

// Deleting a profile is irreversible and reaches put.io and the disk, so the
// dialog states the outcome in counts before the user commits — and the three
// answers are exclusive per download, so exactly one outcome is ever described.
test('the profile deletion prompt states what each answer would do, in counts', () => {
  const preview = {
    profile: { id: 3, name: 'Radarr', downloadAt: '/downloads' },
    downloads: { total: 4, active: 3, removed: 1, filesOnDisk: 9, localBytes: 2048, unreadableFolders: 0 },
    reassignTargets: [{ id: 1, name: 'Sonarr', type: 'sonarr', autoRemoveCompleted: false }],
  };

  const summary = profileDeletionSummary(preview);
  assert.match(summary, /RR profile Radarr owns 4 downloads/);
  // A tombstoned download is invisible in the downloads list and still holds
  // its put.io transfer, so the count would otherwise look wrong.
  assert.match(summary, /1 of them already deleted from the list but still on put\.io/);

  assert.match(
    profileDeletionOutcome(preview, { mode: 'move', reassignTo: 1 }),
    /Moves 4 downloads to Sonarr, then deletes RR profile Radarr\./,
  );
  assert.match(
    profileDeletionOutcome(preview, { mode: 'move', reassignTo: 1 }),
    /Nothing is removed from put\.io and no files are deleted/,
  );
  // A target that auto-removes completed downloads is a different outcome, and
  // the picker offers it alongside the others: anything moved there leaves
  // putiorr the moment it finishes, so an *arr's queue item vanishes before it
  // has imported. The preset does not decide this — a Prowlarr profile and a
  // hand-toggled one do the same thing — so the flag is what is checked.
  const autoRemoving = {
    ...preview,
    reassignTargets: [{ id: 2, name: 'Browser', type: 'grab', autoRemoveCompleted: true }],
  };
  const moved = profileDeletionOutcome(autoRemoving, { mode: 'move', reassignTo: 2 });
  assert.match(moved, /Moves 4 downloads to Browser/);
  assert.match(moved, /removes completed downloads from putiorr/);
  assert.match(moved, /before your RR software has imported/);

  // An unanswered dialog describes nothing: the Delete button stays disabled
  // until it can name the outcome.
  assert.equal(profileDeletionOutcome(preview, {}), 'Choose what happens to these 4 downloads.');
  assert.equal(
    profileDeletionOutcome(preview, { mode: 'move' }),
    'Choose the RR profile that takes these 4 downloads over.',
  );

  // One download is not "these 1 download", and it is not "them" either.
  const single = { ...preview, downloads: { ...preview.downloads, total: 1, active: 1, removed: 0 } };
  assert.equal(profileDeletionOutcome(single, {}), 'Choose what happens to this download.');
  assert.equal(
    profileDeletionOutcome(single, { mode: 'move' }),
    'Choose the RR profile that takes this download over.',
  );
  assert.match(
    profileDeletionOutcome(single, { mode: 'delete' }),
    /Removes 1 download from putiorr, leaves it on put\.io/,
  );
  assert.match(
    profileDeletionOutcome(single, { mode: 'delete', deleteRemote: true }),
    /cancels its put\.io transfer/,
  );

  const kept = profileDeletionOutcome(preview, { mode: 'delete' });
  assert.match(kept, /Removes 4 downloads from putiorr, leaves them on put\.io/);
  assert.match(kept, /leaves the downloaded files on disk, then deletes RR profile Radarr\./);
  // Left on put.io in a folder no profile owns any more, they stop being
  // adoptable — the dashboard says so, so the dialog says so first.
  assert.match(kept, /unattributed/);

  const purged = profileDeletionOutcome(preview, { mode: 'delete', deleteRemote: true, deleteLocal: true });
  assert.match(purged, /cancels their 4 put\.io transfers/);
  // The count is the staging folders' own, so it says so: it includes the
  // .part files and anything else in them, which rm(recursive) takes too.
  assert.match(purged, /deletes everything in their staging folders — 9 files, 2\.0 KB/);
  assert.doesNotMatch(purged, /unattributed/);

  // A folder it could not read is named rather than quietly left out of the
  // total: silently under-reporting is the failure this count replaces.
  const partlyBlind = profileDeletionOutcome(
    { ...preview, downloads: { ...preview.downloads, unreadableFolders: 2 } },
    { mode: 'delete', deleteLocal: true },
  );
  assert.match(partlyBlind, /2 more it could not read/);
});

test('the profile deletion prompt says plainly when there is nothing to decide', () => {
  const preview = {
    profile: { id: 3, name: 'Radarr', downloadAt: '/downloads' },
    downloads: { total: 0, active: 0, removed: 0, filesOnDisk: 0, localBytes: 0, unreadableFolders: 0 },
    reassignTargets: [],
  };

  assert.equal(
    profileDeletionSummary(preview),
    'RR profile Radarr owns no downloads. Deleting it touches nothing on put.io or on disk.',
  );
  assert.equal(profileDeletionOutcome(preview, {}), 'Deletes RR profile Radarr.');
});

// The request body is the last thing between an unanswered dialog and a delete
// that reaches put.io and the disk, and a disabled button is not a check.
test('an unanswered profile delete dialog cannot serialise into a delete', () => {
  const preview = {
    profile: { id: 3, name: 'Radarr', downloadAt: '/downloads' },
    downloads: { total: 2, active: 2, removed: 0, filesOnDisk: 4, localBytes: 2048 },
    reassignTargets: [{ id: 1, name: 'Sonarr' }],
  };

  for (const choice of [{}, { mode: '' }, { mode: 'nonsense' }, { mode: 'move' }]) {
    assert.throws(() => profileDeletionRequest(preview, choice), /Choose what happens/);
  }

  assert.deepEqual(profileDeletionRequest(preview, { mode: 'move', reassignTo: '1' }), { reassignTo: 1 });
  assert.deepEqual(
    profileDeletionRequest(preview, { mode: 'delete', deleteRemote: true, deleteLocal: false }),
    { deleteDownloads: true, deleteRemote: true, deleteLocal: false },
  );

  // A profile that owns nothing has nothing to answer, so the empty body is
  // the whole request.
  const empty = { ...preview, downloads: { total: 0, active: 0, removed: 0, filesOnDisk: 0, localBytes: 0 } };
  assert.deepEqual(profileDeletionRequest(empty, {}), {});
});

// "putiorr deleted it" and "put.io had already lost it" are different events,
// and the second one means there is no remote copy left to re-fetch. The delete
// endpoints report which one happened; without this the dashboard closed the
// dialog on both and said neither.
test('a delete put.io had nothing left to do is reported, not folded into success', () => {
  assert.equal(remoteAlreadyGoneNotice([]), '');
  assert.equal(remoteAlreadyGoneNotice([{ ok: true }, { ok: true }]), '');
  assert.equal(remoteAlreadyGoneNotice(undefined), '');

  assert.equal(
    remoteAlreadyGoneNotice({ remoteAlreadyGone: true }),
    'Removed from putiorr. put.io no longer had 1 download, so there was nothing to delete there.',
  );
  assert.equal(
    remoteAlreadyGoneNotice([{ remoteAlreadyGone: true }, { ok: true }, { remoteAlreadyGone: true }]),
    'Removed from putiorr. put.io no longer had 2 downloads, so there was nothing to delete there.',
  );
});
