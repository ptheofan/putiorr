// Pure helpers shared by the content script and the service worker.
// No chrome.* APIs here so node's test runner can import this file.

// Site rules come from chrome.storage.sync, which can hold data written by a
// different extension version, so every shape read below is treated as
// untrusted: a throw here would become a silent no-op on a magnet click.

function normalizeDomain(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^\.+/, '');
  if (!raw) return '';

  const candidate = raw.includes('://') ? raw : `http://${raw}`;
  try {
    return new URL(candidate).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
}

function normalizeProfileId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

export function isMagnetLink(href) {
  return typeof href === 'string' && href.toLowerCase().startsWith('magnet:');
}

// Check isMagnetLink first: a magnet URI whose payload ends in ".torrent"
// would otherwise be parsed as a torrent path here.
export function isTorrentLink(href) {
  if (typeof href !== 'string') return false;
  try {
    const url = new URL(href, 'http://placeholder.invalid');
    return /\.torrent$/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function matchSiteRuleProfileId(rules, hostname) {
  const host = normalizeDomain(hostname);
  if (!host) return undefined;

  for (const rule of Array.isArray(rules) ? rules : []) {
    const domains = Array.isArray(rule?.domains) ? rule.domains : [];
    for (const domain of domains) {
      const normalized = normalizeDomain(domain);
      if (!normalized) continue;
      if (host === normalized || host.endsWith(`.${normalized}`)) return rule.profileId;
    }
  }

  return undefined;
}

export function resolveProfileId({ explicitProfileId, rules, hostname, defaultProfileId }) {
  const explicit = normalizeProfileId(explicitProfileId);
  if (explicit) return explicit;

  const fromRule = normalizeProfileId(matchSiteRuleProfileId(rules, hostname));
  if (fromRule) return fromRule;

  return normalizeProfileId(defaultProfileId);
}
