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

## Workspace sync contract

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

## Cloud Web Workbench

The cloud web role serves the Cloud Web Workbench at `/`. The workbench is an
API client for the same cloud control plane used by desktop sync and gateway
clients; it does not access Postgres or secret storage directly.

The browser app currently keeps a no-framework, server-rendered shell with an
inline nonce-protected client script. That is intentional for the first cloud
workbench build-out: it keeps the cloud image simple, preserves the existing
CSP and cookie-auth path, and avoids introducing a separate asset build before
the browser product surface needs richer interaction. The shell is still split
around typed route metadata so the app can grow into a bundled browser client
without changing the Cloud API contract.

The information architecture is split into two surfaces:

- Workbench: Threads, Chat, Agents, Tools & Skills, Workflows, and Artifacts.
- Admin: Org, Members, Profiles & Policy, BYOK, Connections, Billing, Gateway,
  Audit, Usage, and Diagnostics.

The Threads and Chat panels are the first interactive workbench surfaces:

- `GET /api/sessions` loads the org-scoped durable session list.
- `GET /api/sessions/:id/view` hydrates the selected thread from its durable
  projection and shared `SessionView`.
- `POST /api/sessions` creates a browser-origin cloud thread with a chat-only,
  allowed Git, or uploaded snapshot project source.
- `POST /api/sessions/:id/prompt` sends browser prompts through the same durable
  command path used by desktop sync and gateway clients.
- `GET /api/sessions/:id/events` and `GET /api/events` keep the selected thread
  and thread list live through SSE, resuming from durable event sequences after
  reconnect.

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

- Agents are derived from the current profile's allowed agent list plus the
  cloud-safe tool and skill catalog. Starting an agent creates a cloud thread
  and pins that agent into the composer; execution still flows through the
  cloud worker and OpenCode runtime.
- Tools & Skills browse `/api/capabilities`, including source, scope, agent
  relationships, and policy notes. The browser renders cloud-safe metadata
  only; custom content that is synced but disabled by profile policy is shown as
  unavailable rather than exposed with local process details or secrets.
- Workflows use `/api/workflows` for durable definitions and run history,
  `POST /api/workflows/:id/run` for manual runs, and the pause/resume/archive
  routes for lifecycle changes. Manual runs can open the generated run thread so
  users can inspect the same projection shown in Chat.
- Artifacts includes a selected-thread browser plus a cross-thread history from
  already hydrated durable projections. Artifact bodies are still fetched only
  on explicit user action.

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

The browser workbench has its own release gates because `/healthz` only proves
the server is alive. Run these before provider rollout and keep them in CI:

```bash
pnpm --filter @open-cowork/website test:browser
pnpm --filter @open-cowork/website test:a11y
pnpm --filter @open-cowork/website perf:check
pnpm test:cloud-web
```

The browser E2E gate hydrates the actual workbench client in a DOM harness and
checks signed-out, member, admin, thread create/prompt/continue, SSE refresh,
approval/question, artifact, workflow, BYOK, gateway, billing, diagnostics,
policy-blocked, quota-blocked, and billing-blocked flows.

The accessibility gate checks labelled controls, keyboard-reachable navigation,
focus management, active route state, reduced-motion CSS, responsive layout
rules, and contrast budgets. The performance and scale gate checks 10k-thread
fixtures, hundreds of capabilities, bounded DOM row rendering, load-more
behavior, client-side filtering budgets, and SSE reconnect handling.

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
- redacted audit events through `/api/admin/audit`, with browser-side search
  and export over the already redacted event payload,
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
  signing.

For local demos the cloud compose file uses `auth.mode=none` and explicit
insecure overrides. Public deployments must use OIDC or a trusted identity
proxy for the cloud web role and a real gateway service token.

Gateway health endpoints:

- `GET /health` reports process liveness.
- `GET /ready` reports provider readiness.
- `GET /metrics` exposes Prometheus metrics when enabled. Public binds require
  `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`.
- `GET /diagnostics` returns redacted gateway config, provider state, and
  counters for support. Public binds require the same admin token.
- `GET /deliveries` lists recent delivery backlog rows for operators.
- `POST /deliveries/:id/retry` schedules a failed/dead delivery for retry.
- `POST /deliveries/:id/dead-letter` marks a poison delivery as dead. These
  delivery controls require the same gateway admin token.

The gateway image is separate from the cloud image because it owns channel
secrets, long-polling or webhook connections, and a different scaling profile.
It does not import the OpenCode SDK and does not own control-plane Postgres
state.

For Kubernetes, use the provider-neutral Helm chart as the scalable starting
point:

```bash
helm upgrade --install open-cowork-cloud helm/open-cowork-cloud \
  --set image.repository=ghcr.io/joe-broadhead/open-cowork-cloud \
  --set cloud.profile=full \
  --set cloud.auth.mode=oidc \
  --set cloud.auth.oidcIssuerUrl='https://issuer.example.com' \
  --set cloud.auth.oidcClientId='open-cowork-cloud' \
  --set cloud.controlPlaneUrl='postgres://...' \
  --set cloud.objectStore.kind=s3 \
  --set cloud.objectStore.bucket='open-cowork' \
  --set roles.worker.enabled=true \
  --set roles.scheduler.enabled=true
```

