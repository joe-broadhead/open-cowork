---
title: Open Cowork Cloud
description: Deploy Open Cowork Cloud as a provider-neutral web, worker, and scheduler service.
---

# Open Cowork Cloud

Open Cowork Cloud is the provider-neutral deployment shape for running the
Open Cowork product layer as a web app. It keeps the same ownership boundary
as the desktop app: OpenCode owns execution, while Open Cowork owns
composition, profiles, durable projection, workflows, and deployment policy.

The cloud entrypoint is one OCI image with role-based behavior:

| Role | Purpose | Scaling note |
| --- | --- | --- |
| `all-in-one` | Runs web, worker, and scheduler together. | Local demos, focused internal pilots, and single-process installs. |
| `web` | Serves HTTP APIs and browser SSE from durable state. | Stateless; scale horizontally behind a load balancer. |
| `worker` | Owns OpenCode execution and consumes durable session commands. | Long-running compute; scale by active-session capacity. |
| `scheduler` | Atomically claims due workflows. | Safe to run multiple replicas, though one is enough for most deployments. |

Production deployments should prefer split roles. Cloud Run-style all-in-one
deployments are useful for demos, but long-running OpenCode workers should run
on infrastructure with predictable CPU and process lifetime.

Keep worker replicas conservative unless runtime/workspace checkpointing is
enabled for your deployment. Multiple workers can claim fenced sessions, and
checkpointing externalizes the proven OpenCode runtime/XDG and workspace
portable set so a different worker can restore before resuming a session.

## Local References

Use the all-in-one reference for quick local checks:

```bash
docker compose -f docker-compose.cloud.yml up --build
```

Use the split-role reference when testing the scalable topology:

```bash
docker compose -f docker-compose.cloud.split.yml up --build
```

The split compose file starts `web`, `worker`, and `scheduler` services against
shared Postgres and MinIO. The web role writes commands only; the worker role
binds OpenCode runtime sessions and executes them.

The cloud web role serves the browser web app at `/`. It uses the same
HTTP/SSE contract as API clients: sessions are loaded from durable projections,
prompts are written as commands, and session event streams reconnect from the
last durable event sequence.

The typed `createHttpSseCloudTransportAdapter` wraps that HTTP/SSE contract for
browser clients that need a `window.coworkApi`-style transport without Electron
IPC.

For Kubernetes, use the provider-neutral Helm chart as the scalable starting
point:

```bash
helm upgrade --install open-cowork-cloud helm/open-cowork-cloud \
  --set image.repository=ghcr.io/joe-broadhead/open-cowork-cloud \
  --set cloud.profile=full \
  --set cloud.controlPlaneUrl='postgres://...' \
  --set cloud.objectStore.kind=s3 \
  --set cloud.objectStore.bucket='open-cowork'
```

Use `cloud.existingSecret` in production so database URLs, object-store
credentials, and envelope keys come from your platform secret manager rather
than from Helm values.

For workers that write runtime/workspace checkpoints, provide either
`OPEN_COWORK_CLOUD_SECRET_KEY` or `OPEN_COWORK_CLOUD_SECRET_KEY_REF`. The ref
form can point at `env:NAME`, GCP Secret Manager
(`gcp-sm://projects/{project}/secrets/{secret}/versions/{version}`), AWS
Secrets Manager (`aws-sm://{secret-id}?region={region}`), or Azure Key Vault
(`azure-kv://{vault}/secrets/{secret}/{version}`).

## Validation

The regular `pnpm test` suite covers the in-memory control-plane adapter and
skips provider infrastructure. Before shipping a scalable cloud release, run
the real Postgres concurrency gate against an isolated database:

```bash
OPEN_COWORK_TEST_POSTGRES_URL='postgres://...' pnpm test tests/cloud-postgres-concurrency.test.ts
```

That gate proves Postgres row-lock behavior for worker leases, ordered event
sequence writes, session command idempotency/reclaim, scheduler claims, and
webhook replay claims.

CI runs the same cloud gates in the `cloud-gates` job: Phase 0 OpenCode
portability proof, real Postgres concurrency tests, Compose config validation,
cloud OCI image build, split-role Compose `/healthz` smoke, and Helm
lint/render validation.

## Configuration

Set these environment variables in every role:

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_ROLE` | `all-in-one`, `web`, `worker`, or `scheduler`. |
| `OPEN_COWORK_CLOUD_PROFILE` | Deployment profile such as `full`, `focused-agent`, or `custom`. |
| `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` | Postgres connection URL for durable cloud state. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_KIND` | `filesystem`, `minio`, `s3`, `gcs`, `azure-blob`, or `digitalocean-spaces`. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET` | Bucket/container name for artifacts and snapshots. |
| `OPEN_COWORK_CLOUD_SECRET_KEY` | Envelope key for local/dev encrypted secret storage. |
| `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | Optional cloud secret-manager ref for the envelope key when the key is not injected directly. |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | HMAC key for signed browser session cookies; falls back to `OPEN_COWORK_CLOUD_SECRET_KEY` for local demos. |
| `OPEN_COWORK_CLOUD_COOKIE_SECURE` | Defaults to `true`; local HTTP compose references set it to `false`. |
| `OPEN_COWORK_CLOUD_PUBLIC_URL` | Public base URL used for OIDC callback redirect URIs behind proxies or ingress. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | Optional OIDC confidential-client secret; config `clientSecretRef` can point at a platform secret env var instead. |
| `OPEN_COWORK_CLOUD_SERVICE_NAME` | Service name included in structured logs and OTLP resource attributes. |
| `OPEN_COWORK_CLOUD_SERVICE_VERSION` | Optional version string included in structured logs and OTLP resource attributes. |
| `OPEN_COWORK_CLOUD_LOG_FORMAT` | `json`, `pretty`, or `silent`; defaults to JSON for cloud logs. |
| `OPEN_COWORK_CLOUD_OTLP_ENDPOINT` | Optional OpenTelemetry OTLP HTTP base endpoint; exports traces to `/v1/traces` and metrics to `/v1/metrics`. |
| `OPEN_COWORK_CLOUD_OTLP_HEADERS` | Optional JSON object of OTLP HTTP headers, stored as a secret when it contains collector credentials. |
| `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED` | `true` enables worker runtime/workspace checkpoints in object storage. |

