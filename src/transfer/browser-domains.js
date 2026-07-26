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

// A browser site is one of two things, and both are compared against a URL
// hostname:
//
//   x.example     that host, and nothing under it
//   *.x.example   that host and every subdomain of it
//
// The wildcard covering the apex too is deliberate: claiming a whole tracker is
// the common case, and needing two entries for it would be a trap.
//
// Under the star, anything that is not a hostname shape can never match: labels
// of [a-z0-9_-] that neither start nor end with "-", or a bracketed IPv6
// literal. The underscore is invalid in public DNS but the URL parser keeps it,
// so "media_server.lan" on a home LAN is a site that genuinely matches —
// refusing it would be a false rejection.
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

// An entry is a host, or "*." in front of one. Splits the two apart without
// judging either: `base` still has to survive normalizeDomain and
// MATCHABLE_DOMAIN, and `hasStar` reports a star the leading "*." did not
// account for — "dl.*.example", "example.*", a bare "*", "**.x.example".
function parseEntry(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const wildcard = text.startsWith('*.');
  const base = wildcard ? text.slice(2) : text;
  return { wildcard, base, hasStar: base.includes('*') };
}

// A star anywhere else is not a narrower wildcard putiorr declined to
// implement, it is a shape the matcher has no meaning for. The refusal names
// the one position that works rather than leaving the user to guess at it.
function starRefusal(entry) {
  return `"${entry}" is not a domain putiorr can match:`
    + ' a wildcard is only a leading "*.", as in "*.x.example"';
}

// One stored entry, reduced to what matching compares. Rows come from the
// database and may have been written by an older putiorr — including a star in
// a position that is now refused — so an entry that makes no sense yields
// undefined and matches nothing, rather than throwing on the path every grab
// takes.
function storedEntry(value) {
  const { wildcard, base, hasStar } = parseEntry(value);
  if (hasStar) return undefined;
  const normalized = normalizeDomain(base);
  if (!normalized) return undefined;
  return { wildcard, base: normalized, domain: wildcard ? `*.${normalized}` : normalized };
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

    const { wildcard, base, hasStar } = parseEntry(entry);
    if (hasStar) {
      errors.push(starRefusal(entry));
      continue;
    }

    // The URL host parser has no opinion on empty labels or a leading "-", so
    // normalizeDomain hands back plenty of strings that no hostname can ever
    // equal or end with. Refusing them here is the only place the user finds
    // out. "*." in front does not make an unmatchable base matchable.
    const normalized = normalizeDomain(base);
    if (!normalized || !MATCHABLE_DOMAIN.test(normalized)) {
      errors.push(`"${entry}" is not a domain putiorr can match`);
      continue;
    }

    const stored = wildcard ? `*.${normalized}` : normalized;

    // Only a wildcard reaches past the host it names, so only a wildcard can be
    // broad by accident, and a single-label base is what every public suffix a
    // user would type looks like. putiorr carries no public-suffix list and
    // must not bundle one, so it cannot tell "*.com" from "*.example" — and a
    // single label is also what a LAN name looks like, which is why this is
    // advice rather than a refusal. An IP literal has no labels to be a suffix
    // of, so it is exempt.
    if (wildcard && !normalized.includes('.') && !normalized.startsWith('[')) {
      warnings.push(`"${stored}" matches ${normalized} and every site ending in ".${normalized}"`);
    }

    if (!domains.includes(stored)) domains.push(stored);
  }

  return { domains, errors, warnings };
}

// Who takes a grab from `host`, as `{ profile, domain, wildcard }` or undefined.
// `domain` is the entry that matched, spelled as it is stored — callers name it
// in a refusal and in the popup's sentence, and neither can recompute it
// without a second copy of this rule.
//
// The order is exact match first, then the most specific wildcard, and it is
// what makes an overlap safe rather than a conflict: "dl.x.example" on one
// profile and "*.x.example" on another is a configuration that says something,
// and the same host claimed twice is what the store refuses instead.
//
// Ties go to the first profile in the order given, and to the first entry
// within it. The store will not hold the same entry on two grab profiles, but a
// row written before that rule existed must still answer every grab the same
// way rather than by whichever the loop saw last.
//
// Rows come from the database and may have been written by an older putiorr, so
// every shape is treated as untrusted: a throw here would turn a magnet click
// into a failure with no explanation.
export function matchProfileByHost(profiles, host) {
  const hostname = normalizeDomain(host);
  if (!hostname) return undefined;

  let widest;
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    // Store rows carry both key styles; a caller assembling a profile by hand
    // may have only one of them.
    const stored = profile?.browser_domains ?? profile?.browserDomains;
    const domains = Array.isArray(stored) ? stored : [];
    for (const value of domains) {
      const entry = storedEntry(value);
      if (!entry) continue;

      // An exact entry beats every wildcard, so the first one found is the
      // answer and nothing later can outrank it.
      if (!entry.wildcard) {
        if (hostname === entry.base) return { profile, domain: entry.domain, wildcard: false };
        continue;
      }

      // The apex counts as covered. Claiming a whole tracker is the common
      // case, and making the user list the apex separately would be a trap they
      // only find out about from a grab landing somewhere else.
      if (hostname !== entry.base && !hostname.endsWith(`.${entry.base}`)) continue;
      // Longest base wins: "*.dl.x.example" is a statement about dl.x.example
      // that "*.x.example" is not.
      if (!widest || entry.base.length > widest.entry.base.length) widest = { profile, entry };
    }
  }

  return widest ? { profile: widest.profile, domain: widest.entry.domain, wildcard: true } : undefined;
}
