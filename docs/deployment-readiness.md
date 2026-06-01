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

Choose one of the first-class topology profiles before choosing a provider:

| Profile | Production boundary |
| --- | --- |
| `desktop-only` | local Desktop execution, no remote dependency |
| `gateway-only` | Standalone Gateway owns private OpenCode and Gateway Postgres |
| `cloud-only` | Cloud web/worker/scheduler own Cloud workspaces |
| `cloud-channel-gateway` | Gateway is a Cloud client and channel adapter |
| `desktop-gateway` | Desktop executes through outbound pairing only |
| `cloud-gateway-edge` | Cloud registers an external Gateway/edge authority explicitly |
| `full-hybrid` | every workspace declares one execution authority |

The topology profile contract lives in
`deploy/topologies/topology-profiles.json`; the operator kit is
`deploy/topologies/README.md`; the docs overview is
[Deployment Topologies](deployment-topologies.md).

After choosing a topology, apply the matching security gate from
[Hybrid Security Gates](hybrid-security-gates.md). The gate contract lives in
`deploy/security/hybrid-security-gates.json` and defines the required auth,
revocation, approval/question policy, audit events, quotas/rate limits,
durability, backup/restore, redaction, and fail-closed checks for
`desktop-local`, `desktop-pairing`, `standalone-gateway`, `cloud-worker`,
`cloud-channel-gateway`, `cloud-gateway-edge`, and `full-hybrid`.

Use [Setup and Health Center](setup-and-health-center.md) as the operator-facing
bridge between topology selection and rollout evidence. Desktop exposes the same
authority-aware states for local runtime readiness, workspace support, Cloud
auth/sync, Gateway doctor/smoke checks, database migration posture, object store
posture, backup posture, and pairing freshness.

Production Cloud deployments should run these processes separately:

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

Compose files in this repo are local/demo references. They intentionally ship
loopback URLs, local MinIO, local Postgres, insecure auth overrides, fake/demo
tokens, and `build:` blocks for fast validation. Production downstream
overlays must pin OCI images by release tag or digest, replace every demo
secret, use HTTPS public URLs, and move Postgres/object storage/secrets to the
provider control plane.

## Deployer Config

- Keep downstream product policy in `open-cowork.config.json`; keep
  provider-specific wiring in Compose, Helm, Terraform, or platform manifests.
- Use `branding` for Desktop, `cloud.publicBranding` for Cloud Web, and
  `gateway.branding` for headless channel surfaces so all three clients expose
  the same downstream product name, logo, legal links, support links, and
  managed connection labels.
- Use `cloudDesktop.preconfiguredConnections` for managed-org Desktop builds
  instead of hardcoding cloud URLs in renderer code.
- Use `gateway.providers[]` for channel provider bindings and credential refs.
  Gateway can read this section through `OPEN_COWORK_CONFIG_PATH`,
  `OPEN_COWORK_CONFIG_DIR`, or `OPEN_COWORK_DOWNSTREAM_ROOT`, with
  `OPEN_COWORK_GATEWAY_*` env vars as deployment overrides.
- Use `cloud.billing.provider=none` or `stub` for OSS self-host deployments.
  Stripe or future billing adapters are managed-hosting configuration, not a
  core runtime dependency.
- For managed BYOK private beta, use
  `docs/runbooks/private-beta-launch.md`, `docs/runbooks/private-beta-support.md`,
  and `deploy/private-beta/` to keep onboarding, support, plan placeholders,
  and OSS self-host boundaries explicit before inviting design partners.
- Run schema and semantic validation for downstream configs before rollout:
  `node --no-warnings --experimental-strip-types --test tests/config-schema-validation.test.ts`.

## Production Checklist

### Auth

- Public cloud uses OIDC or trusted `header` auth behind a signed, trusted
  identity proxy.
- `OPEN_COWORK_CLOUD_AUTH_MODE=none` is allowed only for local/demo installs
  with explicit insecure overrides.
- Header auth includes `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` or
  `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF`; identity headers from arbitrary
  clients are never trusted directly.
- Public dashboard traffic uses HTTPS and a stable `OPEN_COWORK_CLOUD_PUBLIC_URL`
  for OIDC and trusted-header deployments alike.

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
- Multi-worker scale-out requires shared object storage for checkpoints and
  artifacts. Helm fails closed when `roles.worker.replicas > 1` is paired with
  filesystem object storage, missing buckets, disabled global checkpoints, or
  disabled worker checkpoints.

### Secret Adapter/KMS

- Store envelope keys, BYOK material, channel credentials, database URLs,
  object-store credentials, gateway service tokens, and billing secrets in a
  provider secret manager. Use cloud-provider KMS encryption underneath those
  secret-manager products or private deployment overlays until a first-class
  KMS decrypt adapter is added.