Use `cloud.existingSecret` in production so database URLs, object-store
credentials, and envelope keys come from your platform secret manager rather
than from Helm values.

Install the gateway chart next to cloud when you want channel access:

```bash
helm upgrade --install open-cowork-gateway helm/open-cowork-gateway \
  --set image.repository=ghcr.io/joe-broadhead/open-cowork-gateway \
  --set gateway.cloudBaseUrl='https://cowork.example.com' \
  --set gateway.serviceToken='replace-with-secret-manager-value'
```

For production, set `gateway.existingSecret` and inject
`OPEN_COWORK_GATEWAY_SERVICE_TOKEN`, `OPEN_COWORK_GATEWAY_PROVIDERS`, and
provider-specific credentials through External Secrets, sealed secrets, or the
platform secret manager. The cloud chart also exposes the gateway as an
optional dependency under `gateway.enabled=true` for installations that prefer
one parent release.

The chart fails closed when `cloud.auth.mode=none` is used without
`cloud.allowInsecureAuth=true`. Keep that override for local demos only; use
`oidc` or a trusted `header` identity proxy for shared clusters.
Public `header` auth deployments must also set
`OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` or
`OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF`; the proxy must inject that value
with the identity headers. Public OIDC deployments must set
`OPEN_COWORK_CLOUD_PUBLIC_URL` so redirect URIs never depend on forwarded
headers from untrusted callers.
The gateway chart also fails closed unless at least one provider is configured
through `gateway.providersJson`, Telegram, Slack, email, generic webhook
settings, or an existing secret.

The Helm chart uses an ephemeral worker runtime root by default. That is the
scalable path: workers externalize durable session state through Postgres and
object-store checkpoints. A single-worker PVC can be enabled for controlled
pilots, but the chart rejects `roles.worker.persistence.enabled=true` with more
than one worker replica because a shared ReadWriteOnce runtime volume is not a
horizontal scaling model.

For workers that write runtime/workspace checkpoints, provide either
`OPEN_COWORK_CLOUD_SECRET_KEY` or `OPEN_COWORK_CLOUD_SECRET_KEY_REF`. The ref
form can point at `env:NAME`, GCP Secret Manager
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
| `OPEN_COWORK_CLOUD_OBJECT_STORE_KIND` | `filesystem`, `minio`, `s3`, `gcs`, `azure-blob`, or `digitalocean-spaces`. |
| `OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET` | Bucket/container name for artifacts and snapshots. |
| `OPEN_COWORK_CLOUD_SECRET_KEY` | Envelope key for local/dev encrypted secret storage. |
| `OPEN_COWORK_CLOUD_SECRET_KEY_REF` | Optional cloud secret-manager ref for the envelope key when the key is not injected directly. |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET` | HMAC key for signed browser session cookies; falls back to `OPEN_COWORK_CLOUD_SECRET_KEY` for local demos. |
| `OPEN_COWORK_CLOUD_COOKIE_SECRET_REF` | Optional env secret ref for the cookie signing key when it is managed outside chart values. |
| `OPEN_COWORK_CLOUD_COOKIE_SECURE` | Defaults to `true`; local HTTP compose references set it to `false`. |
| `OPEN_COWORK_CLOUD_PUBLIC_URL` | Public base URL used for OIDC callback redirect URIs behind proxies or ingress. |
| `OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON` | JSON object matching `cloud.publicBranding`; Helm renders this from `cloud.branding`. |
| `OPEN_COWORK_CLOUD_BRAND_NAME` / `OPEN_COWORK_CLOUD_BRAND_SHORT_NAME` | Simple env overrides for the dashboard product name and short mark. |
| `OPEN_COWORK_CLOUD_BRAND_LOGO_URL` | HTTPS logo URL for the browser dashboard. |
| `OPEN_COWORK_CLOUD_SUPPORT_URL` / `OPEN_COWORK_CLOUD_PRIVACY_URL` / `OPEN_COWORK_CLOUD_SECURITY_URL` / `OPEN_COWORK_CLOUD_LEGAL_URL` | Optional public footer links. |
| `OPEN_COWORK_CLOUD_AUTH_MODE` | `none` for loopback/local demos, `header` for a trusted identity proxy, or `oidc` for public browser/JWT auth. |
| `OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH` | Explicit local/demo override that permits `auth.mode=none` on a non-loopback bind. Do not use for public deployments. |
| `OPEN_COWORK_CLOUD_OIDC_ISSUER_URL` | HTTPS OIDC issuer used for discovery and JWT verification. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_ID` | OIDC audience/client id expected in browser login and bearer tokens. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET` | Optional OIDC confidential-client secret; config `clientSecretRef` can point at a platform secret env var instead. |
| `OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF` | Optional env secret ref for the OIDC client secret. |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN` | Internal-only token for operational endpoints such as scheduler tick probes. Keep it in a platform secret store. |
| `OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF` | Optional env secret ref for the internal operational token. |
| `OPEN_COWORK_CLOUD_OIDC_CALLBACK_PATH` | OIDC callback path; defaults to `/auth/callback`. |
| `OPEN_COWORK_CLOUD_SIGNUP_MODE` | Optional explicit org signup mode: `closed`, `invite`, `domain`, or `open`. `invite` permits admin-created invited memberships; `domain` uses `OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS`; `closed` allows only existing active memberships. |
| `OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS` | Optional comma-separated email domain allowlist for OIDC identities. |
| `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET` / `OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF` | Required for public `header` auth; trusted proxies must provide the same value in `x-open-cowork-header-auth-secret`. |
| `OPEN_COWORK_CLOUD_ALLOW_SELF_SERVICE_SIGNUP` | Explicitly allows first-login OIDC org membership creation. Keep disabled for invite-only managed deployments. |
| `OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS` | Allows `x-forwarded-for` for rate-limit attribution only when the deployment is behind a trusted proxy. |
| `OPEN_COWORK_CLOUD_SERVICE_NAME` | Service name included in structured logs and OTLP resource attributes. |
| `OPEN_COWORK_CLOUD_SERVICE_VERSION` | Optional version string included in structured logs and OTLP resource attributes. |
| `OPEN_COWORK_CLOUD_LOG_FORMAT` | `json`, `pretty`, or `silent`; defaults to JSON for cloud logs. |
| `OPEN_COWORK_CLOUD_OTLP_ENDPOINT` | Optional OpenTelemetry OTLP HTTP base endpoint; exports traces to `/v1/traces` and metrics to `/v1/metrics`. |
| `OPEN_COWORK_CLOUD_OTLP_HEADERS` | Optional JSON object of OTLP HTTP headers, stored as a secret when it contains collector credentials. |
| `OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED` | `true` enables worker runtime/workspace checkpoints in object storage. |

