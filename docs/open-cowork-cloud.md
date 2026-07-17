---
title: Open Cowork Cloud
description: Deploy Open Cowork Cloud as a provider-neutral web, worker, and scheduler service.
---

# Open Cowork Cloud

Open Cowork Cloud is the provider-neutral deployment shape for running the
Open Cowork product layer as a web app. It keeps the same ownership boundary
as the desktop app: OpenCode owns execution, while Open Cowork owns
composition, profiles, durable projection, workflows, and deployment policy.

Choose a deployment topology before choosing a cloud provider. Cloud-only,
Cloud Channel Gateway, Cloud Gateway edge, and full-hybrid deployments are
defined in [Deployment Topologies](deployment-topologies.md) and the
machine-readable `deploy/topologies/topology-profiles.json` contract.
Product naming, release channels, image names, and Gateway product-mode policy
are defined in
[Packaging and Gateway Product Modes](packaging-and-product-modes.md).

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

The managed worker service plane builds on the same split-role model. It adds
explicit worker pools, worker identity, lifecycle controls, durable leases,
fencing tokens, recovery rules, quotas, and operations runbooks for
laptop-independent cloud execution. The architecture, threat model, and
operations contract are in [Managed Worker Service Plane](managed-workers.md);
public deployment templates live under `deploy/managed-workers/`.

## Workspace sync contract

The full cross-surface contract is documented in
[Product Contract](product-contract.md). Cloud implements the cloud-workspace
side of that contract.

The browser release contract and route/API matrix are documented in
[Cloud Web Workbench](cloud-web-workbench.md).

Cloud is the source of truth only for cloud workspaces. A user can start a
cloud thread in desktop, continue it in the browser, and interact with the same
thread through a gateway channel because all three clients read and write the
same cloud session, command, event, projection, artifact, workflow, settings,
and policy records.

Local desktop workspaces are separate. Cloud does not automatically ingest
local threads, host project paths, local stdio MCP commands, machine-native
runtime config, provider keys, OAuth tokens, or local-only artifacts. The cloud
worker owns OpenCode execution for cloud threads; the desktop owns OpenCode
execution for local threads; the gateway owns only channel I/O.

`workspace.support()` is the capability contract between cloud policy and
clients. It returns `supported`, `read_only`, `blocked_by_policy`,
`not_supported`, or `deferred` entries with user-facing verdict reasons. Web,
desktop, and gateway clients should use those verdicts before enabling sends,
project pickers, host-path diffs, custom content, artifacts, workflows, or
gateway interactions.

## Cloud Project Context

Cloud sessions do not read arbitrary desktop or server host paths. A cloud
thread starts with an explicit project source that the worker restores into an
isolated app-managed workspace before creating or prompting the OpenCode
session.

Supported v1 sources:

- Git source: HTTPS repository URL, optional branch/tag/commit ref, optional
  subdirectory, and optional credential ref. Credentials must be stored as
  secret references (`env:`, `gcp-sm://`, `aws-sm://`, `azure-kv://`, or
  Azure Key Vault `https://` URLs); they must not be embedded in repository
  URLs. A credential secret may be a raw access token, or JSON with
  `username` plus `password` or `token` for hosts that require a specific Git
  username.
- Uploaded snapshot: the desktop inventories a selected directory, excludes
  secret-bearing files and dependency/build output, shows file count and bytes,
  uploads the bounded snapshot to object storage, and sends only the snapshot
  reference in the session create request.

Default policy:

```json
{
  "cloud": {
    "projectSources": {
      "git": {
        "enabled": true,
        "allowedHosts": ["github.com", "gitlab.com"],
        "allowedRepositories": [],
        "allowFileUrls": false
      },
      "uploadedSnapshots": {
        "enabled": true,
        "maxFiles": 2000,
        "maxBytes": 26214400
      },
      "managedWorkspaces": {
        "enabled": false
      }
    }
  }
}
```

For GitHub Enterprise or GitLab self-managed, add the host to
`cloud.projectSources.git.allowedHosts`. To restrict tenants to approved repos,
set `allowedRepositories` to exact lowercase `host/org/repo` keys, for example
`git.internal.example/platform/api`.

Deployments that cannot allow local uploads should set:

```json
{
  "cloud": {
    "projectSources": {
      "uploadedSnapshots": { "enabled": false }
    }
  }
}
```

Managed workspace checkpointing is the v2 path for long-running or scheduled
cloud work. Enable it only with object storage and checkpoint encryption
configured:

```json
{
  "cloud": {
    "projectSources": {
      "managedWorkspaces": { "enabled": true }
    }
  }
}
```

Headless gateway agents can define a default project source on a channel
binding via `settings.defaultProjectSource`, or through a profile-level
`defaultProjectSource`. The gateway passes the binding to cloud; cloud workers
still own restore and execution.

## Local References

Use the all-in-one reference for quick local checks:

```bash
docker compose -f docker-compose.cloud.yml up --build
```

Use the Cloud Channel Gateway appliance references when a user should talk to
Cloud from a headless channel:

```bash
docker compose -f docker-compose.gateway-remote.yml up --build
docker compose -f docker-compose.cloud-gateway.yml up --build
```

The remote Cloud Channel Gateway compose file connects to an existing Cloud URL
and binds loopback by default. The Cloud + Gateway compose file runs a local
all-in-one Cloud control plane, Postgres, MinIO, and Cloud Channel Gateway on
one host. See
`docs/gateway-appliance.md` for VPS, Mac mini, Raspberry Pi, systemd, launchd,
Telegram webhook, TLS, firewall, upgrade, and rollback guidance.
Provider launch tiers and contract tests are tracked in
`docs/gateway-provider-readiness.md`.

Use the split-role reference when testing the scalable topology:

```bash
docker compose -f docker-compose.cloud.split.yml up --build
```

The split compose file starts `web`, `worker`, and `scheduler` services against
shared Postgres and MinIO. The web role writes commands only; the worker role
binds OpenCode runtime sessions and executes them.

All Compose references are local/demo manifests. They use local builds,
loopback HTTP URLs, local Postgres/MinIO credentials, and explicit insecure
auth overrides. For production, move to Helm or a downstream private Compose
overlay that pins `OPEN_COWORK_CLOUD_IMAGE` and `OPEN_COWORK_GATEWAY_IMAGE` to
release tags or digests, replaces every demo secret, uses HTTPS origins, and
backs checkpoints with provider object storage.

The cloud web role serves the browser web app at `/`. It uses the same
HTTP/SSE contract as API clients: sessions are loaded from durable projections,
prompts are written as commands, and session event streams reconnect from the
last durable event sequence.

The workspace `@open-cowork/cloud-client` package provides the typed
`createHttpSseCloudTransportAdapter` for clients built from this repo that need
HTTP/SSE Cloud transport without Electron IPC.

## Cloud Web Workbench

The cloud web role serves the Cloud Web Workbench at `/`. The workbench is an
API client for the same cloud control plane used by desktop sync and gateway
clients; it does not access Postgres or secret storage directly.

The browser app is the unified Open Cowork renderer (`packages/app/src`)
— the same UI that runs on Electron Desktop. In the browser it runs against a
typed `CoworkAPI` shim (`packages/app/src/browser/cowork-api.ts`)
backed by the cloud HTTP + SSE API, and is served as a hashed-asset SPA under
the server's CSP nonce and cookie-auth path. There is no separate Cloud Web
codebase: the cloud serves the renderer's browser build
(`packages/app/dist-browser`, produced by `pnpm cloud:build` and served from
`apps/desktop/dist/cloud/browser-renderer`), so Desktop and
Cloud Web cannot drift.

The information architecture is split into two surfaces:

- Workbench: Projects, Chat, Team, Tools & Skills, Playbooks, Knowledge, Channels, and Artifacts.
- Admin: Org, Members, Profiles & Policy, BYOK, Connections, Billing, Gateway,
  Audit, Usage, and Diagnostics.

The Projects and Chat panels are the first interactive workbench surfaces:

- `GET /api/sessions` loads the user-scoped durable session list. It accepts
  `limit`, opaque `cursor`, `status`, `profileName`, and text query via `q` or
  `query`, and returns `sessions`, `nextCursor`, and `totalEstimate` so large
  orgs never require unbounded list scans.
- `GET /api/sessions/:id/view` hydrates the selected thread from its durable
  projection and shared `SessionView`.
- `POST /api/sessions` creates a browser-origin cloud thread with a chat-only,
  allowed Git, or uploaded snapshot project source.
- `POST /api/sessions/:id/prompt` sends browser prompts through the same durable
  command path used by desktop sync and gateway clients.
- `GET /api/sessions/:id/events` and `GET /api/events` keep the selected thread
  and thread list live through SSE, resuming from durable event sequences after
  reconnect.
- Operator-only `GET /api/sessions/:id/projection-status` and
  `POST /api/sessions/:id/projection-repair` expose projection lag and replay
  repair from the durable event log.

The Chat panel renders the full cloud runtime projection contract rather than a
minimal message list. It includes user and assistant messages, streaming-safe
assistant snapshots, task runs, compact tool traces, pending and resolved
permission approvals, pending and resolved questions, artifacts, todos, cost and
token totals, context/compaction state, and categorized errors. Browser approval
and question actions call the same durable command routes used by desktop and
gateway clients:

- `POST /api/sessions/:id/permission-respond`
- `POST /api/sessions/:id/question-reply`
- `POST /api/sessions/:id/question-reject`

Artifact metadata is listed from the durable projection and
`GET /api/sessions/:id/artifacts`. Artifact bodies are fetched only for explicit
View or Download actions through `GET /api/sessions/:id/artifacts/:artifactId`;
the browser does not keep artifact bodies, signed object-store URLs, bucket
names, or object keys in long-lived state.

The rest of the Workbench uses the same cloud API contract:

- Team (coworkers) is derived from the current profile's allowed agent list plus
  the cloud-safe tool and skill catalog. Starting a coworker creates a cloud
  project chat and pins that agent into the composer; execution still flows
  through the cloud worker and OpenCode runtime.
- Tools & Skills browse `/api/capabilities`, including source, scope, agent
  relationships, and policy notes. The browser renders cloud-safe metadata
  only; custom content that is synced but disabled by profile policy is shown as
  unavailable rather than exposed with local process details or secrets.
- Playbooks use `/api/workflows` for durable definitions and run history,
  `POST /api/workflows/:id/run` for manual runs, and the pause/resume/archive
  routes for lifecycle changes. Manual runs can open the generated run chat so
  users can inspect the same projection shown in Chat.
- Artifacts includes a selected-chat browser plus selected-chat history from
  the hydrated durable projection. Cross-chat artifact browsing remains
  deferred until Cloud exposes a durable artifact index API. Artifact bodies are
  still fetched only on explicit user action.

Thread list filtering is client-side over the current durable session snapshot:
search text, status, profile, project kind, and tag/smart-filter metadata are
supported. The browser paginates large org thread lists in fixed batches so a
thousands-sized session list remains responsive without changing the cloud API.

Browser-created project context is explicit and policy checked. A Git source is
validated by `/api/project-sources/validate`; an uploaded snapshot is first
stored through `/api/project-sources/snapshots`, then referenced by session
creation. The browser never receives or sends local desktop host paths,
machine-native OpenCode config, local stdio MCP process details, or local
provider secrets unless the user explicitly uploads bounded project files as a
cloud snapshot.

Continuation is intentionally symmetric: a thread created by desktop sync or a
gateway channel is just a cloud session and can be opened in the browser; a
thread created in the browser appears to desktop and gateway clients through the
same session list, projection, and SSE contracts.

### Cloud Web Workbench readiness gates

The browser workbench has its own release gates because `/livez` only proves
the server is alive. Cloud Web is the browser build of the desktop renderer, so
its UI is covered by the renderer suite, while the cloud control-plane behavior
is covered by the cloud HTTP and continuation suites. Run these before provider
rollout and keep them in CI:

```bash
pnpm test:renderer
pnpm test:cloud-continuation
pnpm cloud:smoke
```

The renderer suite exercises the actual UI — signed-out, member, and admin
states; thread create/prompt/continue, SSE refresh, approval/question, artifact,
workflow, BYOK, gateway, billing, and diagnostics flows; policy/quota/billing
blocked states — together with labelled controls, keyboard-reachable navigation,
focus management, active route state, reduced-motion CSS, responsive layout, and
contrast. The cloud suites verify large thread/capability fixtures, bounded
pagination, cursor validation, and SSE reconnect against the real cloud API, and
`pnpm cloud:smoke` builds the production cloud bundle (including the browser
renderer) and runs an import smoke so the served `GET /` keeps shipping.

Signed-in member users can open the workbench and read allowed org/policy/usage
state. Admin-only panels are hidden for members and all admin mutations remain
server-authorized. Disabled controls in the browser are an ergonomic layer only.

Authenticated users land on an org-scoped dashboard backed by
`GET /api/workspace`. That request also performs the configured first-login org
bootstrap path. The workbench also bootstraps public deployment metadata from
`GET /api/config`; both bootstrap responses are metadata-only and must not
contain provider keys, OAuth tokens, API tokens, MCP secrets, or local host
paths. Admin panels expose:

- member and invite operations through `/api/admin/members`, with owner/admin
  RBAC enforced by the API and destructive member disable/revoke actions
  requiring explicit confirmation,
- runtime profile, feature, project-source, signup-mode, and gateway policy
  visibility through `/api/admin/policy`,
- a queryable, exportable audit log through `/api/admin/audit`, gated on the
  `audit:read` permission (owner/admin by default). The control plane audits both
  control-plane actions (members, roles, policy, worker credentials) and
  data-plane actions (session create/import/abort, command prompt/abort/
  permission-respond, artifact upload/download, and worker lease claims). The
  query accepts `actorId`, `actorType`, `action` (event-type prefix),
  `targetType`, `targetId`, `result`, `from`/`to`, and a stable keyset `cursor`
  (page sizes are bounded). `/api/admin/audit/export?format=json|csv` streams a
  deterministic, redacted-by-default export (secrets are scrubbed at write time;
  local filesystem paths are scrubbed at export time); `unredacted=true` is an
  org-admin-only mode whose disclosure is itself recorded as an `audit.exported`
  event. Audit events also emit an `open_cowork_cloud_audit_events_total` metric
  so operators can alert on audit volume without scraping logs. Retention reuses
  the event-retention scheduler and is off by default
  (`OPEN_COWORK_CLOUD_RETENTION_AUDIT_EVENT_MS`), so no event is ever dropped
  before an explicitly configured window,
- per-org enterprise SSO (SAML 2.0 + OIDC) and SCIM 2.0 provisioning through
  `/api/admin/sso` (config CRUD gated on the `sso:manage` permission) and the
  `/scim/v2` endpoints (authenticated by a per-org SCIM bearer token). IdP secrets
  (SAML certificate, OIDC client secret) and the SCIM token are stored encrypted
  with the existing envelope key (`OPEN_COWORK_CLOUD_SECRET_KEY`) — never plaintext.
  SSO config supports an SSO-only enforcement toggle, and SCIM deprovisioning
  suspends the membership and revokes the member's credentials immediately. A
  durable, store-backed sync-event queue retries with backoff and periodically
  reconciles directory ↔ membership drift. This feature adds **no new environment
  variables** — it is configured entirely per-org through the admin API. See the
  [SSO and SCIM setup runbook](runbooks/sso-scim-setup.md) for IdP-specific wiring
  (Okta, Microsoft Entra ID, Google Workspace),
- BYOK provider status, plaintext key rotation, and KMS reference submission
  through metadata-only BYOK APIs,
- one-time API token issuance and revocation for desktop and gateway clients,
- headless gateway agent/channel setup through channel binding APIs, plus
  delivery backlog retry/dead-letter controls for admins,
- billing subscription, plan entitlement, checkout, and portal actions when
  billing is enabled,
- recent usage event summaries and current quota windows through
  `/api/usage/summary`,
- redacted support diagnostics through `/api/diagnostics` for org admins and
  admin-scoped API tokens.

Role and policy decisions are enforced by the cloud APIs. The dashboard mirrors
those decisions by disabling admin-only actions for member users, but disabled
controls are only an ergonomic layer, not the authorization boundary. Token
plaintext is shown only in the create response, and raw provider keys are never
returned by read APIs.

The diagnostics bundle is intentionally a support artifact, not a secret export.
It includes runtime role, billing mode, BYOK provider metadata, quota summaries,
recent sampled gateway counters, and recent usage totals, but excludes raw
provider keys, KMS refs, OAuth/API tokens, signed URLs, channel credentials,
cookies, and local host paths.

Self-hosted deployments can run with the stub/no billing adapter. In that mode
the dashboard keeps the billing panel non-blocking while BYOK, desktop token,
gateway token, and usage surfaces remain available.

Downstream deployments can brand the public cloud surface through
`cloud.publicBranding` or the Helm `cloud.branding` block. The same structure
controls the dashboard product name, logo URL, theme tokens, support/privacy/
security/legal links, dashboard copy, and managed-org connection labels. The
cloud API also returns this metadata from `GET /api/config` so desktop and
gateway clients can show the same deployer identity.

## Generic Docker: Cloud + Gateway

Use the combined self-host reference when validating the browser dashboard,
desktop token flow, and headless gateway together:

```bash
docker compose -f docker-compose.cloud-gateway.yml up --build
```

That file starts:

- Open Cowork Cloud in `all-in-one` mode on <http://localhost:8787>,
- Postgres for the control plane,
- MinIO for artifacts and checkpoints,
- Open Cowork Gateway on <http://localhost:8790>.

The gateway requires at least one real provider by default. Telegram, Slack,
email, and generic webhook providers can run together in one gateway process, or
you can deploy one gateway per channel binding for tighter blast-radius control.
For local-only smoke tests without real channel credentials, opt into the fake
provider explicitly:

```bash
OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true \
  docker compose -f docker-compose.cloud-gateway.yml up --build
```

Do not expose the fake provider publicly. Real public deployments should
configure Telegram, Slack, email, or a signed webhook provider instead. For a
real self-hosted gateway:

1. Open the dashboard at <http://localhost:8787>.
2. Configure BYOK provider credentials if your profile requires them.
3. Create a scoped gateway API token from the dashboard.
4. Create a headless agent and channel binding.
5. Restart the gateway with `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` set to that
   one-time token and provider credentials such as
   `OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN`,
   `OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN`, or
   `OPEN_COWORK_GATEWAY_EMAIL_INBOUND_SECRET`.
6. Set `OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel` for clarity. The
   current daemon fails closed for `standalone` and `hybrid` product modes.
7. Set `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` for metrics, diagnostics, readiness
   provider inventory, and delivery backlog controls. Only local loopback demos
   should use `OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS=true`.
   Compose references require this value explicitly and the gateway rejects
   placeholder tokens such as `change-me-*` or `replace-with-*`.

Provider requirements:

- **Telegram** can run polling for a private VPS or webhook mode when
  `OPEN_COWORK_GATEWAY_PUBLIC_URL` is reachable by Telegram.
- **Slack** requires `OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN` and
  `OPEN_COWORK_GATEWAY_SLACK_SIGNING_SECRET`; incoming requests are rejected
  unless Slack's timestamp/signature check passes.
- **Email** requires an inbound webhook shared secret plus SMTP settings. Email
  preserves `In-Reply-To` / `References` thread IDs and uses command-token
  approval fallback rather than inline buttons.
- **Webhook** requires a shared secret for public ingress and outbound bridge
  signing. Outbound bridge delivery is signed with timestamped HMAC headers by
  default; receivers should verify the raw body and reject stale timestamps.

