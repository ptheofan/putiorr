import { state, el } from './state.js';
import { api } from './api.js';
import { DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD } from './constants.js';
import {
  fieldValue,
  slugify,
  numericSelectValue,
  byteInputValue,
  timeInputValue,
  setByteInput,
  setTimeInput,
  syncByteInput,
  syncTimeInput,
  setText,
  setProfileFact,
  formatWholeSpeed,
  formatWholeBytes,
} from './util.js';
import { setMessage } from './putio.js';
import {
  renderProfiles,
  profileType,
  profileDisplayName,
  upsertProfileState,
} from './profiles.js';
import { loadAll } from './app.js';

export const DOWNLOAD_PROFILE_HELP = {
  downloadProfileName: {
    title: 'Name',
    paragraphs: [
      'The name is shown on download profile cards, RR profile cards, and the link dialog where RR profiles attach to downloader behavior.',
      'Create names around the shape of the files being copied locally, such as Movies, TV Episodes, Music, or Books.',
    ],
    tips: [
      'Keep names short enough to scan in RR profile cards.',
      'If two apps need different reset rules, give each behavior its own download profile.',
    ],
    valueLabel: 'Generated slug',
    value: (profile) => profile.slug || 'Name this profile',
  },
  downloadSlowSpeedThreshold: {
    title: 'Slow threshold',
    paragraphs: [
      'When this is greater than zero, putiorr watches the local copy speed from put.io. If the speed stays below this value for the configured duration, the local copy is reset and resumed.',
      'Use the Off checkbox to disable slow-speed resets for this profile without entering a magic zero value.',
    ],
    tips: [
      'Large movie files can usually tolerate a higher threshold than small music files.',
      'Enter an integer amount and choose bytes/s, MB/s, or GB/s from the unit selector.',
    ],
    valueLabel: 'Current threshold',
    value: (profile) => profile.slowSpeedThresholdBytesPerSecond > 0
      ? formatWholeSpeed(profile.slowSpeedThresholdBytesPerSecond)
      : 'Off: slow-speed reset disabled',
  },
  downloadSlowSpeedDuration: {
    title: 'Duration',
    paragraphs: [
      'This is how long the local copy speed must remain below the threshold before putiorr resets the stalled copy.',
      'A longer duration avoids resetting short dips. A shorter duration reacts faster to truly stuck downloads.',
    ],
    tips: [
      'Start around 60 to 120 seconds for large files.',
      'Enter an integer amount and choose seconds or minutes from the unit selector.',
    ],
    valueLabel: 'Reset after',
    value: (profile) => `${profile.slowSpeedDurationSeconds}s below threshold`,
  },
  downloadSlowSpeedGrace: {
    title: 'Startup grace',
    paragraphs: [
      'This delay starts when putiorr begins copying a file locally. Slow-speed checks wait until the grace period has passed.',
      'It prevents a reset while the transfer is still ramping up or opening the destination file.',
    ],
    tips: [
      'Keep a small grace period for fast local disks.',
      'Enter an integer amount and choose seconds or minutes from the unit selector.',
    ],
    valueLabel: 'Grace period',
    value: (profile) => `${profile.slowSpeedGraceSeconds}s before checks start`,
  },
  downloadSlowSpeedMinSize: {
    title: 'Ignore below',
    paragraphs: [
      'Files smaller than this size skip the slow-speed reset guard. That keeps tiny metadata, subtitle, sample, and music files from being reset unnecessarily.',
      'Use the Off checkbox when every file should be eligible for slow-speed checks, regardless of size.',
    ],
    tips: [
      'Music profiles usually need a much lower value than movie profiles.',
      'Enter an integer amount and choose bytes, MB, or GB from the unit selector.',
    ],
    valueLabel: 'Ignored files',
    value: (profile) => `Below ${formatWholeBytes(profile.slowSpeedMinSizeBytes)}`,
  },
};

export function renderDownloadProfiles() {
  el.downloadProfilesBody.replaceChildren();
  if (state.downloadProfiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state profile-empty';
    empty.textContent = 'No download profiles yet. Create one to control local download behavior.';
    el.downloadProfilesBody.appendChild(empty);
    return;
  }

  for (const downloadProfile of state.downloadProfiles) {
    el.downloadProfilesBody.appendChild(createDownloadProfileCard(downloadProfile));
  }
}

