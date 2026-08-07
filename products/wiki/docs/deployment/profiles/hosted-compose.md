# Hosted Compose (Docker)

The reference self-hosted deployment for a team or org. A packaged OCI image and a
Docker Compose stack that boot an empty wiki and run it with coordinated Postgres
state, scheduled backups, and optional on-prem Git sync. No OpenWiki runtime code
changes are required: the stack is the existing CLI in three roles
(`serve` / `worker` / `cron`) plus a Postgres service.

Artifacts live in [`products/wiki/packaging/`](https://github.com/joe-broadhead/open-cowork/blob/master/products/wiki/packaging/README.md):

| Artifact | Purpose |
| --- | --- |
| `Dockerfile` | One image, three roles (serve/worker/cron) |
| `entrypoint.sh` | Boot: init → Git bootstrap → search index → index-store → Postgres migrations |
| `docker-compose.yml` | `postgres` + `wiki` + `worker` + `cron` (+ `--profile s3` MinIO, `--profile git` SSH git remote) |
| `.env.example` | Env contract (origin, DB password, identity secrets, sync remote, rate limits) |
| `smoke-hosted-compose.mjs` | Local boot-path check (no Docker) and full compose check (`--docker`) |

## When to use this profile

- You want a team wiki behind your existing SSO, with backups and upgrades that
  follow the operations guidance.
- You want OpenWiki's MCP-over-HTTP (OAuth 2.1) or scoped service-account tokens
  for agents.
- You want the wiki Git history to live in a repo you control (GitHub/GitLab, or
  the bundled on-prem `git-server`).

## Decision-fit vs. other profiles

| Concern | Hosted Compose | Local Team | Public Static |
| --- | --- | --- | --- |
| Team access via SSO | Yes (trusted-header proxy) | No (local) | Read-only |
| Agents over HTTP MCP | Yes (OAuth 2.1 + tokens) | stdio | No |
| Backups | Local + optional S3/MinIO | Local | N/A |
| Git source of truth | Remote (https/ssh) | Local | Export only |
| Runtime state | Postgres (coordinated) | SQLite | N/A |

## Quick start

```sh
cd products/wiki/packaging
cp .env.example .env            # set OPENWIKI_PUBLIC_ORIGIN + OPENWIKI_DATABASE_PASSWORD
docker build -f Dockerfile -t openwiki:local ../..   # context = monorepo root
docker compose up -d --wait
curl -fsS "$OPENWIKI_PUBLIC_ORIGIN/readyz"
docker compose exec wiki doctor --profile hosted --json
```

## Operational contract

- **Readiness**: `/livez`, `/readyz`, `/healthz`, `/api/v1/health`; `doctor
  --profile hosted` is the gate before traffic.
- **Identity**: human SSO is delegated to the reverse proxy (trusted headers,
  ADR 0004); agents use OAuth 2.1 remote MCP (ADR 0008) or scoped service
  accounts (`openwiki auth token create`).
- **Backups**: `cron` runs `backup create` on a schedule to the local volume and,
  with `--profile s3`, to MinIO. Rehearse restores before relying on them.
- **Upgrades**: rebuild the image, `docker compose up -d`; rollback = previous
  tag. Migrations are explicit and versioned.
- **Git**: the wiki working tree is a Git repo; sync to `OPENWIKI_SYNC_REMOTE`
  (https or ssh). The `git` profile provides an on-prem SSH remote.

See [`packaging/README.md`](https://github.com/joe-broadhead/open-cowork/blob/master/products/wiki/packaging/README.md) for the full runbook
(identity setup, S3 configuration, restore rehearsal, scaling notes) and
[`operations/backup-restore.md`](../operations/backup-restore.md) for restore
procedures.
