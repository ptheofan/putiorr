# putiorr compose stack

This folder runs a local test stack with:

- putiorr: http://127.0.0.1:17010
- Radarr: http://127.0.0.1:17011
- Sonarr: http://127.0.0.1:17012
- Prowlarr: http://127.0.0.1:17013

## Layout

```text
putiorr-compose/data/putiorr   # putiorr SQLite state
putiorr-compose/data/radarr    # Radarr config
putiorr-compose/data/sonarr    # Sonarr config
putiorr-compose/data/prowlarr  # Prowlarr config
putiorr-compose/data/staged        # SSD-style staging root shared by putiorr/Radarr/Sonarr
putiorr-compose/data/movies        # Radarr final movie library path
putiorr-compose/data/series        # Sonarr final series library path
putiorr-compose/data/downloads     # spare shared downloads path
```

## Start

```bash
cd putiorr-compose
cp .env.example .env
docker compose up -d --build
```

The compose stack builds the Dockerfile `dev` target for putiorr, runs
`pnpm run dev`, and bind-mounts `../src` into the container. Editing server or
web UI files under `src/` should restart putiorr automatically.

You can leave `PUTIORR_PUTIO_TOKEN` empty and connect put.io in the putiorr web
UI with OAuth. Manual token paste remains available as a fallback.

If you already started the stack before the staged layout existed, update the
putiorr Radarr/Sonarr profile local paths in the UI, or reset only the putiorr
state database before restarting:

```bash
docker compose down
rm -f data/putiorr/putiorr.sqlite data/putiorr/putiorr.sqlite-shm data/putiorr/putiorr.sqlite-wal
docker compose up -d --build
```

On first boot, putiorr seeds two profiles:

| App | put.io folder | staging folder | final library | RPC path |
| --- | --- | --- | --- | --- |
| Radarr | `movies` | `/staged` + category `radarr` | `/movies` | `/radarr/transmission/rpc` |
| Sonarr | `series` | `/staged` + category `sonarr` | `/series` | `/sonarr/transmission/rpc` |

## Configure Radarr

Add a Transmission download client:

- Name: `putiorr`
- Host: `putiorr`
- Port: `9091`
- Use SSL: off
- Username / Password: blank, unless `PUTIORR_RPC_USERNAME` / `PUTIORR_RPC_PASSWORD` are configured
- Category: `radarr`
- URL Base, if Radarr shows it under advanced settings: `/radarr/transmission`
- Directory: `/staged`

Set Radarr's movie root folder to `/movies`. Radarr will import completed
downloads from `/staged/radarr` into `/movies` and then remove imported files
from staging according to its normal completed-download handling.

Make sure Radarr's completed download handling is enabled. If Radarr does not
remove staging files after import, check the download-client option for removing
completed downloads.

## Configure Sonarr

Add a Transmission download client:

- Name: `putiorr`
- Host: `putiorr`
- Port: `9091`
- Use SSL: off
- Username / Password: blank, unless `PUTIORR_RPC_USERNAME` / `PUTIORR_RPC_PASSWORD` are configured
- Category: `sonarr`
- URL Base, if Sonarr shows it under advanced settings: `/sonarr/transmission`
- Directory: `/staged`

Set Sonarr's series root folder to `/series`. Sonarr will import completed
downloads from `/staged/sonarr` into `/series` and then remove imported files
from staging according to its normal completed-download handling.

Make sure Sonarr's completed download handling is enabled. If Sonarr does not
remove staging files after import, check the download-client option for removing
completed downloads.

## Configure Prowlarr

Open Prowlarr at `http://127.0.0.1:17013`.

Add Radarr and Sonarr under Prowlarr's Apps settings with Docker-internal URLs:

- Radarr URL: `http://radarr:7878`
- Sonarr URL: `http://sonarr:8989`

Use the API keys from Radarr and Sonarr's settings pages. Once the apps are
connected, add test indexers in Prowlarr and sync them to Radarr/Sonarr. Prowlarr
does not need a putiorr profile by default; Radarr and Sonarr still send grabs
to putiorr through their Transmission download-client settings.

The profile-specific URL bases are the cleanest way to keep one putiorr instance
serving multiple apps. The generic Transmission URL base `/transmission` also
works for category-based RR clients: putiorr routes new grabs to a matching
profile by category (`radarr`, `sonarr`) and returns all active transfers to the
generic endpoint so each RR app can filter its own queue.
