---
title: Standalone Gateway
description: Run Open Cowork Gateway-only with private OpenCode and Gateway Postgres.
---

# Standalone Gateway

Standalone Gateway is the Gateway-only Open Cowork execution appliance. It is
for a VPS, private server, Mac mini, internal workstation, or Kubernetes
cluster where the Gateway owns private OpenCode execution and durable Gateway
Postgres state without requiring Open Cowork Cloud.

Use the `gateway-only` topology profile for this deployment path. The profile
is documented in [Deployment Topologies](deployment-topologies.md) and in
`deploy/topologies/topology-profiles.json`.

Product naming, historical `opencode-agent-gateway` migration, release-channel
policy, and compatibility aliases are documented in
[OSS Packaging and Gateway Migration](oss-packaging-migration.md).

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
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL=true
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_REJECT_UNAUTHORIZED=true
OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN=...
OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL=http://127.0.0.1:4096
OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN=...
```

Generate a starter env file:

```bash
pnpm standalone-gateway:setup -- \
  --admin-token "$OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN" \
  --opencode-url http://127.0.0.1:4096 \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN" \
  --output .env.standalone-gateway
```

The setup helper writes env files with mode `0600`, refuses public OpenCode
URLs, and does not echo provided secrets to stdout when `--output` is used. Use
`--print` only for placeholder examples unless you explicitly pass
`--allow-secret-print` in a controlled terminal.

### Persistence backend

`OPEN_COWORK_STANDALONE_GATEWAY_STORE` selects the store:

- `postgres` (default) — durable, multi-replica Gateway Postgres. Requires
  `OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL` and verified TLS for team/enterprise
  deployments.
- `memory` — an ephemeral in-process store for local development or embedded
  single-process deployments. No database URL is required and the Postgres TLS
  gate does not apply. **Data is lost on restart and is not shared across
  replicas**, so it is not suitable for production team/enterprise use.

### File config

Every `OPEN_COWORK_STANDALONE_GATEWAY_*` value can be supplied from a JSON (or
JSONC) file instead of, or in addition to, the environment. Environment
variables always override file values.

```bash
# A flat JSON object keyed by the same env var names:
OPEN_COWORK_STANDALONE_GATEWAY_CONFIG=/etc/open-cowork/standalone-gateway.json
# …or inline JSON:
OPEN_COWORK_STANDALONE_GATEWAY_CONFIG_JSON='{"OPEN_COWORK_STANDALONE_GATEWAY_STORE":"memory", ...}'
```

### Postgres TLS

Solo/local deployments may run against a local Postgres listener without TLS.
Team and enterprise deployments must enable verified Postgres TLS:

```bash
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL=true
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_REJECT_UNAUTHORIZED=true
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_CA_PATH=/run/secrets/postgres-ca.pem
```

Client certificates are optional and are passed directly to the Postgres pool
when configured:

```bash
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_CERT_PATH=/run/secrets/postgres-client.pem
OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_KEY_PATH=/run/secrets/postgres-client-key.pem
```

The doctor report exposes only booleans for TLS state and certificate presence.
It does not print certificate file contents or connection string secrets.

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

When the Standalone Gateway sits behind a reverse proxy and should use
forwarded client IPs for webhook abuse controls, set
`OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS=true` and restrict
`OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS` to the proxy hops.

The signed webhook provider can bridge custom channels. It requires
`OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET` and validates incoming
provider payloads before they can prompt private OpenCode.

Provider webhook verification authenticates the provider request, not the human
or channel actor. Standalone Gateway denies every inbound prompt until the
sender has an active prompt-capable identity in Gateway Postgres.

Bootstrap the first identity before accepting traffic:

```bash
pnpm --filter @open-cowork/standalone-gateway identity -- \
  upsert \
  --provider webhook \
  --external-user-id "$CHANNEL_USER_ID" \
  --role admin
```

For provider workspaces such as Slack teams or Discord guilds, scope the
identity when the provider supplies that workspace id:

```bash
pnpm --filter @open-cowork/standalone-gateway identity -- \
  upsert \
  --provider slack-prod \
  --provider-workspace-id "$SLACK_TEAM_ID" \
  --external-user-id "$SLACK_USER_ID" \
  --role member
```

An unscoped identity only authorizes provider messages that do not include a
provider workspace id. It is not a global fallback for every workspace on the
same provider.

Roles are deliberately small:

- `owner` and `admin` can prompt, approve, and manage identities.
- `member` can prompt from their channel identity.
- `approver` can approve/respond when approval flows are wired, but cannot start
  private OpenCode work.
- `viewer` and disabled identities cannot prompt.

The doctor check fails until at least one active `owner`, `admin`, or `member`
identity exists. Denied prompt attempts are audited as
`standalone.prompt.denied` without storing message text.

## Backup And Retention

Backups must cover:

- Postgres database
- artifact storage path or bucket
- exported standalone manifest rows for sessions, identities, jobs, and audits
- private env/secret inventory, stored separately from the backup manifest

Retention windows are explicit:

- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_SESSION_DAYS`
- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_ARTIFACT_DAYS`
- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_AUDIT_DAYS`
- `OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_JOB_DAYS`

The serving daemon runs retention under the active daemon lease. A standby
process that cannot hold the lease cannot prune data. Retention deletes:

- idle, failed, or completed sessions older than the session window, including
  their event rows
- artifact metadata older than the artifact window
- audit events older than the audit window
- completed, failed, or dead jobs older than the job window

Retention preserves running sessions, blocked sessions, and any session with a
pending, claimed, or running job. Each successful retention pass writes a
`standalone.retention.pruned` audit event with cutoff times and deletion
counts.

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
