import { BYTE_UNITS, TIME_UNITS, DEFAULT_PROFILE_TYPE } from './constants.js';

// Web Awesome inputs (wa-input/wa-select) return `null` for an empty value
// rather than ''. Normalize to a string so the many `.value.trim()` reads below
// never throw on untouched fields.
export function fieldValue(input) {
  return String(input?.value ?? '');
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
