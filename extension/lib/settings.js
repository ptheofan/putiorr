// Pure validation for the options form. Every function here exists so that a
// setting the extension would otherwise rewrite or drop in silence is reported
// back to the user instead. No chrome.* or DOM APIs, so node can import it.

import { normalizeDomain } from './resolve.js';

// What the user most likely meant when they typed a bare host, with or without
// a port: only these get the "write http:// in front" hint, so a "data:" URL or
// a mistyped "http:/nas" is not answered with "write http://http:/nas".
const HOSTISH = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d+)?$/i;

// A rule domain is compared against a URL hostname, so anything that is not a
// hostname shape can never match: labels of [a-z0-9-] that neither start nor
// end with "-", or a bracketed IPv6 literal.
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const MATCHABLE_DOMAIN = new RegExp(`^(?:${LABEL})(?:\\.(?:${LABEL}))*$|^\\[[0-9a-f:.]+\\]$`, 'i');

// The stored baseUrl is only ever used as `new URL('/api/grab', baseUrl)`, which
// resolves against the origin. Anything past the host is therefore discarded,
// and a URL that cannot be parsed at all turns every grab into a failure the
// user first sees on a link click, far away from this form.
export function validateBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the putiorr URL, for example http://nas:9091' };

  if (!raw.includes('://')) {
    return {
      ok: false,
      error: HOSTISH.test(raw)
        ? `"${raw}" has no scheme: write http://${raw} instead`
        : `"${raw}" is not a full URL: putiorr needs one starting with http:// or https://`,
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `"${raw}" is not a valid URL` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `putiorr URL must start with http:// or https://, not ${url.protocol}//` };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'Put the username and password in the fields below, not in the URL' };
  }

  const beyondHost = `${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
  if (beyondHost) {
    return {
      ok: false,
      // putiorr is not subpath-deployable, so this is a refusal rather than a
      // normalization: "https://nas/putiorr" would silently become "https://nas".
      error: `putiorr must be at the root of the host: "${beyondHost}" would be ignored and every grab would go to ${url.protocol}//${url.host}/api/grab`,
    };
  }

  // The root dot of a fully qualified name is dropped here as it is in a rule
  // domain, so "https://nas./" and "https://nas" are one stored setting.
  const host = `${url.hostname.replace(/\.$/, '')}${url.port ? `:${url.port}` : ''}`;
  return { ok: true, baseUrl: `${url.protocol}//${host}` };
}

// "*.x.example" is the one wrong entry worth naming: it is a reasonable thing to
// try, and the rule the user wants is the same string without the wildcard.
function wildcardHint(entry) {
  if (!entry.startsWith('*')) return undefined;
  const suggestion = normalizeDomain(entry.replace(/^\*+\.?/, ''));
  return suggestion && MATCHABLE_DOMAIN.test(suggestion)
    ? `Write "${suggestion}" instead of "${entry}": a rule domain already matches its subdomains`
    : `"${entry}" is not a domain: list each site, subdomains are matched automatically`;
}

// Splits one rule row's comma-separated text into the domains that will be
// stored. Returns the normalized list plus what the user has to be told:
// `errors` block the save, `warnings` only accompany it.
export function parseRuleDomains(value) {
  const domains = [];
  const errors = [];
  const warnings = [];

  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    // The URL host parser has no opinion on "*", empty labels or a leading "-",
    // so normalizeDomain hands back plenty of strings that no hostname can ever
    // equal or end with. Refusing them here is the only place the user finds out.
    const normalized = normalizeDomain(entry);
    if (!normalized || !MATCHABLE_DOMAIN.test(normalized)) {
      errors.push(wildcardHint(entry) ?? `"${entry}" is not a domain putiorr can match`);
      continue;
    }

    // Matching is by suffix, so a single label is a rule over a whole TLD. An IP
    // literal has no labels to be a suffix of, so it is exempt.
    if (!normalized.includes('.') && !normalized.startsWith('[')) {
      warnings.push(`"${normalized}" also matches every site ending in ".${normalized}"`);
    }

    if (!domains.includes(normalized)) domains.push(normalized);
  }

  return { domains, errors, warnings };
}