export function createDownloadProfileCard(downloadProfile) {
  const card = document.createElement('article');
  const usageCount = countRrProfilesUsingDownloadProfile(downloadProfile.id);
  card.className = 'profile-card download-profile-card';
  card.dataset.id = downloadProfile.id || '';
  card.innerHTML = `
    <div class="profile-card-main">
      <div>
        <div class="profile-eyebrow">Download profile</div>
        <h3 data-role="name"></h3>
        <p data-role="summary"></p>
      </div>
      <span data-role="status" class="profile-status status"></span>
    </div>
    <dl class="profile-facts">
      <div>
        <dt>Startup grace</dt>
        <dd data-role="grace"></dd>
      </div>
      <div>
        <dt>Ignore below</dt>
        <dd data-role="min-size"></dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd data-role="duration"></dd>
      </div>
      <div>
        <dt>Slow threshold</dt>
        <dd data-role="threshold"></dd>
      </div>
    </dl>
    <div class="profile-actions" aria-label="Download profile actions">
      <button data-action="edit" class="profile-action primary" type="button">Edit</button>
      <button data-action="delete" class="profile-action danger" type="button">Delete</button>
    </div>
  `;

  setText(card.querySelector('[data-role="name"]'), downloadProfile.name);
  setText(card.querySelector('[data-role="summary"]'), downloadProfileSummary(downloadProfile, usageCount));
  setText(card.querySelector('[data-role="status"]'), isDefaultDownloadProfile(downloadProfile) ? 'Default' : `${usageCount} RR`);
  card.querySelector('[data-role="status"]').className = `profile-status status ${isDefaultDownloadProfile(downloadProfile) ? 'ok' : ''}`;
  setProfileFact(
    card,
    'threshold',
    Number(downloadProfile.slowSpeedThresholdBytesPerSecond) > 0
      ? formatWholeSpeed(downloadProfile.slowSpeedThresholdBytesPerSecond)
      : 'Off',
  );
  setProfileFact(card, 'duration', `${Number(downloadProfile.slowSpeedDurationSeconds ?? 0)}s`);
  setProfileFact(card, 'grace', `${Number(downloadProfile.slowSpeedGraceSeconds ?? 0)}s`);
  setProfileFact(card, 'min-size', formatWholeBytes(downloadProfile.slowSpeedMinSizeBytes));

  card.querySelector('[data-action="edit"]').addEventListener('click', () => openDownloadProfileDialog(downloadProfile));
  const deleteButton = card.querySelector('[data-action="delete"]');
  deleteButton.hidden = isDefaultDownloadProfile(downloadProfile);
  deleteButton.addEventListener('click', () => deleteDownloadProfileById(downloadProfile.id));
  return card;
}

export function downloadProfileSummary(downloadProfile, usageCount) {
  if (isDefaultDownloadProfile(downloadProfile)) {
    return 'Fallback policy for RR profiles without a custom attachment.';
  }
  return usageCount === 1
    ? 'Attached to 1 RR profile.'
    : `Attached to ${usageCount} RR profiles.`;
}

export function countRrProfilesUsingDownloadProfile(downloadProfileId) {
  const defaultId = defaultDownloadProfileId();
  return state.profiles.filter((profile) => {
    const attachedId = profile.download_profile_id ?? profile.downloadProfileId ?? defaultId;
    return String(attachedId) === String(downloadProfileId);
  }).length;
}

export function populateDownloadProfileSelect(select, selectedId = defaultDownloadProfileId()) {
  select.replaceChildren();
  const profiles = state.downloadProfiles.length > 0
    ? state.downloadProfiles
    : [{
        id: '',
        name: 'Default',
      }];
  for (const downloadProfile of profiles) {
    const option = document.createElement('wa-option');
    option.value = downloadProfile.id == null ? '' : String(downloadProfile.id);
    option.textContent = downloadProfile.name || 'Default';
    select.appendChild(option);
  }
  const nextValue = selectedId == null ? '' : String(selectedId);
  if (Array.from(select.querySelectorAll('wa-option')).some((option) => option.value === nextValue)) {
    select.value = nextValue;
  }
}

