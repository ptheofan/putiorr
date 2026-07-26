# putiorr grab — Chrome extension

Captures `magnet:` links and `.torrent` downloads on any site and sends them to
putiorr, which adds them to put.io and downloads them to the local folder of the
putiorr profile the grab resolved to. That profile is always one whose **App
preset** is **Putiorr Grab**: no other preset is offered here, and a grab aimed
at any other preset is refused.

There are two ways to grab:

- **Click** a `magnet:` or `.torrent` link. The click is captured and putiorr
  decides where it goes: the profile that lists the page's site under **Browser
  sites**, or the one profile set to take every site nobody listed.
  Auto-capture can be switched off in the options.
- **Right-click any link → Send to putiorr → `<profile>`.** This overrides
  the profile for that one grab, and it is also the way to grab from trackers
  whose download URLs do not end in `.torrent` (`download.php?id=…` and
  friends), because click capture only recognises a path ending in `.torrent`.

`.torrent` files are fetched from inside the page, so private-tracker session
cookies apply.

## Install

The extension is not on the Chrome Web Store yet; until it is, load it unpacked.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this `extension/` directory.
3. Reload any tabs that were already open — pages loaded before the extension
   have no content script, so clicks on them are not captured and the
   right-click menu answers "Reload the page, then try again" for `.torrent`
   links.

## Configure The Sites In putiorr

Which site grabs into which profile is a putiorr setting, kept on the profile
itself — the extension holds no copy of it. In the putiorr dashboard, open a
profile's setup wizard and set **App preset** to **Putiorr Grab**. The wizard
then drops the RPC endpoint step — no *arr download client connects to a grab
profile, so its path, host, port, and SSL are not asked for, and no path is
reserved for it either: a grab profile has no Transmission RPC endpoint at all,
and `/api/grab` is the only way in — and shows step **3. Browser grabs**
instead. **Browser sites** there is a comma-separated list of the sites whose
grabs land in that profile. Subdomains match automatically, so list the domain
itself —
`x.example` also covers `dl.x.example`. Leave it empty to keep a profile out of
browser grabs. Sites listed on any other preset are never consulted.

Under it is **Take grabs from any site no other profile claims**. Tick it on one
grab profile and every grab from a site nobody listed lands there; leave it off
everywhere and such a grab is refused rather than guessed at. It is a fallback,
not a wildcard: a profile that lists a site still wins for that site. Only one
profile may hold it, and a second save is refused, naming the one that does.

putiorr normalizes what you save and the profile card shows the stored result,
so what is listed is what will be matched: a unicode domain is stored in
punycode, a scheme, port, or path is stripped, and leading dots and a trailing
dot are dropped. Underscore hostnames (`media_server.lan`) are accepted because
they really do match on a home LAN. Wildcards are refused — `*.x.example` is
answered with the entry you actually want, `x.example`, and the profile is not
saved until you fix it. A single-label site saves with a warning next to the
confirmation, because suffix matching makes `lan` a rule over every host ending
in `.lan`.

## Configure The Extension

Open the extension options (`chrome://extensions` → **Details** →
**Extension options**) and:

1. Enter the **putiorr URL**, for example `http://nas:9091`. It must be the
   root URL of the host, `http://` or `https://`, with no path, query, or
   fragment; putiorr cannot be served from a subpath, so a URL with one is
   refused rather than silently trimmed.
2. If putiorr is behind Basic auth, fill in **Username** and **Password**. They
   are kept in `chrome.storage.local`, not in the Google-account-synced storage
   that holds the rest of the settings.
3. Click **Test connection & load profiles**. It calls
   `GET /api/profiles?type=grab`, so putiorr answers with Putiorr Grab profiles
   only and this page never offers a profile putiorr would refuse; the disabled
   ones come back too and are dropped here. Loading only fills the page — press
   **Save** to store them.
4. Leave **Auto-capture magnet and .torrent clicks** on, or switch it off to
   grab exclusively through the right-click menu.

There is nothing here that decides where a grab lands. That moved onto the
putiorr profiles, so this page holds a connection and a capture toggle and
shows putiorr's routing read-only.

Three different answers leave nothing to load, and the status says which one it
was rather than sending you off to create a profile you already have:

- "has no Putiorr Grab profiles; create one there with the Putiorr Grab preset"
  — nothing came back at all. A putiorr full of *arr profiles reads this way
  too, since none of them can accept a grab.
- "has no enabled Putiorr Grab profiles; enable one there" — grab profiles
  exist, and every one of them is switched off.
- "answered with Putiorr Grab profiles this page could not read; check that the
  URL points at putiorr" — rows came back without a usable id, which is what
  some other server's JSON at that URL looks like from here.

None of the three is applied: clearing the page and saving that would take the
right-click menu with it.

