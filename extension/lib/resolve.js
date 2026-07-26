// Pure helpers shared by the content script and the service worker.
// No chrome.* APIs here so node's test runner can import this file.
// This module is web-accessible (the content script can only import resources
// that are), so it holds nothing beyond what that script and the worker need.

// The cached profile list comes from chrome.storage.sync, which can hold data
// written by a different extension version, so every shape read below is
// treated as untrusted: a throw here would become a silent no-op on a click.

function normalizeProfileId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

// Profiles drive the context menu, so one malformed element must not take the
// whole menu down: entries without a usable id are dropped, and the survivors
// come back with a numeric id and a printable name.
export function sanitizeProfiles(profiles) {
  const sanitized = [];

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const id = normalizeProfileId(profile?.id);
    if (!id) continue;

    const name = String(profile?.name ?? '').trim();
    sanitized.push({ id, name: name || `profile #${id}` });
  }

  return sanitized;
}

export function isMagnetLink(href) {
  return typeof href === 'string' && href.toLowerCase().startsWith('magnet:');
}

// Check magnetFromLink first: a magnet URI whose payload ends in ".torrent"
// would otherwise be parsed as a torrent path here, and so would an https
// handler URL that carries a magnet and happens to end in ".torrent".
export function isTorrentLink(href) {
  if (typeof href !== 'string') return false;
  try {
    const url = new URL(href, 'http://placeholder.invalid');
    return /\.torrent$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// A single stray "%" is enough to make decodeURIComponent throw, and this runs
// on hrefs written by whoever owns the page. Undecodable input is worth reading
// as itself; it must never take the click down with it.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function* queryPairs(query) {
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    yield [pair.slice(0, separator), pair.slice(separator + 1)];
  }
}

// put.io is handed this as a torrent source, so "is it a magnet URI" is not the
// question — "does it name a BitTorrent swarm" is. A magnet can address ed2k,
// SHA-1 files, anything; only btih (v1) and btmh (v2) are ours. Requiring the
// topic also keeps a link that merely says the word magnet from being captured.
function namesATorrent(magnet) {
  const separator = magnet.indexOf('?');
  if (separator === -1) return false;
  for (const [name, value] of queryPairs(magnet.slice(separator + 1))) {
    // A dual v1/v2 magnet numbers its topics "xt.1" and "xt.2"; a magnet with
    // one topic writes a bare "xt".
    const key = safeDecode(name).trim().toLowerCase();
    if (key !== 'xt' && !key.startsWith('xt.')) continue;
    const urn = safeDecode(value).trim().toLowerCase();
    if (urn.startsWith('urn:btih:') || urn.startsWith('urn:btmh:')) return true;
  }
  return false;
}

// The magnet an anchor is really offering, or '' when there is none. Sites
// routinely wrap magnets in an http(s) handler — a "send to put.io" link, a
// download.php?magnet=…, a redirector — and following one of those hands the
// torrent to whoever wrote the page instead of to putiorr.
export function magnetFromLink(href) {
  if (typeof href !== 'string') return '';
  // A real magnet href is returned as it came, unvalidated: this is the path
  // every magnet click already took, and narrowing it now would drop links
  // that work today.
  if (isMagnetLink(href)) return href;

  // Scanning the raw href beats reading the parameter that holds the magnet,
  // and the difference is not cosmetic. Wrapped magnets are usually written
  // with the inner "&dn=" and "&tr=" left unencoded, so the outer URL parser
  // claims them as top-level parameters of the *handler* URL: the parameter
  // then holds the infohash alone, and the display name and every tracker are
  // gone. Everything from "magnet:?" to the end of the href keeps them.
  const start = href.toLowerCase().indexOf('magnet:?');
  if (start !== -1) {
    const candidate = href.slice(start);
    if (namesATorrent(candidate)) return candidate;
  }

  // Nothing raw to find, so the site is one of the well-behaved ones that
  // percent-encodes the magnet it wraps. Each value is decoded once — the
  // pairs are read raw rather than through searchParams, which has already
  // decoded them and would make this a second pass over the same text.
  let query;
  try {
    query = new URL(href, 'http://placeholder.invalid').search.slice(1);
  } catch {
    return '';
  }
  for (const [, value] of queryPairs(query)) {
    const decoded = safeDecode(value).trim();
    if (isMagnetLink(decoded) && namesATorrent(decoded)) return decoded;
  }
  return '';
}
