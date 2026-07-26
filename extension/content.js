// Captures clicks on magnet:/.torrent links — and on the http(s) handler links
// that carry a magnet in their query — and forwards them to the service
// worker. .torrent files are fetched here, in the page context, so
// private-tracker session cookies apply. Not a module (content scripts can't
// be), so shared helpers load via dynamic import.

(() => {
  const FETCH_TIMEOUT_MS = 15000;

  const bypass = new WeakSet();
  const inFlight = new Set();
  // Right-click grabs run in the service worker, which sends the page an
  // acknowledgement and then its answer; the id ties the two together so the
  // second resolves the first in place instead of stacking on top of it.
  const menuFeedback = new Map();
  let lib;
  let toastLib;
  let surface;
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

  // Imported separately from the helpers above, so that feedback failing to
  // load costs the page its toasts and not its capture. The notification the
  // service worker sends is unaffected either way.
  import(chrome.runtime.getURL('lib/toast.js'))
    .then((module) => {
      toastLib = module;
      surface = module.createFeedbackSurface(document);
    })
    .catch((error) => {
      console.warn('[putiorr] in-page feedback failed to load, grabs report by notification only:', error);
    });

  // Everything below is decoration, and decoration must never speak up in the
  // click handler. Its catch means "the grab never left the page" and answers by
  // refiring the click; a throw from a toast landing there would turn one
  // successful grab into a second, duplicate download. So each of these
  // swallows its own failure and hands back nothing rather than throwing.
  function showFeedback(state) {
    try {
      return surface?.show(state) ?? null;
    } catch (error) {
      console.warn('[putiorr] could not draw the in-page feedback:', error);
      return null;
    }
  }

  // profileName is only ever passed on by a caller that was told one — the
  // right-click path, where the user named the profile on the menu. The click
  // handler calls this with nothing, because at click time nothing on this side
  // knows which profile will take the grab.
  function acknowledge(profileName) {
    return toastLib ? showFeedback(toastLib.pendingFeedback(profileName)) : null;
  }

  function settleFeedback(handle, result) {
    if (!toastLib) return;
    const state = toastLib.feedbackFor(result);
    if (!handle) {
      showFeedback(state);
      return;
    }
    try {
      handle.update(state);
    } catch (error) {
      console.warn('[putiorr] could not update the in-page feedback:', error);
    }
  }

  function withdrawFeedback(handle) {
    try {
      handle?.dismiss();
    } catch (error) {
      console.warn('[putiorr] could not remove the in-page feedback:', error);
    }
  }

  // The one storage key this script reads, spelled out rather than imported from
  // lib/settings.js: a content script can only import web-accessible resources,
  // and exposing the settings module to every page is not worth one default.
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

  function filenameFrom(response, url) {
    const fromHeader = filenameFromDisposition(response.headers.get('content-disposition') ?? '').trim();
    if (fromHeader) return withTorrentSuffix(fromHeader);
    const base = new URL(url, window.location.href).pathname.split('/').pop();
    return base ? withTorrentSuffix(base) : 'upload.torrent';
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
    // magnetFromLink covers both a magnet: href and a magnet carried inside an
    // http(s) handler URL, and it must be asked first: isTorrentLink would
    // otherwise claim a magnet URI whose payload happens to end in ".torrent",
    // and a handler URL whose path does.
    const magnet = lib.magnetFromLink(href);
    if (!magnet && !lib.isTorrentLink(href)) return;
    event.preventDefault();
    event.stopPropagation();
    // An impatient second click must not become a second transfer. Dropping it
    // rather than letting it through matters: the browser would otherwise
    // download the very file the pending capture is already handling.
    if (inFlight.has(anchor)) return;
    inFlight.add(anchor);
    // Outside the async block below, and outside its try, on purpose: this is
    // the one call that says "the click landed", it has to happen before any
    // await for that to be true, and its structural distance from the catch is
    // what keeps a failure to draw out of the refire path.
    const feedback = acknowledge();
    (async () => {
      try {
        const payload = magnet
          ? { kind: 'grab', magnet, pageUrl: window.location.href }
          : { kind: 'grab', ...(await fetchTorrent(href)), pageUrl: window.location.href };
        const result = await chrome.runtime.sendMessage(payload);
        settleFeedback(feedback, result);
      } catch (error) {
        // The click is about to be replayed, so the browser is going to do what
        // it would have done unaided; leaving the acknowledgement up would
        // claim a grab that never happened.
        withdrawFeedback(feedback);
        // The grab never reached putiorr: the .torrent fetch failed or timed
        // out, or an extension reload orphaned this content script and
        // sendMessage has nothing left to talk to. Refire the click so the
        // browser does what it would have without the extension — download the
        // .torrent, hand a magnet: href to the OS protocol handler, or follow a
        // handler link to the page it points at. A grab that did reach putiorr
        // and failed there resolves normally, and is reported by the toast
        // above and by the service worker's notification, so it must never land
        // here — and neither may a toast that could not be drawn.
        console.warn('[putiorr] capture failed, falling back to the browser:', error);
        refire(anchor);
      } finally {
        inFlight.delete(anchor);
      }
    })();
  }, true);

  // A right-click grab happens entirely in the service worker, so the page only
  // hears about it if the worker says so. The message arrives twice: once
  // without a result to acknowledge the pick, once with it. An answer whose
  // acknowledgement was never seen — a page that navigated in between, a
  // content script that had not built its surface yet — still shows up, because
  // the answer is the half that matters.
  function applyMenuFeedback({ id, result, profileName }) {
    if (result === undefined) {
      // The pick carries the profile the user chose, so the acknowledgement can
      // name it rather than waiting a round trip to say the same thing. The
      // worker sends nothing here when its stored list no longer holds the id,
      // and an unnamed acknowledgement then reads exactly like a click's.
      const handle = acknowledge(profileName);
      if (handle) menuFeedback.set(id, handle);
      return;
    }
    settleFeedback(menuFeedback.get(id) ?? null, result);
    menuFeedback.delete(id);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === 'grab-feedback') {
      applyMenuFeedback(message);
      // Answered on the spot: the worker awaits this, and a port left to close
      // on its own would reject there and be reported as a failed grab.
      sendResponse({ ok: true });
      return undefined;
    }
    if (message?.kind !== 'fetch-link') return undefined;
    fetchTorrent(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