For local demos the cloud compose file uses `auth.mode=none` and explicit
insecure overrides. Public deployments must use OIDC or a trusted identity
proxy for the cloud web role and a real gateway service token.

Gateway health endpoints:

- `GET /health` reports process liveness.
- `GET /ready` reports provider readiness.
- `GET /metrics` exposes Prometheus metrics when enabled. Public binds require
  `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`; local loopback bypass must be explicit and
  only applies when the bind host, socket peer, and `Host` header are loopback
  with no forwarded headers.
- `GET /diagnostics` returns redacted gateway config, provider state, and
  counters for support. It requires the same admin token unless explicit local
  loopback bypass is enabled.
- `GET /deliveries` lists recent delivery backlog rows for operators.
- `POST /deliveries/:id/retry` schedules a failed/dead delivery for retry.
- `POST /deliveries/:id/dead-letter` marks a poison delivery as dead. These
  delivery controls require the same gateway admin token.

The gateway image is separate from the cloud image because it owns channel
secrets, long-polling or webhook connections, and a different scaling profile.
It does not import the OpenCode SDK and does not own control-plane Postgres
state.
Gateway stream state is process-local today, so run one replica per
channel-binding shard. For production, deploy one Gateway release per shard
with `replicaCount: 1`. The Helm chart fails closed for `replicaCount > 1`
unless `gateway.experimentalDistributedOwnership=true` is set explicitly for an
experimental deployment; that flag is a lab escape hatch, not a production
distributed-ownership implementation.

For Kubernetes, use the provider-neutral Helm chart as the scalable starting
point:

```bash
helm upgrade --install open-cowork-cloud helm/open-cowork-cloud \
  --set image.repository=ghcr.io/joe-broadhead/open-cowork-cloud \
  --set image.digest=sha256:REPLACE_WITH_CLOUD_DIGEST \
  --set cloud.deploymentTier=public_production \
  --set cloud.profile=full \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl='https://issuer.example.com' \
  --set cloud.auth.oidcClientId='open-cowork-cloud' \
  --set cloud.existingSecret=open-cowork-cloud-secrets \
  --set cloud.objectStore.kind=s3 \
  --set cloud.objectStore.bucket='open-cowork' \
  --set roles.worker.enabled=true \
  --set roles.scheduler.enabled=true
```

Use `cloud.existingSecret` in production so database URLs, object-store
credentials, and envelope keys come from your platform secret manager rather
than from Helm values. Public production chart installs reject inline
secret-bearing values such as `cloud.controlPlaneUrl`, cookie secrets, header
auth secrets, object-store credentials, and OIDC client secrets. The external
secret must provide the runtime environment keys the chart reads, such as
`OPEN_COWORK_CLOUD_CONTROL_PLANE_URL`, `OPEN_COWORK_CLOUD_SECRET_KEY_REF`,
`OPEN_COWORK_CLOUD_COOKIE_SECRET_REF`, and object-store credential keys. Use
managed refs such as
`azure-kv://prod-vault/secrets/open-cowork-secret-key/current` for envelope,
cookie, header, and OIDC client secrets where the runtime supports them.

Install the gateway chart next to cloud when you want channel access:

```bash
helm upgrade --install open-cowork-gateway helm/open-cowork-gateway \
  --set image.repository=ghcr.io/joe-broadhead/open-cowork-gateway \
  --set gateway.cloudBaseUrl='https://cowork.example.com' \
  --set gateway.existingSecret=open-cowork-gateway-secrets
```

For production, set `gateway.existingSecret` and inject
`OPEN_COWORK_GATEWAY_SERVICE_TOKEN`, `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`,
`OPEN_COWORK_GATEWAY_PROVIDERS`, and provider-specific credentials through
External Secrets, sealed secrets, or the platform secret manager. The cloud
chart also exposes the gateway as an optional dependency under
`gateway.enabled=true` for installations that prefer one parent release.

The chart fails closed when `cloud.auth.mode=none` is used without
`cloud.allowInsecureAuth=true`. Keep that override for local demos only; use
`oidc` or a trusted `header` identity proxy for shared clusters.
Public `header` auth deployments must also set
`OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` or
`OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF`; the proxy must inject that value
and sign the identity headers with `x-open-cowork-header-auth-timestamp` and
`x-open-cowork-header-auth-signature`. Unsigned header auth is local/demo only.
Public web deployments, including trusted-header deployments, must set
`OPEN_COWORK_CLOUD_PUBLIC_URL` to the canonical HTTPS origin so redirects,
cookies, and proxy handling never depend on forwarded headers from untrusted
callers.
The gateway chart also fails closed unless at least one provider is configured
through `gateway.providersJson`, Telegram, Slack, email, generic webhook
settings, or an existing secret.
It also fails closed when `replicaCount > 1` without
`gateway.experimentalDistributedOwnership=true`, when operator auth is missing,
when public URLs are not HTTPS, when public deployments use inline
secret-bearing Helm values without `gateway.existingSecret`, when loopback
operator bypass is combined with public exposure, when placeholder secrets are
still present, or when generic webhook ingress is configured without a shared
secret.

Kubernetes public production deployments force NetworkPolicy egress isolation.
For Cloud, `cloud.deploymentTier=public_production` renders an Egress policy
even when `networkPolicy.egress.enabled=false`; for Gateway, public exposure
does the same. Public Cloud and public Gateway renders also fail when
`networkPolicy.ingress.from` is empty, because Kubernetes treats an ingress rule
without `from` as all sources. Production overlays should name the ingress
controller or private caller explicitly:

```yaml
networkPolicy:
  ingress:
    allowAllSourcesForLocalOnly: false
    from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: ingress-nginx
        podSelector:
          matchLabels:
            app.kubernetes.io/name: ingress-nginx
```

For private/internal topologies, use the namespace and pod labels for the
Gateway release, service mesh, or internal workload that is allowed to call the
service. Cloud L7 controllers without in-cluster pods should use
provider-approved `ipBlock` peers in a private overlay. An empty egress
allowlist renders `egress: []`. Add one `networkPolicy.egress.allow[]` entry per
approved dependency, with explicit `to` peers and `ports`, when the cluster
needs outbound access to Cloud, object-store, identity, provider API, or
telemetry endpoints.

The Helm chart uses an ephemeral worker runtime root by default. That is the
scalable path: workers externalize durable session state through Postgres and
object-store checkpoints. A single-worker PVC can be enabled for controlled
pilots, but the chart rejects `roles.worker.persistence.enabled=true` with more
than one worker replica because a shared ReadWriteOnce runtime volume is not a
horizontal scaling model.

For workers that write runtime/workspace checkpoints, provide
`OPEN_COWORK_CLOUD_SECRET_KEY_REF` from a provider secret manager in hosted
production. `OPEN_COWORK_CLOUD_SECRET_KEY` is accepted for local/self-host
pilots but production startup rejects weak or demo key material. The ref form
can point at `env:NAME`, GCP Secret Manager
(`gcp-sm://projects/{project}/secrets/{secret}/versions/{version}`), AWS
Secrets Manager (`aws-sm://{secret-id}?region={region}`), or Azure Key Vault
(`azure-kv://{vault}/secrets/{secret}/{version}`).

## Production Readiness

Before exposing cloud or gateway publicly, use the deployment checklist in
`deployment-readiness.md`. It covers auth, cookie secrets, Postgres, object
storage, secret adapter/KMS references, public HTTPS origins, worker/scheduler
scaling, gateway service tokens, provider webhook signing, quotas/rate limits,
OTLP/logging, backups, and restore.

Managed BYOK operators should also follow `runbooks/managed-byok-saas.md`.
That runbook covers org signup mode, token TTLs, invite/domain controls,
billing setup, BYOK validation, gateway operations, and incident response.
Managed worker operators should use `deploy/managed-workers/` for worker pool
environment templates, Helm overlays, release evidence, and restore drill
templates.

Run deployment manifest validation before rollout:

```bash
pnpm deploy:validate
```

Smoke a running deployment after traffic is routed:

```bash
OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
pnpm deploy:smoke
```

Validate the Desktop cloud-workspace path against that deployment before
calling desktop sync production-ready:

```bash
OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN=... \
pnpm deploy:desktop:smoke
```

The Desktop smoke uses the Electron main-process cloud adapter/cache code,
issues a short-lived Desktop token when an admin token is provided, validates
Desktop OIDC metadata when configured, exercises bearer-auth HTTP/SSE, checks Desktop-created
and Web-created session continuation, verifies prompt/abort routing, confirms
read-only offline cache behavior, proves the local workspace remains
independent, and revokes the ephemeral token.

Validate the Gateway deployment path before calling channel access
production-ready:

```bash
OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:gateway:smoke
```

The Gateway smoke checks managed Gateway health/readiness and public operator
endpoint protection, then runs a loopback self-host Gateway process with a fake
provider against the deployed Cloud control plane. It issues and revokes a
short-lived gateway-scoped service token, creates temporary channel state,
proves least privilege, sends an inbound channel prompt, waits for session SSE
rendering, routes an approval interaction, drains an async delivery, and
exercises retry/dead-letter controls.

Run the continuation parity smoke after Cloud Web, Desktop sync, and Gateway
smokes pass:

```bash
OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
pnpm deploy:continuation:smoke
```

This #498 gate creates one deployment-level proof for the three-surface product
promise: Cloud Web API, Desktop cloud workspace adapter, and Gateway channel
adapter all continue the same tenant-scoped cloud sessions through durable
commands, events, and projections. It also validates request-id correlation,
permission/question resolution, artifact metadata, concurrent prompt ordering,
stale cursor hydration, Gateway rendering, and smoke-token revocation.

## Validation

The regular `pnpm test` suite covers the in-memory control-plane adapter and
skips provider infrastructure. Before shipping a scalable cloud release, run
the real Postgres concurrency gate against an isolated database:

