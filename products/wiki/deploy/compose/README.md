# Docker Compose

Run an OpenWiki web/API/MCP server, worker, and Postgres runtime database:

```sh
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose/docker-compose.yml up --build
```

The Compose profile digest-pins the default Postgres and optional MinIO support
images. Override them with `OPENWIKI_POSTGRES_IMAGE` and
`OPENWIKI_MINIO_IMAGE` only when you are intentionally rolling those support
images forward.
The OpenWiki application services run as uid/gid `1000`, drop Linux
capabilities, set `no-new-privileges`, and use a read-only root filesystem with
`/tmp` as tmpfs. Keep `/data/wiki` and `/data/backups` as the only writable
runtime mounts.

The server listens on `http://127.0.0.1:3030`. The `openwiki` container initializes
`/data/wiki` on first boot, runs Postgres migrations when `DATABASE_URL` is set,
rebuilds the local search and index-store, and serves the HTTP API plus `/mcp`.
The `openwiki` service uses `OPENWIKI_READ_BACKEND=postgres` and
`OPENWIKI_SEARCH_BACKEND=postgres`, so workspace summaries, proposal queues,
graph reads, and search can be served from Postgres-derived tables after
initial sync; write paths keep those tables current when the Postgres read or
search backend is enabled. The worker shares the same wiki volume and uses
`OPENWIKI_QUEUE_BACKEND=postgres` so queued runs are claimed through Postgres
with row locking. Both web and worker set
`OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres`, so Git-mutating operations
contend on the same durable write lease instead of racing through the shared
volume.

Compose is a local/trusted deployment profile by default. For public read-only
serving, expose only viewer-scoped access or publish a static export instead.
For hosted write access, put the web service behind trusted SSO or reverse proxy
auth and set `OPENWIKI_PUBLIC_ORIGIN` to the external origin, for example
`https://wiki.example.com`, so server-rendered write forms pass the same-origin
POST check. Use trusted identity headers only with
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET` configured at both the proxy and OpenWiki.
For remote MCP clients that support OAuth, set `OPENWIKI_OAUTH_ENABLED=1` and
`OPENWIKI_OAUTH_ISSUER=https://wiki.example.com` only after the same external
origin is protected by TLS and the auth boundary. Keep OAuth client definitions
and client-secret hashes in `openwiki.json` or a bootstrap secret process; never
store raw client secrets or bearer tokens in Compose YAML. Leave
`OPENWIKI_OAUTH_DYNAMIC_CLIENT_REGISTRATION` empty unless an admin-gated
registration workflow fronts `/oauth/register`.
The Compose file does not enable wildcard CORS by default. Set
`OPENWIKI_CORS_ORIGIN` only when a specific trusted browser origin needs
cross-origin API access.

The checked-in port mapping binds to loopback:

```yaml
services:
  openwiki:
    ports:
      - "127.0.0.1:3030:3030"
```

For a private LAN, VPN, or SSO-protected reverse proxy, put a different binding
in a local override file. Only use `3030:3030` or `0.0.0.0:3030:3030` after
the host, network, or proxy path is already protected by the trusted boundary.

To back the compose stack with a remote Git repository, set the bootstrap
environment on the `openwiki` service or in a local override file:

```yaml
services:
  openwiki:
    environment:
      OPENWIKI_GIT_REMOTE_URL: git@github.com:acme/wiki.git
      OPENWIKI_GIT_BRANCH: main
      OPENWIKI_GIT_PULL_ON_BOOT: "1"
      OPENWIKI_SYNC_INTERVAL: 15m
      OPENWIKI_SYNC_PULL_ON_START: "1"
      OPENWIKI_SYNC_PUSH_AFTER_COMMIT: "1"
    volumes:
      - ~/.ssh:/home/node/.ssh:ro
      - openwiki_data:/data/wiki
```