export function openDownloadProfileDialog(downloadProfile = createDefaultDownloadProfile()) {
  const isExisting = Boolean(downloadProfile.id);
  el.downloadProfileDialogTitle.textContent = isExisting
    ? `Download profile: ${downloadProfile.name}`
    : 'New download profile';
  el.downloadProfileId.value = downloadProfile.id || '';
  el.downloadProfileName.value = downloadProfile.name || '';
  setByteInput(
    el.downloadSlowSpeedThreshold,
    el.downloadSlowSpeedThresholdDisabled,
    el.downloadSlowSpeedThresholdAmount,
    el.downloadSlowSpeedThresholdUnit,
    downloadProfile.slowSpeedThresholdBytesPerSecond ?? 0,
  );
  setTimeInput(
    el.downloadSlowSpeedDuration,
    el.downloadSlowSpeedDurationAmount,
    el.downloadSlowSpeedDurationUnit,
    downloadProfile.slowSpeedDurationSeconds ?? 120,
  );
  setTimeInput(
    el.downloadSlowSpeedGrace,
    el.downloadSlowSpeedGraceAmount,
    el.downloadSlowSpeedGraceUnit,
    downloadProfile.slowSpeedGraceSeconds ?? 30,
  );
  setByteInput(
    el.downloadSlowSpeedMinSize,
    el.downloadSlowSpeedMinSizeDisabled,
    el.downloadSlowSpeedMinSizeAmount,
    el.downloadSlowSpeedMinSizeUnit,
    downloadProfile.slowSpeedMinSizeBytes ?? 100 * 1024 * 1024,
  );
  el.deleteDownloadProfileButton.hidden = !isExisting || isDefaultDownloadProfile(downloadProfile);
  el.saveDownloadProfileButton.textContent = isExisting ? 'Save profile' : 'Create profile';
  setDownloadProfileMessage('');
  setDownloadProfileHelpForField(DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD);

  el.downloadProfileDialog.open = true;
  el.downloadProfileName.focus();
}

export function closeDownloadProfileDialog() {
  if (el.downloadProfileDialog.open) el.downloadProfileDialog.open = false;
}

export function createDefaultDownloadProfile() {
  const fallback = state.settings?.downloadPolicy ?? state.downloadProfiles[0] ?? {};
  return {
    id: '',
    name: '',
    slowSpeedThresholdBytesPerSecond: fallback.slowSpeedThresholdBytesPerSecond ?? 0,
    slowSpeedDurationSeconds: fallback.slowSpeedDurationSeconds ?? 120,
    slowSpeedGraceSeconds: fallback.slowSpeedGraceSeconds ?? 30,
    slowSpeedMinSizeBytes: fallback.slowSpeedMinSizeBytes ?? 100 * 1024 * 1024,
  };
}

export function getDownloadProfilePayload() {
  return {
    name: fieldValue(el.downloadProfileName).trim(),
    slug: slugify(fieldValue(el.downloadProfileName)),
    slowSpeedThresholdBytesPerSecond: byteInputValue(
      el.downloadSlowSpeedThresholdDisabled,
      el.downloadSlowSpeedThresholdAmount,
      el.downloadSlowSpeedThresholdUnit,
    ),
    slowSpeedDurationSeconds: timeInputValue(el.downloadSlowSpeedDurationAmount, el.downloadSlowSpeedDurationUnit),
    slowSpeedGraceSeconds: timeInputValue(el.downloadSlowSpeedGraceAmount, el.downloadSlowSpeedGraceUnit),
    slowSpeedMinSizeBytes: byteInputValue(
      el.downloadSlowSpeedMinSizeDisabled,
      el.downloadSlowSpeedMinSizeAmount,
      el.downloadSlowSpeedMinSizeUnit,
    ),
  };
}

export function updateDownloadProfileHelp(event) {
  const fieldId = getDownloadProfileHelpFieldFromEvent(event);
  if (fieldId) el.downloadProfileDialog.dataset.activeHelpField = fieldId;
  syncDownloadProfileTimeInputs();
  syncDownloadProfileByteInputs();
  setDownloadProfileHelpForField(el.downloadProfileDialog.dataset.activeHelpField || DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD);
}

