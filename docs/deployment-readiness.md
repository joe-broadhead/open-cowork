---
title: Deployment Readiness
description: Production checklist for self-hosted and managed Open Cowork Cloud plus Gateway deployments.
---

# Deployment Readiness

Use this checklist before exposing Open Cowork Cloud or the headless gateway to
company users, customers, or public channel webhooks. The deployment should be
the same product on every provider: configure adapters and infrastructure, do
not add provider-specific branches to core app code.

## Required Topology

Production deployments should run these processes separately:

- cloud `web`: stateless HTTP, browser dashboard, API, SSE, auth, and durable
  projections.
- cloud `worker`: OpenCode execution, command processing, checkpoints, and
  artifact generation.
- cloud `scheduler`: durable workflow claims and scheduled run creation.
- gateway: channel I/O, provider webhooks or polling, channel rendering, and
  delivery retries.

Local Compose may run `all-in-one` cloud for speed. Provider demos may use
all-in-one for a focused pilot. Shared or hosted deployments should use split
roles and shared Postgres/object storage.

## Production Checklist

### Auth

- Public cloud uses OIDC or trusted `header` auth behind a signed, trusted
  identity proxy.
- `OPEN_COWORK_CLOUD_AUTH_MODE=none` is allowed only for local/demo installs
  with explicit insecure overrides.
- Header auth includes `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` or
  `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF`; identity headers from arbitrary
  clients are never trusted directly.
- Public dashboard traffic uses HTTPS and a stable `OPEN_COWORK_CLOUD_PUBLIC_URL`.

### Cookie Secret

- Set a high-entropy cookie secret through `OPEN_COWORK_CLOUD_COOKIE_SECRET` or
  `OPEN_COWORK_CLOUD_COOKIE_SECRET_REF`.
- Keep `OPEN_COWORK_CLOUD_COOKIE_SECURE=true` for HTTPS deployments.
- Rotate the cookie secret during a maintenance window because browser
  sessions may be invalidated.

### Postgres

- Use managed Postgres or a highly available cluster for the control plane.
- Enable automated backups and point-in-time recovery.
- Size connection limits for web replicas, workers, scheduler replicas, and
  dashboard/gateway API traffic.
- Run the real Postgres concurrency tests before changing schema, lease,
  command, delivery, or quota behavior.

### Object Store

- Configure object storage for artifacts, uploads, exports, runtime
  checkpoints, workspace snapshots, and diagnostics bundles.
- Use provider-native object storage through adapter configuration: S3, GCS,
  Azure Blob, DigitalOcean Spaces, or compatible S3 endpoints.
- Do not rely on local filesystem object storage for scaled workers.
- Confirm object-store read/write with a smoke artifact or checkpoint-enabled
  session before enabling multiple workers.

### Secret Adapter/KMS

- Store envelope keys, BYOK material, channel credentials, database URLs,
  object-store credentials, gateway service tokens, and billing secrets in a
  provider secret manager or KMS-backed secret adapter.
- Use `OPEN_COWORK_CLOUD_SECRET_KEY_REF` where possible:
  `gcp-sm://...`, `aws-sm://...`, `azure-kv://...`, or `env:...` for
  platform-injected secrets.
- BYOK plaintext is only revealed in the worker role and only long enough to
  build provider runtime config.

### Public URL/HTTPS

- Set `OPEN_COWORK_CLOUD_PUBLIC_URL` to the canonical HTTPS origin.
- Set `OPEN_COWORK_GATEWAY_PUBLIC_URL` when providers require webhook
  callbacks.
- Terminate TLS at ingress, load balancer, Cloud Run/App Platform, or the
  service mesh; internal pod/service traffic may remain private.
- Do not send desktop bearer tokens, gateway service tokens, cookies, or BYOK
  setup requests over non-loopback HTTP.

### Worker/Scheduler Scaling

- Enable `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true` before scaling worker
  replicas beyond one.
- Keep worker runtime roots ephemeral for horizontally scaled Kubernetes
  workers unless a single-worker persistent root is intentionally configured.