On an empty `openwiki_data` volume, the container clones the remote into
`/data/wiki`. Empty remotes are supported; the entrypoint creates the configured
branch locally and then initializes OpenWiki. On an existing volume, it
configures the remote and optionally fast-forward pulls before rebuilding
indexes. Keep Git credentials in SSH keys, credential helpers, or platform
secrets; OpenWiki records only the remote name, branch, redacted URL metadata,
and optional `credential_ref`.

For continuous Git sync, start the sync profile after the remote is configured:

```sh
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
export OPENWIKI_GIT_REMOTE_URL=git@github.com:acme/wiki.git
export OPENWIKI_GIT_BRANCH=main
export OPENWIKI_SYNC_INTERVAL=15m
docker compose -f deploy/compose/docker-compose.yml --profile sync up --build
```

The sync sidecar refuses to start when no Git remote URL is configured. This is
intentional: Git is the live versioned sync layer, and an interval without a
remote creates a false sense of protection.

For scheduled workspace backups, use the backup profile. It writes immutable
snapshot artifacts to the separate `openwiki_backups` volume by default:

```sh
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
export OPENWIKI_BACKUP_INTERVAL=24h
docker compose -f deploy/compose/docker-compose.yml --profile backup up --build
```

If `runtime.backups.destinations` contains a named destination, set
`OPENWIKI_BACKUP_DESTINATION` instead of using the local `/data/backups`
volume. Keep cloud access keys in environment secrets or platform secret
stores; do not put raw credentials in Compose YAML or `openwiki.json`.

Useful endpoints:

```sh
curl http://127.0.0.1:3030/livez
curl http://127.0.0.1:3030/readyz
curl -H "Authorization: Bearer $OPENWIKI_ADMIN_TOKEN" http://127.0.0.1:3030/metrics
curl "http://127.0.0.1:3030/api/v1/search?q=agent%20memory"
curl "http://127.0.0.1:3030/mcp-manifest.json"
```

Runtime services:

- `openwiki`: web UI, HTTP API, and remote MCP bridge.
- `openwiki-worker`: queued job worker.
- `openwiki-sync`: optional Git sync watcher with `--profile sync`.
- `openwiki-backup`: optional workspace backup watcher with `--profile backup`.
- `postgres`: hosted runtime database for migrations and queue state.
- `minio`: optional S3-compatible object storage when started with
  `--profile object-storage`.

To test S3-compatible source object storage locally, start the optional MinIO
profile with explicit credentials and configure `runtime.storage` in
`openwiki.json`:

```sh
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
export OPENWIKI_MINIO_ACCESS_KEY="$(openssl rand -hex 16)"
export OPENWIKI_MINIO_SECRET_KEY="$(openssl rand -base64 32)"
docker compose -f deploy/compose/docker-compose.yml --profile object-storage up --build
```

The compose profile uses a digest-pinned MinIO image by default instead of
`latest`. Override `OPENWIKI_MINIO_IMAGE` only after checking the MinIO
release notes and rerunning the compose smoke locally. Production object
storage should normally use a managed S3-compatible bucket with provider-native
versioning, lifecycle policy, encryption, and backup controls rather than the
local MinIO sidecar.

```json
{
  "runtime": {
    "storage": {
      "backend": "minio",
      "endpoint_url": "http://minio:9000",
      "bucket": "openwiki",
      "region": "us-east-1",
      "prefix": "default",
      "access_key_id_env": "OPENWIKI_MINIO_ACCESS_KEY",
      "secret_access_key_env": "OPENWIKI_MINIO_SECRET_KEY",
      "inline_max_bytes": 0
    }
  }
}
```

The Compose file does not publish MinIO ports by default. For local console
access, add a private override that maps `127.0.0.1:9000:9000` and
`127.0.0.1:9001:9001`, then create the `openwiki` bucket before ingesting
sources that exceed `inline_max_bytes`.

Named volumes:

- `openwiki_data`: canonical Git-backed wiki workspace and local derived files.
- `openwiki_backups`: optional workspace backup artifacts created by the
  backup profile.
- `postgres_data`: Postgres runtime tables, including queue state.
- `minio_data`: optional S3-compatible source object storage.