export function getDownloadProfileHelpFieldFromEvent(event) {
  const fieldId = event?.target?.closest?.('[data-help-field]')?.dataset.helpField || event?.target?.id;
  return DOWNLOAD_PROFILE_HELP[fieldId] ? fieldId : '';
}

export function syncDownloadProfileByteInputs() {
  syncByteInput(
    el.downloadSlowSpeedThreshold,
    el.downloadSlowSpeedThresholdDisabled,
    el.downloadSlowSpeedThresholdAmount,
    el.downloadSlowSpeedThresholdUnit,
  );
  syncByteInput(
    el.downloadSlowSpeedMinSize,
    el.downloadSlowSpeedMinSizeDisabled,
    el.downloadSlowSpeedMinSizeAmount,
    el.downloadSlowSpeedMinSizeUnit,
  );
}

export function syncDownloadProfileTimeInputs() {
  syncTimeInput(el.downloadSlowSpeedDuration, el.downloadSlowSpeedDurationAmount, el.downloadSlowSpeedDurationUnit);
  syncTimeInput(el.downloadSlowSpeedGrace, el.downloadSlowSpeedGraceAmount, el.downloadSlowSpeedGraceUnit);
}

export function setDownloadProfileHelpForField(fieldId = DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD, profile = getDownloadProfilePayload()) {
  const nextFieldId = DOWNLOAD_PROFILE_HELP[fieldId] ? fieldId : DEFAULT_DOWNLOAD_PROFILE_HELP_FIELD;
  const help = DOWNLOAD_PROFILE_HELP[nextFieldId];
  el.downloadProfileDialog.dataset.activeHelpField = nextFieldId;
  setText(el.downloadProfileHelpKicker, 'Field guide');
  setText(el.downloadProfileHelpTitle, help.title);
  setText(el.downloadProfileHelpValueLabel, help.valueLabel || 'Current value');
  setText(el.downloadProfileHelpValue, resolveDownloadProfileHelpValue(help, profile));
  renderDownloadProfileHelpParagraphs(resolveDownloadProfileHelpContent(help.paragraphs, profile));
  renderDownloadProfileHelpList(resolveDownloadProfileHelpContent(help.tips, profile));
}

export function resolveDownloadProfileHelpContent(content, profile) {
  return typeof content === 'function' ? content(profile) : content;
}

export function resolveDownloadProfileHelpValue(help, profile) {
  return typeof help.value === 'function' ? help.value(profile) : help.value;
}

export function renderDownloadProfileHelpParagraphs(paragraphs = []) {
  el.downloadProfileHelpBody.replaceChildren();
  for (const paragraphText of paragraphs) {
    const paragraph = document.createElement('p');
    setText(paragraph, paragraphText);
    el.downloadProfileHelpBody.appendChild(paragraph);
  }
}

export function renderDownloadProfileHelpList(items = []) {
  el.downloadProfileHelpList.replaceChildren();
  for (const itemText of items) {
    const item = document.createElement('li');
    setText(item, itemText);
    el.downloadProfileHelpList.appendChild(item);
  }
}