Gateway variables:

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_BASE_URL` | Cloud web base URL used by the gateway HTTP/SSE client. |
| `OPEN_COWORK_GATEWAY_SERVICE_TOKEN` | Scoped cloud API token with gateway access. Store it as a secret. |
| `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` | Required when `/metrics` or `/diagnostics` are enabled on a public bind. Send as bearer auth or `x-open-cowork-gateway-admin-token`. |
| `OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP` | Allows non-loopback HTTP cloud URLs for local Docker networks only. |
| `OPEN_COWORK_GATEWAY_HOST` / `OPEN_COWORK_GATEWAY_PORT` | Gateway HTTP bind address and port. |
| `OPEN_COWORK_GATEWAY_PUBLIC_URL` | Public gateway URL for channel webhook registration. |
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
| `OPEN_COWORK_GATEWAY_EMAIL_FROM` / `OPEN_COWORK_GATEWAY_EMAIL_ADDRESS` | Outbound sender and inbound address shown in channel binding setup. |
| `OPEN_COWORK_GATEWAY_EMAIL_SMTP_HOST` / `OPEN_COWORK_GATEWAY_EMAIL_SMTP_PORT` / `OPEN_COWORK_GATEWAY_EMAIL_SMTP_SECURE` | SMTP transport settings for email replies. |
| `OPEN_COWORK_GATEWAY_EMAIL_SMTP_USERNAME` / `OPEN_COWORK_GATEWAY_EMAIL_SMTP_PASSWORD` | Optional SMTP auth credentials. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_URL` | Outbound URL for the generic webhook provider. |
| `OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET` | Required shared secret for generic webhook ingress HMAC signatures and outbound bridge authentication. Inbound generic webhook requests include `x-open-cowork-gateway-webhook-timestamp` and `x-open-cowork-gateway-webhook-signature` over the raw body. |

Hosted/public deployments should keep abuse controls enabled. The defaults are
conservative and can be tuned per deployment; set an individual numeric quota
to `0` to disable that quota for self-hosted/private installs.

| Variable | Meaning |
| --- | --- |
| `OPEN_COWORK_CLOUD_ABUSE_ENABLED` | Enables quota, rate-limit, usage, and auth-backoff enforcement. |
| `OPEN_COWORK_CLOUD_MAX_CONCURRENT_SESSIONS_PER_ORG` | Maximum non-closed cloud sessions per org. |
| `OPEN_COWORK_CLOUD_MAX_ACTIVE_WORKERS_PER_ORG` | Maximum active worker leases per org. |
| `OPEN_COWORK_CLOUD_MAX_PROMPTS_PER_HOUR` | Per-org prompt enqueue quota. |
| `OPEN_COWORK_CLOUD_MAX_GATEWAY_DELIVERIES_PER_HOUR` | Per-org gateway delivery claim quota. |
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
| `OPEN_COWORK_CLOUD_SCHEDULER_ID` | `scheduler`, `all-in-one` | Stable scheduler identity for heartbeats. |
| `OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS` | `scheduler`, `all-in-one` | Workflow scheduler polling interval. |

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
not in the cloud cache.

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
- Public workflow webhooks require HMAC timestamp signatures. Direct `none`
  mode is loopback/local-only. `header` mode is only for a reverse proxy that
  strips caller-supplied identity headers and injects trusted
  `x-open-cowork-*` headers.
