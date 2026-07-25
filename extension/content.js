// Captures clicks on magnet:/.torrent links and forwards them to the service
// worker. .torrent files are fetched here, in the page context, so
// private-tracker session cookies apply. Not a module (content scripts can't
// be), so shared helpers load via dynamic import.

(() => {
  const FETCH_TIMEOUT_MS = 15000;

  const bypass = new WeakSet();
  const inFlight = new Set();
  let lib;
  let autoCapture = true;

  // Until the helpers land, clicks fall through to the browser untouched. A
  // failed import must say so: silently never capturing anything looks
  // identical to a broken extension from the user's side.
  import(chrome.runtime.getURL('lib/resolve.js'))
    .then((module) => {
      lib = module;
    })
    .catch((error) => {
      console.warn('[putiorr] link helpers failed to load, capture is off on this page:', error);
    });

  chrome.storage.sync.get({ autoCapture: true })
    .then((value) => {
      autoCapture = value.autoCapture ?? true;
    })
    .catch((error) => {
      console.warn('[putiorr] could not read settings, capture stays on:', error);
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    // A cleared or removed key means "back to the default"; newValue is
    // undefined then, and assigning it straight through would turn capture off
    // permanently even though a fresh read of storage would say it is on.
    if (area === 'sync' && changes.autoCapture) autoCapture = changes.autoCapture.newValue ?? true;
  });

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

  function filenameFromDisposition(disposition) {
    // filename* wins when both are present, which is exactly when the real name
    // is non-ASCII and the plain filename is the server's mangled fallback.
    const extended = disposition.match(EXT_FILENAME);
    if (extended) {
      // ext-value is charset'language'percent-encoded-name.
      const value = extended[1].trim().replace(/^[^']*'[^']*'/, '');
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

  function filenameFrom(response, url) {
    const fromHeader = filenameFromDisposition(response.headers.get('content-disposition') ?? '').trim();
    if (fromHeader) return fromHeader;
    const base = new URL(url, window.location.href).pathname.split('/').pop();
    return base || 'upload.torrent';
  }

  async function fetchTorrent(url) {
    // A tracker that accepts the connection and then stalls would otherwise
    // leave the click dead for good: preventDefault has already run and the
    // promise never settles, so the fallback below never gets its turn.
    const response = await fetch(url, {
      credentials: 'include',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`fetch failed with ${response.status}`);
    const buffer = await response.arrayBuffer();
    return { torrentBase64: arrayBufferToBase64(buffer), filename: filenameFrom(response, url) };
  }

  function refire(anchor) {
    bypass.add(anchor);
    anchor.click();
  }

  function findAnchor(event) {
    // composedPath crosses open shadow roots, where the target seen from the
    // document has been retargeted to the host and closest() can no longer
    // reach the link. It also walks ancestors, so nested markup is covered.
    if (typeof event.composedPath === 'function') {
      return event.composedPath().find((node) => node instanceof Element && node.matches?.('a[href]'));
    }
    return event.target instanceof Element ? event.target.closest('a[href]') : null;
  }

  document.addEventListener('click', (event) => {
    if (!lib || !autoCapture || event.button !== 0 || event.defaultPrevented) return;
    // A modified click is the user asking for something else: alt is Chrome's
    // "download to disk", and it doubles as the escape hatch from capture.
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = findAnchor(event);
    if (!anchor) return;
    if (bypass.has(anchor)) {
      bypass.delete(anchor);
      return;
    }
    // Only a real user click may spend the user's put.io account; any page can
    // call anchor.click() on a magnet it planted. isTrusted is unforgeable
    // (Event declares it [LegacyUnforgeable], and page expandos are invisible
    // in this isolated world anyway). The check has to sit below the bypass
    // block: refire()'s own click is synthetic, and returning above would leave
    // its mark behind to swallow the next genuine click on that link.
    if (!event.isTrusted) return;
    const href = anchor.href;
    // isMagnetLink must be asked first: isTorrentLink would otherwise claim a
    // magnet URI whose payload happens to end in ".torrent".
    const magnet = lib.isMagnetLink(href);
    if (!magnet && !lib.isTorrentLink(href)) return;
    event.preventDefault();
    event.stopPropagation();
    // An impatient second click must not become a second transfer. Dropping it
    // rather than letting it through matters: the browser would otherwise
    // download the very file the pending capture is already handling.
    if (inFlight.has(anchor)) return;
    inFlight.add(anchor);
    (async () => {
      try {
        const payload = magnet
          ? { kind: 'grab', magnet: href, pageUrl: window.location.href }
          : { kind: 'grab', ...(await fetchTorrent(href)), pageUrl: window.location.href };
        await chrome.runtime.sendMessage(payload);
      } catch (error) {
        // The grab never reached putiorr: the .torrent fetch failed or timed
        // out, or an extension reload orphaned this content script and
        // sendMessage has nothing left to talk to. Refire the click so the
        // browser does what it would have without the extension — download the
        // .torrent, or hand the magnet to the OS protocol handler. A grab that
        // did reach putiorr and failed there resolves normally and was already
        // reported by the service worker, so it must never land here.
        console.warn('[putiorr] capture failed, falling back to the browser:', error);
        refire(anchor);
      } finally {
        inFlight.delete(anchor);
      }
    })();
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind !== 'fetch-link') return undefined;
    fetchTorrent(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
