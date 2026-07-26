# Browser Grab Extension Design

Tracking issue: https://github.com/ptheofan/putiorr/issues/59

**Superseded in part by issue #68.** The options page has no default-profile
dropdown. Where a grab from an unlisted site lands is a checkbox on the putiorr
profile (`browser_catch_all`, at most one profile), so the extension holds a
connection and a capture toggle and routes nothing. Read every "default
profile" below as that profile.

## Goal

Let the user click a `magnet:` link or a `.torrent` download link on any tracker
site and have the grab land in putiorr, which adds it to put.io and downloads
it locally according to a putiorr profile — the same flow the *arr apps use,
but triggered from the browser.

## Scope

- Chrome/Chromium only (Manifest V3), loaded unpacked. No store publishing.
- Extension code lives in this repo under `extension/`.
- One new server endpoint; everything else reuses existing putiorr machinery.

## Architecture

```text
tracker page ── click magnet:/.torrent link
      │ (content script intercepts)
      ▼
service worker ── resolves profile: per-grab pick → site rule → default
      │ POST /api/grab (Basic auth)
      ▼
putiorr ── service.addTorrent() → put.io → local download per profile
```

The extension is a thin client. All download behavior (put.io folder, local
download folder, download policy) stays in putiorr profiles.

## Server change

One new route in the existing `handleApi` switch in
`src/transmission/server.js`:

- `POST /api/grab`
  - Body: `{ profileId, magnet }` or `{ profileId, torrentBase64, filename }`,
    plus optional `sourceUrl` (logging only).
  - Validates the profile exists, then calls the existing
    `service.addTorrent()` — the same code path as Transmission `torrent-add`,
    which already accepts magnet links (`filename`) and base64 metainfo
    (`src/transfer/service.js:267-286`).
  - Success: `{ ok: true, transfer: { id, name } }`.
  - Failure: appropriate 4xx/5xx with `{ error: "message" }`.
- Auth: the existing gate — `handle()` applies Basic auth to every route
  before dispatch (`src/transmission/server.js:352`).
- CSRF defense (Basic auth does not provide it — browsers replay cached
  credentials cross-site): the endpoint requires an `X-Putiorr-Grab` header
  and returns 403 without it. A custom header forces a CORS preflight the
  server never answers, so attacker web pages are blocked; the extension
  sends the header explicitly and is exempt from CORS via host permissions.
- `torrentBase64` is validated at the boundary (base64 round-trip + bencode
  dict first byte) so an expired-tracker-session HTML page is rejected with a
  clear 400 instead of being uploaded to put.io.
- Profile discovery: the existing `GET /api/profiles`.

## Extension components (`extension/`)

- `manifest.json` — MV3. `content_scripts` on `<all_urls>` (click capture on
  any site; also grants fetch access to the putiorr origin). Permissions:
  `storage`, `notifications`, `contextMenus`.
- `content.js` — intercepts clicks on `a[href^="magnet:"]` and links matching
  `\.torrent(\?|$)`.
  - Magnets: forward the href to the service worker.
  - `.torrent`: fetch from the page context so private-tracker session cookies
    apply, base64-encode, forward to the service worker.
  - Cancels the click's default action only after in-page capture succeeds; if
    the fetch fails, the click falls through to a normal browser download.
  - Respects a global auto-capture on/off toggle.
- `background.js` (service worker) — profile resolution, POST to putiorr,
  success/failure notifications, and a context menu on any link:
  "Send to putiorr → <profile list>". The context menu is both the per-grab
  profile override and the fallback for trackers whose download URLs do not
  end in `.torrent` (e.g. `download.php?id=`).
- `options.html` / `options.js` — putiorr base URL, Basic auth credentials,
  default profile (dropdown fed by `/api/profiles`), auto-capture toggle, and
  the site-rules table.

## Site rules

Rules map page domains to profiles:

```json
{ "domains": ["x.example", "z.example"], "profileId": 3 }
```

"All grabs from X and Z use profile XZ."

- Matching uses the page's hostname (the tab URL), not the link target, with a
  suffix match so subdomains count.
- Resolution order: explicit context-menu choice → first matching site rule →
  default profile.
- Storage: rules and settings in `chrome.storage.sync`; credentials in
  `chrome.storage.local`.

## Completed-transfer cleanup

Browser grabs have no *arr download client to import them, so they follow the
prowlarr-profile behavior: when the local download completes, the transfer is
removed from the putiorr list and from put.io, and the downloaded files are
kept on disk.

This needs no new mechanism — cleanup is already driven by the per-profile
`auto_remove_completed` flag (`src/download/manager.js:31`); prowlarr profiles
merely default it to on (`src/state/store.js:131-139`). Therefore:

- Profiles used as browser-grab targets (the default profile and site-rule
  targets) are expected to be dedicated profiles with
  `auto_remove_completed` enabled. (Superseded by #67 phase 5: the Putiorr Grab
  preset defaults the flag to on in the store, so the wizard, `POST
  /api/profiles` and `PUTIORR_PROFILES_JSON` all get it.)
- Documentation (README section and `extension/README.md`) instructs the user
  to create browser profiles with this flag on.
- If `/api/grab` targets a profile without the flag, the grab still succeeds;
  putiorr logs a warning that the completed transfer will stay in the list
  until removed manually.

## Error handling

Every grab ends in a Chrome notification:

- Success: profile name + transfer name.
- Failure: putiorr's real error message (bad auth, put.io rejection,
  duplicate, unreachable server).

The content script never leaves the user stuck: capture failures fall through
to the normal download.

## Testing

- Server: `test/api-grab.test.js` using the node test runner, mirroring the
  existing `transmission-rpc.test.js` style. Cases: magnet add, metainfo add,
  unknown profile, malformed body.
- Extension: pure logic (rule matching, profile resolution, link detection)
  extracted into importable modules and covered by node tests. Browser wiring
  verified manually against the compose stack.

## Delivery

- Branch `feat/browser-grab-extension` from `origin/main`.
- PR references issue #59.
- Docs: README section + `extension/README.md` with load-unpacked
  instructions.
