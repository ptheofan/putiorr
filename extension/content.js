// Captures clicks on magnet:/.torrent links and forwards them to the service
// worker. .torrent files are fetched here, in the page context, so
// private-tracker session cookies apply. Not a module (content scripts can't
// be), so shared helpers load via dynamic import.

(() => {
  const bypass = new WeakSet();
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

  function filenameFrom(response, url) {
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
    const base = new URL(url, window.location.href).pathname.split('/').pop();
    return base || 'upload.torrent';
  }

  async function fetchTorrent(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`fetch failed with ${response.status}`);
    const buffer = await response.arrayBuffer();
    return { torrentBase64: arrayBufferToBase64(buffer), filename: filenameFrom(response, url) };
  }

  function refire(anchor) {
    bypass.add(anchor);
    anchor.click();
  }

  document.addEventListener('click', (event) => {
    if (!lib || !autoCapture || event.button !== 0 || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    if (bypass.has(anchor)) {
      bypass.delete(anchor);
      return;
    }
    const href = anchor.href;
    // isMagnetLink must be asked first: isTorrentLink would otherwise claim a
    // magnet URI whose payload happens to end in ".torrent".
    const magnet = lib.isMagnetLink(href);
    if (!magnet && !lib.isTorrentLink(href)) return;
    event.preventDefault();
    event.stopPropagation();
    (async () => {
      try {
        const payload = magnet
          ? { kind: 'grab', magnet: href, pageUrl: window.location.href }
          : { kind: 'grab', ...(await fetchTorrent(href)), pageUrl: window.location.href };
        await chrome.runtime.sendMessage(payload);
      } catch (error) {
        // Capture failed before reaching putiorr (e.g. the .torrent fetch
        // errored). Fall through to the normal browser download so the user
        // is never stuck. Grab failures reported by putiorr already surfaced
        // as a notification from the service worker.
        console.warn('[putiorr] capture failed, falling back to normal download:', error);
        if (!magnet) refire(anchor);
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