Run the cloud continuation harness whenever touching desktop sync, cloud
session projection, or gateway channel APIs:

```bash
pnpm test:cloud-continuation
```

That harness starts an in-process cloud, authenticates desktop, web, and
gateway clients with bearer tokens, verifies SSE replay, proves approval and
question resolution across all surfaces, and checks restart/offline desktop
hydration from durable cloud projections.

Run `pnpm deploy:continuation:smoke` against local Compose or a deployed cloud
environment before calling Web/Desktop/Gateway sync production-ready.

```bash
OPEN_COWORK_TEST_POSTGRES_URL='postgres://...' pnpm test tests/cloud-postgres-concurrency.test.ts
```

That gate proves Postgres row-lock behavior for worker leases, ordered event
sequence writes, session command idempotency/reclaim, scheduler claims, and
webhook replay claims. It also covers quota counter concurrency for prompt
windows, concurrent session caps, and active worker caps when
`OPEN_COWORK_TEST_POSTGRES_URL` is set.

CI runs the same cloud gates in the `cloud-gates` job: OpenCode portability
proof, real Postgres concurrency tests, Compose config validation, cloud OCI
image build, Cloud Web Workbench readiness gates, split-role Compose
workbench/API smoke, and Helm lint/render validation.

## Configuration

Set these environment variables in every role:

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_ROLE` | `all-in-one`, `web`, `worker`, or `scheduler`. |
| `OPEN_COWORK_CLOUD_PROFILE` | Deployment profile such as `full`, `focused-agent`, or `custom`. |
| `OPEN_COWORK_CLOUD_CONTROL_PLANE_URL` | Postgres connection URL for durable cloud state. |
| `OPEN_COWORK_CLOUD_PG_POOL_MAX` | Max Postgres pool connections (default 10). The control plane saturates here first under load — size against your Postgres `max_connections` and replica count. |
| `OPEN_COWORK_CLOUD_PG_STATEMENT_TIMEOUT_MS` | Per-statement timeout (default 30000); a non-zero default bounds an unbounded read from pinning a connection. DDL/migrations are exempt. |
| `OPEN_COWORK_CLOUD_PG_IDLE_TX_TIMEOUT_MS` | `idle_in_transaction_session_timeout` (default 120000) so an abandoned transaction can't hold a connection forever. |
| `OPEN_COWORK_CLOUD_PG_CONNECTION_TIMEOUT_MS` / `OPEN_COWORK_CLOUD_PG_IDLE_TIMEOUT_MS` | Pool connect timeout and idle-connection eviction window. |
| `OPEN_COWORK_CLOUD_PG_APP_NAME` | `application_name` set on each connection for Postgres-side observability. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_KIND` | `filesystem`, `minio`, `s3`, `gcs`, `azure-blob`, or `digitalocean-spaces`. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET` | Bucket/container name for artifacts and snapshots. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_ENDPOINT` | Custom endpoint URL (MinIO / S3-compatible / DigitalOcean Spaces). |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_REGION` | Region for the S3/Spaces backend. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_PREFIX` | Optional key prefix namespacing all objects. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_ACCESS_KEY_ID` / `OPEN_COWORK_CLOUD_OBJECT_STORE_SECRET_ACCESS_KEY` / `OPEN_COWORK_CLOUD_OBJECT_STORE_SESSION_TOKEN` | S3/MinIO/Spaces static credentials (session token optional for STS). |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_ACCOUNT_NAME` / `OPEN_COWORK_CLOUD_OBJECT_STORE_SAS_TOKEN` | Azure Blob account name + SAS token. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_BEARER_TOKEN` | GCS OAuth bearer token (when not using ambient ADC). |
| `OPEN_COWORK_CLOUD_SECRET_KEY` | Envelope key for local/dev encrypted secret storage. |
| `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | Optional cloud secret-manager ref for the envelope key when the key is not injected directly. |
| `OPEN_COWORK_CLOUD_SECRET_KEY_PREVIOUS` / `OPEN_COWORK_CLOUD_SECRET_KEY_PREVIOUS_REF` | Comma-separated retired envelope keys (raw values or secret-manager refs) kept in the decrypt keyring for rotation. New writes always use the current key and stamp its key id; already-stored ciphertexts decrypt with the matching retired key. Re-encrypt and drop the old key once migration completes. |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | HMAC key for signed browser session cookies (minimum **32 bytes**, same floor as envelope secret keys). Falls back to `OPEN_COWORK_CLOUD_SECRET_KEY` for local demos only — public production requires a distinct cookie secret. |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET_REF` | Optional env secret ref for the cookie signing key when it is managed outside chart values. |
| `OPEN_COWORK_CLOUD_COOKIE_SECURE` | Defaults to `true`; local HTTP compose references set it to `false`. |
| `OPEN_COWORK_CLOUD_PUBLIC_URL` | Public base URL used for OIDC callback redirect URIs behind proxies or ingress. Must be set to the canonical `https://` origin for any HTTPS-fronted deployment so HSTS is emitted (see Cloud advanced / tuning). |
| `OPEN_COWORK_CLOUD_PUBLISHED_ADDR` | Docker compose host-side bind address for local/demo references. Defaults to `127.0.0.1`; when `OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH=true`, non-loopback values fail startup. |
| `OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON` | JSON object matching `cloud.publicBranding`; Helm renders this from `cloud.branding`. |
| `OPEN_COWORK_CLOUD_BRAND_NAME` / `OPEN_COWORK_CLOUD_BRAND_SHORT_NAME` | Simple env overrides for the dashboard product name and short mark. |
| `OPEN_COWORK_CLOUD_BRAND_LOGO_URL` | HTTPS logo URL for the browser dashboard. |
| `OPEN_COWORK_CLOUD_SUPPORT_URL` / `OPEN_COWORK_CLOUD_PRIVACY_URL` / `OPEN_COWORK_CLOUD_SECURITY_URL` / `OPEN_COWORK_CLOUD_LEGAL_URL` | Optional public footer links. |
| `OPEN_COWORK_CLOUD_AUTH_MODE` | `none` for loopback/local demos, `header` for a trusted identity proxy, or `oidc` for public browser/JWT auth. |
| `OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH` | Explicit local/demo override for unauthenticated Cloud demos. It only starts when the published address and public URL are loopback-local; use `oidc` or `header` auth before exposing Cloud beyond localhost. |
| `OPEN_COWORK_CLOUD_OIDC_ISSUER_URL` | HTTPS OIDC issuer used for discovery and JWT verification. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_ID` | OIDC audience/client id expected in browser login and bearer tokens. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | Optional OIDC confidential-client secret; config `clientSecretRef` can point at a platform secret env var instead. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF` | Optional env secret ref for the OIDC client secret. |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` | Internal-only token for operational endpoints such as scheduler tick probes. Keep it in a platform secret store. |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF` | Optional env secret ref for the internal operational token. |
| `OPEN_COWORK_CLOUD_OIDC_CALLBACK_PATH` | OIDC callback path; defaults to `/auth/callback`. |
| `OPEN_COWORK_CLOUD_SIGNUP_MODE` | Optional explicit org signup mode: `disabled`, `invite`, `domain`, or `open`. `invite` permits admin-created invited memberships; `domain` uses `OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS`; `disabled` allows only existing active memberships. Invalid values fail startup validation. |
| `OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS` | Optional comma-separated email domain allowlist for OIDC identities. |
| `OPEN_COWORK_CLOUD_ORG_MODE` | Deployment topology: `multi-org` (default) preserves multi-tenant behaviour; `single-org` funnels every principal into one auto-bootstrapped org and skips tenant switching, for single-tenant self-host installs. |
| `OPEN_COWORK_CLOUD_SINGLE_ORG_ID` | Org/tenant id used as the single org when `OPEN_COWORK_CLOUD_ORG_MODE=single-org` (default `default`). Ignored in `multi-org` mode. |
| `OPEN_COWORK_CLOUD_SINGLE_ORG_NAME` | Display name for the single org in `single-org` mode (default `Default Organization`). Ignored in `multi-org` mode. |
| `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` / `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF` | Required for public `header` auth; trusted proxies must provide the same value in `x-open-cowork-header-auth-secret`. |
| `OPEN_COWORK_CLOUD_HEADER_AUTH_ALLOW_UNSIGNED` | Local/demo escape hatch only. Public and `public_production` trusted-header deployments require signed headers. |
| `OPEN_COWORK_CLOUD_HEADER_AUTH_MAX_SIGNATURE_AGE_MS` | Maximum accepted trusted-header signature age. Defaults to five minutes. |
| `OPEN_COWORK_CLOUD_ALLOW_SELF_SERVICE_SIGNUP` | Explicitly allows first-login OIDC org membership creation. Keep disabled for invite-only managed deployments. |
| `OPEN_COWORK_CLOUD_API_TOKEN_DEFAULT_TTL_MS` / `OPEN_COWORK_CLOUD_API_TOKEN_MAX_TTL_MS` | Default and maximum TTLs for desktop/gateway API tokens. Defaults are 90 days and 365 days. |
| `OPEN_COWORK_CLOUD_API_TOKEN_ALLOWED_SCOPES` | Comma-separated API token scopes operators allow admins to mint. Defaults to `desktop,gateway,admin,operator`; `worker-internal` is reserved for managed worker credential flows. |
| `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS` | Allows `Forwarded`/`x-forwarded-for` for rate-limit attribution only when the request socket is in `OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS`; if both headers are present they must resolve to the same client or the socket address is used. |
| `OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS` | Comma-separated CIDR/address allowlist for trusted reverse proxies whose forwarded client headers may be used. Leave empty unless `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS=true`. |
| `OPEN_COWORK_CLOUD_SERVICE_NAME` | Service name included in structured logs and OTLP resource attributes. |
| `OPEN_COWORK_CLOUD_SERVICE_VERSION` | Optional version string included in structured logs and OTLP resource attributes. |
| `OPEN_COWORK_CLOUD_LOG_FORMAT` | `json`, `pretty`, or `silent`; defaults to JSON for cloud logs. |
| `OPEN_COWORK_CLOUD_OTLP_ENDPOINT` | Optional OpenTelemetry OTLP HTTP base endpoint; exports traces to `/v1/traces` and metrics to `/v1/metrics`. |
| `OPEN_COWORK_CLOUD_OTLP_HEADERS` | Optional JSON object of OTLP HTTP headers, stored as a secret when it contains collector credentials. |
| `OPEN_COWORK_CLOUD_OTLP_FLUSH_INTERVAL_MS` | Optional non-negative OTLP export interval in milliseconds; defaults to `30000`; `0` disables the timer and relies on explicit flush/close. |
| `OPEN_COWORK_CLOUD_OTLP_MAX_QUEUE_SIZE` | Optional positive maximum queued spans and metrics per OTLP record type before oldest records are dropped and counted; defaults to `1000`. |
| `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED` | `true` enables worker runtime/workspace checkpoints in object storage. |

