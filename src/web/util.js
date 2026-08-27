import { BYTE_UNITS, TIME_UNITS, DEFAULT_PROFILE_TYPE, PROFILE_TYPES } from './constants.js';

// Web Awesome inputs (wa-input/wa-select) return `null` for an empty value
// rather than ''. Normalize to a string so the many `.value.trim()` reads below
// never throw on untouched fields.
export function fieldValue(input) {
  return String(input?.value ?? input?.getAttribute?.('value') ?? '');
}

// The property is the live state; the attribute is only the state the markup
// or a setWizardChecked call started it in. A wa-checkbox flips the property
// when the user clicks it and leaves the attribute alone, so reading the two
// with `||` made every box the wizard pre-checked impossible to uncheck — the
// stale attribute outvoted the user. Fall back to the attribute only for an
// element that has no property yet, i.e. a custom element still upgrading.
export function fieldChecked(input) {
  if (!input) return false;
  if (typeof input.checked === 'boolean') return input.checked;
  return Boolean(input.hasAttribute?.('checked'));
}

export function numericSelectValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function setNumberInput(input, value) {
  const nextValue = String(Math.max(0, Number.parseInt(value ?? 0, 10) || 0));
  if (input.value !== nextValue) input.value = nextValue;
}

export function numberInputValue(input) {
  const parsed = Number.parseInt(input.value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function integerInputValue(input) {
  const parsed = Number.parseInt(input.value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function setByteInput(hiddenInput, disabledInput, amountInput, unitInput, value) {
  const bytes = Math.max(0, Number.parseInt(value ?? 0, 10) || 0);
  const disabled = bytes <= 0;
  hiddenInput.value = String(bytes);
  disabledInput.checked = disabled;

  const { amount, unit } = splitBytesForInput(bytes);
  amountInput.value = disabled ? '' : String(amount);
  unitInput.value = unit;
  updateByteInputDisabledState(disabledInput, amountInput, unitInput);
}

export function setTimeInput(hiddenInput, amountInput, unitInput, value) {
  const seconds = Math.max(0, Number.parseInt(value ?? 0, 10) || 0);
  hiddenInput.value = String(seconds);
  amountInput.value = String(seconds);
  unitInput.value = 'seconds';
}

export function splitBytesForInput(bytes) {
  if (bytes > 0 && bytes % BYTE_UNITS.gb === 0) {
    return { amount: bytes / BYTE_UNITS.gb, unit: 'gb' };
  }
  if (bytes > 0 && bytes % BYTE_UNITS.mb === 0) {
    return { amount: bytes / BYTE_UNITS.mb, unit: 'mb' };
  }
  return { amount: bytes, unit: 'bytes' };
}

export function byteInputValue(disabledInput, amountInput, unitInput) {
  if (disabledInput.checked) return 0;
  return integerInputValue(amountInput) * (BYTE_UNITS[unitInput.value] ?? BYTE_UNITS.bytes);
}

export function timeInputValue(amountInput, unitInput) {
  return integerInputValue(amountInput) * (TIME_UNITS[unitInput.value] ?? TIME_UNITS.seconds);
}

export function syncByteInput(hiddenInput, disabledInput, amountInput, unitInput) {
  amountInput.value = amountInput.value.replace(/[^\d]/g, '');
  if (!disabledInput.checked && amountInput.value === '' && document.activeElement === disabledInput) {
    amountInput.value = '1';
  }
  hiddenInput.value = String(byteInputValue(disabledInput, amountInput, unitInput));
  updateByteInputDisabledState(disabledInput, amountInput, unitInput);
}

export function syncTimeInput(hiddenInput, amountInput, unitInput) {
  amountInput.value = amountInput.value.replace(/[^\d]/g, '');
  hiddenInput.value = String(timeInputValue(amountInput, unitInput));
}

export function updateByteInputDisabledState(disabledInput, amountInput, unitInput) {
  const disabled = disabledInput.checked;
  const wrapper = disabledInput.closest('.byte-input');
  if (wrapper) wrapper.classList.toggle('is-disabled', disabled);
  amountInput.disabled = disabled;
  unitInput.disabled = disabled;
}

export function setText(element, value) {
  const nextValue = String(value ?? '');
  if (element.textContent !== nextValue) {
    element.textContent = nextValue;
  }
}

export function setAttribute(element, name, value) {
  const nextValue = String(value ?? '');
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
  }
}

export function setDataValue(element, name, value) {
  const nextValue = String(value ?? '');
  if (element.dataset[name] !== nextValue) {
    element.dataset[name] = nextValue;
  }
}

export function setHidden(element, hidden) {
  if (element.hidden !== hidden) {
    element.hidden = hidden;
  }
}

export function placeChildAt(parent, child, index) {
  const current = parent.children[index] ?? null;
  if (current !== child) {
    parent.insertBefore(child, current);
  }
}

export function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
}

export function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatWholeBytes(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 / 1024)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatSpeed(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return 'Idle';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

export function formatWholeSpeed(value) {
  const bytes = Number(value ?? 0);
  if (bytes <= 0) return 'Idle';
  if (bytes >= 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024 / 1024)} GB/s`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB/s`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

export function formatEta(value) {
  const seconds = Number(value ?? -1);
  if (seconds < 0) return 'ETA unavailable';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function slugify(value) {
  return String(value || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'profile';
}

export function statusLabel(value) {
  switch (value) {
    case 'complete':
      return 'Complete';
    case 'downloading':
      return 'Active';
    case 'failed':
      return 'Failed';
    default:
      return 'Pending';
  }
}

export function normalizeRpcPath(value) {
  const pathValue = String(value ?? '').trim();
  if (!pathValue) return '';
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}

export function joinPathParts(base, segment) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanSegment = String(segment || '').replace(/^\/+/, '');
  if (!cleanBase) return cleanSegment ? `/${cleanSegment}` : '';
  return cleanSegment ? `${cleanBase}/${cleanSegment}` : cleanBase;
}

export function defaultRpcPathForType(type) {
  return `/${slugify(type || DEFAULT_PROFILE_TYPE)}/transmission/rpc`;
}

// A preset switch renames the profile only while the name is still the one a
// preset chose. Otherwise the refusal that tells a user to switch an *arr
// profile to Putiorr Grab would cost them the name they typed — and with it the
// slug, which is how putiorr identifies the profile everywhere else.
export function presetDisplayName(currentName, previousLabel, nextLabel) {
  const current = String(currentName ?? '').trim();
  return current === '' || current === previousLabel ? nextLabel : current;
}

// The wizard only sends the sites when it is showing them. A hidden Browser
// grabs step means the preset has none, and the field still holds whatever the
// last profile left in it: sending that would write sites onto an *arr profile
// nobody typed them for, and refuse the save over an entry that is off screen.
// The update is a partial one, so omitting the key leaves a stored list alone
// rather than clearing it.
export function browserDomainsPayload(hidden, value) {
  return hidden ? {} : { browserDomains: value };
}

// Sent under the same rule as the sites, and for the same reason: the checkbox
// exists only while the Browser grabs step is showing, so an *arr save would
// otherwise set a grab-only flag from a control nobody saw — and the save that
// did it could be refused over a second catch-all the user never asked for.
export function browserCatchAllPayload(hidden, checked) {
  return hidden ? {} : { browserCatchAll: Boolean(checked) };
}

// Issue #111. The App URL hint has to name the app the preset picked. A Radarr
// profile showing http://sonarr:8989 reads as a value to copy, and someone will
// copy it — the field takes a real URL, so a wrong hint is a wrong config, not
// just untidy copy. Host comes from the label and port from the preset, so
// there is no third list of app names to drift.
export function arrBaseUrlPlaceholder(type) {
  const preset = PROFILE_TYPES[String(type ?? '').trim().toLowerCase()];
  if (!preset?.defaultPort) return '';
  return `http://${preset.label.toLowerCase()}:${preset.defaultPort}`;
}

// Issue #111. Only a visible step sends its fields — a hidden control must
// never write a setting nobody saw, which is the same rule the browser fields
// follow. Which presets show the step lives in constants.js, shared with the
// downloader that has to act on it.
// The field is MB because nobody reasons about a release in bytes; the column
// is bytes because every size putiorr compares it against is. Anything
// unreadable becomes 0, which is "no minimum" — the harmless direction, where
// a NaN floor would reject every release.
export function minSizeMbToBytes(value) {
  const mb = Number(String(value ?? '').trim());
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 0;
}

export function minSizeBytesToMb(bytes) {
  const size = Number(bytes ?? 0);
  return Number.isFinite(size) && size > 0 ? String(Math.round(size / (1024 * 1024))) : '';
}

export function rejectionPayload(hidden, { enabled, baseUrl, apiKey, minSizeMb }) {
  if (hidden) return {};
  return {
    reject_unimportable: Boolean(enabled),
    arr_base_url: String(baseUrl ?? '').trim(),
    // Blank is "keep the stored key" all the way down: the wizard never reads
    // one back, so it cannot resubmit what it was not given.
    arr_api_key: String(apiKey ?? '').trim(),
    reject_min_size: minSizeMbToBytes(minSizeMb),
  };
}

// Stored as ISO so the row is portable; shown in the reader's own locale and
// zone, because "was that before or after I noticed the gap?" is the question
// being asked of it. An unparseable value is shown as stored rather than as
// "Invalid Date".
export function formatDateTime(value) {
  const parsed = new Date(String(value ?? ''));
  return Number.isNaN(parsed.getTime()) ? String(value ?? '') : parsed.toLocaleString();
}

// Issue #111. The count is the headline, but a rejection putiorr could not
// deliver to the *arr is the one worth reading — that release was downloaded
// and the queue item is still stuck — so it is never folded into the total.
export function rejectedReleasesSummary({ total = 0, blocklisted = 0, downloaded = 0 } = {}) {
  if (!total) return '';
  const releases = `${total} release${total === 1 ? '' : 's'}`;
  if (!downloaded) {
    return `${releases} rejected and sent back for a new search.`;
  }
  if (!blocklisted) {
    return `${releases} judged unimportable, but the app was never told — ${downloaded === 1 ? 'it was' : 'they were'} downloaded as usual and may still be stuck in its queue.`;
  }
  return `${releases} judged unimportable: ${blocklisted} blocklisted and searched again, ${downloaded} downloaded anyway because the app could not be told.`;
}

// What the takeover offer says, and what it costs. The consequence is stated
// next to the action rather than behind it: the profile it clears may not even
// be on screen, and "it worked" is no answer to "what did it do?".
export const CATCH_ALL_TAKEOVER_LABEL = 'Make this the fallback grab profile';

export function catchAllTakeoverConsequence(name) {
  return ` — this will stop ${name} being the fallback.`;
}

// The intent, added to the payload the save already had. Absent unless a
// takeover was actually asked for: without it the refusal behaves exactly as
// it always has. The holder id travels too, so a fallback that moved between
// the refusal and the click is refused again rather than quietly cleared.
export function catchAllTakeoverPayload(holderId) {
  if (holderId == null || holderId === '') return {};
  return { takeOverCatchAll: true, takeOverCatchAllFrom: Number(holderId) };
}

// A profile the user may never have had on screen just stopped being the
// fallback. Under its own line after a blank one, for the reason the browser
// site warnings are: the message being appended to may already end in a
// labelled list, and a bare line would read as one more entry in it.
export function catchAllTakenFrom(profile) {
  const taken = profile?.catch_all_taken_from ?? profile?.catchAllTakenFrom;
  return taken?.name ? taken : undefined;
}

export function withCatchAllTakeoverNote(message, profile) {
  const taken = catchAllTakenFrom(profile);
  return taken ? `${message}\n\n${taken.name} is no longer the fallback grab profile.` : message;
}

// It answered on the reply that carried it; keeping the key would leave a
// stale note attached to the profile in state.
export function withoutCatchAllTakeover(profile) {
  const { catch_all_taken_from: taken, catchAllTakenFrom: takenCamel, ...rest } = profile;
  return taken === undefined && takenCamel === undefined ? profile : rest;
}

// The offer itself, appended to the refusal the message area is already
// showing (#profileWizardMessage is white-space: pre-line, so the newlines are
// the layout). A button rather than an anchor: the message sits inside the
// wizard form, where an href="#" is a navigation that never happens and a
// button with no type would submit the dialog. It is styled as a link, which
// is what the reader was promised.
export function renderCatchAllTakeover(element, holder, onTakeover) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'message-link';
  link.dataset.testid = 'profile-catch-all-takeover';
  link.textContent = CATCH_ALL_TAKEOVER_LABEL;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    onTakeover(holder);
  });
  element.append(
    // Reads as prose for anyone who never clicks: the sentence above says how
    // to move the fallback by hand, and this says the same thing in one click.
    document.createTextNode('\n\nOr: '),
    link,
    document.createTextNode(catchAllTakeoverConsequence(holder.name)),
  );
  return link;
}

// What the offer beside the download-folder refusal says, and what it costs.
// The folder is named rather than implied: the field is still showing the one
// the server would not take, and "put it back" is no answer to "back to what?".
export const KEEP_DOWNLOAD_FOLDER_LABEL = 'Keep the folder this profile has';

export function keepDownloadFolderConsequence(folder) {
  return ` — the folder goes back to ${folder} and the rest of this profile is saved.`;
}

// The same offer as the takeover's, for the refusal that protects a profile's
// downloads: the wizard is still showing the folder the server would not take,
// so every later save is refused over it too until it goes back. One click puts
// it back and re-submits everything else the user typed.
export function renderKeepDownloadFolder(element, lock, onKeep) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'message-link';
  link.dataset.testid = 'profile-download-folder-keep';
  link.textContent = KEEP_DOWNLOAD_FOLDER_LABEL;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    onKeep(lock);
  });
  element.append(
    document.createTextNode('\n\nOr: '),
    link,
    document.createTextNode(keepDownloadFolderConsequence(lock.from)),
  );
  return link;
}

