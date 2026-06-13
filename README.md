# putiorr

`putiorr` is a put.io bridge for Sonarr, Radarr, Lidarr, Readarr, and other
apps that can use a Transmission download client.

It pretends to be Transmission on the *arr side, sends magnet/torrent grabs to
put.io, downloads completed put.io files to a local folder, and exposes enough
queue state for completed-download handling to import media into your normal
library.

The common target setup is:

```text
put.io -> putiorr -> SSD staging folder -> Radarr/Sonarr import -> HDD/NAS library
```

This keeps slow library storage out of the active download path while still
letting Radarr, Sonarr, and similar apps move or hardlink/copy media exactly the
way they normally do.

## Status

This is early software. The current goal is reliability over feature breadth:

- durable SQLite state
- Transmission-compatible RPC endpoints
- put.io OAuth from the web UI
- multiple *arr profiles from one putiorr instance
- per-profile put.io folders, download folders, and RPC paths
- WebSocket dashboard updates
- file-level local download progress and speed
- safe handling of `delete-local-data`

Implemented Transmission RPC methods:

- `session-get`
- `torrent-add`
- `torrent-get`
- `torrent-remove`

This is not a full Transmission replacement. It implements the pieces needed by
the *arr completed-download workflow.

## Quick Start With Docker Compose

The repository includes a local stack in [`putiorr-compose`](putiorr-compose).
It starts putiorr, Radarr, Sonarr, and Prowlarr with ports in the `17010-17020`
range.

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

The compose stack is development-oriented. It builds the Dockerfile `dev`
target, bind-mounts `src/`, runs `pnpm run dev`, and enables browser reload for
the putiorr UI.

See [`putiorr-compose/README.md`](putiorr-compose/README.md) for the exact
Radarr, Sonarr, and Prowlarr settings.

## Typical NAS Layout

Most real installs should share one staging path between putiorr and each *arr
app, then mount final media libraries only where the importer needs them.

Example host paths:

```text
/volume1/docker/putiorr       # putiorr SQLite state
/volumeSSD/staged             # fast SSD download/staging folder
/volumeNAS/media/movies       # final Radarr library on NAS/HDD
/volumeNAS/media/series       # final Sonarr library on NAS/HDD
```

Example container paths:

```text
putiorr: /staged
radarr:  /staged and /movies
sonarr:  /staged and /series
```

The important rule is that the download path reported by putiorr must be a path
Radarr/Sonarr can also see. If Radarr receives `/staged/radarr`, the Radarr
container must have that same path mounted.

## Production Compose Example

Until published images exist, build from a local checkout:

```yaml
services:
  putiorr:
    build:
      context: .
      dockerfile: Dockerfile
      target: production
    image: putiorr/local:latest
    container_name: putiorr
    restart: unless-stopped
    environment:
      TZ: Europe/Athens
      PUTIORR_LISTEN_HOST: 0.0.0.0
      PUTIORR_LISTEN_PORT: 9091
      PUTIORR_STATE_PATH: /data/putiorr/putiorr.sqlite
      PUTIORR_TARGET_DIR: /staged
      PUTIORR_PUTIO_APP_ID: "3270"
      PUTIORR_WORKERS: "4"
      PUTIORR_CLEANUP_REMOTE_FILES: "true"
    ports:
      - "17010:9091"
    volumes:
      - /volume1/docker/putiorr:/data/putiorr
      - /volumeSSD/staged:/staged
```

Radarr and Sonarr need the same staging mount:

```yaml
services:
  radarr:
    image: lscr.io/linuxserver/radarr:latest
    volumes:
      - /volume1/docker/radarr:/config
      - /volumeSSD/staged:/staged
      - /volumeNAS/media/movies:/movies

  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    volumes:
      - /volume1/docker/sonarr:/config
      - /volumeSSD/staged:/staged
      - /volumeNAS/media/series:/series
```

## Connect Put.io

Open the putiorr web UI and use **Connect with put.io**.

The UI will show a short code and link to <https://put.io/link>. Authorize the
code there, then putiorr stores the OAuth token in its SQLite database. The
token survives container restarts as long as `PUTIORR_STATE_PATH` is on a
persistent volume.

Manual token paste is also available in the UI.

`PUTIORR_PUTIO_APP_ID` defaults to `3270`. You can create your own put.io app
and set its app id if you prefer. The current flow uses put.io's out-of-band
device/link authorization, so no callback URL is required by putiorr.

## Configure RR Profiles

Each profile maps one *arr app to:

- a put.io destination folder
- a local download folder
- a Transmission RPC endpoint path

Recommended profiles:

| App | put.io folder | Download folder | RPC endpoint |
| --- | --- | --- | --- |
| Radarr | `movies` | `/staged` | `/radarr/transmission/rpc` |
| Sonarr | `series` | `/staged` | `/sonarr/transmission/rpc` |
| Lidarr | `music` | `/staged` | `/lidarr/transmission/rpc` |
| Readarr | `books` | `/staged` | `/readarr/transmission/rpc` |

The *arr download client category creates the final staging subfolder. For
example:

```text
Radarr category: radarr -> /staged/radarr
Sonarr category: sonarr -> /staged/sonarr
```

That gives each app a separate staging folder while still using one shared SSD
mount.

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
Directory: /staged
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

With completed-download handling enabled, Radarr imports from `/staged/radarr`
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
Directory: /staged
URL Base: /sonarr/transmission
```

If Sonarr is outside the compose network:

```text
Host: your-nas-hostname-or-ip
Port: 17010
URL Base: /sonarr/transmission
```

Set Sonarr's series root folder to `/series`.

With completed-download handling enabled, Sonarr imports from `/staged/sonarr`
to `/series` and then removes imported files from staging according to Sonarr's
normal settings.

## Configure Prowlarr

Prowlarr does not usually need a putiorr profile. It connects to Radarr/Sonarr,
syncs indexers, and Radarr/Sonarr send accepted grabs to putiorr through their
Transmission download-client settings.

In the bundled compose stack, configure Prowlarr apps with Docker-internal URLs:

```text
Radarr URL: http://radarr:7878
Sonarr URL: http://sonarr:8989
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

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PUTIORR_LISTEN_HOST` | `0.0.0.0` | HTTP/RPC bind host |
| `PUTIORR_LISTEN_PORT` | `9091` | HTTP/RPC bind port |
| `PUTIORR_TARGET_DIR` | `./downloads` | Default local download root |
| `PUTIORR_STATE_PATH` | `./data/putiorr.sqlite` | SQLite state database |
| `PUTIORR_PUTIO_TOKEN` | unset | Optional initial put.io token; UI-stored token wins after OAuth |
| `PUTIORR_PUTIO_APP_ID` | `3270` | put.io OAuth app id |
| `PUTIORR_PUTIO_FOLDER` | `putiorr` | Default put.io folder for the default profile |
| `PUTIORR_DEFAULT_PROFILE_NAME` | `Default` | Name for the default profile |
| `PUTIORR_DEFAULT_PROFILE_TYPE` | `custom` | Type for the default profile |
| `PUTIORR_DEFAULT_RPC_PATH` | `/transmission/rpc` | Default Transmission RPC path |
| `PUTIORR_PROFILES_JSON` | `[]` | Optional seed profiles as JSON |
| `PUTIORR_WORKERS` | `4` | Concurrent local file downloads |
| `PUTIORR_POLL_INTERVAL_MS` | `30000` | put.io polling interval, minimum 5000 |
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
