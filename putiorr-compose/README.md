# putiorr compose stack

This folder is a local playground for testing putiorr with the common *arr
workflow:

- putiorr: <http://127.0.0.1:17010>
- Radarr: <http://127.0.0.1:17011>
- Sonarr: <http://127.0.0.1:17012>
- Prowlarr: <http://127.0.0.1:17013>
- Lidarr: <http://127.0.0.1:17014>

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

The repository tracks placeholders only for shared download/state/library paths.
The app config folders are created by Docker on your machine and are ignored by
git.

```text
putiorr-compose/data/putiorr-config # putiorr SQLite state
putiorr-compose/data/putiorr        # SSD-style staging root shared by putiorr/Radarr/Sonarr/Lidarr
putiorr-compose/data/movies         # Radarr final movie library path
putiorr-compose/data/series         # Sonarr final series library path
putiorr-compose/data/music          # Lidarr final music library path
putiorr-compose/data/downloads      # spare shared downloads path

putiorr-compose/data/radarr         # local-only Radarr config, ignored
putiorr-compose/data/sonarr         # local-only Sonarr config, ignored
putiorr-compose/data/lidarr         # local-only Lidarr config, ignored
putiorr-compose/data/prowlarr       # local-only Prowlarr config, ignored
```

On first boot, putiorr seeds three profiles:

| App | put.io folder | Download folder | Final library | RPC path |
| --- | --- | --- | --- | --- |
| Radarr | `putiorr` | `/putiorr` | `/movies` | `/radarr/transmission/rpc` |
| Sonarr | `putiorr` | `/putiorr` | `/series` | `/sonarr/transmission/rpc` |
| Lidarr | `putiorr` | `/putiorr` | `/music` | `/lidarr/transmission/rpc` |

The download-client category controls the physical staging subfolder:

```text
radarr -> /putiorr/radarr
sonarr -> /putiorr/sonarr
lidarr -> /putiorr/lidarr
```

## Configure putiorr

Open <http://127.0.0.1:17010>.

1. Click **Connect with put.io**.
2. Open <https://put.io/link>.
3. Enter the code shown by putiorr.
4. Wait for putiorr to show the connection as active.

The OAuth token is stored in `data/putiorr-config/putiorr.sqlite`, so it
survives container restarts.

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
Directory: /putiorr
URL Base: /radarr/transmission
```

Set Radarr's movie root folder to `/movies`.

With completed-download handling enabled, Radarr imports completed downloads
from `/putiorr/radarr` into `/movies` and then removes imported files from
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
Directory: /putiorr
URL Base: /sonarr/transmission
```

Set Sonarr's series root folder to `/series`.

With completed-download handling enabled, Sonarr imports completed downloads
from `/putiorr/sonarr` into `/series` and then removes imported files from
staging according to its normal settings.

## Configure Lidarr

Open <http://127.0.0.1:17014>.

Add a Transmission download client:

```text
Name: putiorr
Host: putiorr
Port: 9091
Use SSL: off
Username: blank
Password: blank
Category: lidarr
Directory: /putiorr
URL Base: /lidarr/transmission
```

Set Lidarr's music root folder to `/music`.

With completed-download handling enabled, Lidarr imports completed downloads
from `/putiorr/lidarr` into `/music` and then removes imported files from
staging according to its normal settings.

## Configure Prowlarr

Open <http://127.0.0.1:17013>.

Add Radarr, Sonarr, and Lidarr under Prowlarr's app settings:

```text
Radarr URL: http://radarr:7878
Sonarr URL: http://sonarr:8989
Lidarr URL: http://lidarr:8686
```

Use the API keys from Radarr, Sonarr, and Lidarr's settings pages. Once the apps
are connected, add indexers in Prowlarr and sync them to the apps.

Prowlarr does not need a putiorr profile by default. Radarr, Sonarr, and Lidarr
send accepted grabs to putiorr through their Transmission download-client
settings.

## Reset The Playground

To reset only putiorr state:

```bash
docker compose down
rm -f data/putiorr-config/putiorr.sqlite data/putiorr-config/putiorr.sqlite-shm data/putiorr-config/putiorr.sqlite-wal
docker compose up -d --build
```

To reset everything, remove `putiorr-compose/data` and recreate the `.gitkeep`
files or check the repository out again.
