---
title: Standalone Gateway
description: Run Open Cowork Gateway-only with private OpenCode and Gateway Postgres.
---

# Standalone Gateway

Standalone Gateway is the Gateway-only Open Cowork execution appliance. It is
for a VPS, private server, Mac mini, internal workstation, or Kubernetes
cluster where the Gateway owns private OpenCode execution and durable Gateway
Postgres state without requiring Open Cowork Cloud.

This is not the Cloud Channel Gateway. Cloud Channel Gateway is a Cloud client.
Standalone Gateway is an execution authority.

## Product Contract

Standalone Gateway owns:

- private OpenCode runtime access
- Gateway Postgres/control-plane rows
- channel provider bindings and identities
- sessions, ordered events, jobs, audit, artifacts metadata, and dashboard state
- scheduler/background jobs, team tasks, watches, backup, retention, doctor,
  smoke, and metrics surfaces

Those Gateway-owned surfaces use the shared
[Coordination Model](coordination-model.md): team projects/tasks map to
Projects and Tasks, background jobs map to Runs, cron/scheduled jobs map to
Schedules plus Runs, channel subscriptions map to Watches, native delegation
hints and explicit delegate sessions map to Delegations, and uploads/diffs/logs
map to Artifacts. Gateway table names may stay Gateway-specific internally, but
operator docs, dashboards, and future Desktop/Cloud bridges should use the
shared nouns.

Standalone Gateway must keep OpenCode private. It refuses public OpenCode URLs
and wildcard OpenCode bind addresses. Do not expose the OpenCode port through a
public reverse proxy.

## Configuration

Required environment:

```bash
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL=postgres://...
OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN=...
OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL=http://127.0.0.1:4096
OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN=...
```

Generate a starter env file:

```bash
pnpm standalone-gateway:setup -- \
  --opencode-url http://127.0.0.1:4096 \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN" \
  --output .env.standalone-gateway
```

## Run

```bash
pnpm build:standalone-gateway
set -a
. ./.env.standalone-gateway
set +a
pnpm --filter @open-cowork/standalone-gateway start
```

Useful checks:

```bash
pnpm --filter @open-cowork/standalone-gateway doctor
pnpm deploy:standalone-gateway:smoke
pnpm deploy:standalone-gateway:validate
```

The dashboard is served by the Standalone Gateway process and reads Gateway
database rows, not Cloud APIs:

```bash
curl -H "Authorization: Bearer $OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN" \
  http://127.0.0.1:8795/dashboard
```

Operator metrics are also admin-token protected:

```bash
curl -H "Authorization: Bearer $OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN" \
  http://127.0.0.1:8795/metrics
```

## Provider Modes

Telegram polling is the simplest private-server setup. Webhook mode requires a
public HTTPS reverse proxy and a Telegram webhook secret.

The signed webhook provider can bridge custom channels. It requires
`OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET` and validates incoming
provider payloads before they can prompt private OpenCode.

## Backup And Retention

Backups must cover:

- Postgres database
- artifact storage path or bucket
- private env/secret inventory, stored separately from the backup manifest

Retention windows are explicit:

- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_SESSION_DAYS`
- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_ARTIFACT_DAYS`
- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_AUDIT_DAYS`

Run a restore drill before public or enterprise rollout.

## Validation

Required gates for this product mode:

```bash
pnpm build:standalone-gateway
pnpm typecheck:standalone-gateway
pnpm --filter @open-cowork/standalone-gateway test
pnpm deploy:standalone-gateway:validate
```

The normal repo gates also cover the standalone app:

```bash
pnpm lint
pnpm typecheck
pnpm test
python3 -m mkdocs build --strict
```