// api() used to throw the reply's sentence and drop everything else, which left
// callers matching prose to decide anything. The message is unchanged; the
// status and every field the body carried come with it.
export function apiError(status, body = {}) {
  const error = new Error(body.error || `HTTP ${status}`);
  error.status = status;
  if (body.code) error.code = body.code;
  if (body.catchAllHolder) error.catchAllHolder = body.catchAllHolder;
  if (body.downloadFolderLock) error.downloadFolderLock = body.downloadFolderLock;
  error.body = body;
  return error;
}

// A grab profile has no category and no client to describe, so its card is
// summarized by the browser grabs it claims: the sites it lists, and — for the
// one profile that takes them — every site nobody listed.
export function grabProfileSummary(domains = [], catchAll = false) {
  if (catchAll) {
    return domains.length
      ? `Browser grabs from ${domains.join(', ')}, and from any site no other profile claims.`
      : 'Browser grabs from any site no other profile claims.';
  }
  return domains.length
    ? `Browser grabs from ${domains.join(', ')}.`
    : 'Browser grabs sent here by the extension.';
}

export function setProfileFact(card, role, value) {
  const element = card.querySelector(`[data-role="${role}"]`);
  setText(element, value);
  setAttribute(element, 'title', value);
}

export function escapeSvgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncateLabel(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

// What the last schema upgrade did. The quarantine cards below cover the rows
// that need a decision; this covers the rest, which is otherwise only in the
// log — and the log is not where a NAS user looks.
export function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function schemaMigrationSummary(migrations) {
  // Read once, gone for good — recorded on the server against the report it
  // was read for, so a reload, a restart and another browser all agree.
  if (migrations?.summaryDismissed) return '';
  const parts = [];
  const downloads = migrations?.downloads;
  const profiles = migrations?.profiles;
  if (downloads?.migrated) parts.push(`migrated ${pluralize(downloads.migrated, 'download')}`);
  if (downloads?.adoptedBySoleProfile) {
    parts.push(`assigned ${pluralize(downloads.adoptedBySoleProfile, 'download')} to the only profile`);
  }
  const quarantined = (downloads?.ownerless?.length ?? 0)
    + (downloads?.noPutioId?.length ?? 0)
    + (downloads?.extraAssociations?.length ?? 0);
  if (quarantined) parts.push(`quarantined ${pluralize(quarantined, 'download')}`);
  if (profiles?.downloadProfilesAssigned) {
    parts.push(`gave ${pluralize(profiles.downloadProfilesAssigned, 'profile')} the default download profile`);
  }
  if (profiles?.grabRpcPathsCleared) {
    parts.push(`retired ${pluralize(profiles.grabRpcPathsCleared, 'Putiorr Grab RPC endpoint')}`);
  }
  if (parts.length === 0) return '';
  return `The last database upgrade ${parts.join(', ')}. Files on disk were not touched.`;
}

// Web Awesome checkboxes and buttons carry their state in both the property
// and the attribute, and which one is authoritative depends on whether the
// component has upgraded yet, so both are written and both are read.
export function setCheckboxChecked(checkbox, checked) {
  checkbox.checked = checked;
  checkbox.toggleAttribute('checked', checked);
}

export function isCheckboxChecked(checkbox) {
  return Boolean(checkbox.checked || checkbox.hasAttribute('checked'));
}

// Any control, not only a button: a radio whose choice cannot be completed is
// switched off the same way.
export function setDisabled(control, disabled) {
  control.disabled = disabled;
  control.toggleAttribute('disabled', disabled);
}

// Deleting an RR profile is irreversible and reaches put.io and the disk, so
// the dialog opens by saying how much is at stake, in counts.
export function profileDeletionSummary(preview) {
  const name = preview?.profile?.name ?? 'this RR profile';
  const total = Number(preview?.downloads?.total ?? 0);
  if (total === 0) {
    return `RR profile ${name} owns no downloads. Deleting it touches nothing on put.io or on disk.`;
  }
  // A tombstoned download is invisible in the downloads list and still holds
  // its put.io transfer and its files, so a count that left it out would not
  // match the one the delete acts on.
  const removed = Number(preview?.downloads?.removed ?? 0);
  const removedPart = removed > 0
    ? ` (${removed} of them already deleted from the list but still on put.io)`
    : '';
  return `RR profile ${name} owns ${pluralize(total, 'download')}${removedPart}.`
    + ' A download cannot be left without an owner, so choose what happens to them.';
}

// The one sentence the user reads before committing. It describes exactly one
// outcome: moving and deleting are different fates for the same rows, so an
// answer that has not chosen between them describes neither.
export function profileDeletionOutcome(preview, choice = {}) {
  const name = preview?.profile?.name ?? 'this RR profile';
  const total = Number(preview?.downloads?.total ?? 0);
  const downloads = pluralize(total, 'download');
  // "these 1 download" is the sort of thing a user reads as a bug in the count
  // rather than as English, on the one dialog that has to be believed.
  const theseDownloads = total === 1 ? 'this download' : `these ${downloads}`;
  if (total === 0) return `Deletes RR profile ${name}.`;

  if (choice.mode === 'move') {
    const target = (preview?.reassignTargets ?? [])
      .find((candidate) => String(candidate.id) === String(choice.reassignTo));
    if (!target) return `Choose the RR profile that takes ${theseDownloads} over.`;
    // Not about the preset — a Prowlarr profile and a hand-toggled one behave
    // the same way — so the flag itself is what is reported. A target that
    // auto-removes takes every one of these out of putiorr the moment it
    // finishes downloading, which for an *arr means the queue item disappears
    // before the import runs. The files survive; the import does not.
    const autoRemoves = target.autoRemoveCompleted && !preview?.profile?.autoRemoveCompleted
      ? ` ${target.name} removes completed downloads from putiorr automatically, so these will leave the`
        + ' list as soon as they finish — before your RR software has imported them.'
      : '';
    return `Moves ${downloads} to ${target.name}, then deletes RR profile ${name}.`
      + ' Nothing is removed from put.io and no files are deleted.'
      + autoRemoves;
  }

  if (choice.mode !== 'delete') return `Choose what happens to ${theseDownloads}.`;

  const remote = choice.deleteRemote
    ? `cancels ${total === 1 ? 'its' : 'their'} ${total === 1 ? 'put.io transfer' : `${total} put.io transfers`}`
    : `leaves ${total === 1 ? 'it' : 'them'} on put.io`;
  // Named as the folders, not as the downloaded files: deleting is rm on the
  // whole staging folder, so it takes the `.part` of anything still running and
  // whatever else is in there — none of which putiorr has a row for. A count of
  // completed file rows read as "0 downloaded files" for a download holding the
  // entire release.
  const filesOnDisk = Number(preview?.downloads?.filesOnDisk ?? 0);
  const unreadable = Number(preview?.downloads?.unreadableFolders ?? 0);
  const blind = unreadable > 0 ? `, plus ${unreadable} more it could not read` : '';
  const local = choice.deleteLocal
    ? `deletes everything in ${total === 1 ? 'its staging folder' : 'their staging folders'}`
      + ` — ${pluralize(filesOnDisk, 'file')}, ${formatBytes(preview?.downloads?.localBytes)}${blind}`
    : 'leaves the downloaded files on disk';
  // Kept on put.io, in a folder no RR profile owns any more, they stop being
  // adoptable — and putiorr says nothing about a transfer it cannot place. So
  // this dialog is the only place it is ever said, and it is said while the
  // choice is still the user's.
  const stranded = choice.deleteRemote
    ? ''
    : ` The ${total === 1 ? 'transfer' : 'transfers'} left on put.io stay${total === 1 ? 's' : ''} there:`
      + ' putiorr ignores a put.io transfer in a folder no RR profile downloads into.';
  return `Removes ${downloads} from putiorr, ${remote}, ${local}, then deletes RR profile ${name}.${stranded}`;
}

// The dialog's answer, turned into the body the endpoint takes — and the last
// place an unanswered dialog can be stopped. It refuses rather than defaulting:
// falling through to the delete branch made "no answer" mean "delete them, and
// whatever the checkboxes happen to say", with a disabled button as the only
// thing in the way. A disabled button is not a check.
export function profileDeletionRequest(preview, choice = {}) {
  if (Number(preview?.downloads?.total ?? 0) === 0) return {};
  if (choice.mode === 'move') {
    // Answered against the list the dialog actually offered. The sentence above
    // the picker is "Choose the RR profile that takes these over", and a target
    // that is not in reassignTargets is not one of them: it stages into a
    // different folder, so the server refuses it — after the dialog has already
    // closed on an answer the user believed it took.
    const offered = (preview?.reassignTargets ?? [])
      .some((target) => String(target?.id) === String(choice.reassignTo));
    if (!choice.reassignTo || !offered) {
      throw new Error('Choose what happens to these downloads: pick the RR profile that takes them over');
    }
    return { reassignTo: Number(choice.reassignTo) };
  }
  if (choice.mode !== 'delete') {
    throw new Error('Choose what happens to these downloads before deleting the profile');
  }
  return {
    deleteDownloads: true,
    deleteRemote: Boolean(choice.deleteRemote),
    deleteLocal: Boolean(choice.deleteLocal),
  };
}

// put.io answered 404 rather than deleting anything, so the copy the user was
// asked about had already gone. Surfaced rather than folded into the silent
// close a successful delete gets: "putiorr deleted it" and "put.io had already
// lost it" are different events, and only the second one means there is no
// remote copy left to fetch the files from again.
export function remoteAlreadyGoneNotice(results) {
  const list = Array.isArray(results) ? results : [results];
  const count = list.filter((result) => result?.remoteAlreadyGone).length;
  if (count === 0) return '';
  return `Removed from putiorr. put.io no longer had ${pluralize(count, 'download')},`
    + ' so there was nothing to delete there.';
}

// Two downloads put.io named the same thing, under one profile and category.
// Only the older one stages; the other waits, and would otherwise look like a
// download that simply stopped.
export function stagingCollisionSummary(collisions) {
  const entries = Array.isArray(collisions)
    ? collisions.filter((collision) => (collision?.downloads?.length ?? 0) > 1)
    : [];
  if (entries.length === 0) return '';
  return entries.map((collision) => {
    const [first, ...rest] = collision.downloads;
    const holder = first.removed
      ? `download ${first.id} (${first.name}), which is deleted but still has its files in`
      : `download ${first.id} (${first.name}), which is using`;
    return `${pluralize(rest.length, 'download')} cannot start: put.io named ${rest.length === 1 ? 'it' : 'them'}`
      + ` the same as ${holder} ${collision.localPath}.`
      + ' Rename one of them on put.io, or delete the one you do not want along with its files.';
  }).join(' ');
}

// The two halves of the migration panel, decided in one place. The summary is
// a one-time fact and can be dismissed; the warning is downloads nobody can
// see until they act on it, so it stays until the condition behind it is gone
// — and the panel stays with it. Only when both have nothing to say does the
// panel go.
export function schemaMigrationNoticeView(migrations) {
  const summary = schemaMigrationSummary(migrations);
  const warning = schemaMigrationWarning(migrations);
  return { summary, warning, noticeVisible: Boolean(summary || warning) };
}

export function schemaMigrationWarning(migrations) {
  const stranded = migrations?.downloads?.strandedLegacyRows;
  if (stranded) {
    return `${pluralize(stranded, 'download')} could not be read by the upgrade and are not visible here.`
      + ' Restore a backup taken before the upgrade, or re-add them.';
  }
  const legacyRows = migrations?.legacyTablesPresent;
  if (legacyRows === undefined) return '';
  // An older putiorr recreates these tables just by starting, so their presence
  // is not evidence of anything. Empty, they cost the user nothing and the
  // server drops them on the next boot — telling anyone that 0 downloads are
  // unreadable, and to restore a pre-upgrade backup over it, was worse than
  // silence: the restore discards every download made since the upgrade.
  if (!legacyRows) return '';
  return `An older putiorr has written ${pluralize(legacyRows, 'download')} into storage this version`
    + ' cannot read. Restore the .pre-downloads-*.bak taken before the upgrade, or re-add them.';
}