- Use `OPEN_COWORK_CLOUD_SECRET_KEY_REF` where possible:
  `gcp-sm://...`, `aws-sm://...`, `azure-kv://...`, or `env:...` for
  platform-injected secrets.
- `public_production` rejects weak inline envelope keys; hosted deployments
  should use managed refs or existing Kubernetes secrets rather than Helm
  literal values.
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

### Cloud Web Workbench

- Treat the browser workbench as a release-critical client, not only as an
  admin convenience UI.
- Run the browser E2E gate before provider rollout:
  `pnpm --filter @open-cowork/website test:browser`.
- Run the accessibility gate before provider rollout:
  `pnpm --filter @open-cowork/website test:a11y`.
- Run the performance and scale gate before provider rollout:
  `pnpm --filter @open-cowork/website perf:check`.
- `pnpm test:cloud-web` runs all three gates together for CI and release
  qualification.
- The workbench route at `GET /` must return HTML with the bootstrap JSON,
  route panels, `cache-control: no-store`, and a nonce-backed
  `Content-Security-Policy`.
- API bootstrap endpoints such as `GET /api/config` and `GET /api/workspace`
  must be reachable through the deployed origin and return either authenticated
  metadata or an expected auth error, never a proxy/static-asset failure.
- Validate signed-out, member, admin, policy-blocked, quota-blocked, and
  billing-blocked states. A disabled browser control is only an ergonomic
  mirror; the API remains the authorization boundary.
- Test laptop and tablet widths. Thread lists, admin tables, approval/question
  panels, and artifact controls must not overlap or depend on desktop-only
  viewport assumptions.
- Downstream branding smoke checks should load the workbench with the deployed
  product name, logo URL, theme tokens, and managed connection labels.

### Deployment Tiers

- Set `OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=local` for laptop demos and
  throwaway all-in-one experiments.
- Set `OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=self_host_beta` or `private_beta` for
  downstream pilots where the operator understands the remaining launch
  evidence gaps.
- Set `OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=public_production` only for split-role
  public deployments. This tier fails startup unless the control plane is
  durable Postgres, object storage is provider-backed, secret/cookie material is
  production-strength or resolved from a managed secret ref, auth is enabled,
  the web role has a canonical HTTPS public URL, web does not process commands
  inline, and workers have checkpoints enabled.
- Use `/livez` for process liveness and `/readyz` for dependency readiness.
  `/healthz` remains backward-compatible, but Kubernetes readiness probes should
  not use it for public production.

### Worker/Scheduler Scaling

- Enable `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true` before scaling worker
  replicas beyond one.
- Set `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS` and the platform termination grace
  so active command loops can finish after a drain request.
- Keep worker runtime roots ephemeral for horizontally scaled Kubernetes
  workers unless a single-worker persistent root is intentionally configured.
- Run at least one scheduler. Multiple schedulers are safe when they use
  database claims.
- For Kubernetes, add HPA or KEDA in the provider overlay that owns metrics.

### Gateway Scaling And Operator Auth

- Run one gateway replica per channel-binding shard until stream ownership and
  cursors are externalized. The Helm chart rejects `replicaCount > 1` unless
  `gateway.experimentalDistributedOwnership=true` is set deliberately.
- Configure `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` for operator endpoints in every
  shared or public deployment. The loopback bypass is explicit local-only:
  `OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS=true` and a loopback bind.
- Keep `OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES` aligned with provider
  advertised file limits. Generic bridge/email attachment limits default to the
  same request-body cap.
- Set bounded network deadlines:
  `OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS`,
  `OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS`,
  `OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS`, and
  `OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS`.
  HPA is appropriate for web CPU/memory or worker CPU/memory capacity; KEDA is
  appropriate for command queue depth, backlog age, or provider-native queue
  metrics.
- Enable PodDisruptionBudgets for production web, worker, scheduler, and
  gateway workloads, then use topology spread constraints so replicas are
  distributed across nodes and zones.
- Monitor worker heartbeat age, scheduler heartbeat age, command latency,
  projection lag, and lease reclaim counts.
- Managed worker pools must follow the
  [Managed Worker Service Plane](managed-workers.md) contract before they are
  exposed as production capacity: explicit worker identity, scoped expiring
  credentials, lifecycle state, durable work claims, lease-token fencing,
  checkpoint/artifact ownership, recovery rules, quotas, and operator runbooks.
- Cloud-connected Standalone Gateway deployments must follow the
  [Cloud Gateway Registration](cloud-gateway-registration.md) contract:
  `external_workspace` is redacted metadata only, `edge_worker` uses
  managed-worker lease fencing for Cloud-owned work, and customer-hosted edge
  workers against managed SaaS remain deferred.
