# OpenWiki hosted packaging (self-hosted reference stack)

Phase 2 of the desktop wiki plan: a packaged, observable, recoverable way to host an
OpenWiki workspace for a team or org. The stack keeps **Git as the source of truth**,
Postgres for coordinated runtime state, and the existing `openwiki` CLI as the only
process. No new OpenWiki runtime code was required — this packaging reuses the
server, worker, cron, backup, sync, OAuth, and health machinery that already exists.

```
┌─ reverse proxy (TLS + SSO) ──────────────────────────────┐
│   (Caddy / Traefik / Cloudflare Access / Authentik…)      │
│   injects signed x-openwiki-* headers (see Identity)       │
└──────────────────────────┬────────────────────────────────┘
                           ▼
        ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
        │  wiki (serve) │   │ worker (jobs) │   │ cron (bk/sync)│
        │  :3030        │   └───────┬───────┘   └───────┬───────┘
        └──────┬────────┘           │                   │
               ▼                    ▼                   ▼
        ┌──────────────────────────────────────────────────┐
        │  /data/wiki volume (Git working tree + derived)  │
        │  /data/backups volume (local archive)            │
        └───────────────┬──────────────────────────────────┘
                        ▼
        ┌───────────────── postgres:16 (queue, leases, OAuth state, search) ─┐
        │  optional profiles: --profile s3 (MinIO backups) --profile git      │
        └─────────────────────────────────────────────────────────────────────┘
```

## Quick start

```sh
cp .env.example .env
# edit .env: OPENWIKI_PUBLIC_ORIGIN, OPENWIKI_DATABASE_PASSWORD (+ identity/secrets)
docker build -f products/wiki/packaging/Dockerfile -t openwiki:local .
docker compose -f products/wiki/packaging/docker-compose.yml up -d --wait
docker compose -f products/wiki/packaging/docker-compose.yml ps
curl https://<origin>/readyz
```

The stack starts: `postgres`, `wiki` (web UI + HTTP API + MCP over HTTP),
`worker` (Postgres queue consumer), `cron` (periodic backup + optional git sync).
The `wiki` container bootstraps an empty workspace in `/data/wiki` on first start
(`init` → git → search index → index-store → Postgres migrations), so an empty
volume is fine.

## Verify a deployment (readiness gate)

```sh
docker compose exec wiki doctor --profile hosted --json
# Expect: public-origin, rate-limits, postgres, postgres-backup, operational-state,
# readyz-prerequisites, hosted-mcp-tokens, git-remote + backup checks to be passing
# (or the listed warn/skip items you intentionally accept).
curl -fsS https://<domain>/livez && curl -fsS https://<domain>/readyz
curl -fsS https://<domain>/api/v1/health
```

Endpoints: `/livez` (process), `/readyz` (derived stores + backends), `/healthz`
(deep health summary), `/api/v1/health`, Prometheus metrics at `/metrics`
(`OPENWIKI_PUBLIC_METRICS=1` when you want them public).

## Identity (defaults)

- **Humans — SSO at the reverse proxy (ADR 0004).** The proxy authenticates and
  injects `x-openwiki-actor` (etc.), signed with the shared secret
  `OPENWIKI_TRUST_AUTH_HEADERS_SECRET` (header `x-openwiki-proxy-secret`). The proxy
  MUST strip inbound `x-openwiki-*` headers from clients. The wiki container gets
  `--trust-headers` automatically when that env var is set.
- **Agents — OAuth 2.1 / MCP over HTTP (ADR 0008).** Set `OPENWIKI_OAUTH_ENABLED=1`
  (+ `OPENWIKI_OAUTH_ISSUER`, `OPENWIKI_OAUTH_CSRF_SECRET`); OAuth state is kept in
  Postgres. Create scoped service-account tokens for automation:
  ```sh
  docker compose exec wiki openwiki auth token create --role researcher --scope wiki:read --expires-in-days 90
  ```

## Git as source of truth

The wiki root is a Git repository. sync automation pushes/pulls to
`OPENWIKI_SYNC_REMOTE` (https or ssh). For fully on-prem sync use the `git` profile
(bare SSH repo) — see below. Mount the app's SSH keypair at
`./secrets/ssh/{id_ed25519,id_ed25519.pub}` (bind-mounted read-only into
`/root/.ssh`); add an ssh `config` with the host to tolerate host-key checking.

```sh
git@github.com:acme/wiki.git      # hosted
git@git-server:/srv/git/wiki.git  # on-prem (see below)
```

## Backup + restore

- Local archive: set `OPENWIKI_BACKUP_PATH` (default `/data/backups`, volume
  `backups-data`); the entrypoint auto-configures destination `backup-local` and the
  `cron` container runs `backup create` every `OPENWIKI_BACKUP_INTERVAL_SECONDS`.
- S3/MinIO: `docker compose --profile s3 up -d --wait`, then configure once:
  ```sh
  docker compose exec wiki openwiki backup configure minio --id backup-s3 \
    --endpoint-url http://minio:9000 --bucket openwiki --prefix backups \
    --access-key-env MINIO_ROOT_USER --secret-key-env MINIO_ROOT_PASSWORD \
    --force-path-style --allow-insecure-http
  ```
  The cron container also runs `backup create` for the current destination.
- Restore rehearsal (prove you can restore) — docs: `docs/deployment/operations/backup-restore.md`:
  ```sh
  docker compose exec wiki openwiki backup rehearse latest --target-root /tmp/restore --destination id --force
  docker compose exec wiki openwiki backup restore latest --target-root /data/wiki --destination backup-local --force --dry-run
  ```

## Upgrades

1. `git pull` the wiki product sources; rebuild the image
   (`docker build … -t openwiki:new`).
2. `docker compose up -d` (migrations auto-run: `OPENWIKI_POSTGRES_MIGRATE=1`);
   workers pick up the new bundle on restart.
3. Rollback = point `image:` back at the previous tag and `up -d` (Git stays
   canonical; derived stores are rebuildable). See `docs/deployment/operations/upgrades.md`.

## Scaling notes

- One `wiki` replica with the default env is the baseline. To scale reads later,
  switch read/search backends to Postgres (already set in compose) and add replicas
  with `OPENWIKI_READ_BACKEND=postgres`; keep exactly one writer per Git working
  tree or move Git mutations to a dedicated service (write leases in Postgres make
  this possible — see `docs/deployment/operations/write-coordination.md`).
- Worker concurrency: `OPENWIKI_WORKER_MAX_JOBS` is deliberately conservative (1
  by default) until git mutation ownership is explicit.
- Rate limits: enabled by default (`OPENWIKI_RATE_LIMIT_ENABLED=1`); tune
  `OPENWIKI_RATE_LIMIT_*` policy envs before exposing to untrusted networks.

## Smoke

```sh
node packaging/smoke-hosted-compose.mjs           # local boot-path check (no Docker)
node packaging/smoke-hosted-compose.mjs --docker  # full compose stack check (Docker)
```

CI wiring: `pnpm --dir products/wiki smoke:wiki-standalone`.

## Layout

```
packaging/
  Dockerfile            # one image, roles: serve | worker | cron
  entrypoint.sh         # init → git bootstrap → derived stores → role
  docker-compose.yml    # reference stack (+ --profile s3 MinIO, --profile git)
  .env.example          # env contract
  smoke-hosted-compose.mjs
  git-server/           # optional on-prem SSH git remote
```