Role-specific knobs:

| Variable | Roles | Meaning |
| --- | --- | --- |
| `OPEN_COWORK_CLOUD_HOST` / `OPEN_COWORK_CLOUD_PORT` | `web`, `all-in-one` | HTTP bind address. |
| `OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS` | `all-in-one` | Process queued commands inline for local/demo use. |
| `OPEN_COWORK_CLOUD_WORKER_ID` | `worker`, `all-in-one` | Stable worker identity for leases and heartbeats. |
| `OPEN_COWORK_CLOUD_WORKER_POLL_MS` | `worker`, `all-in-one` | Durable command polling interval. |
| `OPEN_COWORK_CLOUD_SCHEDULER_ID` | `scheduler`, `all-in-one` | Stable scheduler identity for heartbeats. |
| `OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS` | `scheduler`, `all-in-one` | Workflow scheduler polling interval. |

Profiles are enforced server-side and in generated OpenCode config. Cloud
profiles default to app-managed runtime config and deny arbitrary host project
directories, arbitrary local stdio MCPs, and machine-native runtime config
unless a deployer explicitly allows a controlled image or volume-backed
environment.

## Provider Mapping

Provider-specific recipes should remain thin compositions of the same image,
roles, Postgres control plane, object-store adapter, and secret adapter.

| Provider | Web | Worker/Scheduler | Control plane | Object store | Secret store |
| --- | --- | --- | --- | --- | --- |
| Kubernetes | Deployment + Service/Ingress | Deployments or jobs with HPA/KEDA as needed | Managed or in-cluster Postgres | S3-compatible, GCS, Azure Blob, or MinIO | External Secrets or sealed secrets |
| GCP | Cloud Run or GKE | GKE for production workers; Cloud Run all-in-one demo only | Cloud SQL for PostgreSQL | Cloud Storage | Secret Manager |
| AWS | ECS/Fargate or EKS | ECS services or EKS deployments | RDS PostgreSQL | S3 | Secrets Manager |
| Azure | Container Apps or AKS | Container Apps jobs/services or AKS | Azure Database for PostgreSQL | Azure Blob Storage | Key Vault |
| DigitalOcean | App Platform for demos; DOKS for scale | DOKS deployments | Managed PostgreSQL | Spaces | App Platform/DOKS secrets |

The app core should not contain provider-specific branches. Provider behavior
belongs in config, adapters, and deployment recipes.

Recipe starting points live under `deploy/gcp`, `deploy/aws`, `deploy/azure`,
and `deploy/digitalocean`. Each one maps provider services back to the same
role, Postgres, object-store, and secret-manager contract.

## Focused Agent Deployments

Use the `focused-agent` profile when a downstream wants a single-purpose cloud
app, such as a data-analyst agent. The deployer should configure:

- one allowlisted agent name,
- the minimum tool/MCP allowlist required by that agent,
- disabled custom skills, custom agents, custom MCPs, workflows, and settings
  unless the use case requires them,
- OIDC or reverse-proxy authentication before exposing the service publicly.

The web API enforces profile allowlists directly, so hiding a feature in the
browser is not the only protection.

## Operational Checks

- `GET /healthz` reports process liveness and the active cloud role/profile.
- `GET /api/runtime/status` reports the active role/profile, whether this
  process can execute runtime commands, and whether commands are handled inline
  or by durable worker polling.
- `GET /api/workers/heartbeats` exposes worker and scheduler heartbeat state
  for authenticated operators.
- Cloud HTTP requests emit structured request logs with request ids, role,
  profile, status, and duration. When `OPEN_COWORK_CLOUD_OTLP_ENDPOINT` is
  set, the same request observations are exported as OTLP HTTP traces and
  duration metrics without adding provider-specific code paths.
- Browser event streams use ordered durable events, so web replicas do not need
  sticky sessions for session replay.
- Browser sessions use signed `HttpOnly`, `SameSite=Lax` cookies and require
  `X-CSRF-Token` on mutating API calls when authenticated by cookie. Bearer
  API clients remain supported without CSRF.
- OIDC browser login is exposed through `/auth/login` and the configured
  callback path. The flow uses signed state cookies, PKCE, nonce validation,
  and the same verified identity mapping as bearer JWT auth.
- Public workflow webhooks require HMAC timestamp signatures; shared-secret
  bearer/header modes are local/demo-only.