- Use the public templates under `deploy/managed-workers/` for self-hosted and
  managed-worker pool deployment, release evidence, and restore drills.
- The first supported managed-worker mode is control-plane-owned worker pools.
  Do not connect customer-hosted workers to a separate managed SaaS control
  plane until a separate trust review, update policy, and data-residency model
  are implemented.

### Gateway Service Token

- Run the gateway as a separate deployment with a scoped service/API token.
- Store `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` in the platform secret manager.
- Rotate gateway tokens by issuing a new token, updating the deployment secret,
  restarting the gateway, then revoking the old token.
- The gateway token authenticates the gateway process only; inbound channel
  actor identity and approval authority are resolved separately by cloud.

### Provider Webhook Signing

- Public webhook providers require provider signing secrets or timestamped
  HMAC signatures.
- Slack uses its signing secret, email uses an inbound shared secret, and the
  generic webhook provider signs the raw body with
  `OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET` using
  `x-open-cowork-gateway-webhook-timestamp` and
  `x-open-cowork-gateway-webhook-signature`.
- The fake provider is local/demo-only. Public demo exposure requires the
  deliberate `OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER=true` override and
  must not be used for production traffic.
- Gateway metrics, diagnostics, and delivery operator endpoints require an
  admin token unless the process is explicitly running in local loopback bypass
  mode.

### Trusted Header Auth

- `cloud.auth.mode=header` is for deployments behind a trusted identity proxy.
- Public deployments require `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` and signed
  timestamped identity headers. Unsigned header auth is only for local demos.
- Header-auth role headers must map to `owner`, `admin`, or `member`; unknown
  roles are rejected rather than treated as privileged users.

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
- Configure `OPEN_COWORK_CLOUD_OTLP_ENDPOINT`, scrape authenticated
  `GET /api/metrics` for Cloud where Prometheus is used, and scrape Gateway
  `/metrics` with the Gateway admin token.
- Include request ids, org ids, session ids, run ids, worker ids, scheduler ids,
  and gateway delivery ids.
- Redact BYOK keys, API tokens, cookies, OAuth tokens, webhook secrets,
  database URLs, object-store signed URLs, and local paths.
- Keep deployable metric, dashboard, and alert assets under
  `deploy/observability/` in sync with the production SLOs.

### Backups/Restore

- Back up Postgres and object storage on the same retention policy.
- Restore Postgres first, then object-store artifacts/checkpoints for the same
  point in time.
- Start web with workers at zero, verify projections and session lists, start
  one worker, run a smoke prompt, then start scheduler and gateway.
- Verify channel deliveries resume from durable cursors without duplicates.
- Follow `docs/runbooks/backup-restore.md` and keep the latest redacted drill
  evidence in `docs/runbooks/restore-drill-report.md` or a downstream private
  operations repository.

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
- Helm image pinning, no-`latest` policy, and multi-worker checkpoint/object
  store guardrails.
- Presence of provider recipes, this checklist, and the managed BYOK SaaS
  runbook.

## Load, Soak, And Launch Gates

Before local/self-host beta, private-beta, or public-beta rollout, define the
exact launch profile and run the load/soak harness in strict mode. The
committed target profiles are in `deploy/load/launch-readiness-targets.json`,
and the current accepted public launch tier is recorded in
`deploy/load/launch-evidence-matrix.json`:

- `local-self-host-beta` for OSS self-host and local reference deployments. This
  is the only launch tier the public repo currently claims.
- `private-beta` for design-partner and internal managed BYOK rollout.
- `public-beta` for the first broader hosted BYOK rollout.
- `enterprise-scale` for large downstream or managed org readiness after
  public-beta evidence is green.

Do not use public templates alone to claim private hosted beta, public hosted
beta, general availability, or enterprise-scale readiness. Those tiers need
environment-specific private operations evidence for load, soak, failover,
restore, security, support, and cost/SLO behavior.

Generate the planned route matrix:

```bash
OPEN_COWORK_LOAD_PROFILE=private-beta \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_STRICT=true \
pnpm deploy:load:plan
```

Run the short load gate:

```bash
OPEN_COWORK_LOAD_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_LOAD_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_PROFILE=private-beta \
pnpm deploy:load:strict
```

Run the long soak gate after the load gate is green:

```bash
OPEN_COWORK_LOAD_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_LOAD_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_LOAD_CLOUD_TOKEN=... \
OPEN_COWORK_LOAD_GATEWAY_ADMIN_TOKEN=... \
OPEN_COWORK_LOAD_BYOK_PROVIDER=anthropic \
OPEN_COWORK_LOAD_INCLUDE_MUTATIONS=true \
OPEN_COWORK_LOAD_INCLUDE_SSE=true \
OPEN_COWORK_LOAD_OPERATOR_CHECKS=true \
OPEN_COWORK_LOAD_PROFILE=private-beta \
pnpm deploy:soak:strict
```