Data-retention variables (scheduler/all-in-one roles). The scheduler runs a bounded, batched
retention sweep no more than once per `OPEN_COWORK_CLOUD_RETENTION_INTERVAL_MS`. Every window is in
milliseconds and deletes rows older than the window, oldest-first; a window of `0`/unset disables
that prune (the scheduler does nothing destructive until you opt in).

**Public production (JOE-841 / JOE-835):** `OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=public_production`
**fails closed** unless both `OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS` and
`OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS` are set to positive values. Local and
self-host tiers may leave event retention off, but unbounded `cloud_session_events` /
`cloud_workspace_events` growth will hurt SSE replay latency, backup size, and cost — set
windows as soon as a tenant is non-demo.

Recommended production starting points (adjust to compliance policy):

| Table | Recommended window | Notes |
| --- | --- | --- |
| Session events | `1209600000` (14 days) | Durable session projection still covers the trimmed window for UI state. |
| Workspace events | `1209600000` (14 days) | Keep aligned with session events (written 1:1). |
| Audit events | policy-driven | Leave off until legal/compliance approves prune. |
| Usage events | after export | Leave off until billing aggregation/export is complete. |

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_RETENTION_INTERVAL_MS` | Minimum gap between retention sweeps. Defaults to one hour. |
| `OPEN_COWORK_CLOUD_RETENTION_BATCH_SIZE` / `OPEN_COWORK_CLOUD_RETENTION_MAX_BATCHES` | Rows deleted per batch and max batches per table per sweep. Defaults `500` / `20`. |
| `OPEN_COWORK_CLOUD_RETENTION_CHANNEL_DELIVERY_MS` | Prune terminal (`sent`/`dead`) channel deliveries older than this. Off by default. |
| `OPEN_COWORK_CLOUD_RETENTION_CHANNEL_INTERACTION_MS` | Prune expired one-shot channel-interaction tokens older than this. Off by default. |
| `OPEN_COWORK_CLOUD_RETENTION_STALE_THROTTLE_MS` | Prune stale rate-limit windows + expired auth-backoff rows. Pure bookkeeping that grows one row per client IP, so this defaults **on** at one hour; `0` disables. |
| `OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS` | Prune `cloud_session_events` (the durable SSE replay log) older than this. Off by default for local/self-host; **required** for `public_production`. Durable session projection still covers the trimmed window. |
| `OPEN_COWORK_CLOUD_RETENTION_AUDIT_EVENT_MS` | Prune `cloud_audit_events` older than this. Off by default — enable only if your compliance/retention policy permits deleting the audit trail. |
| `OPEN_COWORK_CLOUD_RETENTION_USAGE_EVENT_MS` | Prune `cloud_usage_events` older than this. Off by default — enable only after the usage data has been exported/aggregated for billing. |
| `OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS` | Prune `cloud_workspace_events` older than this. Written 1:1 with `cloud_session_events`; **required** for `public_production`. Durable projection still covers the trimmed window. |
| `OPEN_COWORK_CLOUD_CONCURRENCY_RECONCILE_MS` | Optional interval for the scheduler to recompute the concurrency gauges (`cloud_concurrency_counters`) from their source tables. Off by default — the gauges are drift-free for normal activity; enable as a belt-and-suspenders correction (e.g. one hour). |

Managed billing variables:

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_BILLING_ENABLED` | Enables provider-neutral billing enforcement. Leave `false` for self-host OSS deployments. |
| `OPEN_COWORK_CLOUD_BILLING_PROVIDER` | `none`, `stub`, or `stripe`. Public hosted deployments should not use `none`. |
| `OPEN_COWORK_CLOUD_BILLING_DEFAULT_PLAN` | Default plan key used for checkout and provider webhook mapping. |
| `OPEN_COWORK_CLOUD_STRIPE_API_KEY` / `OPEN_COWORK_CLOUD_STRIPE_API_KEY_REF` | Stripe API credential or env secret ref for checkout/portal calls. |
| `OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET` / `OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET_REF` | Stripe webhook signing secret. Required for Stripe webhook handling. |
| `OPEN_COWORK_CLOUD_STRIPE_PRICE_ID` | Default Stripe price id for the default plan. |
| `OPEN_COWORK_CLOUD_STRIPE_SUCCESS_URL` / `OPEN_COWORK_CLOUD_STRIPE_CANCEL_URL` / `OPEN_COWORK_CLOUD_STRIPE_PORTAL_RETURN_URL` | Public URLs used by Stripe hosted checkout and portal flows. |

### Optional, pluggable monetization (entitlements engine)

