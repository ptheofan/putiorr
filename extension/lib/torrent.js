// Fetching a .torrent and naming it, shared by the content script and the
// service worker. Both make this exact request now: the page makes it first so
// the tracker's session cookies apply, and the worker makes it again when the
// page's copy is refused by CORS. Two copies of the RFC 6266 reading below
// would be two copies free to drift, and only one of them would be the one the
// tests pin.
//
// No chrome.* APIs here, for the same reason resolve.js has none: node's test
// runner imports this file directly, and a content script may only import a
// web-accessible resource, which this is.

// The click has already been swallowed by preventDefault when this runs, so a
// tracker that accepts the connection and then stalls would leave the link dead
// for good: the promise never settles and the fallback never gets its turn.
// The worker's own attempt is held to the same budget, so a rescue that hangs
// cannot strand the acknowledgement the page is showing either.
export const FETCH_TIMEOUT_MS = 15000;

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// RFC 6266 parameters. Each name is anchored to the start of the header or to
// a ";" so that a different parameter ending in "filename" cannot pose as one.
const EXT_FILENAME = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i;
const PLAIN_FILENAME = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i;

export function filenameFromDisposition(disposition) {
  // filename* wins when both are present, which is exactly when the real name
  // is non-ASCII and the plain filename is the server's mangled fallback.
  const extended = disposition.match(EXT_FILENAME);
  if (extended) {
    // ext-value is charset'language'percent-encoded-name, and is not allowed
    // to be quoted — but servers that quote it anyway would otherwise leave
    // the closing quote glued to the name.
    const value = extended[1].trim().replace(/^"(.*)"$/s, '$1').replace(/^[^']*'[^']*'/, '');
    try {
      return decodeURIComponent(value);
    } catch {
      // A charset other than UTF-8 leaves byte escapes decodeURIComponent
      // rejects; the still-encoded name beats guessing at the bytes.
      return value;
    }
  }

  const plain = disposition.match(PLAIN_FILENAME);
  if (!plain) return '';
  // A quoted string may hold the ";" that would otherwise end the parameter.
  if (plain[1] !== undefined) return plain[1].replace(/\\(.)/g, '$1');
  // Percent escapes are literal here: decoding a plain filename would turn
  // "a%2Fb.torrent" into a path.
  return plain[2].trim();
}

// put.io takes the upload's name at face value, and the right-click path exists
// precisely for trackers whose download URLs are "download.php?id=123": neither
// that basename nor a disposition naming the script is a torrent name.
function withTorrentSuffix(name) {
  return /\.torrent$/i.test(name) ? name : `${name}.torrent`;
}

export function filenameFrom(response, url, base) {
  const fromHeader = filenameFromDisposition(response.headers.get('content-disposition') ?? '').trim();
  if (fromHeader) return withTorrentSuffix(fromHeader);
  const path = new URL(url, base).pathname.split('/').pop();
  return path ? withTorrentSuffix(path) : 'upload.torrent';
}

// `base` resolves a relative URL against the page that carried it; the worker
// has no such page and only ever passes absolute links.
export async function fetchTorrent(url, { base, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`fetch failed with ${response.status}`);
  const buffer = await response.arrayBuffer();
  return { torrentBase64: arrayBufferToBase64(buffer), filename: filenameFrom(response, url, base) };
}

// A bencoded metainfo file is a dictionary, so it starts with "d". This is not
// validation — putiorr checks the bytes again, and its refusal is the one the
// user reads. It answers a question only the fetcher can: a redirect that lands
// on an HTML login or error page answers 200, and telling that apart from a
// torrent is the difference between "the fetch failed, hand the click back to
// the browser" and a grab putiorr can only refuse.
export function looksLikeMetainfo(torrentBase64) {
  try {
    return atob(torrentBase64).charCodeAt(0) === 0x64;
  } catch {
    return false;
  }
}
