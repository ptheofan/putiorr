// Pure helpers shared by the content script and the service worker.
// No chrome.* APIs here so node's test runner can import this file.

export function isMagnetLink(href) {
  return typeof href === 'string' && href.startsWith('magnet:');
}

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
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return undefined;

  for (const rule of rules ?? []) {
    for (const domain of rule.domains ?? []) {
      const normalized = String(domain).trim().toLowerCase();
      if (!normalized) continue;
      if (host === normalized || host.endsWith(`.${normalized}`)) return rule.profileId;
    }
  }

  return undefined;
}

export function resolveProfileId({ explicitProfileId, rules, hostname, defaultProfileId }) {
  if (explicitProfileId) return explicitProfileId;

  const ruleProfileId = matchSiteRuleProfileId(rules, hostname);
  if (ruleProfileId) return ruleProfileId;

  return defaultProfileId;
}
