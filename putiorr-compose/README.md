# putiorr compose stack

This folder is a local playground for testing putiorr with the common *arr
workflow:

- putiorr: <http://127.0.0.1:17010>
- Radarr: <http://127.0.0.1:17011>
- Sonarr: <http://127.0.0.1:17012>
- Prowlarr: <http://127.0.0.1:17013>

The public ports intentionally stay in the `17010-17020` range.

## Start

```bash
cd putiorr-compose
cp .env.example .env
docker compose up -d --build
```

The stack builds the Dockerfile `dev` target for putiorr, runs
`pnpm run dev`, and bind-mounts `../src` into the container. Server and UI
changes under `src/` restart putiorr automatically; the web UI also has a
development live-reload hook.

You can leave `PUTIORR_PUTIO_TOKEN` empty and connect put.io from the putiorr
web UI with OAuth. Manual token paste remains available as a fallback.

## Layout

```text
putiorr-compose/data/putiorr   # putiorr SQLite state
putiorr-compose/data/radarr    # Radarr config
putiorr-compose/data/sonarr    # Sonarr config
putiorr-compose/data/prowlarr  # Prowlarr config
putiorr-compose/data/staged    # SSD-style staging root shared by putiorr/Radarr/Sonarr
putiorr-compose/data/movies    # Radarr final movie library path
putiorr-compose/data/series    # Sonarr final series library path
putiorr-compose/data/downloads # spare shared downloads path
```

On first boot, putiorr seeds two profiles:

| App | put.io folder | Download folder | Final library | RPC path |
| --- | --- | --- | --- | --- |
| Radarr | `movies` | `/staged` | `/movies` | `/radarr/transmission/rpc` |
| Sonarr | `series` | `/staged` | `/series` | `/sonarr/transmission/rpc` |

The download-client category controls the physical staging subfolder:

```text
radarr -> /staged/radarr
sonarr -> /staged/sonarr
```

## Configure putiorr

Open <http://127.0.0.1:17010>.

1. Click **Connect with put.io**.
2. Open <https://put.io/link>.
3. Enter the code shown by putiorr.
4. Wait for putiorr to show the connection as active.

The OAuth token is stored in `data/putiorr/putiorr.sqlite`, so it survives
container restarts.

## Configure Radarr

Open <http://127.0.0.1:17011>.

Add a Transmission download client:

```text
Name: putiorr
Host: putiorr
Port: 9091
Use SSL: off
Username: blank
Password: blank
Category: radarr
Directory: /staged
URL Base: /radarr/transmission
```

Set Radarr's movie root folder to `/movies`.

With completed-download handling enabled, Radarr imports completed downloads
from `/staged/radarr` into `/movies` and then removes imported files from
staging according to its normal settings.

## Configure Sonarr

Open <http://127.0.0.1:17012>.

Add a Transmission download client:

```text
Name: putiorr
Host: putiorr
Port: 9091
Use SSL: off
Username: blank
Password: blank
Category: sonarr
Directory: /staged
URL Base: /sonarr/transmission
```

Set Sonarr's series root folder to `/series`.

With completed-download handling enabled, Sonarr imports completed downloads
from `/staged/sonarr` into `/series` and then removes imported files from
staging according to its normal settings.

## Configure Prowlarr

Open <http://127.0.0.1:17013>.

Add Radarr and Sonarr under Prowlarr's app settings:

```text
Radarr URL: http://radarr:7878
Sonarr URL: http://sonarr:8989
```

Use the API keys from Radarr and Sonarr's settings pages. Once the apps are
connected, add indexers in Prowlarr and sync them to Radarr/Sonarr.

Prowlarr does not need a putiorr profile by default. Radarr and Sonarr send
accepted grabs to putiorr through their Transmission download-client settings.

## Reset The Playground

To reset only putiorr state:

```bash
docker compose down
rm -f data/putiorr/putiorr.sqlite data/putiorr/putiorr.sqlite-shm data/putiorr/putiorr.sqlite-wal
docker compose up -d --build
```

To reset everything, remove `putiorr-compose/data` and recreate the `.gitkeep`
files or check the repository out again.
