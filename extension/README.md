# putiorr grab — Chrome extension

Captures `magnet:` links and `.torrent` downloads on any site and sends them to
putiorr, which adds them to put.io and downloads them to the local folder of the
putiorr profile the grab resolved to.

There are two ways to grab:

- **Click** a `magnet:` or `.torrent` link. The click is captured and the grab
  goes to the profile of the first matching site rule, or to the default
  profile. Auto-capture can be switched off in the options.
- **Right-click any link → Send to putiorr → `<profile>`.** This overrides
  the profile for that one grab, and it is also the way to grab from trackers
  whose download URLs do not end in `.torrent` (`download.php?id=…` and
  friends), because click capture only recognises a path ending in `.torrent`.

`.torrent` files are fetched from inside the page, so private-tracker session
cookies apply.

## Install

The extension is not published; load it unpacked.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `extension/` directory.
3. Reload any tabs that were already open — pages loaded before the extension
   have no content script, so clicks on them are not captured and the
   right-click menu answers "Reload the page, then try again" for `.torrent`
   links.

## Configure

Open the extension options (`chrome://extensions` → **Details** →
**Extension options**) and:

1. Enter the **putiorr URL**, for example `http://nas:9091`. It must be the
   root URL of the host, `http://` or `https://`, with no path, query, or
   fragment; putiorr cannot be served from a subpath, so a URL with one is
   refused rather than silently trimmed.
2. If putiorr is behind Basic auth, fill in **Username** and **Password**. They
   are kept in `chrome.storage.local`, not in the Google-account-synced storage
   that holds the rest of the settings.
3. Click **Test connection & load profiles**. It calls `GET /api/profiles` and
   loads the enabled profiles. Loading only fills the dropdowns — press
   **Save** to store them.
4. Pick a **default profile**. Without one, only site rules and the right-click
   menu can grab.
5. Leave **Auto-capture magnet and .torrent clicks** on, or switch it off to
   grab exclusively through the right-click menu.
6. Optionally add **site rules**: a comma-separated list of domains and the
   profile they grab into. Subdomains match automatically, so list the domain
   itself — `x.example` also covers `dl.x.example`.

Rule domains are normalized when you save and written back into the field, so
what is on screen is what will be matched: a unicode domain is stored in
punycode, a scheme or path is stripped, and a leading dot is dropped. Underscore
hostnames (`media_server.lan`) are accepted because they really do match on a
home LAN. Wildcards are rejected — `*.x.example` is answered with the rule you
actually want, `x.example`. A single-label domain saves with a warning, because
suffix matching makes `lan` a rule over every host ending in `.lan`.

## Pick The Right Profile

Create a dedicated putiorr profile for browser grabs and enable **Auto-remove
completed downloads** on it. A browser grab has no *arr app that will import it
and signal completion, so without that flag the transfer sits in the putiorr
list forever. With it — exactly like a `prowlarr` profile, which gets the flag
by default — the completed transfer is removed from putiorr and from put.io
once the files have downloaded, while the downloaded files stay on disk.

putiorr logs a warning (once per profile) when a grab targets a profile that
does not have the flag set.

## Verify The Setup

Run this once after loading the extension, against a running putiorr (the
[compose stack](../putiorr-compose) is enough):

1. Click a `magnet:` link on any tracker page → a **Sent to putiorr →
   `<profile>`** notification appears and the transfer shows up in the putiorr
   dashboard.
2. Click a `.torrent` link → the same, with the put.io transfer created from
   the uploaded file.
3. Right-click a link → **Send to putiorr → `<other profile>`** → the
   transfer lands under that other profile's folder.

## What To Expect

- Every grab that reaches the extension's service worker ends in a
  notification. Success shows the profile and the transfer name; failure shows
  what went wrong (unreachable putiorr, rejected credentials, no profile
  configured, the error putiorr returned).
- Modifier clicks are never captured. Ctrl/Cmd, Shift, and Alt clicks are passed
  straight to Chrome, so **Alt+click stays "download to disk"** and is the
  manual escape hatch when you want the raw `.torrent`.
- Only genuine left-clicks are captured; a click a page synthesised on a link it
  planted is ignored.
- If a capture fails before the grab reaches putiorr — the `.torrent` fetch
  failed or timed out, or an extension reload orphaned the page's content
  script — the click is replayed as a normal browser action: a magnet goes to
  the OS handler, a `.torrent` downloads. A grab that did reach putiorr and
  failed there is reported by notification instead and is never retried this
  way.
- Clicking the same link again while a capture is still in flight is dropped, so
  an impatient double-click does not create two transfers.
- Fetches have deadlines: 15s for the in-page `.torrent` fetch and for **Test
  connection & load profiles**, 30s for the worker's request to putiorr (putiorr
  waits on put.io while adding the transfer, so it needs the headroom).

## The `/api/grab` Endpoint

The extension posts to `POST /api/grab` on putiorr. That endpoint requires the
`X-Putiorr-Grab` header and answers `403` without it; any non-browser client
(curl, a script) must send it too:

```bash
curl -X POST http://nas:9091/api/grab \
  -H 'X-Putiorr-Grab: 1' \
  -H 'Content-Type: application/json' \
  -d '{"profileId":1,"magnet":"magnet:?xt=urn:btih:…"}'
```

The header is an anti-CSRF measure, not authentication. Without it, any web page
you visit could POST a grab to your putiorr as a cross-site "simple" request
(no preflight, credentials attached) and spend your put.io account; the response
would be unreadable to the attacker, but the transfer would still be created.
A custom header forces the browser to preflight, and putiorr never answers
preflights, so the request never leaves the attacker's page. The extension is
exempt from CORS through its `host_permissions`. Basic auth, if configured,
applies to `/api/grab` like it does to every other putiorr route.

## Known Limitations

- Cross-origin `.torrent` links are fetched by the content script and are
  therefore subject to the page's CORS policy; a host that does not allow the
  page's origin fails the fetch and the click falls back to a normal browser
  download.
- Links inside iframes are not captured (`all_frames` is not set in the
  manifest), so an embedded frame behaves as if the extension were not
  installed.
- There is no size cap on the fetched `.torrent`; an oversized file trips
  Chrome's message size limit, which fails the send and falls back to a normal
  download.
- A malicious page can overlay an invisible magnet link under a real button and
  harvest a genuine click — the grab notification is the only tell.
- Any page can detect that the extension is installed by fetching its
  web-accessible `lib/resolve.js`; `use_dynamic_url` was deliberately not used
  because it broke dynamic import from content scripts before Chrome 132, and is
  worth re-evaluating once the supported Chrome floor moves past that.
- Chrome only. This is a Manifest V3 extension built against the `chrome.*` APIs
  and has not been adapted for other browsers.