Billing is optional and **must never gate administration or reads**. An
`EntitlementResolver` is the single typed seam the app consults for feature
access and quotas (`canUse(feature)`, `checkQuota(resource, amount)`,
`describeEntitlements(org)`). Feature/quota code asks the resolver — it never
calls a payment provider directly. The payment-provider sync boundary
(checkout/portal/webhook) stays behind the separate billing adapter.

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_ENTITLEMENTS_ENABLED` | Global kill switch for entitlement gating. Default `false`. When `false`, **no** gating is applied regardless of provider — reads, writes, and admin all pass. Existing orgs are grandfathered because gating is off until an operator opts in; flip back to `false` to instantly disable all gating during a rollout. |
| `OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER` | Which resolver backs feature/quota decisions: `none` (default) → the unlimited resolver (complete, ungated product, no Billing UI signal); `stripe` → the plan/subscription **metadata** resolver, which decides purely from stored plan tiers + `cloud_billing_subscriptions` state (no live provider calls) and returns structured `402` denials on gated **writes**; `custom` → a downstream-registered resolver (see below). |

Gating discipline (enforced and tested): entitlement checks may gate
**writes/creation only** (session/prompt/worker/workflow/artifact/BYOK/channel
create paths, via `assertEntitled`) — never reads, exports, deletes, or any
admin/org/RBAC/policy/audit action. With a lapsed or free plan, reads/exports
and every admin action still succeed while a gated create is denied; with
`provider: none` (or the kill switch off) nothing is ever denied.

The read-only `GET /api/billing/entitlements` endpoint returns the current plan
status (`provider`, `gatingEnabled`, `billingEnabled`, `planKey`, `features`,
`limits`). The admin plane reads `billingEnabled` to decide whether to surface a
Billing section; it is never gated and carries no secrets.

Custom adapter seam: a downstream fork wires its own resolver with a small
module — implement `EntitlementResolver` (exported from `@open-cowork/cloud-server`),
call `registerEntitlementResolverProvider('custom', factory)` at startup, then set
`OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER=custom`. No entitlement plan/subscription
migration is required: state persists in the existing `cloud_billing_subscriptions`
store, and the kill switch defaults off so no existing org breaks.

BYOK provider keys are never supplied through environment variables. Users add
them through `/api/byok`; records remain `pending_validation` until a provider
validator passes, or an org admin uses the audited override endpoint with a
redacted reason.

Credentialless OpenCode-native desktop providers, including GitHub Copilot, are
not normal Cloud BYOK providers. The upstream managed BYOK path admits only
provider descriptors with declared secret credential fields, so Copilot is
blocked by default for cloud workers and gateway sessions unless a deployer adds
an explicit cloud-safe profile and policy for it. Do not route Copilot OAuth or
device-code tokens through gateway providers, renderer state, cache, logs, or
BYOK payloads.

Gateway variables:

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_BASE_URL` | Cloud web base URL used by the gateway HTTP/SSE client. |
| `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` | Scoped cloud API token with gateway access. Store it as a secret. |
| `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` | Required for operator endpoints in shared/public deployments. Send as bearer auth or `x-open-cowork-gateway-admin-token`. |
| `OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS` | Explicit local-only bypass for operator endpoints when bound to loopback. Runtime rejects public URLs, public/forwarded `Host` headers, proxy-forwarded requests, and public binds for this bypass. |
| `OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP` | Allows non-loopback HTTP cloud URLs for local Docker networks only. |
| `OPEN_COWORK_GATEWAY_HOST` / `OPEN_COWORK_GATEWAY_PORT` | Gateway HTTP bind address and port. |
| `OPEN_COWORK_GATEWAY_PUBLIC_URL` | Public HTTPS gateway URL for channel webhook registration. Non-HTTPS and loopback values fail closed. |
| `OPEN_COWORK_GATEWAY_INSTANCE_ID` | Optional stable gateway instance/shard id used as Cloud delivery claimant. Kubernetes sets it from the pod name. |
| `OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES` | Maximum inbound webhook/body size. Bridge/email file limits default to this cap. |
| `OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS` | Allows `Forwarded`/`x-forwarded-for` for webhook abuse controls only when the request socket is in `OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS`; if both headers are present they must resolve to the same client or the socket address is used. |
| `OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS` | Comma-separated CIDR/address allowlist for reverse proxies whose forwarded client headers may be used. Leave empty unless `OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS=true`. |
| `OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS` | Deadline for cloud HTTP API calls made by the gateway. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS` | Deadline for outbound bridge/webhook delivery and Slack API calls. |
| `OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS` | Deadline for SMTP connection/read/write operations. |
| `OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS` | Maximum time to drain in-flight deliveries before provider shutdown. |
| `OPEN_COWORK_GATEWAY_PRODUCT_MODE` | `cloud_channel` for the current Cloud Channel Gateway daemon. `standalone` and `hybrid` are separate/future product modes and fail closed here. |
| `OPEN_COWORK_GATEWAY_MODE` | `self-host` or `managed`; affects diagnostics and deployment labeling. |
| `OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON` | JSON object matching the public branding contract; Helm renders this from `gateway.branding`. |
| `OPEN_COWORK_GATEWAY_BRAND_NAME` / `OPEN_COWORK_GATEWAY_BRAND_SHORT_NAME` | Simple env overrides for gateway health/readiness and setup metadata. |
| `OPEN_COWORK_GATEWAY_SUPPORT_URL` / `OPEN_COWORK_GATEWAY_PRIVACY_URL` / `OPEN_COWORK_GATEWAY_SECURITY_URL` / `OPEN_COWORK_GATEWAY_LEGAL_URL` | Optional public links returned by gateway health/readiness metadata. |
| `OPEN_COWORK_GATEWAY_METRICS_ENABLED` | Enables `/metrics`; public binds require `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`. |
| `OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED` | Enables `/diagnostics`; public binds require `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`. |
| `OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER` | Enables the fake local/demo provider when no real provider is configured. Do not expose it publicly. |
| `OPEN_COWORK_GATEWAY_PROVIDERS` | JSON provider array for multi-provider deployments. Treat as secret when it carries credentials. |
| `OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN` | Telegram bot token for the Telegram provider. |
| `OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET` | Telegram webhook secret token when running webhook mode. |
| `OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN` | Slack bot token for Slack channel access. |
| `OPEN_COWORK_GATEWAY_SLACK_SIGNING_SECRET` | Required Slack signing secret for webhook verification. |
| `OPEN_COWORK_GATEWAY_SLACK_CHANNEL_BINDING_ID` / `OPEN_COWORK_GATEWAY_SLACK_TEAM_ID` | Cloud channel binding id and Slack team/workspace id. |
| `OPEN_COWORK_GATEWAY_EMAIL_INBOUND_SECRET` | Required shared secret for inbound email webhook delivery. |
| `OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES` | Optional email attachment cap; defaults to `OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES`. |
| `OPEN_COWORK_GATEWAY_EMAIL_FROM` / `OPEN_COWORK_GATEWAY_EMAIL_ADDRESS` | Outbound sender and inbound address shown in channel binding setup. |
| `OPEN_COWORK_GATEWAY_EMAIL_SMTP_HOST` / `OPEN_COWORK_GATEWAY_EMAIL_SMTP_PORT` / `OPEN_COWORK_GATEWAY_EMAIL_SMTP_SECURE` | SMTP transport settings for email replies. |
| `OPEN_COWORK_GATEWAY_EMAIL_SMTP_USERNAME` / `OPEN_COWORK_GATEWAY_EMAIL_SMTP_PASSWORD` | Optional SMTP auth credentials. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_URL` | Outbound URL for the generic webhook provider. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES` | Optional generic webhook attachment cap; defaults to `OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES`. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET` | Required shared secret for generic webhook ingress HMAC signatures and outbound bridge authentication. Inbound and outbound generic webhook requests include `x-open-cowork-gateway-webhook-timestamp` and `x-open-cowork-gateway-webhook-signature` over the raw body. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_CHANNEL_BINDING_ID` | Cloud channel binding id mapped to the generic webhook provider (default `webhook`). |
| `OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_ALLOWED_HOSTS` | Comma-separated host allowlist for outbound webhook/bridge delivery URLs. Constrains SSRF blast radius; leave empty to allow any public host. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_ALLOW_PRIVATE_DELIVERY` | Allows outbound webhook/bridge delivery to private/loopback addresses. Off by default (SSRF guard); enable only for trusted internal bridges. |
| `OPEN_COWORK_GATEWAY_TELEGRAM_CHANNEL_BINDING_ID` | Cloud channel binding id mapped to the Telegram provider (default `telegram`). |
| `OPEN_COWORK_GATEWAY_TELEGRAM_MODE` | `polling` (private VPS) or `webhook` (when `OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL` is reachable by Telegram). |
| `OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL` | Public HTTPS base URL Telegram calls in webhook mode; falls back to `OPEN_COWORK_GATEWAY_PUBLIC_URL`. |
| `OPEN_COWORK_GATEWAY_TELEGRAM_RESPOND_IN_GROUPS` | Whether the Telegram bot responds to non-mention group messages. |
| `OPEN_COWORK_GATEWAY_SLACK_DEFAULT_CHANNEL_ID` | Optional default Slack channel id for outbound posts. |
| `OPEN_COWORK_GATEWAY_SLACK_API_BASE_URL` | Optional Slack API base URL override (testing / Slack-compatible gateways). |
| `OPEN_COWORK_GATEWAY_EMAIL_CHANNEL_BINDING_ID` | Cloud channel binding id mapped to the email provider (default `email`). |
| `OPEN_COWORK_GATEWAY_EMAIL_DOMAIN` | Inbound email domain advertised in channel binding setup. |
| `OPEN_COWORK_GATEWAY_LOG_LEVEL` | Gateway log level: `debug`, `info`, `warn`, `error`, or `silent` (default `info`). |
| `OPEN_COWORK_GATEWAY_BRAND_LOGO_URL` | HTTPS logo URL returned in gateway health/readiness and setup metadata. |
| `OPEN_COWORK_GATEWAY_MAX_DELIVERY_CONCURRENCY` | Maximum cloud→channel deliveries dispatched at once (default `8`, clamped `1`–`256`). Caps outbound fan-out so a backlog drain cannot storm providers into rate limits. |
| `OPEN_COWORK_GATEWAY_MAX_DELIVERY_QUEUE_DEPTH` | Hard cap on locally queued deliveries (default `512`, clamped `16`–`100000`). Beyond it deliveries are shed back to the cloud to re-serve instead of growing the heap. |
| `OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER` | Local/demo escape hatch that permits the fake provider on a public bind. Keep off; real public deployments must use a real provider. |
| `OPEN_COWORK_GATEWAY_FAKE_CHANNEL_BINDING_ID` / `OPEN_COWORK_GATEWAY_FAKE_WORKSPACE_ID` | Channel binding id and external workspace id for the local/demo fake provider. |
| `OPEN_COWORK_GATEWAY_CLI_ENABLED` | Enables the local CLI channel provider for development/testing. |
| `OPEN_COWORK_GATEWAY_CLI_CHANNEL_BINDING_ID` / `OPEN_COWORK_GATEWAY_CLI_WORKSPACE_ID` | Channel binding id and external workspace id for the CLI provider. |

### Bridge providers (discord / whatsapp / signal)

