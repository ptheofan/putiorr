# putiorr

`putiorr` lets Sonarr, Radarr, Lidarr, Readarr, and Prowlarr **use put.io as
their download client**.

It pretends to be Transmission on the *arr side, sends magnet/torrent grabs to
put.io, downloads completed put.io files to a local folder those apps already
mount, and exposes enough queue state for completed-download handling to import
media into your normal library. Anything else that speaks Transmission works
too, pointed at a profile's own RPC path.

**Docs: <https://ptheofan.github.io/putiorr/>** —
[setup](https://ptheofan.github.io/putiorr/setup.html),
[configuration](https://ptheofan.github.io/putiorr/configuration.html),
[browser extension](https://ptheofan.github.io/putiorr/extension.html),
[install with an AI agent](https://ptheofan.github.io/putiorr/agent-setup.html).

The common target setup is:

```text
put.io -> putiorr -> SSD staging folder -> *arr import -> HDD/NAS library
```

This keeps slow library storage out of the active download path while still
letting Radarr, Sonarr, Lidarr, and similar apps move or hardlink/copy media
exactly the way they normally do.

## Status

putiorr favours reliability over feature breadth. What it does today:

- durable SQLite state
- Transmission-compatible RPC endpoints
- put.io OAuth from the web UI
- multiple *arr profiles from one putiorr instance
- per-profile put.io folders, download folders, and RPC paths
- WebSocket dashboard updates
- file-level local download progress and speed
- safe handling of `delete-local-data`
- a Chrome extension that sends magnet links and `.torrent` clicks on any site
  to put.io, routed to a profile by the site they came from
- automatic cleanup of completed transfers for profiles nothing imports from —
  the `prowlarr` and **Putiorr Grab** presets get it by default (removed from
  the list and put.io, downloaded files kept on disk)

Implemented Transmission RPC methods:

- `session-get`
- `torrent-add`
- `torrent-get`
- `torrent-remove`

This is not a full Transmission replacement. It implements the pieces needed by
the *arr completed-download workflow.

## Upgrading From 2.0.x

This release collapses the several different ways a download used to be linked
to a profile into one: the request identifies the app, the ownership it implies
is recorded once and frozen. See
[Which profile owns a download](#which-profile-owns-a-download). Each item
below is a setup that works on 2.0.x and stops working on upgrade.

**Category routing is gone.** The *arr download-client category no longer picks
a profile, vetoes one, or has to agree with the app's labels: it names the
staging subfolder under the owning profile's download folder and nothing more.
*Fix:* nothing for the recommended setup, where each app already names itself.
Prowlarr's per-release mapped categories, which used to need a User-Agent
bypass to get past the category check, simply work.

**A download client that does not name itself, on a multi-profile install.**
The shared `/transmission/rpc` endpoint identifies the calling app from its
`User-Agent`, so the five *arr apps need no change. Anything else — a script, a
generic Transmission client — resolves to no profile there, and is refused an
add and a removal, naming each profile's path in the refusal. `torrent-get`
still answers, with every download. *Fix:* give that client the RPC path of the
profile it means. The same applies to two profiles answering to one name, such
as a second Sonarr instance.

**Downloads with no owning profile no longer acquire one at boot.** They were
handed to whichever profile sorted first; now they appear in the dashboard's
**Needs attention** section instead of the downloads list, and the sweeps skip
them. *Fix:* assign each one to a profile, or delete it. Their files are left
untouched on disk either way.

**The schema upgrade rewrites the database once, in place.** Before it starts it
writes `<state>.pre-downloads-<timestamp>.bak` next to the state file and logs
the path. The backup is never deleted automatically and is safe to delete once
the upgrade looks right. **Restoring it is the only way to roll back to 2.0.x**,
because the older version recreates the legacy tables and writes into storage
this version does not read.

Downloads the upgrade could not attach to a profile, could not identify (no
put.io transfer id), or whose put.io transfer an older sibling already claimed,
are moved to **Needs attention**. A machine-readable record of everything it did
is kept in the `downloads_schema_v1_report` and `profiles_schema_v2_report`
settings keys and returned by `GET /api/settings` as `schemaMigrations`. Check
that list against the *arr queues: an *arr holding the Transmission id of a
quarantined download gets an empty `torrent-get` until it is reassigned.
Reassigning gives the download its original Transmission id back, so the queue
item recovers — unless something has taken that id in the meantime, in which
case the *arr re-grabs on its next RSS cycle. It also keeps the staging folder
the files are already in, as long as the profile you assign it to downloads
into the same place. Assign it to one that stages elsewhere and putiorr
downloads the release again into the new location, leaving the old files where
they are for you to remove.

**Putiorr Grab profiles lose their `/grab/<slug>/rpc` endpoint.** It existed
only because `profiles.rpc_path` was `NOT NULL UNIQUE`, and it doubled as a live
Transmission endpoint an *arr could add into. The path now answers every request
with a refusal. *Fix:* nothing — grab profiles are reached through the browser
extension.

**A disabled RR profile now refuses instead of disappearing.** Its RPC path
still resolves to it, and `torrent-add` there answers with a refusal naming it
rather than the dashboard's HTML; it still
claims its browser sites, and the catch-all role if it holds that, so such a
grab is refused instead of falling through to another profile; and it is still
counted when the shared endpoint decides whether it is ambiguous, so switching a profile off no
longer hands that endpoint to another one. Its existing downloads are
unaffected. *Fix,* for anyone who used "disabled" to free up the shared endpoint
or a site: delete the profile instead.

**Profiles created through `POST /api/profiles` or `PUTIORR_PROFILES_JSON` with
the Putiorr Grab preset now default to auto-removing completed downloads**, as
the wizard and four documents already said they did. Send
`auto_remove_completed: false` to keep the old behaviour.

**Every RR profile must have a download profile.** The upgrade assigns the
default to any profile that had none, and a download profile that is in use can
no longer be deleted without reassigning the profiles that reference it —
which `DELETE /api/download-profiles/:id` now does automatically, to the
default.

API changes, for anything scripted against putiorr:

- **`GET /api/downloads` answers `{ downloads, orphaned }` instead of a bare
  array.** The quarantine is a separate list so the dashboard can render it as
  its own needs-attention section. The WebSocket downloads payload carries the
  same two arrays. Scripts reading the old shape need `.downloads`.
- **`DELETE /api/profiles/:id` no longer deletes a profile that owns downloads
  without being told what happens to them.** Send `reassignTo`, or
  `deleteDownloads: true` with the optional `deleteRemote` / `deleteLocal`
  flags. A profile that owns nothing still deletes with no body at all. A delete
  that stops part-way through answers `400` with the same `downloads` counts a
  success carries, naming what it had already cancelled on put.io and removed
  from disk.
- **The `rpc request failed` log names `profiles` where it named
  `enabledProfiles`,** and each entry carries `enabled`. A disabled profile is
  one of the likelier reasons a request is in that log at all, and the old shape
  left it out.

## Cross-Site Requests

putiorr has no login, which is not the same as having nothing to lose: a page
the user visits can aim requests at their LAN putiorr and the browser sends
them. Every request to `/api/` that is not a `GET` is therefore refused with
`403` when the browser labels it `Sec-Fetch-Site: cross-site` or `same-site` —
another site started it. Nothing else is refused. The dashboard is
`same-origin`, a direct navigation is `none`, and a caller that is not a
browser — `curl`, a script, a cron job — sends no such header at all and is
left alone, as is anything carrying the `X-Putiorr-Grab` header the extension
sends. `GET` requests and the Transmission RPC endpoints the *arr apps use are
untouched.

## Browser Extension

The [`extension/`](extension) directory holds a Chrome (Manifest V3) extension
that captures `magnet:` links, `.torrent` downloads, and the `http(s)` links
that carry a magnet in their query — a site's "send to put.io" link, a
`download.php?magnet=…` — on any site, and sends
them to putiorr via `POST /api/grab`. That endpoint requires the
`X-Putiorr-Grab` header and answers `403` without it, so a web page cannot
trigger grabs cross-site. Grabs land only in profiles built with the **Putiorr
Grab** app preset, which is the only preset the extension is offered. Such a
profile has no Transmission RPC endpoint at all — nothing connects to it as a
download client — and it auto-removes completed downloads by default, the way
`prowlarr` profiles do, since nothing imports a browser grab. Nothing in the
extension decides where a grab lands: it holds the connection to putiorr and
whether clicks are captured, and nothing else.

The toolbar icon grabs nothing. It opens a popup naming the current tab's site
and the profile a grab from it would reach, and — when no profile claims it —
offers to claim it for one through `POST /api/profiles/:id/browser-sites`,
which requires the same `X-Putiorr-Grab` header `/api/grab` does. The site it
stores is whatever is in an editable field, pre-filled with the tab's hostname
exactly as it is and hinting at the `*.` prefix. Nothing shortens a host to the
registrable domain behind it: neither putiorr nor the extension carries a
public-suffix list, and the rule that turns `www.x.example` into `x.example`
would turn `x.co.uk` into `co.uk`.

### Which Site Goes Where

Each Putiorr Grab profile lists the **Browser sites** whose grabs it takes.
Sites live on the profile; the extension holds no copy of them. An entry is
written one of two ways, and both are compared against the page's hostname
alone — scheme, port and path are stripped before matching:

| Entry | Matches |
| --- | --- |
| `x.example` | `x.example`, and nothing under it |
| `*.x.example` | `x.example` **and** every subdomain of it, at any depth |

A plain entry does **not** cover subdomains. The leading `*.` is what does, and
it covers the apex as well, so claiming a whole tracker is one entry rather
than two. The star is only ever the first thing in an entry — `dl.*.example`
and `example.*` are refused — and a wildcard on a single label, `*.com` or
`*.lan`, saves with a warning, because putiorr carries no public-suffix list
and cannot tell one from your LAN.

A grab resolves in this order:

1. the profile picked by hand from the extension's right-click menu;
2. the profile listing the page's host **exactly**;
3. the profile with the most specific wildcard covering it — the longest base
   wins, so `*.dl.x.example` beats `*.x.example`;
4. the one profile set to **take grabs from any site no other profile claims**;
5. otherwise a refusal, naming that setting.

Exactly one profile may hold the catch-all, or none, and a second save is
refused naming the one that has it. The **same entry** on two profiles is
refused too. Coverage that merely overlaps is not: `dl.x.example` on one
profile and `*.x.example` on another sends that one host to the first and the
rest of the domain to the second, which is the point of the order above.

See [`extension/README.md`](extension/README.md) for setup and limitations.

## Quick Start With Docker Compose

The repository includes a local stack in [`putiorr-compose`](putiorr-compose).
It starts putiorr, Radarr, Sonarr, Lidarr, and Prowlarr with ports in the
`17010-17020` range.

```bash
cd putiorr-compose
cp .env.example .env
docker compose up -d --build
```

Open:

- putiorr: <http://127.0.0.1:17010>
- Radarr: <http://127.0.0.1:17011>
- Sonarr: <http://127.0.0.1:17012>
- Prowlarr: <http://127.0.0.1:17013>
- Lidarr: <http://127.0.0.1:17014>

The compose stack is development-oriented. It builds the Dockerfile `dev`
target, bind-mounts `src/`, runs `pnpm run dev`, and enables browser reload for
the putiorr UI.

See [`putiorr-compose/README.md`](putiorr-compose/README.md) for the exact
Radarr, Sonarr, Lidarr, and Prowlarr settings.

## Container Images

Release images are published to GitHub Container Registry:

```text
ghcr.io/ptheofan/putiorr
```

Publishing happens when a GitHub Release is published. Use a semver tag with a
leading `v`; the workflow builds the Dockerfile `production` target for
`linux/amd64` and `linux/arm64`.

Release tags produce image tags like:

```text
ghcr.io/ptheofan/putiorr:vMAJOR.MINOR.PATCH
ghcr.io/ptheofan/putiorr:MAJOR.MINOR.PATCH
ghcr.io/ptheofan/putiorr:MAJOR.MINOR
ghcr.io/ptheofan/putiorr:latest
```

Prereleases do not receive the `latest` tag.

### Release Gate

`package.json` is the source of truth for the app version. Before publishing a
release, run the guarded release script with the intended semver tag. The script
updates release metadata, and the **Release Gate** GitHub Actions workflow can
then validate `main` with the matching tag.

The release gate uses the `semver` package to compare versions. It checks that:

- `package.json` contains a valid semver version.
- the requested release tag matches `package.json` exactly, with a leading `v`.
- `package.json` is not older than the latest GitHub Release.
- the release workflow still runs the release gate before publishing images.

The release workflow also runs the release gate after a GitHub Release is
published, then runs the same lint/test gates as pull requests before publishing
an image.

For local or test runs where the GitHub API should be pinned, set
`RELEASE_GATE_LATEST_RELEASE_TAG`:

```bash
RELEASE_GATE_LATEST_RELEASE_TAG=vMAJOR.MINOR.PATCH pnpm release:gate
pnpm release:gate
pnpm lint
pnpm test
```

### Creating a Release

Use the guarded `gh` wrapper when an agent or maintainer should create a release
from the local checkout:

```bash
pnpm release:create -- vMAJOR.MINOR.PATCH
pnpm release:create -- vMAJOR.MINOR.PATCH --yes
pnpm release:create -- vMAJOR.MINOR.PATCH --yes --publish
```

The script accepts a release tag, updates `package.json` to match it with
`semver`, requires a clean and up-to-date `main` checkout, and runs:

```bash
pnpm release:gate
pnpm lint
pnpm test
```

If `package.json` changed, the script stops after the checks so the metadata can
be committed and merged. Once `main` already contains the target version, rerun
the same command. Without `--yes`, the script only prints the
`gh release create` command it would run. With `--yes`, it creates a draft
release by default. Add `--publish` only when the release should be published
immediately and the container publishing workflow should start.

## Typical NAS Layout

Most real installs should share one staging path between putiorr and each *arr
app, then mount final media libraries only where the importer needs them.

Example host paths:

```text
/volume1/docker/putiorr-config # putiorr SQLite state
/volumeSSD/putiorr             # fast SSD download/staging folder
/volumeNAS/media/movies       # final Radarr library on NAS/HDD
/volumeNAS/media/series       # final Sonarr library on NAS/HDD
/volumeNAS/media/music        # final Lidarr library on NAS/HDD
```

Example container paths:

```text
putiorr: /putiorr
radarr:  /putiorr and /movies
sonarr:  /putiorr and /series
lidarr:  /putiorr and /music
```

The important rule is that the download path reported by putiorr must be a path
Radarr/Sonarr/Lidarr can also see. If Radarr receives `/putiorr/radarr`, the
Radarr container must have that same path mounted.

## Production Compose Example

After publishing a release, use the GHCR image:

```yaml
services:
  putiorr:
    image: ghcr.io/ptheofan/putiorr:latest
    container_name: putiorr
    restart: unless-stopped
    environment:
      TZ: Europe/Athens
      PUTIORR_LISTEN_HOST: 0.0.0.0
      PUTIORR_LISTEN_PORT: 9091
      PUTIORR_STATE_PATH: /data/putiorr-config/putiorr.sqlite
      PUTIORR_TARGET_DIR: /putiorr
      PUTIORR_PUBLIC_URL: https://putiorr.example.com
      PUTIORR_WORKERS: "4"
      PUTIORR_CLEANUP_REMOTE_FILES: "true"
    ports:
      - "17010:9091"
    volumes:
      - /volume1/docker/putiorr-config:/data/putiorr-config
      - /volumeSSD/putiorr:/putiorr
```

Radarr, Sonarr, and Lidarr need the same staging mount:

```yaml
services:
  radarr:
    image: lscr.io/linuxserver/radarr:latest
    volumes:
      - /volume1/docker/radarr:/config
      - /volumeSSD/putiorr:/putiorr
      - /volumeNAS/media/movies:/movies

  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    volumes:
      - /volume1/docker/sonarr:/config
      - /volumeSSD/putiorr:/putiorr
      - /volumeNAS/media/series:/series

  lidarr:
    image: lscr.io/linuxserver/lidarr:latest
    volumes:
      - /volume1/docker/lidarr:/config
      - /volumeSSD/putiorr:/putiorr
      - /volumeNAS/media/music:/music
```

## Connect Put.io

Open the putiorr web UI and use **Connect with put.io**.

The UI opens put.io's OAuth authorization page. There are two supported
redirect modes.

### Hosted relay mode

Hosted relay mode is the default. The Docker image bakes in putiorr's public
put.io app id and GitHub Pages relay URL, so normal installs do not need OAuth
environment variables.

Register this callback URL in the put.io app:

```text
https://ptheofan.github.io/putiorr/putio-oauth-relay.html
```

These values are baked into the image and should not be added to normal
`docker-compose.yml` environment blocks. Forks or custom builds can override
them with Docker build arguments when they intentionally use a different put.io
OAuth app or relay.

The Put.io connection dialog also has an **Advanced** section with editable
OAuth relay URL and App Id fields. Saving there stores an instance-level
override in the SQLite state database. Reset clears that override and restores
the baked defaults.

Only the put.io **Client ID** is public and safe to bake in. Do not put the
client secret or the app owner's OAuth token in GitHub Actions, GitHub Pages,
or any static file. The relay is static JavaScript and only passes the returned
token back to the user's putiorr instance.

### Self-hosted redirect mode

If you do not use the hosted relay, put.io must redirect directly to the putiorr
instance:

```text
https://your-putiorr-host/api/oauth/callback
```

Set `PUTIORR_PUBLIC_URL` to the externally reachable putiorr base URL and add
the callback URL above to your put.io OAuth app. After authorization, putiorr
stores the OAuth token in its SQLite database. The token survives container
restarts as long as `PUTIORR_STATE_PATH` is on a persistent volume.

Manual token paste is also available in the UI.

Self-hosted OAuth redirect requires your own put.io OAuth app id and an empty
`PUTIORR_PUTIO_OAUTH_RELAY_URL`. The old default `3270` belongs to put.io's
Swagger test API and will reject your self-hosted callback URL.

## Configure RR Profiles

Each profile maps one *arr app to:

- a put.io destination folder
- a local download folder
- a Transmission RPC endpoint path

Recommended profiles:

| App | put.io folder | Download folder | RPC endpoint |
| --- | --- | --- | --- |
| Radarr | `putiorr` | `/putiorr` | `/radarr/transmission/rpc` |
| Sonarr | `putiorr` | `/putiorr` | `/sonarr/transmission/rpc` |
| Lidarr | `putiorr` | `/putiorr` | `/lidarr/transmission/rpc` |
| Readarr | `putiorr` | `/putiorr` | `/readarr/transmission/rpc` |

Leave every app on the default `/transmission/rpc` and set no URL Base: each
one is identified by the name it sends in its `User-Agent`. Give an app the
distinct path above, as its URL Base without the `/rpc` — `/radarr/transmission`
— when the name cannot settle it: two Sonarr instances, or a client that does
not name itself.

### Which Profile Owns A Download

A download belongs to exactly one profile. The owner is decided once, where the
download is created, and is never re-derived afterwards:

| How it arrived | Owner |
| --- | --- |
| RPC on a profile's own path | that profile |
| RPC on the shared `/transmission/rpc` | the profile the app's `User-Agent` names, else the one *arr profile, else a refusal |
| `POST /api/grab` naming a profile | that profile |
| `POST /api/grab` from a claimed site | the grab profile claiming it — exact entry first, then the longest wildcard base |
| `POST /api/grab`, neither | the grab profile set to take any other site, else a refusal |

Nothing else selects an owner. In particular:

- **The category selects nothing.** The *arr download-client category is the
  name of the staging subfolder under the owning profile's download folder,
  computed after the owner is already known. It never picks a profile and never
  vetoes one, so two apps may use the same category and an app may use several.
- **The User-Agent routes a request; it never re-owns a download.** It decides
  which profile a request is addressed to, once, before anything is created. It
  is never consulted again: the owner recorded on a download is read back from
  the download, so no header can move an existing one between profiles.

**Every *arr can share `/transmission/rpc` with no URL Base change**, which is
what the shared endpoint is for. Sonarr, Radarr, Lidarr, Readarr and Prowlarr
each put their own name in the `User-Agent` — `Sonarr/4.0.19.2932 (linux x64)`
— and putiorr matches the part before the slash against each profile's slug,
its name, and its app preset unless that preset is `custom`. Case and
punctuation are ignored. It is either an exact match or a profile identity of
at least four characters that the client's name starts with, and it has to be
the only one: two profiles answering to the same name resolve to neither.
Putiorr Grab profiles are never matched, whatever they are called.

**A distinct RPC path is the override for the cases the name cannot settle**:
two Sonarr instances, or a client that does not name itself. Point it at
`/sonarr-4k/transmission/rpc` and that path wins over whatever `User-Agent` it
sends. A request that neither the path nor the name resolves is refused for
`torrent-add` and `torrent-remove`, naming the RPC path each profile should be
pointed at instead — including the profile still sitting on the shared path,
which needs one of its own.

`session-get` and `torrent-get` always answer. `session-get` is the call an
*arr uses to test the connection; `torrent-get` is the queue poll that drives
completed-download import, and an unresolved one returns every download rather
than an error — each labelled with its own owner's download folder.

One put.io transfer belongs to one download, keyed on put.io's own transfer id.
put.io de-duplicates, so a second profile grabbing a release the first already
owns gets that same transfer back; putiorr refuses the second add and names the
profile that holds it rather than letting two profiles share one download.

### Where The Files Land

```text
<download folder>/<category>/<the name put.io gave the transfer>
```

For the recommended setup that is:

```text
Radarr category: radarr -> /putiorr/radarr/<name>
Sonarr category: sonarr -> /putiorr/sonarr/<name>
Lidarr category: lidarr -> /putiorr/lidarr/<name>
```

Each app gets a separate staging folder while sharing one SSD mount. The name
is put.io's, untouched, because every *arr resolves a completed download as
`downloadDir + name` — a folder spelled any other way is a download that never
imports. A name that will not fit in a filesystem's 255 bytes per path segment
is refused on the download rather than truncated.

That folder is **frozen the first time the download is staged**. put.io renames
transfers, and the name putiorr reports follows the rename because that is what
you see in the dashboard; the folder does not, because the files on disk do not
move either.

Profiles may share one put.io folder, which is what the recommended setup does.

### Disabling A Profile

`enabled = 0` means **the profile accepts no new work**. It is a refusal, never
a disappearance.

A disabled profile still holds its RPC path, still answers to its own name on
the shared endpoint, still claims its browser sites, is still counted when the
shared endpoint decides whether it is ambiguous, and still owns its put.io
folder. Whether it accepts work is asked only where work is created:
`torrent-add`, `/api/grab`, and the adoption of a put.io transfer putiorr did
not create. `torrent-add` and `/api/grab` refuse with one sentence naming the
profile, because somebody is waiting on the answer. Adoption is nobody's
request, so the transfer is left on put.io without a word, and enabling the
profile adopts it on the next poll.

It is not asked on `torrent-get`, `torrent-remove` or `session-get`. The
downloads already queued keep downloading and stay listable, importable and
removable, so switching a profile off does not make its *arr re-grab everything
it can no longer see.

### Deleting A Profile

A download cannot be left without an owner, so `DELETE /api/profiles/:id` will
not delete a profile that still owns downloads until it is told what happens to
them. The dashboard asks in a dialog that states the counts first — how many
downloads, how many of them already deleted from the list but still on put.io,
how many files and bytes are in their staging folders, and how many of those
folders it could not read.

There are three answers:

- **Move them to another RR profile** (`reassignTo`). Nothing is removed from
  put.io and no files are deleted.
- **Remove them from putiorr** (`deleteDownloads: true`), optionally also
  cancelling their put.io transfers (`deleteRemote`) and deleting their staging
  folders from disk (`deleteLocal`). Neither flag defaults to true.
- Nothing — which is refused, by count, naming both of the above.

A request carrying both a move and a delete is refused: they are different
fates for the same rows.

The move target is restricted to profiles that download into the **same**
folder, and the refusal says why. Nothing moves on disk, and the path stays
`<download folder>/<category>/<frozen name>`, so a target that stages elsewhere
would point putiorr at an empty directory — and a finished download whose
files have gone missing is deleted and its put.io transfer cancelled. The two
folders are compared as they are written, so a symlink or bind mount naming
the same directory counts as a different one.

Whichever answer is given, the download rows themselves go: there is no owner
left to keep them under. put.io transfers you chose to keep stay on put.io and
are never picked up again — putiorr ignores a transfer in a folder no RR profile
downloads into — and the dialog says so before you commit.

`deleteLocal` is a recursive delete of the whole staging folder, so it also
takes the `.part` file of anything still running and anything else you put in
there. That is why the counts are measured off the disk rather than off
putiorr's file rows.

## Configure Radarr

Add a Transmission download client.

If Radarr is in the same compose network as putiorr:

```text
Name: putiorr
Host: putiorr
Port: 9091
Use SSL: off
Username: blank unless configured
Password: blank unless configured
Category: radarr
Directory: /putiorr
URL Base: /radarr/transmission
```

If Radarr is outside the compose network, use the host/IP and published port
instead:

```text
Host: your-nas-hostname-or-ip
Port: 17010
URL Base: /radarr/transmission
```

Set Radarr's movie root folder to `/movies`.

With completed-download handling enabled, Radarr imports from `/putiorr/radarr`
to `/movies` and then removes imported files from staging according to Radarr's
normal settings.

## Configure Sonarr

Add a Transmission download client.

If Sonarr is in the same compose network as putiorr:

```text
Name: putiorr
Host: putiorr
Port: 9091
Use SSL: off
Username: blank unless configured
Password: blank unless configured
Category: sonarr
Directory: /putiorr
URL Base: /sonarr/transmission
```

If Sonarr is outside the compose network:

```text
Host: your-nas-hostname-or-ip
Port: 17010
URL Base: /sonarr/transmission
```

Set Sonarr's series root folder to `/series`.

With completed-download handling enabled, Sonarr imports from `/putiorr/sonarr`
to `/series` and then removes imported files from staging according to Sonarr's
normal settings.

## Configure Lidarr

Add a Transmission download client.

If Lidarr is in the same compose network as putiorr:

```text
Name: putiorr
Host: putiorr
Port: 9091
Use SSL: off
Username: blank unless configured
Password: blank unless configured
Category: lidarr
Directory: /putiorr
URL Base: /lidarr/transmission
```

If Lidarr is outside the compose network:

```text
Host: your-nas-hostname-or-ip
Port: 17010
URL Base: /lidarr/transmission
```

Set Lidarr's music root folder to `/music`.

With completed-download handling enabled, Lidarr imports from `/putiorr/lidarr`
to `/music` and then removes imported files from staging according to Lidarr's
normal settings.

## Configure Prowlarr

Prowlarr does not usually need a putiorr profile. It connects to
Radarr/Sonarr/Lidarr, syncs indexers, and those apps send accepted grabs to
putiorr through their Transmission download-client settings.

In the bundled compose stack, configure Prowlarr apps with Docker-internal URLs:

```text
Radarr URL: http://radarr:7878
Sonarr URL: http://sonarr:8989
Lidarr URL: http://lidarr:8686
```

Use the API keys from each app's settings page.

## Progress Model

putiorr reports combined progress as two phases:

```text
0-50%:   put.io remote transfer
50-100%: local download from put.io to the staging folder
```

The web dashboard shows both put.io progress and local file progress. For
multi-file releases, expand the files list to see per-file status, bytes, and
local speed.

Some *arr apps only read torrent-level Transmission fields, so they may display
one shared percentage for all queue items from a multi-file torrent. The putiorr
dashboard is the source of truth for per-file local download progress.

## Local Resume And Slow Resets

Local downloads are written as `.part` files and resumed with HTTP `Range`
requests. If putiorr or the container restarts while a file is downloading, the
next worker continues from the existing partial file.

Slow-speed reset is optional. Set a nonzero threshold to enable it. After the
startup grace window, if a file stays below the threshold for the configured
duration, putiorr closes that file download and resumes it from the partial
file. Files smaller than the configured minimum size are ignored by the reset
policy.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PUTIORR_LISTEN_HOST` | `0.0.0.0` | HTTP/RPC bind host |
| `PUTIORR_LISTEN_PORT` | `9091` | HTTP/RPC bind port |
| `PUTIORR_TARGET_DIR` | `./downloads` | Default local download root |
| `PUTIORR_STATE_PATH` | `./data/putiorr.sqlite` | SQLite state database |
| `PUTIORR_PUTIO_TOKEN` | unset | Optional initial put.io token; UI-stored token wins after OAuth |
| `PUTIORR_PUTIO_APP_ID` | `9354` | Public putorr put.io OAuth app id |
| `PUTIORR_PUBLIC_URL` | request host | Public putiorr base URL used to build the self-hosted put.io OAuth callback |
| `PUTIORR_PUTIO_OAUTH_RELAY_URL` | `https://ptheofan.github.io/putiorr/putio-oauth-relay.html` | Hosted relay URL registered as the put.io OAuth callback; set empty for self-hosted redirect |
| `PUTIORR_PUTIO_FOLDER` | `putiorr` | Default put.io folder for the default profile |
| `PUTIORR_DEFAULT_PROFILE_NAME` | `Custom` | Name for the fallback custom profile |
| `PUTIORR_DEFAULT_PROFILE_TYPE` | `custom` | Type for the default profile |
| `PUTIORR_DEFAULT_RPC_PATH` | `/transmission/rpc` | Default Transmission RPC path |
| `PUTIORR_PROFILES_JSON` | `[]` | Optional seed profiles as JSON |
| `PUTIORR_WORKERS` | `4` | Concurrent local file downloads |
| `PUTIORR_POLL_INTERVAL_MS` | `30000` | Backend put.io polling interval, minimum 5000. The web UI receives updates over WebSocket. |
| `PUTIORR_SLOW_SPEED_THRESHOLD_BYTES_PER_SECOND` | `0` | Local file speed threshold. `0` disables slow-speed reset. |
| `PUTIORR_SLOW_SPEED_DURATION_SECONDS` | `120` | Seconds below the threshold before resetting the file connection |
| `PUTIORR_SLOW_SPEED_GRACE_SECONDS` | `30` | Startup grace window before slow-speed checks begin |
| `PUTIORR_SLOW_SPEED_MIN_SIZE_BYTES` | `104857600` | Do not slow-reset files smaller than this size |
| `PUTIORR_CLEANUP_REMOTE_FILES` | `true` | Delete put.io files/transfers after local completion |
| `PUTIORR_RPC_USERNAME` | unset | Optional HTTP basic auth username |
| `PUTIORR_RPC_PASSWORD` | unset | Optional HTTP basic auth password |
| `PUTIORR_REFRESH_ON_RPC` | `false` | Refresh put.io state during RPC `torrent-get` calls |
| `PUTIORR_LIVE_RELOAD` | enabled outside production | Dev-only browser reload hook |

## Development

Install dependencies:

```bash
corepack enable
pnpm install
```

Run locally:

```bash
cp .env.example .env
pnpm run dev
```

Open <http://127.0.0.1:9091>.

Run tests:

```bash
pnpm lint
pnpm test
```

Build and run the development compose stack:

```bash
cd putiorr-compose
cp .env.example .env
docker compose up -d --build
```

## License

putiorr is licensed under the GNU Affero General Public License v3.0. See
[`LICENSE`](LICENSE).
