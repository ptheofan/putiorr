// Which putiorr profile handles the site in the current tab, and what the
// toolbar popup would store to make it a different one. No chrome.* or DOM
// APIs here so node's test runner can import this file.
//
// This is a second implementation of the rule that lives in
// src/transfer/browser-domains.js, not a copy of that file: `src/` and
// `extension/` are different deployment surfaces and neither may import the
// other. The two are pinned together in test/extension-popup.test.js, which
// runs the same hosts through both — a case they answer differently is a popup
// naming a profile that would not have received the grab.
//
// Nothing here decides anything. putiorr resolves every grab itself; this only
// says what the answer will be, so the popup can offer to change it.

// Same shape a browser site has to have on the server: labels of [a-z0-9_-]
// that neither start nor end with "-", or a bracketed IPv6 literal.
const LABEL = '[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?';
const MATCHABLE_DOMAIN = new RegExp(`^(?:${LABEL})(?:\\.(?:${LABEL}))*$|^\\[[0-9a-f:.]+\\]$`, 'i');

// Reduces a site or host to what matching actually compares: scheme and path
// stripped, unicode punycoded, leading and trailing dots dropped, '' for
// anything unparseable.
function normalizeSite(value) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/^\.+/, '');
  if (!raw) return '';

  const candidate = raw.includes('://') ? raw : `http://${raw}`;
  try {
    return new URL(candidate).hostname.replace(/\.$/, '');
  } catch {
    return '';
  }
}

// The host of the page in the current tab, or '' when the tab has none worth
// claiming. Only http(s) pages have one: a browser site is compared against a
// URL hostname, and "chrome://extensions", "about:blank", a file:// page and a
// data: URL each have nothing a profile could ever match.
export function hostFromTabUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return normalizeSite(parsed.hostname);
}

// What putiorr would store for this host — the host itself, and never a guess
// at the registrable domain behind it. An extension carries no public-suffix
// list, so the only rule available for shortening "www.x.example" to
// "x.example" would shorten "x.co.uk" to "co.uk" and claim a whole TLD with
// it. '' for a host putiorr could not match, so the popup can refuse before it
// asks the server to.
export function storableSite(host) {
  const site = normalizeSite(host);
  return site && MATCHABLE_DOMAIN.test(site) ? site : '';
}

// Rows come off the network and may have been written by an older putiorr, so
// every shape below is treated as untrusted. Both key styles are read: either
// one is the mapping.
function domainsOf(profile) {
  const stored = profile?.browser_domains ?? profile?.browserDomains;
  return Array.isArray(stored) ? stored : [];
}

function isCatchAll(profile) {
  return Boolean(profile?.browser_catch_all ?? profile?.browserCatchAll);
}

// A profile that is switched off still claims its sites: putiorr refuses such
// a grab by name rather than passing it to the next profile, so the popup has
// to name it too — and say that it is off, which is why the grab fails.
function isDisabled(profile) {
  return profile?.enabled === false || profile?.enabled === 0;
}

// Who handles `host`, in the order putiorr resolves it: the first profile whose
// browser sites match exactly or as a suffix, then the profile set to take
// everything else, then nobody.
//
//   { kind: 'none' }                                    — the tab has no host
//   { kind: 'claimed', profile, domain, viaSubdomain, disabled }
//   { kind: 'catch-all', profile, disabled }
//   { kind: 'unclaimed' }
//
// `domain` is the site the profile actually lists, which is not always the host
// asked about; `viaSubdomain` says so, because "dl.x.example is handled by X"
// otherwise reads like a site nobody typed.
export function routingForHost(profiles, host) {
  const hostname = normalizeSite(host);
  if (!hostname) return { kind: 'none' };

  const rows = Array.isArray(profiles) ? profiles : [];
  for (const profile of rows) {
    for (const domain of domainsOf(profile)) {
      const site = normalizeSite(domain);
      if (!site) continue;
      if (hostname === site || hostname.endsWith(`.${site}`)) {
        return {
          kind: 'claimed',
          profile,
          domain: site,
          viaSubdomain: hostname !== site,
          disabled: isDisabled(profile),
        };
      }
    }
  }

  // Only once nothing matched: a profile that lists a site still wins for that
  // site, which is what lets both settings sit on the same profile.
  const catchAll = rows.find((profile) => isCatchAll(profile));
  if (catchAll) return { kind: 'catch-all', profile: catchAll, disabled: isDisabled(catchAll) };

  return { kind: 'unclaimed' };
}