The **Profiles** card lists what the last load returned: every enabled Putiorr
Grab profile with what it takes, read-only. A profile that takes the unlisted
sites is marked "and any site no other profile claims" — that question is why
this page once had a Default profile dropdown, and the card is where it is
answered now. If no profile takes them, the load says so, because otherwise the
first you hear of it is a link click that fails.

It is a view of putiorr's setting, not a second place to edit it. The routing is
deliberately not stored, so after a reload of the options page the card lists the
profile names it has cached with "routing unknown until you load" in their place,
until you test the connection again; it is empty only when nothing is cached at
all. A site moved to another profile in putiorr applies to the very next click
whether or not the card has caught up.

Upgrading from a version that had its own site rules? The options page shows
them read-only under **Old site rules**, above the connection card, and keeps
showing them until you press **Dismiss**, which deletes them from storage. They
are never pushed to putiorr: only you know whether that mapping is still what
you want. Recreate it as **Browser sites** on the profiles you want, then
dismiss.

## Which Profile A Grab Lands In

putiorr resolves this on every grab, in this order, and every path ends at a
Putiorr Grab profile:

1. The profile picked from the right-click menu, when the grab came from there.
2. Otherwise the first Putiorr Grab profile, in creation order, whose **Browser
   sites** match the page's hostname exactly or as a suffix. Listing one site on
   two profiles is therefore not an error; the older profile simply wins.
3. Otherwise the one Putiorr Grab profile with **Take grabs from any site no
   other profile claims** ticked. It is consulted only once no profile's sites
   matched, so listing a site never loses to it.
4. Otherwise nothing: putiorr answers `400` with "No Putiorr Grab profile claims
   `<host>` and none is set to take everything else; tick "Take grabs from any
   site no other profile claims" on a profile in putiorr", which the
   notification shows verbatim. The fix is in putiorr, so the extension does not
   reword it.

Step 1 names a profile the extension holds, so putiorr checks the preset before
grabbing into it: a profile that is not a Putiorr Grab profile is refused with
"`<name>` is not a Putiorr Grab profile; set its App preset to Putiorr Grab in
putiorr". The menu was built with the preset filter applied, so this is what a
stale one looks like — load profiles again in the options, or change that
profile's preset in putiorr.

A disabled profile still claims its sites, and still holds the catch-all if it
has it. Disabling means the profile accepts no new work, not that it is absent,
so such a grab is refused by name ("RR profile X is disabled") instead of
falling through to the next candidate — which would put the transfer in a folder
you never chose, as a result of switching a profile off. An explicit right-click
pick is refused the same way. Delete the profile if you want its claims
released.

The **Profiles** card and the right-click menu list only enabled profiles, so a
site claimed by a disabled one is a click that fails against a profile this page
does not show. The refusal names it, which is where to look.

## Pick The Right Profile

Browser grabs get their own profile, created with the **Putiorr Grab** preset,
which ticks its auto-remove checkbox — **Nothing imports a browser grab; remove
from putiorr once files download locally**, in the wizard's Options step — by
default. So does a grab profile created through `POST /api/profiles` or seeded
from `PUTIORR_PROFILES_JSON`: the default is putiorr's, not the wizard's. Send
`auto_remove_completed: false` to opt out. A browser grab has no *arr app that
will import it and signal completion, so without that flag the transfer sits in
the putiorr list forever.
With it — exactly like a `prowlarr` profile, which gets the flag for the same
reason — the completed transfer is removed from putiorr and from put.io once
the files have downloaded, while the downloaded files stay on disk. Switching
it back off is allowed, and putiorr logs a warning (once per profile) when a
grab targets a profile that does not have the flag set.

Grabs land in the profile's **Shared download folder** as put.io named them,
with no category subfolder: that folder exists so an *arr app can find its own
imports, and nothing imports a browser grab.

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
4. In putiorr, set **Browser sites** on a Putiorr Grab profile that is *not* the
   one taking the unlisted sites to the site you are testing on, save, and click
   a `magnet:` link there → the notification names that profile, not the
   catch-all, and the transfer lands under its folder. Nothing in the extension
   is touched for this: the options page shows the new site after the next
   **Test connection & load profiles**, but grabs route correctly before that.

## What To Expect

- Every grab that reaches the extension's service worker ends in a
  notification. Success names the profile putiorr actually resolved — read from
  the response, not guessed locally — along with the transfer name; failure
  shows what went wrong (unreachable putiorr, rejected credentials, nothing
  claiming the site, the error putiorr returned).