- Run at least one scheduler. Multiple schedulers are safe when they use
  database claims.
- Monitor worker heartbeat age, scheduler heartbeat age, command latency,
  projection lag, and lease reclaim counts.

### Gateway Service Token

- Run the gateway as a separate deployment with a scoped service/API token.
- Store `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` in the platform secret manager.
- Rotate gateway tokens by issuing a new token, updating the deployment secret,
  restarting the gateway, then revoking the old token.
- The gateway token authenticates the gateway process only; inbound channel
  actor identity and approval authority are resolved separately by cloud.

### Provider Webhook Signing

- Public webhook providers require provider signing secrets or shared secrets.
- Slack uses its signing secret, email uses an inbound shared secret, and the
  generic webhook provider uses `OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET`.
- The fake provider is local/demo-only and must not be exposed publicly.
- Gateway metrics and diagnostics on `0.0.0.0` require an admin token or
  private networking.

### Quotas/Rate Limits

- Configure per-org session, worker, prompt, API, and gateway delivery limits
  before public hosting.
- Keep billing disabled or stubbed for OSS self-host; self-hosted use should
  work with no billing provider or the stub billing provider.
- Hosted SaaS should gate new execution on subscription state while preserving
  read access and export paths.
- Rate limits should return clear 429 responses with `Retry-After`; billing
  gates should return clear 402 responses.

### OTLP/Logging

- Use JSON logs in production.
- Configure `OPEN_COWORK_CLOUD_OTLP_ENDPOINT` and gateway metrics scraping
  where available.
- Include request ids, org ids, session ids, run ids, worker ids, scheduler ids,
  and gateway delivery ids.
- Redact BYOK keys, API tokens, cookies, OAuth tokens, webhook secrets,
  database URLs, object-store signed URLs, and local paths.

### Backups/Restore

- Back up Postgres and object storage on the same retention policy.
- Restore Postgres first, then object-store artifacts/checkpoints for the same
  point in time.
- Start web with workers at zero, verify projections and session lists, start
  one worker, run a smoke prompt, then start scheduler and gateway.
- Verify channel deliveries resume from durable cursors without duplicates.

## Deployment Validation

Run static and tool-backed configuration checks:

```bash
pnpm deploy:validate
```

In CI or release qualification, require Docker and Helm:

```bash
pnpm deploy:validate -- --require-tools
```

The validator checks:

- Compose config for `docker-compose.cloud.yml`,
  `docker-compose.cloud.split.yml`, and `docker-compose.cloud-gateway.yml`.
- Helm lint/render for cloud and gateway charts.
- Helm fail-closed behavior for unsafe public cloud auth, public gateway
  metrics without admin auth, and generic webhook ingress without a shared
  secret.
- Presence of provider recipes, this checklist, and the managed BYOK SaaS
  runbook.

## Runtime Smoke Checks

For a local Compose deployment:

```bash
pnpm cloud:smoke:compose
```

For any already-running provider deployment:

```bash
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
pnpm deploy:smoke
```

For operator-only readiness checks:

```bash
OPEN_COWORK_SMOKE_OPERATOR_CHECKS=true \
OPEN_COWORK_SMOKE_CLOUD_TOKEN=... \
OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:smoke
```

The smoke script validates cloud `/healthz`, gateway `/health`, and gateway
`/ready`. Operator mode also checks cloud runtime/heartbeat endpoints and
gateway metrics when tokens are provided.

## Provider Recipe Contract

Provider recipes under `deploy/gcp`, `deploy/aws`, `deploy/azure`, and
`deploy/digitalocean` must stay thin. They should define:

- image repository and tag,
- public HTTPS origins,
- OIDC or trusted header auth,
- Postgres control-plane URL,
- object-store adapter settings,
- secret manager/KMS references,
- worker/scheduler replica counts,
- gateway service token and provider signing secrets,
- OTLP/logging endpoints,
- backup/restore ownership.

They must not require changes to session, runtime, projection, gateway,
OpenCode SDK, billing, or BYOK core code.
