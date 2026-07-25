// Which websites route a browser grab to which putiorr profile.
//
// These rules started in the browser extension and were moved here when the
// mapping moved onto the profile itself: the extension no longer holds a copy
// to disagree with, it sends the page host and putiorr answers. This file is
// the only place the rules exist, and test/browser-domains.test.js is the only
// place they are pinned.
//
// Nothing is imported across the two trees in either direction: `src/` and
// `extension/` are different deployment surfaces — the extension ships as an
// unbundled MV3 package that cannot reach into the server tree, and the server
// must not depend on a directory that is packaged and versioned separately.
//
// No node built-ins beyond the global URL parser, no side effects: the profile
// form and grab resolution both call in here so a site is matched by exactly
// the rules it was validated against.

// A browser site is compared against a URL hostname, so anything that is not a
// hostname shape can never match: labels of [a-z0-9_-] that neither start nor
// end with "-", or a bracketed IPv6 literal. The underscore is invalid in
// public DNS but the URL parser keeps it, so "media_server.lan" on a home LAN
// is a site that genuinely matches — refusing it would be a false rejection.
const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const MATCHABLE_DOMAIN = new RegExp(`^(?:${LABEL})(?:\\.(?:${LABEL}))*$|^\\[[0-9a-f:.]+\\]$`, 'i');

// Reduces an entry to the host that matching actually uses. The profile form
// shows this result back to the user, so what it rewrites is part of the
// contract: scheme and path stripped, unicode punycoded, leading and trailing
// dots dropped, and '' for anything unparseable.
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

// "*.x.example" is the one wrong entry worth naming: it is a reasonable thing
// to try, and the entry the user wants is the same string without the wildcard.
function wildcardHint(entry) {
  if (!entry.startsWith('*')) return undefined;
  const suggestion = normalizeDomain(entry.replace(/^\*+\.?/, ''));
  return suggestion && MATCHABLE_DOMAIN.test(suggestion)
    ? `Write "${suggestion}" instead of "${entry}": a browser site already matches its subdomains`
    : `"${entry}" is not a domain: list each site, subdomains are matched automatically`;
}

// A stored value is always an array; the profile form sends the raw
// comma-separated text the user typed. Both are accepted so the caller does not
// have to guess which side it is on. Anything else is passed through as a
// single entry for the non-string branch below to report: String(5) would
// otherwise reach the URL parser and come back as the host "0.0.0.5".
function splitEntries(input) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input) && typeof input !== 'string') return [input];

  const raw = Array.isArray(input) ? input : input.split(',');
  return raw
    .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
    .filter((entry) => entry !== '' && entry !== null && entry !== undefined);
}

// Turns one profile's browser-sites input into the domains that will be stored.
// Returns the normalized list plus what the user has to be told: `errors` block
// the save, `warnings` only accompany it.
export function normalizeBrowserDomains(input) {
  const domains = [];
  const errors = [];
  const warnings = [];

  for (const entry of splitEntries(input)) {
    // A non-string can only come from a hand-written API call. Coercing it
    // would hand the URL parser something like 5 and store "0.0.0.5", so it is
    // reported instead.
    if (typeof entry !== 'string') {
      errors.push(`"${String(entry)}" is not a domain putiorr can match`);
      continue;
    }

    // The URL host parser has no opinion on "*", empty labels or a leading "-",
    // so normalizeDomain hands back plenty of strings that no hostname can ever
    // equal or end with. Refusing them here is the only place the user finds out.
    const normalized = normalizeDomain(entry);
    if (!normalized || !MATCHABLE_DOMAIN.test(normalized)) {
      errors.push(wildcardHint(entry) ?? `"${entry}" is not a domain putiorr can match`);
      continue;
    }

    // Matching is by suffix, so a single label covers a whole TLD. An IP
    // literal has no labels to be a suffix of, so it is exempt.
    if (!normalized.includes('.') && !normalized.startsWith('[')) {
      warnings.push(`"${normalized}" also matches every site ending in ".${normalized}"`);
    }

    if (!domains.includes(normalized)) domains.push(normalized);
  }

  return { domains, errors, warnings };
}

// The first profile, in the order given, whose browser sites match `host`
// exactly or as a suffix. Rows come from the database and may have been written
// by an older putiorr, so every shape is treated as untrusted: a throw here
// would turn a magnet click into a failure with no explanation.
export function matchProfileByHost(profiles, host) {
  const hostname = normalizeDomain(host);
  if (!hostname) return undefined;

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    // Store rows carry both key styles; a caller assembling a profile by hand
    // may have only one of them.
    const stored = profile?.browser_domains ?? profile?.browserDomains;
    const domains = Array.isArray(stored) ? stored : [];
    for (const domain of domains) {
      const normalized = normalizeDomain(domain);
      if (!normalized) continue;
      if (hostname === normalized || hostname.endsWith(`.${normalized}`)) return profile;
    }
  }

  return undefined;
}
