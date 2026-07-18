# Docker Compose

Compose runs the web/API/MCP server, worker, Postgres runtime database, and
optional MinIO object storage.

```sh
export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker compose -f deploy/compose/docker-compose.yml up --build
```

Use Compose for local or trusted deployments. Internet-facing write access needs
an authenticating proxy and `OPENWIKI_PUBLIC_ORIGIN` set to the external origin.
Compose does not enable wildcard CORS by default. Set `OPENWIKI_CORS_ORIGIN`
only for a specific trusted browser origin that needs cross-origin API reads.
The OpenWiki services run as uid/gid `1000`, with a read-only root filesystem,
no Linux capabilities, `no-new-privileges`, and `/tmp` mounted as tmpfs.
The checked-in port mapping binds the server to `127.0.0.1:3030`; use a local
override for a private LAN, VPN, or SSO-protected reverse proxy:

```yaml
services:
  openwiki:
    ports:
      - "10.0.0.10:3030:3030"
```

Do not use `3030:3030` or `0.0.0.0:3030:3030` unless that interface is already
protected by the trusted network boundary.

Backup and sync profiles are explicit:

```sh
export OPENWIKI_GIT_REMOTE_URL=git@github.com:acme/wiki.git
export OPENWIKI_GIT_BRANCH=main
export OPENWIKI_SYNC_INTERVAL=15m
docker compose -f deploy/compose/docker-compose.yml --profile sync up --build

export OPENWIKI_BACKUP_INTERVAL=24h
docker compose -f deploy/compose/docker-compose.yml --profile backup up --build
```

The backup profile writes workspace snapshots to a separate
`openwiki_backups` volume unless `OPENWIKI_BACKUP_DESTINATION` points at a
configured destination in `runtime.backups`. Keep Git keys, cloud keys, and
service tokens in environment or platform secrets, not in Compose YAML.