Discord, WhatsApp, and Signal are outbound-bridge providers: Open Cowork signs
and POSTs messages to an external bridge process that owns the platform
connection, and the bridge POSTs inbound messages back through the signed
generic-webhook ingress path. Each provider is configured from a parallel env
family (substitute `DISCORD`, `WHATSAPP`, or `SIGNAL` for `<KIND>`). A provider
is only created when its `_DELIVERY_URL` is set, and it then requires a
`_SHARED_SECRET`.

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_GATEWAY_DISCORD_DELIVERY_URL` / `OPEN_COWORK_GATEWAY_WHATSAPP_DELIVERY_URL` / `OPEN_COWORK_GATEWAY_SIGNAL_DELIVERY_URL` | Outbound URL of the external bridge for that platform. Setting it enables the provider. |
| `OPEN_COWORK_GATEWAY_DISCORD_SHARED_SECRET` / `OPEN_COWORK_GATEWAY_WHATSAPP_SHARED_SECRET` / `OPEN_COWORK_GATEWAY_SIGNAL_SHARED_SECRET` | Required HMAC shared secret for that bridge's signed inbound ingress and outbound delivery. |
| `OPEN_COWORK_GATEWAY_<KIND>_CHANNEL_BINDING_ID` | Cloud channel binding id mapped to the bridge provider (defaults to the kind). |
| `OPEN_COWORK_GATEWAY_<KIND>_WORKSPACE_ID` | Optional external workspace id for the bridge binding. |
| `OPEN_COWORK_GATEWAY_<KIND>_DELIVERY_ALLOWED_HOSTS` | Comma-separated host allowlist for outbound bridge delivery (SSRF guard). |
| `OPEN_COWORK_GATEWAY_<KIND>_ALLOW_PRIVATE_DELIVERY` | Allows bridge delivery to private/loopback addresses. Off by default. |
| `OPEN_COWORK_GATEWAY_<KIND>_MAX_ATTACHMENT_BYTES` | Optional attachment cap; defaults to `OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES`. |

Gateway config JSON from `OPEN_COWORK_CONFIG_PATH`,
`OPEN_COWORK_CONFIG_DIR`, `OPEN_COWORK_DOWNSTREAM_ROOT`,
`OPEN_COWORK_GATEWAY_CONFIG`, or `OPEN_COWORK_GATEWAY_CONFIG_JSON` is
intentionally not trusted for the cloud endpoint, service token, or
cloud-client timeout/insecure-HTTP policy. Set `OPEN_COWORK_CLOUD_BASE_URL`,
`OPEN_COWORK_GATEWAY_SERVICE_TOKEN`,
`OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS`, and
`OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP` through env or your deployment secret
manager instead.

Hosted/public deployments should keep abuse controls enabled. The defaults are
conservative and can be tuned per deployment; set an individual numeric quota
to `0` to disable that quota for self-hosted/private installs.

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_ABUSE_ENABLED` | Enables quota, rate-limit, usage, and auth-backoff enforcement. |
| `OPEN_COWORK_CLOUD_MAX_CONCURRENT_SESSIONS_PER_ORG` | Maximum non-closed cloud sessions per org. |
| `OPEN_COWORK_CLOUD_MAX_ACTIVE_WORKERS_PER_ORG` | Maximum active worker leases per org. |
| `OPEN_COWORK_CLOUD_MAX_PROMPTS_PER_HOUR` | Per-org prompt enqueue quota. |
| `OPEN_COWORK_CLOUD_MAX_GATEWAY_PROMPTS_PER_HOUR` | Per-org prompt quota for channel-gateway-originated prompts. |
| `OPEN_COWORK_CLOUD_MAX_WORKFLOW_RUNS_PER_HOUR` | Per-org workflow-run start quota. |
| `OPEN_COWORK_CLOUD_MAX_CONCURRENT_WORKFLOW_RUNS_PER_ORG` | Maximum simultaneously-running workflow runs per org. |
| `OPEN_COWORK_CLOUD_MAX_QUEUED_COMMANDS_PER_ORG` | Maximum pending session commands queued per org. |
| `OPEN_COWORK_CLOUD_MAX_QUEUE_AGE_MS` | Maximum age of the oldest pending command before new enqueues are rejected (backpressure). |
| `OPEN_COWORK_CLOUD_MAX_WORKER_MINUTES_PER_HOUR` | Per-org worker-minute quota used to block new execution after hourly usage is exhausted. |
| `OPEN_COWORK_CLOUD_MAX_GATEWAY_DELIVERIES_PER_HOUR` | Per-org gateway delivery claim quota. |
| `OPEN_COWORK_CLOUD_MAX_GATEWAY_CHANNEL_BINDINGS_PER_ORG` | Maximum active gateway channel bindings per org. |
| `OPEN_COWORK_CLOUD_MAX_ARTIFACT_BYTES_PER_DAY` | Per-org artifact upload byte quota. |
| `OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_ENABLED` | Enables HTTP request rate limiting. |
| `OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_WINDOW_MS` | HTTP rate-limit window. |
| `OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_MAX_REQUESTS` | Maximum HTTP requests per IP, org, and API token per window. |
| `OPEN_COWORK_CLOUD_AUTH_BACKOFF_ENABLED` | Enables backoff after repeated rejected authentication attempts. |
| `OPEN_COWORK_CLOUD_AUTH_BACKOFF_WINDOW_MS` | Auth failure counting window. |
| `OPEN_COWORK_CLOUD_AUTH_BACKOFF_MAX_FAILURES` | Failures before auth backoff starts. |
| `OPEN_COWORK_CLOUD_AUTH_BACKOFF_MS` | Backoff duration returned through `Retry-After`. |

Quota and rate-limit failures return `429` with `Retry-After`, `retryAfterMs`,
and a machine-readable policy code such as
`quota.prompts_per_hour_exceeded` or `rate_limit.http_exceeded`. Billing or
plan enforcement can layer separate `402` policy responses on top of this
control-plane surface.

Role-specific knobs:

| Variable | Roles | Meaning |
| --- | --- | --- |
| `OPEN_COWORK_CLOUD_HOST` / `OPEN_COWORK_CLOUD_PORT` | `web`, `all-in-one` | HTTP bind address. |
| `OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS` | `all-in-one` | Process queued commands inline for local/demo use. |
| `OPEN_COWORK_CLOUD_WORKER_ID` | `worker`, `all-in-one` | Stable worker identity for leases and heartbeats. |
| `OPEN_COWORK_CLOUD_WORKER_POLL_MS` | `worker`, `all-in-one` | Durable command polling interval. |
| `OPEN_COWORK_CLOUD_WORKER_SESSION_CONCURRENCY` | `worker`, `all-in-one` | How many distinct sessions one worker tick processes concurrently (default `4`, clamped `1`–`32`). Sessions are independent, so this stops one long-running command from head-of-line-blocking other tenants on the worker; set to `1` for the previous strictly-serial behaviour. Each concurrent session can run its own runtime, so size it against the worker's CPU/memory and the per-org worker entitlement. |
| `OPEN_COWORK_CLOUD_WORKER_MAX_COMMANDS_PER_SESSION_PER_TICK` | `worker`, `all-in-one` | How many commands a single session drains before yielding its lane back to the pool (default `50`, clamped `1`–`10000`). Bounds a session with a large backlog from monopolising a lane; the session is re-surveyed on the next pass while it still has pending commands. |
| `OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS` | `worker`, `scheduler`, `all-in-one` | Grace window used during process shutdown to let an active worker/scheduler loop finish after a drain or termination signal. |
| `OPEN_COWORK_CLOUD_SCHEDULER_ID` | `scheduler`, `all-in-one` | Stable scheduler identity for heartbeats. |
| `OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS` | `scheduler`, `all-in-one` | Workflow scheduler polling interval. |

### Cloud advanced / tuning

Most deployments never set these; they carry safe defaults. They exist so an
operator can tune storage location, connection caps, the runtime cache, and
Postgres safety timeouts per deployment.

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_ROOT` | Filesystem root for cloud runtime working data (logs, ephemeral workspaces, and the filesystem object-store adapter). Compose references set `/data/open-cowork-cloud`. |
| `OPEN_COWORK_CLOUD_DEPLOYMENT_TIER` | Deployment tier that gates production safety checks: `local` for demos, `public_production` for hosted deployments (rejects insecure auth, weak secrets, ephemeral storage, and other unsafe defaults). |
| `OPEN_COWORK_CLOUD_CORS_ORIGIN` | Single allowed CORS origin for the cloud HTTP/SSE API. Leave unset for same-origin browser access; set it when a separate first-party origin must call the API. |
| `OPEN_COWORK_CLOUD_RUN_MIGRATIONS` | Defaults to `true` for local/self-host development. Public production fails closed unless this is explicitly `false`; run the exact pinned image's `cloud:migrate:start` entrypoint separately with a short-lived migrator credential. |
| `OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE` | Migrator-only PostgreSQL role name for the least-privilege runtime role that should receive the application DML grants. Set only on the separately credentialed `cloud:migrate:start` job, together with `OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL`; do not set either variable on long-running roles. |
| `OPEN_COWORK_CLOUD_RUNTIME_DATABASE_PRINCIPAL` | Migrator-only PostgreSQL login/IAM principal that receives membership in `OPEN_COWORK_CLOUD_RUNTIME_DATABASE_ROLE`. The principal must already exist; the migration job validates that neither identity is privileged before granting runtime access. |
| `OPEN_COWORK_CLOUD_ALLOW_EPHEMERAL_STORAGE` | Explicit operator acknowledgement that non-durable control-plane/object storage is acceptable. Required to start a `public_production` tier on ephemeral storage; keep unset so accidental ephemeral storage fails closed. |
| `OPEN_COWORK_CLOUD_LIVENESS_PORT` | Optional dedicated port for a minimal liveness server (separate from the main HTTP port). `0`/unset disables it; the main `/livez` route remains available. |
| `OPEN_COWORK_CLOUD_RUNTIME_CACHE_MAX_ENTRIES` | Maximum cached OpenCode runtimes a worker keeps warm (default `100`). Bounds worker memory under many concurrent sessions. |
| `OPEN_COWORK_CLOUD_RUNTIME_CACHE_IDLE_TTL_MS` | Idle eviction window for cached worker runtimes (default `1800000`, 30 minutes). |
| `OPEN_COWORK_CLOUD_PG_LOCK_TIMEOUT_MS` | Postgres `lock_timeout` per connection (default `0`, disabled). Set a non-zero value to bound how long a statement waits on a row/table lock before failing fast. |
| `OPEN_COWORK_CLOUD_MAX_CONNECTIONS` | Maximum simultaneous TCP connections accepted by the cloud HTTP server (default `10000`). A connection-exhaustion guard above the Node default of unbounded. |
| `OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG` | Maximum concurrent browser/desktop SSE streams **per org per web pod** (default `200`). Enforced by the SSE stream registry on every session, workspace, and channel-delivery stream; excess subscriptions for one org receive an SSE error and are dropped so a single tenant cannot exhaust stream slots. Size this to concurrent interactive users × open tabs, not historical sessions. |
| `OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS` | SSE read-poll cadence in milliseconds (default `1000`). Each open stream polls the control plane at this interval for new events; lower it to cut delivery latency at the cost of more control-plane queries, raise it to shed query load at the cost of latency. |
| `OPEN_COWORK_CLOUD_SSE_PG_NOTIFY` | Postgres `LISTEN`/`NOTIFY` accelerator for SSE delivery (default `false`, Postgres control plane only). **Production multi-web-pod topologies should set this to `true`.** When enabled, the worker write path emits a best-effort `NOTIFY` (identifiers only, no event bodies) after each session/workspace event commit, and each web pod opens one dedicated `LISTEN` connection that wakes the matching SSE topic for an immediate read instead of waiting for the next poll. The poll loop always keeps running as the guaranteed backstop, so a missed or duplicate notification is harmless and a listener failure degrades to pure polling. Leave unset (the default) only for single-process demos that want byte-for-byte poll-only delivery. |
| `OPEN_COWORK_CLOUD_SSE_NOTIFY_BACKSTOP_POLL_MS` | Backstop read-poll cadence (default `15000`, 15 seconds) applied **only** to NOTIFY-addressable SSE topics when `OPEN_COWORK_CLOUD_SSE_PG_NOTIFY` is enabled. With the accelerator on, `LISTEN`/`NOTIFY` drives low-latency delivery, so the per-topic poll relaxes to this longer backstop cadence (bounded by `max(OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS, this)`), cutting steady-state control-plane queries. Has no effect when the accelerator is off — poll cadence stays at `OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS`. |
| `OPEN_COWORK_CLOUD_SSE_MAX_LIFETIME_MS` | Hard ceiling on a single SSE stream's lifetime (default `1800000`, 30 minutes). A wedged/half-open stream cannot pin a slot indefinitely; `EventSource` clients reconnect transparently. |

### Multi-pod SSE load guidance

Split-role production Cloud keeps durable events in Postgres. Every open SSE
stream still needs a delivery path from the worker that wrote the event to the
web pod holding the browser connection:

| Topology | Recommended SSE settings | Why |
| --- | --- | --- |
| Single `all-in-one` demo | defaults (`SSE_PG_NOTIFY` off, poll 1s) | One process; poll loop is enough. |
| Single web pod + separate workers | `OPEN_COWORK_CLOUD_SSE_PG_NOTIFY=true` | Workers and web do not share memory; NOTIFY cuts end-to-end latency without depending on pod-local buses. |
| Multiple web pods behind a load balancer | **`OPEN_COWORK_CLOUD_SSE_PG_NOTIFY=true` (required for scale)** | Cross-pod wake; poll-only multiplies control-plane reads by `streams × pods × (1000 / pollMs)`. |
| Large interactive orgs | raise `OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG` only with evidence; keep `OPEN_COWORK_CLOUD_MAX_CONNECTIONS` above `web_replicas × max_per_org × orgs_per_pod` | Caps are per pod; global capacity is `replicas × per-org cap` under sticky routing assumptions. |

Load-planning rule of thumb for multi-pod web:

1. Enable `OPEN_COWORK_CLOUD_SSE_PG_NOTIFY=true` on **web and worker** roles (worker emits NOTIFY; web LISTENs).
2. Keep `OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS` at `1000` (or higher) and rely on NOTIFY for low latency; tune `OPEN_COWORK_CLOUD_SSE_NOTIFY_BACKSTOP_POLL_MS` (default 15s) as the safety net.
3. Size `OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG` to concurrent tabs per org (default 200). Rejected streams reconnect transparently after a slot frees.
4. Include SSE in launch load gates (`OPEN_COWORK_LOAD_INCLUDE_SSE=true`) so reconnect storms and per-org caps appear in evidence before production traffic.

`OPEN_COWORK_CLOUD_PUBLIC_URL` doubles as the HSTS switch: the server only emits
`Strict-Transport-Security` when `OPEN_COWORK_CLOUD_PUBLIC_URL` is an HTTPS,
non-loopback origin. Any HTTPS-fronted deployment — including self-host tiers
behind a TLS-terminating reverse proxy or ingress — must set
`OPEN_COWORK_CLOUD_PUBLIC_URL` to the canonical `https://` origin so HSTS is
emitted (and so redirects/cookies never depend on untrusted forwarded headers).

