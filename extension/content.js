// Captures clicks on magnet:/.torrent links — and on the http(s) handler links
// that carry a magnet in their query — and forwards them to the service
// worker. .torrent files are fetched here, in the page context, so
// private-tracker session cookies apply. Not a module (content scripts can't
// be), so shared helpers load via dynamic import.

(() => {
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
  // identical to a broken extension from the user's side. Both modules are
  // needed to capture anything at all — one decides what a link is, the other
  // fetches it — so they load as one gate rather than two half-working ones.
  Promise.all([
    import(chrome.runtime.getURL('lib/resolve.js')),
    import(chrome.runtime.getURL('lib/torrent.js')),
  ])
    .then(([resolve, torrent]) => {
      lib = { ...resolve, ...torrent };
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

  // Chrome leaves the runtime object in place and takes the id away, so this is
  // the reliable signal — steadier than matching the wording of an error
  // message, which is Chrome's to change.
  function isOrphaned() {
    return !chrome?.runtime?.id;
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

  // The fetch this page can make, and the reason .torrent capture starts here:
  // the request carries the tracker's own session cookies, which is what a
  // private tracker hands its files to.
  async function fetchTorrent(url) {
    if (!lib) throw new Error('the putiorr link helpers are not loaded on this page; reload it');
    return lib.fetchTorrent(url, { base: window.location.href });
  }

  // ...and the reason it cannot end here. A fetch made from a page is bound by
  // that page's CORS policy, and a great many trackers serve their .torrent
  // files from a separate download host or CDN: the link 302s to another
  // origin, the response carries no Access-Control-Allow-Origin, and the fetch
  // fails on a file that is perfectly reachable. The service worker holds
  // host_permissions and is not bound by the page's CORS, so it gets the
  // second attempt — before the click is handed back to the browser, never
  // instead of the attempt above. Its cookie jar is not the page's: a
  // cross-site request from the worker carries no SameSite=Lax cookie, so a
  // tracker that gates downloads on a session cookie can still fail here. That
  // is what the ordering is for — this is the rescue, not the route.
  async function fetchTorrentWithRescue(url) {
    try {
      return await fetchTorrent(url);
    } catch (error) {
      console.warn('[putiorr] the page could not fetch the .torrent, asking the extension:', error);
      const answer = await chrome.runtime.sendMessage({ kind: 'fetch-torrent', url });
      // A refusal here throws, so it lands in the click handler's catch with
      // the page's own failures and is answered the same way: withdraw the
      // acknowledgement, replay the click, let the browser have it.
      if (!answer?.ok) throw new Error(answer?.error ?? 'the extension could not fetch the .torrent either');
      return { torrentBase64: answer.torrentBase64, filename: answer.filename };
    }
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
          : { kind: 'grab', ...(await fetchTorrentWithRescue(href)), pageUrl: window.location.href };
        const result = await chrome.runtime.sendMessage(payload);
        settleFeedback(feedback, result);
      } catch (error) {
        // An update or a reload orphans every content script already in a page:
        // chrome.runtime survives with no id, and sendMessage rejects with
        // "Extension context invalidated". Nothing is wrong with the link, the
        // network or putiorr, and the browser fallback below is not the remedy
        // — reloading the page is. Withdrawing in silence made that look like a
        // click the extension ignored, and once published this happens to every
        // open tab on every auto-update, so it is the failure users will meet
        // most often and the one worth naming.
        if (isOrphaned()) {
          settleFeedback(feedback, {
            ok: false,
            error: 'putiorr was updated — reload this page, then click again',
          });
        } else {
          // The click is about to be replayed, so the browser is going to do
          // what it would have done unaided; leaving the acknowledgement up
          // would claim a grab that never happened.
          withdrawFeedback(feedback);
        }
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
    // The page's attempt and only that: this request came from the worker, and
    // the worker retries with its own fetch when the answer says the page could
    // not. Rescuing from here would send it straight back where it came from.
    fetchTorrent(message.url)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