- A profile in the right-click menu that putiorr no longer has is called out for
  what it is: the grab fails with "putiorr no longer has the profile you picked
  (#N); load profiles again in the options", and clicking that notification
  opens the options page. It is the only id a grab still carries, so it is the
  only 404 worth rewording.
- Modifier clicks are never captured. Ctrl/Cmd, Shift, and Alt clicks are passed
  straight to Chrome, so **Alt+click stays "download to disk"** and is the
  manual escape hatch when you want the raw `.torrent`.
- Only genuine left-clicks are captured; a click a page synthesised on a link it
  planted is ignored.
- If a capture fails before the grab reaches the extension's service worker —
  the `.torrent` fetch failed or timed out, or an extension reload orphaned the
  page's content script — the click is replayed as a normal browser action: a
  magnet goes to the OS handler, a `.torrent` downloads. Once the worker has the
  grab, every outcome is reported by notification and nothing is replayed: an
  unreachable or sleeping putiorr, rejected credentials, and an error putiorr
  returned all end there, with no fallback download.
- Clicking the same link again while a capture is still in flight is dropped, so
  an impatient double-click does not create two transfers.
- Fetches have deadlines: 15s for the in-page `.torrent` fetch and for **Test
  connection & load profiles**, 25s for the worker's request to putiorr (putiorr
  waits on put.io while adding the transfer, so it needs the headroom, but the
  deadline stays under the 30s at which Chrome retires an idle worker).

## The `/api/grab` Endpoint

The extension posts to `POST /api/grab` on putiorr. That endpoint requires the
`X-Putiorr-Grab` header and answers `403` without it; any non-browser client
(curl, a script) must send it too:

```bash
curl -X POST http://nas:9091/api/grab \
  -H 'X-Putiorr-Grab: 1' \
  -H 'Content-Type: application/json' \
  -d '{"pageHost":"x.example","magnet":"magnet:?xt=urn:btih:…"}'
```

That call lands if some Putiorr Grab profile claims `x.example`, or if one is
set to take the sites no profile claims; add `"profileId":N` to pick a profile
outright instead.

The body carries either `magnet` or `torrentBase64` (plus an optional
`filename`), an optional `sourceUrl` for putiorr's log, and the two fields that
decide the profile:

- `profileId` — optional, the caller's explicit pick. It wins over everything
  else; a non-empty value that is not a positive integer is a `400`, and an id
  putiorr does not have is a `404`, never a silent fallback. Empty or `null`
  counts as no pick at all and falls through to the site match.
- `pageHost` — optional, the hostname of the page the grab came from, matched
  against the **Browser sites** of every Putiorr Grab profile, switched on or
  off. Omitting it skips straight to the catch-all.

With neither, and no catch-all profile, the answer is the `400` "No Putiorr Grab
profile claims `<host>` and none is set to take everything else; tick …".
`defaultProfileId` is no longer read: where an unclaimed grab lands is a setting
on the putiorr profile, and a body still carrying the old key is routed exactly
as one without it.

`profileId` names a profile instead of letting putiorr find one, so it can name
a profile of the wrong preset. That is the `400` "`<name>` is not a Putiorr Grab
profile; set its App preset to Putiorr Grab in putiorr". The list to pick from
is `GET /api/profiles?type=grab`. That parameter
filters by preset and by nothing else — disabled profiles are in the answer
either way — while the bare route answers with every profile of every preset.

The reply names the profile that answered, so the caller does not have to repeat
its own guess back to the user:

```json
{"ok":true,"profile":{"id":4,"name":"browser"},"transfer":{"id":9,"name":"…"}}
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
- The extension puts no size cap on the fetched `.torrent`, but putiorr rejects
  request bodies over 2 MiB and base64 inflates the file by 4/3, so anything
  above roughly 1.5 MiB comes back as a failure notification — with no
  fallback download, because the grab did reach putiorr — and has to be added
  by hand.
- A malicious page can overlay an invisible magnet link under a real button and
  harvest a genuine click — the grab notification is the only tell.
- Any page can detect that the extension is installed by fetching its
  web-accessible `lib/resolve.js`; `use_dynamic_url` was deliberately not used
  because it broke dynamic import from content scripts before Chrome 132, and is
  worth re-evaluating once the supported Chrome floor moves past that.
- The extension expects a putiorr that knows about browser sites. An
  auto-captured click sends no `profileId` — that is the server's decision now —
  so against an older putiorr it comes back as "profileId is required" and only
  the right-click menu still grabs. Update putiorr, or use the menu. The skew in
  the other direction shows up in the menu: an extension that loaded its
  profiles before the Putiorr Grab preset existed cached *arr profiles too, and
  picking one of those is refused with "is not a Putiorr Grab profile". Load
  profiles again in the options and the menu holds only profiles that can
  actually grab.
- Chrome only. This is a Manifest V3 extension built against the `chrome.*` APIs
  and has not been adapted for other browsers.