export async function saveDownloadProfileFromDialog() {
  const id = el.downloadProfileId.value;
  const payload = getDownloadProfilePayload();
  if (!payload.name) {
    setDownloadProfileMessage('Download profile name is required.', 'error');
    return;
  }

  el.saveDownloadProfileButton.disabled = true;
  try {
    const savedProfile = id
      ? await api(`/api/download-profiles/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      })
      : await api('/api/download-profiles', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    upsertDownloadProfileState(savedProfile);
    renderProfiles();
    renderDownloadProfiles();
    closeDownloadProfileDialog();
    setMessage('Download profile saved.', 'ok');
  } catch (error) {
    setDownloadProfileMessage(error.message, 'error');
  } finally {
    el.saveDownloadProfileButton.disabled = false;
  }
}

export function upsertDownloadProfileState(downloadProfile) {
  const index = state.downloadProfiles.findIndex((existing) => String(existing.id) === String(downloadProfile.id));
  if (index >= 0) state.downloadProfiles[index] = downloadProfile;
  else state.downloadProfiles.push(downloadProfile);
}

export async function deleteDownloadProfileById(id = el.downloadProfileId.value) {
  if (!id) {
    closeDownloadProfileDialog();
    return;
  }

  await api(`/api/download-profiles/${id}`, { method: 'DELETE' });
  closeDownloadProfileDialog();
  setMessage('Download profile deleted.', 'ok');
  await loadAll();
}

export function openProfileLinksDialog() {
  renderProfileLinksList();
  setProfileLinksMessage('');

  el.profileLinksDialog.open = true;
  el.profileLinksList.querySelector('wa-select')?.focus();
}

export function closeProfileLinksDialog() {
  if (el.profileLinksDialog.open) el.profileLinksDialog.open = false;
}

export function renderProfileLinksList() {
  el.profileLinksList.replaceChildren();
  if (state.profiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Create an RR profile before linking download profiles.';
    el.profileLinksList.appendChild(empty);
    return;
  }

  for (const profile of state.profiles) {
    el.profileLinksList.appendChild(createProfileLinkRow(profile));
  }
}

export function createProfileLinkRow(profile) {
  const row = document.createElement('div');
  const selectedId = currentProfileDownloadProfileId(profile);
  row.className = 'link-row';
  row.dataset.id = profile.id || '';
  row.dataset.initialDownloadProfileId = selectedId == null ? '' : String(selectedId);
  row.innerHTML = `
    <div class="link-profile">
      <strong data-role="name"></strong>
      <span data-role="meta"></span>
    </div>
    <wa-select label="Download profile" data-role="download-profile"></wa-select>
  `;

  setText(row.querySelector('[data-role="name"]'), profileDisplayName(profile));
  setText(row.querySelector('[data-role="meta"]'), `${profileType(profile.type).label} · ${profile.rpc_path || 'No RPC path'}`);
  populateDownloadProfileSelect(row.querySelector('[data-role="download-profile"]'), selectedId);
  return row;
}

export function currentProfileDownloadProfileId(profile) {
  return profile.download_profile_id ?? profile.downloadProfileId ?? defaultDownloadProfileId();
}

export async function saveProfileLinksFromDialog() {
  const rows = Array.from(el.profileLinksList.querySelectorAll('.link-row[data-id]'));
  const changes = rows.map((row) => {
    const select = row.querySelector('[data-role="download-profile"]');
    return {
      id: row.dataset.id,
      initialDownloadProfileId: row.dataset.initialDownloadProfileId,
      downloadProfileId: select?.value ?? '',
    };
  }).filter((change) => change.id && change.downloadProfileId !== change.initialDownloadProfileId);

  if (changes.length === 0) {
    setProfileLinksMessage('No link changes to save.', 'neutral');
    return;
  }

  el.saveProfileLinksButton.disabled = true;
  try {
    const savedProfiles = await Promise.all(changes.map((change) => api(`/api/profiles/${change.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        download_profile_id: numericSelectValue(change.downloadProfileId),
      }),
    })));
    for (const profile of savedProfiles) upsertProfileState(profile);
    renderProfiles();
    renderDownloadProfiles();
    closeProfileLinksDialog();
    setMessage('RR profile links saved.', 'ok');
  } catch (error) {
    setProfileLinksMessage(error.message, 'error');
  } finally {
    el.saveProfileLinksButton.disabled = false;
  }
}

export function setDownloadProfileMessage(message, tone = 'neutral') {
  el.downloadProfileMessage.textContent = message;
  el.downloadProfileMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

export function setProfileLinksMessage(message, tone = 'neutral') {
  el.profileLinksMessage.textContent = message;
  el.profileLinksMessage.style.color = tone === 'error' ? '#b42318' : tone === 'ok' ? '#16803f' : '#647275';
}

export function defaultDownloadProfileId() {
  return state.settings?.defaultDownloadProfileId
    ?? state.downloadProfiles.find((profile) => profile.slug === 'default')?.id
    ?? state.downloadProfiles[0]?.id
    ?? null;
}

export function isDefaultDownloadProfile(downloadProfile) {
  return String(downloadProfile?.id) === String(defaultDownloadProfileId()) || downloadProfile?.slug === 'default';
}

export function findDownloadProfile(id) {
  const targetId = id ?? defaultDownloadProfileId();
  return state.downloadProfiles.find((profile) => String(profile.id) === String(targetId));
}

export function downloadProfileDisplayName(id) {
  return findDownloadProfile(id)?.name ?? 'Default';
}
