# docker-private

Use Docker or Compose for a private team wiki on a trusted host or private
network.

## Quickstart

```sh
docker run --rm -p 127.0.0.1:3030:3030 \
  -v openwiki_data:/data/wiki \
  ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

Compose starts the `openwiki` server, worker, Postgres, and optional MinIO:

```sh
POSTGRES_PASSWORD="$(openssl rand -base64 32)" \
docker compose -f deploy/compose/docker-compose.yml up
```

Enable live Git sync and scheduled workspace backups explicitly:

```sh
export POSTGRES_PASSWORD="$(openssl rand -base64 32)"
export OPENWIKI_GIT_REMOTE_URL=git@github.com:acme/wiki.git
export OPENWIKI_GIT_BRANCH=main
export OPENWIKI_SYNC_INTERVAL=15m
docker compose -f deploy/compose/docker-compose.yml --profile sync up

export OPENWIKI_BACKUP_INTERVAL=24h
docker compose -f deploy/compose/docker-compose.yml --profile backup up
```

The sync sidecar requires a configured Git remote. The backup sidecar writes
to the separate `openwiki_backups` volume unless `OPENWIKI_BACKUP_DESTINATION`
selects a named destination from `runtime.backups`.

## Preflight

```sh
OPENWIKI_RATE_LIMIT_ENABLED=1 \
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres \
openwiki --root /data/wiki deploy preflight \
  --deploy-profile docker-private \
  --public-origin https://wiki.example.com \
  --image ghcr.io/joe-broadhead/open-wiki@sha256:<digest>
```

## Security Notes

- Keep the service on a private network or behind the SSO/reverse-proxy auth
  boundary.
- Do not expose Compose write access directly to the public internet.
- Keep the checked-in read-only root filesystem, dropped capabilities,
  `no-new-privileges`, and `/tmp` tmpfs hardening on OpenWiki services.
- Configure `OPENWIKI_PUBLIC_ORIGIN` before browser writes through a public
  hostname.
- MinIO ports are not published by default; publish them only for local admin
  work.

## Readiness Checks

```sh
curl --fail http://127.0.0.1:3030/livez
curl --fail http://127.0.0.1:3030/readyz
curl --fail -H "Authorization: Bearer $OPENWIKI_ADMIN_TOKEN" http://127.0.0.1:3030/metrics
openwiki --root /data/wiki run lint --json
```

## Backup And Restore

Back up the Docker volume or host path used for `/data/wiki`, plus Postgres and
object storage when enabled. Prefer a private Git remote for live workspace
sync and the backup profile for point-in-time workspace artifacts. Run a
restore rehearsal into a new volume before replacing production:

```sh
docker compose -f deploy/compose/docker-compose.yml --profile backup run --rm openwiki-backup \
  openwiki --root /data/wiki backup rehearse \
    --out-dir /data/backups \
    --target-root /tmp/openwiki-restore \
    --json
docker compose -f deploy/compose/docker-compose.yml run --rm openwiki \
  openwiki --root /data/wiki doctor --profile hosted --json
```

The restore rehearsal runs in the `openwiki-backup` container because that
profile mounts the backup volume at `/data/backups`; the main web container
does not mount backup artifacts by default.

## Rollback

Stop the worker first, then stop the `openwiki` server container. Restore the wiki volume and
Postgres/object-storage backups into new volumes, restore service secrets from
the host secret store, pin the previous image digest, start the `openwiki` service,
verify `/readyz`, run an MCP read smoke, and then restart the worker.

## MCP

Use HTTP MCP with service-account bearer tokens:

```sh
openwiki --root /data/wiki auth token create --profile proposal-agent --expires-in-days 30
curl http://127.0.0.1:3030/mcp?tools=proposal \
  -H 'authorization: Bearer <service-account-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"tools","method":"tools/list"}'
```

For remote inbox agents, keep Compose behind a private network or
authenticating proxy and follow
[Hosted Inbox Agents](../../guides/hosted-inbox-agents.md) for per-user inboxes,
shared Space inboxes, and token-profile separation.