The harness writes JSON and Markdown reports under
`.open-cowork-test/launch-readiness/` by default. Attach those reports,
dashboard evidence, cost notes, known limits, and final smoke results to
`docs/runbooks/launch-readiness-report.md` or a downstream private operations
repository. Use `pnpm deploy:launch:validate` to verify the committed gate
artifacts stay in sync.

After the ordinary load and soak gates pass with zero unexpected quota
rejections, run a deliberate quota-pressure pass with
`OPEN_COWORK_LOAD_EXPECT_QUOTA_REJECTIONS=true` and a low downstream quota
overlay. That pass should produce 429/402-style rejections without 5xx spikes,
worker crashes, or gateway delivery wedges.

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

For the GCP reference deployment, run a read-only project/API preflight before
rollout:

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_REGION=us-central1 \
pnpm deploy:gcp:preflight
```

After rollout, the GCP infra smoke can combine the Cloud Web smoke with Cloud
Storage and Secret Manager checks:

```bash
OPEN_COWORK_GCP_PROJECT=PROJECT \
OPEN_COWORK_GCP_BUCKET=OPEN_COWORK_BUCKET \
OPEN_COWORK_GCP_SECRET_REF=gcp-sm://projects/PROJECT/secrets/open-cowork-cloud-secret-key/versions/latest \
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
pnpm deploy:gcp:smoke
```

For the Desktop cloud-sync gate against the same deployed Cloud environment:

```bash
OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... \
pnpm deploy:desktop:smoke
```

This smoke uses the Desktop main-process cloud adapter and cache path, not a
separate test-only client. It validates Desktop OIDC metadata when configured, bearer-auth
HTTP/SSE, Desktop-to-Web and Web-to-Desktop session continuation, prompt/abort
routing, read-only offline cache fallback, local workspace isolation, and
ephemeral Desktop token revocation.

For the Gateway gate against the same deployed Cloud environment:

```bash
OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:gateway:smoke
```

This smoke validates both managed and self-host Gateway paths. It checks the
managed Gateway health/readiness and operator endpoint protection, creates
temporary cloud channel state, proves a gateway-scoped token cannot administer
channels or mint tokens, runs a loopback fake-provider Gateway against the
deployed Cloud URL, verifies inbound prompt routing, session SSE rendering,
approval interaction routing, async delivery, retry/dead-letter controls, and
ephemeral token revocation.

For the full Web/Desktop/Gateway continuation parity gate:

```bash
OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
pnpm deploy:continuation:smoke
```

This is the production promise gate for the synced product. It checks Cloud Web
bootstrap and request correlation, creates short-lived Web/Desktop/Gateway
tokens, proves Web-created, Desktop-created, and Gateway-created sessions can be
continued by the other surfaces, verifies durable projection parity after
reload/replay, resolves approval and question state across surfaces, checks
artifact metadata, exercises concurrent prompts on one cloud thread, validates
stale Desktop cursor hydration, verifies Gateway channel rendering, and revokes
all smoke tokens.

For operator-only readiness checks:

```bash
OPEN_COWORK_SMOKE_OPERATOR_CHECKS=true \
OPEN_COWORK_SMOKE_CLOUD_TOKEN=... \
OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:smoke
```

The smoke script validates cloud `/healthz`/`/livez`, the Cloud Web Workbench at `GET /`,
workbench CSP/bootstrap markers, cloud API bootstrap endpoint reachability,
gateway `/health`, and gateway `/ready`. Operator mode also checks cloud
runtime/heartbeat/metrics endpoints and gateway metrics when tokens are
provided.

## Provider Recipe Contract

Provider recipes under `deploy/gcp`, `deploy/aws`, `deploy/azure`, and
`deploy/digitalocean` must stay thin. They should define:

- image repository plus immutable release tag or digest,
- public HTTPS origins,
- OIDC or trusted header auth,
- Postgres control-plane URL,
- object-store adapter settings,
- secret manager/KMS references,
- worker/scheduler replica counts,
- HPA or KEDA policy, PodDisruptionBudgets, and topology spread constraints,
- gateway service token and provider signing secrets,
- OTLP/logging endpoints,
- backup/restore ownership.

They must not require changes to session, runtime, projection, gateway,
OpenCode SDK, billing, or BYOK core code.

Self-host OSS recipes must preserve a billing-free path:
`cloud.billing.enabled=false` with `cloud.billing.provider=none`, or the stub
provider when operators want visible billing states without payment-provider
dependencies. Managed SaaS billing belongs in downstream hosting overlays, not
in the self-host contract.