Profiles are enforced server-side and in generated OpenCode config. Cloud
profiles default to app-managed runtime config and deny arbitrary host project
directories, arbitrary local stdio MCPs, and machine-native runtime config
unless a deployer explicitly allows a controlled image or volume-backed
environment.

## Desktop Sync Configuration

Desktop-to-cloud sync is configured separately from the cloud service roles.
Downstream desktop builds can preconfigure managed cloud orgs without changing
renderer code by setting `cloudDesktop` in `open-cowork.config.json` or a
managed config layer:

```json
{
  "cloudDesktop": {
    "enabled": true,
    "allowUserAddedConnections": false,
    "requireManagedOrg": true,
    "cacheMode": "metadata-only",
    "cacheEncryptionFallback": "disabled",
    "preconfiguredConnections": [
      {
        "baseUrl": "https://cowork.acme.example",
        "label": "Acme Cloud"
      }
    ]
  }
}
```

`enabled: false` hides cloud workspaces and keeps the desktop fully local.
`requireManagedOrg: true` limits desktop sync to the configured org list and
blocks user-added cloud URLs. `cacheMode` controls the local cloud cache:

- `full` caches encrypted session projections and metadata.
- `metadata-only` caches lists, cursors, and metadata but strips message
  bodies and full projections.
- `disabled` avoids durable cloud cache state.

When `cacheMode` is `full`, the desktop requires OS-backed encrypted storage or
uses `cacheEncryptionFallback` to degrade to `metadata-only`, `disabled`, or
fail startup. OAuth access and refresh tokens are stored in OS secure storage,
not in the cloud cache. The cache is keyed by cloud connection, tenant, user,
profile, and workspace identity so two orgs cannot share cached projections or
event cursors.

Cloud workspace logout is an authentication boundary, not a data wipe. It
removes the workspace access and refresh tokens, closes active cloud
subscriptions, and leaves any existing cloud cache as a local read-only fallback
until the user signs in again or removes the workspace. Removing a user-added
cloud workspace is the wipe boundary: it removes the registry record,
credentials, active subscriptions, and that workspace's cached metadata,
cursors, artifact metadata, and encrypted projections. Managed preconfigured
workspaces cannot be removed by the user; downstream builds that require a
stronger wipe policy should configure `cacheMode: "disabled"` or expose an
admin-managed cache clear flow.

Every workspace-scoped API also has a typed support matrix exposed through
`workspace.support()`. Cloud-only clients should use it to distinguish
`supported`, `blocked_by_policy`, `not_supported`, and later-phase surfaces
instead of assuming local desktop APIs such as host-path diffs or local stdio
MCPs are available in cloud workspaces.

## Provider Mapping

Provider-specific recipes should remain thin compositions of the same images,
roles, Postgres control plane, object-store adapter, and secret adapter.

| Provider | Web | Worker/Scheduler | Gateway | Control plane | Object store | Secret store |
| --- | --- | --- | --- | --- | --- | --- |
| Kubernetes | Deployment + Service/Ingress | Deployments or jobs with HPA/KEDA as needed | Separate Deployment + Service/Ingress for webhook channels | Managed or in-cluster Postgres | S3-compatible, GCS, Azure Blob, or MinIO | External Secrets or sealed secrets |
| GCP | Cloud Run or GKE | GKE for production workers; Cloud Run all-in-one demo only | Cloud Run or GKE Deployment | Cloud SQL for PostgreSQL | Cloud Storage | Secret Manager |
| AWS | ECS/Fargate or EKS | ECS services or EKS deployments | ECS service or EKS Deployment | RDS PostgreSQL | S3 | Secrets Manager |
| Azure | Container Apps or AKS | Container Apps jobs/services or AKS | Container Apps service or AKS Deployment | Azure Database for PostgreSQL | Azure Blob Storage | Key Vault |
| DigitalOcean | App Platform for demos; DOKS for scale | DOKS deployments | App Platform component or DOKS Deployment | Managed PostgreSQL | Spaces | App Platform/DOKS secrets |

The app core should not contain provider-specific branches. Provider behavior
belongs in config, adapters, and deployment recipes.

Recipe starting points live under `deploy/gcp`, `deploy/aws`, `deploy/azure`,
and `deploy/digitalocean`. Each one maps provider services back to the same
role, Postgres, object-store, and secret-manager contract.

The GCP reference recipe includes a split-role GKE values file, External
Secrets example, managed certificate example, Cloud Run all-in-one demo
manifest, and provider smoke commands. Run `pnpm deploy:gcp:preflight` before
rollout to check the active `gcloud` project, region, required APIs, and
reference files without mutating resources. Run `pnpm deploy:gcp:smoke` after
rollout to combine the Cloud Web smoke with Cloud Storage and Secret Manager
checks.

Managed operators should also keep the runbook in
[`docs/runbooks/cloud-managed-operations.md`](runbooks/cloud-managed-operations.md)
current for readiness, rollback, gateway backlog, secret rotation, and
diagnostic export procedures.

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

- `GET /livez` reports process liveness and the active cloud role/profile.
- `GET /readyz` reports dependency readiness for the control plane, object
  store, secret adapter, billing adapter, auth config, and role-specific worker
  dependencies. Kubernetes readiness probes should use this route.
- `GET /api/runtime/status` reports the active role/profile, whether this
  process can execute runtime commands, and whether commands are handled inline
  or by durable worker polling.
- `GET /api/workers/heartbeats` exposes worker and scheduler heartbeat state
  for authenticated operators.
- `GET /api/metrics` exposes operator-scoped Prometheus metrics from the
  in-process cloud observability adapter. API-token callers need `operator`
  scope; desktop/gateway tokens and non-operator users are rejected. Use OTLP
  for provider-managed tracing/metrics and this endpoint for scrape-based
  dashboards.
- Cloud HTTP requests emit structured request logs with request ids, role,
  profile, status, and duration. When `OPEN_COWORK_CLOUD_OTLP_ENDPOINT` is
  set, the same request observations are exported as OTLP HTTP traces and
  duration metrics without adding provider-specific code paths.
- OTLP export is best-effort and bounded: collector failures do not block Cloud
  requests or worker commands, overflow drops the oldest queued records, and
  `open_cowork_cloud_otlp_dropped_records_total` reports queue drops by record
  type.
- Browser event streams use ordered durable events, so web replicas do not need
  sticky sessions for session replay.
- Browser sessions use signed `HttpOnly`, `SameSite=Lax` cookies and require
  `X-CSRF-Token` on mutating API calls when authenticated by cookie. Bearer
  API clients remain supported without CSRF.
- OIDC browser login is exposed through `/auth/login` and the configured
  callback path. The flow uses signed state cookies, PKCE, nonce validation,
  and the same verified identity mapping as bearer JWT auth.
- Public workflow webhooks require HMAC timestamp signatures. Direct `none`
  mode is loopback/local-only. `header` mode is only for a reverse proxy that
  strips caller-supplied identity headers and injects trusted
  `x-open-cowork-*` headers.

See also [Worker-scoped runtime adapter](worker-scoped-runtime-adapter.md).
