# putiorr

`putiorr` is a Node.js put.io bridge for Sonarr, Radarr, Lidarr, Prowlarr, and
other apps that can talk to a Transmission download client.

The first implementation goal is boring reliability:

- durable local state in SQLite
- a focused Transmission RPC surface
- web-based put.io and RR profile configuration
- WebSocket-backed dashboard updates
- per-profile put.io folder, download folder, and RPC endpoint paths
- explicit category handling from `download-dir`
- safe local delete behavior
- put.io polling and local download workers behind isolated modules

## Run

```bash
pnpm start
```

For local development with automatic restart on file changes:

```bash
cp .env.example .env
pnpm run dev
```

Use a different port if the compose stack is already running.

The compose stack is also development-oriented: it builds the Dockerfile `dev`
target, bind-mounts `src/`, and runs `pnpm run dev` inside the putiorr
container. The default Dockerfile target is `production`, which uses a
multistage image with production dependencies only.

Open the web UI:

```text
http://127.0.0.1:9091/
```

Default Transmission RPC endpoint:

```text
http://127.0.0.1:9091/transmission/rpc
```

Each RR profile can also define its own RPC path, for example:

```text
http://127.0.0.1:9091/sonarr/transmission/rpc
http://127.0.0.1:9091/radarr/transmission/rpc
```

Configure each *arr app as a Transmission download client pointing at its
profile path.

## Local Compose Stack

There is a ready-to-run compose playground in [putiorr-compose](/Users/pt/work/aralu/putiorr/putiorr-compose/README.md). It starts:

- putiorr on `17010`
- Radarr on `17011`
- Sonarr on `17012`
- Prowlarr on `17013`

It also creates the local data layout under `putiorr-compose/data`, including
`putiorr`, `radarr`, `sonarr`, `prowlarr`, `staged`, `movies`, `series`, and
`downloads`.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PUTIORR_LISTEN_HOST` | `0.0.0.0` | RPC bind host |
| `PUTIORR_LISTEN_PORT` | `9091` | RPC bind port |
| `PUTIORR_TARGET_DIR` | `./downloads` | Local completed download root |
| `PUTIORR_STATE_PATH` | `./data/putiorr.sqlite` | SQLite state database |
| `PUTIORR_PUTIO_TOKEN` | unset | Optional initial put.io OAuth token; can also be configured in the UI |
| `PUTIORR_PUTIO_APP_ID` | `3270` | put.io OAuth app id for the UI connect flow |
| `PUTIORR_PUTIO_FOLDER` | `putiorr` | put.io destination folder |
| `PUTIORR_DEFAULT_RPC_PATH` | `/transmission/rpc` | Default profile RPC endpoint path |
| `PUTIORR_WORKERS` | `4` | Concurrent local downloads |
| `PUTIORR_POLL_INTERVAL_MS` | `30000` | put.io transfer polling interval |
| `PUTIORR_CLEANUP_REMOTE_FILES` | `true` | Delete remote files after local completion, keeping the transfer record |
| `PUTIORR_RPC_USERNAME` | unset | Optional HTTP basic auth username |
| `PUTIORR_RPC_PASSWORD` | unset | Optional HTTP basic auth password |
| `PUTIORR_LIVE_RELOAD` | enabled outside production | Inject a dev-only browser auto-reload hook for web UI changes |

## Current Slice

Implemented:

- Transmission RPC session handshake
- `session-get`
- `torrent-add` for magnets and torrent metainfo upload
- `torrent-get`
- `torrent-remove`
- web UI at `/`
- WebSocket dashboard state stream at `/api/ws`
- settings API for manual put.io token connection
- put.io OAuth code flow from the web UI
- RR profile CRUD with custom RPC paths
- put.io API wrapper
- SQLite-backed transfers and transfer files
- local worker downloads with partial `.part` resume
- safe local deletion for `delete-local-data`

Planned next:

- resumable download verification strategy beyond size checks
- explicit download scheduling windows
- importer-friendly history and retry controls
