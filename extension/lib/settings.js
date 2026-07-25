// Pure validation for the options form. Every function here exists so that a
// setting the extension would otherwise rewrite or drop in silence is reported
// back to the user instead. No chrome.* or DOM APIs, so node can import it.

import { normalizeDomain } from './resolve.js';

const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\//i;

// The stored baseUrl is only ever used as `new URL('/api/grab', baseUrl)`, which
// resolves against the origin. Anything past the host is therefore discarded,
// and a URL that cannot be parsed at all turns every grab into a failure the
// user first sees on a link click, far away from this form.
export function validateBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter the putiorr URL, for example http://nas:9091' };

  if (!SCHEMED.test(raw)) {
    return { ok: false, error: `"${raw}" has no scheme: write http://${raw} instead` };
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

  return { ok: true, baseUrl: `${url.protocol}//${url.host}` };
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
    // A rule domain already matches its own subdomains, so "*.x.example" is not
    // a wider rule: normalizeDomain would keep the "*." label and match nothing.
    if (entry.startsWith('*')) {
      const suggestion = entry.replace(/^\*+\.?/, '').trim();
      errors.push(suggestion
        ? `Write "${suggestion}" instead of "${entry}": a rule domain already matches its subdomains`
        : `"${entry}" is not a domain: list each site, subdomains are matched automatically`);
      continue;
    }

    const normalized = normalizeDomain(entry);
    if (!normalized) {
      errors.push(`"${entry}" is not a domain putiorr can match`);
      continue;
    }

    // Matching is by suffix, so a single label is a rule over a whole TLD.
    if (!normalized.includes('.')) {
      warnings.push(`"${normalized}" also matches every site ending in ".${normalized}"`);
    }

    if (!domains.includes(normalized)) domains.push(normalized);
  }

  return { domains, errors, warnings };
}
