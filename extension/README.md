# putiorr grab — Chrome extension

Captures `magnet:` links, `.torrent` downloads, and the `http(s)` links that
carry a magnet in their query on any site, and sends them to
putiorr, which adds them to put.io and downloads them to the local folder of the
putiorr profile the grab resolved to. That profile is always one whose **App
preset** is **Putiorr Grab**: no other preset is offered here, and a grab aimed
at any other preset is refused.

There are two ways to grab:

- **Click** a `magnet:` or `.torrent` link. The click is captured and putiorr
  decides where it goes: the profile that lists the page's site under **Browser
  sites**, or the one profile set to take every site nobody listed.
  Auto-capture can be switched off in the options.
- **Click a link that carries a magnet in its query**, like
  `https://put.io/default/magnet?url=magnet:?xt=…` or `download.php?magnet=…`.
  Sites wrap magnets in handler links and redirectors all the time; following
  one hands the torrent to whoever wrote that page instead of to putiorr, so
  the magnet is pulled out of the link and grabbed like any other. See
  [What Counts As A Wrapped Magnet](#what-counts-as-a-wrapped-magnet).
- **Right-click any link → Send to putiorr → `<profile>`.** This overrides
  the profile for that one grab, and it is also the way to grab from trackers
  whose download URLs do not end in `.torrent` (`download.php?id=…` and
  friends), because click capture only recognises a path ending in `.torrent`
  or a link with a magnet in it.

`.torrent` files are fetched from inside the page, so private-tracker session
cookies apply. When that fetch cannot be made — most often because the link
redirects to a separate download host and the page's CORS policy refuses the
response — the service worker fetches the file itself and the grab goes ahead;
see [Known Limitations](#known-limitations) for what that costs.

Either way the grab reports itself on the page it came from, and again as a
Chrome notification — see [What A Grab Looks Like](#what-a-grab-looks-like).

The toolbar icon grabs nothing. It opens a popup about the page you are on:
which profile a grab from this site would land in, and — when no profile claims
it yet — a way to claim it for one without opening the dashboard.

## What Counts As A Wrapped Magnet

A link is treated as a magnet when the magnet is somewhere in it and names a
BitTorrent swarm — an `xt` of `urn:btih:` (v1) or `urn:btmh:` (v2). Both of
these are captured, and both keep the display name and every tracker:

| Link | Where the magnet is |
| --- | --- |
| `https://put.io/default/magnet?url=magnet:?xt=…&dn=…&tr=…` | written plain, so the `&dn=` and `&tr=` read as the *outer* link's parameters |
| `https://x.example/download.php?magnet=magnet%3A%3Fxt%3D…` | percent-encoded inside one parameter |

The first form is the common one and the reason the magnet is taken as
everything from `magnet:?` to the end of the link rather than read out of the
parameter that appears to hold it: to a URL parser, that parameter stops at the
first unencoded `&`, so reading it would grab the infohash and throw the name
and every tracker away. put.io would still find the swarm, eventually, through
the DHT — but the transfer would be named after its own hash and would take as
long as the DHT takes.

Reading to the end of the link over-reaches, though, and the magnet is trimmed
back afterwards: it ends at the first parameter no magnet can have, and at the
link's own `#fragment`. So a handler written
`?url=magnet:?xt=…&dn=…&callback=/done&token=abc123` is grabbed as
`magnet:?xt=…&dn=…` and nothing else. That matters because a token or a signed
callback in a handler link is ordinary, and anything left glued to the magnet
would be stored in putiorr's database, written to its logs, and forwarded to
put.io. The keys kept are the ones a magnet is defined to carry — `xt`, `dn`,
`tr`, `ws`, `xl`, `xs`, `as`, `kt`, `mt`, `so`, each optionally numbered
(`xt.1`, `tr.2`), plus the experimental `x.` namespace such as `x.pe`. A magnet
in the second form — one the site encoded into a single parameter — is never
trimmed: nothing over-reached there, so an unfamiliar key inside it is the
site's to keep. Neither is a plain `magnet:` link, which is what the page author
wrote, in full and on purpose.

A link is left alone when nothing in it names a swarm: `magnet` in the path, a
page *about* magnet links, an `xt` of some other URN (`urn:ed2k:`). One
consequence is worth knowing, because there is no way to have the feature
without it: **a link whose query genuinely contains a valid magnet is captured
even when the page meant it as something else** — a search URL for a magnet
string, a "report this magnet" form link. The click is not followed; the magnet
is grabbed instead. Alt+click, which is never captured, is the way past it, and
auto-capture can be switched off entirely in the options.

## Install

The extension is not on the Chrome Web Store, so it is installed by loading it
unpacked. There are two ways to get the folder to load.

**From a release.** Each release on the
[releases page](https://github.com/ptheofan/putiorr/releases) carries
`putiorr-grab-<version>.zip` under **Assets**: the extension alone, packed by
`pnpm ext:package` from these files. Unpack it into a folder you intend to keep,
and load that folder. The number on it is this directory's own
`manifest.json` version, which moves independently of putiorr's, and the asset
is built by the release workflow — releases published before that workflow
existed have no such file, so take the newest one.

**From a clone.** Load this `extension/` directory itself. Best if the machine
running Chrome already has the repository, because updating is then `git pull`
and a reload.

Then, either way:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the directory holding `manifest.json`.
   Chrome reads it from that path from then on, and derives the extension's id
   from it, so keep the directory where it is — moving or deleting it breaks the
   extension and loses its options.
3. Reload any tabs that were already open — pages loaded before the extension
   have no content script, so clicks on them are not captured. The right-click
   menu still works on such a tab, but the fetch is made by the service worker
   without the page's session cookies, so a private tracker may refuse it.

After unpacking a newer archive over the same path, or pulling a new version of
these files, reload the extension on `chrome://extensions` — Chrome does not
re-read the directory on its own — and reload open tabs again. The options
survive, because the path did not change.
[The extension guide](https://ptheofan.github.io/putiorr/extension.html) covers
all of this at length, and the
[privacy policy](https://ptheofan.github.io/putiorr/privacy.html) sets out what
the extension stores and the only two places it sends anything.

To rebuild the archive yourself, run `pnpm ext:package` from the repository
root. It writes `dist/putiorr-grab-<version>.zip` — a gitignored build artifact
— and verifies its own output before reporting success: `manifest.json` at the
archive root, and every file the manifest references actually present.

## Configure The Sites In putiorr

Which site grabs into which profile is a putiorr setting, kept on the profile
itself — the extension holds no copy of it. The toolbar popup can add one site
to one profile without leaving the page you are on (see
[Claim A Site From The Toolbar](#claim-a-site-from-the-toolbar)); everything
below is where the whole list lives. In the putiorr dashboard, open a
profile's setup wizard and set **App preset** to **Putiorr Grab**. The wizard
then drops the RPC endpoint step — no *arr download client connects to a grab
profile, so its path, host, port, and SSL are not asked for, and no path is
reserved for it either: a grab profile has no Transmission RPC endpoint at all,
and `/api/grab` is the only way in — and shows step **3. Browser grabs**
instead. **Browser sites** there is a comma-separated list of the sites whose
grabs land in that profile. Each is written one of two ways:

| Entry | Matches |
| --- | --- |
| `x.example` | `x.example`, and nothing under it |
| `*.x.example` | `x.example` **and** every subdomain — `dl.x.example`, `a.b.x.example` |

The star is only ever the first thing in an entry: `dl.*.example` and
`example.*` are refused. A wildcard on a single label — `*.com`, `*.lan` —
saves with a warning, because it claims everything under that suffix and
putiorr carries no public-suffix list to tell one from your LAN.

A grab resolves in a fixed order: the profile that lists the page's host
exactly, then the most specific wildcard covering it — the longest base wins,
so `*.dl.x.example` beats `*.x.example` — then the catch-all below, then a
refusal. That order is what makes an overlap useful rather than ambiguous:
`dl.x.example` on one profile and `*.x.example` on another sends that one host
to the first and the rest of the domain to the second. What is refused is the
*same entry* on two grab profiles, naming the profile that already has it.

Leave it empty to keep a profile out of browser grabs. Sites listed on any
other preset are never consulted.

Under it is **Take grabs from any site no other profile claims**. Tick it on one
grab profile and every grab from a site nobody listed lands there; leave it off
everywhere and such a grab is refused rather than guessed at. It is a fallback,
not a wildcard: a profile that lists a site still wins for everything that site
covers. Only one profile may hold it, and a second save is refused, naming the
one that does — with an offer to hand the role over: **Make this the fallback
grab profile** saves what you have typed and unticks the box on that profile in
the same step, and the confirmation names the profile that lost it.

putiorr normalizes what you save and the profile card shows the stored result,
so what is listed is what will be matched: a unicode domain is stored in
punycode, a scheme, port, or path is stripped, and leading dots and a trailing
dot are dropped. Only the hostname is ever compared. Underscore hostnames
(`media_server.lan`) are accepted because they really do match on a home LAN.
An entry no hostname could equal — an empty label, a leading `-` — is refused
and the profile is not saved until you fix it.

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

Recreate it deliberately, because the entries no longer mean what they did:
those rules matched by suffix, so `x.example` covered `dl.x.example` too.
A plain **Browser sites** entry matches that host and nothing under it. The
entry that carries the old meaning over is `*.x.example`.

## Claim A Site From The Toolbar

Click the extension's icon on any page and the popup names that page's site,
then says who handles it:

- **A profile claims it.** "Movies claims this site; grabs from here go there."
  If it matched through a wildcard, the popup names the entry that was actually
  listed — "Movies claims *.x.example, which covers dl.x.example" — because
  otherwise you would go looking for an entry no profile has.
- **The catch-all takes it.** "No profile claims this site. Everything takes
  every site no profile claims, so grabs from here go there for now."
- **Nobody.** "No profile claims this site, and no profile takes the sites
  nobody claims: a grab from here is refused." This is the popup telling you, in
  advance, what a click on the next magnet link would answer.

A profile that is switched off still claims its sites, so it is named like any
other, with the reason its grabs fail added: "That profile is switched off, so
such a grab is refused rather than routed."

When no profile claims the site, the popup lists the enabled Putiorr Grab
profiles under a **Site to claim** field, pre-filled with the page's hostname
exactly as it is — `www.x.example` stays `www.x.example` — and a **Claim this
site** button.

**The field is editable, and what it holds is what gets stored.** Nothing here
shortens a host to the registrable domain behind it: an extension carries no
public-suffix list, and the only rule available for turning `www.x.example` into
`x.example` would turn `x.co.uk` into `co.uk` and claim a whole TLD with it. So
type what you mean. Put `*.` in front — `*.x.example` — to claim the domain and
every subdomain of it in one entry. What you type is normalized the way the
wizard normalizes it, and an entry putiorr could never match is refused here
rather than sent.

A site another profile already claims is **not** offered again. The popup names
that profile and stops, because moving a site is two profiles changing at once,
which is worth seeing whole on the profiles themselves. The two buttons at the
bottom go where that edit is made: **Options** and **Open putiorr**.

The popup reads putiorr on every open and caches nothing: a site claimed from
another window a minute ago would otherwise make it a confident, wrong answer,
and answering that exact question is what it is for. When it cannot read
putiorr it says which of the failures it was, and offers no picker: no putiorr
URL set yet, a tab with no site to claim at all (`chrome://`, `about:blank`, a
local file), an unreachable, stalled, credential-rejecting or non-putiorr
server, and a putiorr with no Putiorr Grab profiles — or none enabled.

## Which Profile A Grab Lands In

putiorr resolves this on every grab, in this order, and every path ends at a
Putiorr Grab profile:

1. The profile picked from the right-click menu, when the grab came from there.
2. Otherwise the Putiorr Grab profile whose **Browser sites** list the page's
   hostname exactly.
3. Otherwise the most specific wildcard covering it: the longest base wins, so
   `*.dl.x.example` beats `*.x.example`. Ties, in either step, go to the older
   profile — though putiorr refuses to store the same entry on two profiles in
   the first place.
4. Otherwise the one Putiorr Grab profile with **Take grabs from any site no
   other profile claims** ticked. It is consulted only once no profile's sites
   matched, so listing a site never loses to it.
5. Otherwise nothing: putiorr answers `400` with "No Putiorr Grab profile claims
   `<host>` and none is set to take everything else; tick "Take grabs from any
   site no other profile claims" on a profile in putiorr", which the page and
   the notification both show verbatim. The fix is in putiorr, so the extension
   does not reword it.

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

1. Click a `magnet:` link on any tracker page → **Downloading with putiorr…**
   appears at the top right of the page at once, becomes **Downloading with
   putiorr using `<profile>` profile** with the release name under it, a **Sent
   to putiorr → `<profile>`** notification appears, and the transfer shows up in
   the putiorr dashboard.
2. Click a `.torrent` link → the same, with the put.io transfer created from
   the uploaded file.
3. Click a link that wraps a magnet — a site's "send to put.io" link, or paste
   `https://put.io/default/magnet?url=magnet:?xt=…&dn=…&tr=…` into a page → both
   reports appear, put.io's own add-magnet page does **not** open, and the
   transfer is named after the magnet's `dn` rather than after its hash, which
   is how you can tell the trackers came along too.
4. Right-click a link → **Send to putiorr → `<other profile>`** → the page shows
   the same two states — and because the pick named the profile, the first of
   them already reads **Downloading with putiorr using `<other profile>`
   profile…** — and the transfer lands under that other profile's folder.
5. In putiorr, set **Browser sites** on a Putiorr Grab profile that is *not* the
   one taking the unlisted sites to the site you are testing on, save, and click
   a `magnet:` link there → the page and the notification name that profile, not
   the catch-all, and the transfer lands under its folder. Nothing in the extension
   is touched for this: the options page shows the new site after the next
   **Test connection & load profiles**, but grabs route correctly before that.
6. On a site no profile lists, click the toolbar icon → the popup says no
   profile claims it, offers the enabled grab profiles, and the button reads
   **Claim `<that exact host>`**. Click it → the popup says that profile now
   claims the site, and a `magnet:` click on the same page lands there. Open the
   popup again → it no longer offers the claim, and names the profile instead.

## What A Grab Looks Like

Every grab is reported twice, on two channels that fail in different ways.

**On the page**, at the top right, in putiorr's own colours (light and dark
both). The moment a click is captured — before putiorr has been asked anything —
it says **Downloading with putiorr…**, because the click was swallowed and
otherwise nothing on screen would have moved. It names no profile, and does not
guess one: which profile takes a site is resolved on the server, from browser
sites this extension deliberately does not cache, so at click time this side
genuinely does not know. A right-click pick is the exception — the user named
the profile on the menu, so that acknowledgement reads **Downloading with
putiorr using `<profile>` profile…** from the start. That same item then becomes
one of:

- **Downloading with putiorr using `<profile>` profile**, with the release name
  under it. The profile is the one putiorr resolved, read from its answer rather
  than guessed here. Against a putiorr too old to name it, this reads
  **Downloading with putiorr**.
- **Failed — `<what putiorr said>`**, word for word: a profile that is switched
  off, no profile claiming the site, rejected credentials, an unreachable or
  sleeping putiorr. That sentence is the fix, so it is not summarised.

A failure stays up more than three times as long as a success, and either can be
dismissed with the **×**. Several grabs in a row stack rather than replace one
another. Right-click grabs are drawn the same way, on the page they were made
from.

The item lives in a closed shadow root pinned out of the page's layout, so it
cannot inherit the site's styling or disturb it, and it honours
`prefers-reduced-motion`.

**As a Chrome notification**, which is what the toast cannot be: visible when
the tab is in the background or behind another window. Success names the same
profile and transfer; failure carries the same message. It is also the only
report you get if the page is one the content script never loaded on — a tab
that was already open when the extension was installed.

If notifications never appear, that is macOS rather than the extension: any
Focus mode suppresses them, as does Chrome being switched off under System
Settings › Notifications, and Chrome is not told. The toast is there for exactly
that reason.

## What To Expect

- Every grab that reaches the extension's service worker ends in a notification
  and, when the page can draw it, in a toast. Success names the profile putiorr
  actually resolved — read from the response, not guessed locally — along with
  the transfer name; failure shows what went wrong (unreachable putiorr,
  rejected credentials, nothing claiming the site, the error putiorr returned).
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
  neither the page nor the worker could fetch the `.torrent`, or an extension
  reload orphaned the page's content script — the click is replayed as a
  normal browser action: a
  magnet goes to the OS handler, a `.torrent` downloads, and a link that
  wrapped a magnet is followed to the page it points at. The **Sending to
  putiorr…** item is taken back down with it, since the browser is about to do
  what it would have done unaided. Once the worker has the grab, every outcome
  is reported and nothing is replayed: an unreachable or sleeping putiorr,
  rejected credentials, and an error putiorr returned all end there, with no
  fallback download. A toast that cannot be drawn — a page that has replaced
  `document.createElement`, a DOM torn out mid-grab — is not a failed grab
  either, and never replays the click.
- Clicking the same link again while a capture is still in flight is dropped, so
  an impatient double-click does not create two transfers.
- Fetches have deadlines: 15s for a `.torrent` fetch — the page's and the
  worker's rescue alike, so a hung download host cannot leave the toast up for
  the life of the tab — and for **Test
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

## The `/api/profiles/<id>/browser-sites` Endpoint

What the toolbar popup writes. It appends one site to one Putiorr Grab
profile's **Browser sites** and answers with the list that profile now holds:

```bash
curl -X POST http://nas:9091/api/profiles/4/browser-sites \
  -H 'X-Putiorr-Grab: 1' \
  -H 'Content-Type: application/json' \
  -d '{"host":"x.example"}'
```

```json
{"ok":true,"profile":{"id":4,"name":"movies"},"browser_domains":["z.example","x.example"],"added":"x.example"}
```

The endpoint appends rather than replacing because the popup must not
read-modify-write the list: two popups open in two windows would each save the
list they had read, and the later save would drop the other's site silently,
under a reply that said the claim had worked.

- `host` is one entry, plain or with a leading `*.`, normalized exactly as the
  wizard's **Browser sites** field normalizes one: punycoded, scheme and path
  stripped, leading and trailing dots dropped. A value that could never match a
  hostname is a `400` naming the entry, as it is in the wizard, and a
  comma-separated list is a `400` too — the popup names one site before you
  click, and editing several at once is the profile form's job.
- `added` is the entry that was stored, or `null` when that profile already
  handled it — the same entry twice, or a host a wildcard it already lists
  covers. Both are `200`: claiming twice is not an error, and neither adds a
  second entry.
- The **same entry** on another Putiorr Grab profile is a `409` naming it:
  "`Movies` already claims x.example; remove the site there first if it should
  belong to another profile". Disabled profiles hold their claims here exactly
  as they do for a grab. Coverage that merely overlaps is not refused: claiming
  `dl.x.example` while another profile holds `*.x.example` is how you take one
  host out of a domain, and the exact entry wins for it from then on.
- A profile of any other preset is refused by name, like every other grab path:
  "`<name>` is not a Putiorr Grab profile; set its App preset to Putiorr Grab in
  putiorr". A profile putiorr does not have is a `404`.
- The `X-Putiorr-Grab` header is required, and answered `403` without it
  ("claiming a site requires the X-Putiorr-Grab header"), for the same reason
  `/api/grab` requires it — see below.

## Why Both Endpoints Want The Header

The header is an anti-CSRF measure, not authentication. Without it, any web page
you visit could POST a grab to your putiorr as a cross-site "simple" request
(no preflight, credentials attached) and spend your put.io account; the response
would be unreadable to the attacker, but the transfer would still be created.
The same page could hand its own hostname to one of your profiles and collect
every grab you made from it afterwards. A custom header forces the browser to
preflight, and putiorr never answers preflights, so the request never leaves the
attacker's page. The extension is exempt from CORS through its
`host_permissions`. Basic auth, if configured, applies to both routes like it
does to every other putiorr route.

## Known Limitations

- A `.torrent` is fetched by the content script first, because only that fetch
  carries the tracker's session cookies — and a fetch made from a page is
  subject to that page's CORS policy, so a link that redirects to a separate
  download host or CDN fails there. The service worker then fetches it instead:
  it holds `host_permissions` and is not bound by the page's origin. That
  request is not same-site with the tracker, so Chrome withholds every
  `SameSite=Lax` cookie from it, and a tracker that gates downloads on its
  session cookie can still refuse it — which is why the page is asked first and
  this is a rescue rather than the route. Only when both fail does the click
  fall back to a normal browser download.
- The service worker will only fetch an `http(s)` link whose path ends in
  `.torrent` — the same rule click capture uses — so it cannot be turned into a
  general-purpose cross-origin proxy by anything that can message it. A link
  the rescue fetches that answers with something other than a bencoded file
  (an HTML login page returning `200`, which is where a redirect can land) is
  treated as a failed fetch, so the click still falls back to the browser
  instead of ending in a refusal from putiorr. A right-clicked link is not held
  to the `.torrent` rule: it came from the user, and grabbing a
  `download.php?id=…` is what the menu is for.
- Links inside iframes are not captured (`all_frames` is not set in the
  manifest), so an embedded frame behaves as if the extension were not
  installed.
- The extension puts no size cap on the fetched `.torrent`, but putiorr rejects
  request bodies over 2 MiB and base64 inflates the file by 4/3, so anything
  above roughly 1.5 MiB comes back as a failure — with no fallback download,
  because the grab did reach putiorr — and has to be added by hand.
- A link whose query holds a valid magnet is captured whatever the page meant
  by it, so a search or report link built around a magnet string is grabbed
  rather than followed — see
  [What Counts As A Wrapped Magnet](#what-counts-as-a-wrapped-magnet).
- A malicious page can overlay an invisible magnet link under a real button and
  harvest a genuine click — the toast and the notification are the only tell,
  which is one reason the toast exists: a notification macOS suppressed told the
  user nothing. A wrapped magnet widens the shapes such a link can take, but not
  what it can do: the click still has to be a real one, and it still ends in
  both reports.
- Any page can detect that the extension is installed by fetching its
  web-accessible `lib/resolve.js` or `lib/toast.js`; `use_dynamic_url` was
  deliberately not used because it broke dynamic import from content scripts
  before Chrome 132, and is worth re-evaluating once the supported Chrome floor
  moves past that.
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
