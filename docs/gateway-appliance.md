---
title: Cloud Channel Gateway Appliance
description: Run the Cloud Channel Gateway on a VPS, Mac mini, Raspberry Pi, or internal server.
---

# Cloud Channel Gateway Appliance

The current `apps/gateway` daemon is the **Cloud Channel Gateway**. It is the
headless channel surface for Open Cowork Cloud. It lets users talk to their
cloud workspace from Telegram, Slack, email, webhooks, and future channels
while Cloud remains the source of truth.

Use the `cloud-channel-gateway` topology profile when deploying this daemon.
The profile is documented in [Deployment Topologies](deployment-topologies.md)
and in `deploy/topologies/topology-profiles.json`.

Cloud Channel Gateway is not an OpenCode runtime. It owns channel I/O, command
parsing, provider-specific rendering, approvals/questions UX, and delivery
retries. Cloud owns tenancy, sessions, commands, projections, workflows,
artifacts, and OpenCode execution.

Cloud Channel Gateway participates in the shared
[Coordination Model](coordination-model.md) only through Cloud-owned state:
Cloud workflows create Runs, Cloud schedules are read by the Gateway for
delivery context, channel delivery subscriptions are Watches, and channel
approval/question interactions render Cloud-owned Questions and Permissions.
It must not create Gateway-owned Projects, Tasks, or Delegations in this mode.

Standalone Team Gateway is a separate product mode. It may own a private
OpenCode runtime and Gateway Postgres, but it is implemented by
`apps/standalone-gateway`, not by `apps/gateway`, and must not be enabled
through this daemon.

Provider tiers, capabilities, signing requirements, and test expectations are
tracked in [Gateway Provider Readiness](gateway-provider-readiness.md).
Product naming, historical `opencode-agent-gateway` migration, and compatibility
alias policy are tracked in
[OSS Packaging and Gateway Migration](oss-packaging-migration.md).

## Product Modes

Gateway has two independent mode concepts:

- `OPEN_COWORK_GATEWAY_PRODUCT_MODE`: execution authority. The current daemon
  supports only `cloud_channel`.
- `OPEN_COWORK_GATEWAY_MODE`: deployment posture for this daemon. Existing
  values remain `self-host` and `managed`; this affects diagnostics and
  operator labeling only.

| Product mode | Execution authority | Current support |
| --- | --- | --- |
| `cloud_channel` | Cloud workers execute; Gateway is a Cloud HTTP/SSE client. | Supported by `apps/gateway`. |
| `standalone` | Gateway owns private OpenCode runtime and Gateway Postgres. | Supported by `apps/standalone-gateway`; current daemon fails closed. |
| `hybrid` | Cloud-connected edge/standalone authority. | Reserved for a later trust and registration design. |

Existing Gateway deployments are Cloud Channel Gateways. To make that explicit,
set:

```bash
OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel
```

## Supported Cloud Channel Deployments

### Remote Cloud

Use remote Cloud deployment when you already run Open Cowork Cloud somewhere
else and want a small Cloud Channel Gateway process on a VPS, Mac mini,
Raspberry Pi, or internal server.

Required inputs:

- `OPEN_COWORK_CLOUD_BASE_URL`: HTTPS Cloud URL.
- `OPEN_COWORK_GATEWAY_SERVICE_TOKEN`: gateway-scoped Cloud API token.
- At least one provider credential such as
  `OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN`.

Generate a private env file:

```bash
pnpm gateway:setup -- \
  --mode remote \
  --cloud-url https://cowork.example.com \
  --service-token "$OPEN_COWORK_GATEWAY_SERVICE_TOKEN" \
  --telegram-bot-token "$OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN" \
  --output .env.gateway
```

Run with Compose:

```bash
docker compose --env-file .env.gateway -f docker-compose.gateway-remote.yml up -d --build
```

The remote Compose file binds Gateway to `127.0.0.1` by default. Put a reverse
proxy in front of it for public webhook mode.

### Local All-In-One

Use local all-in-one deployment for self-hosted OSS pilots and internal
appliances. It runs Cloud all-in-one, Postgres, MinIO, and Cloud Channel
Gateway on one host:

```bash
pnpm gateway:setup -- \
  --mode local \
  --telegram-bot-token "$OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN" \
  --output .env.gateway

docker compose --env-file .env.gateway -f docker-compose.cloud-gateway.yml up -d --build
```

This mode does not require commercial billing. Keep it private unless you have
configured TLS, firewall rules, Cloud auth, Gateway admin token, and provider
webhook secrets.

## Telegram

Polling is the simplest private install path:

```bash
OPEN_COWORK_GATEWAY_TELEGRAM_MODE=polling
```

Webhook mode is for public installs behind HTTPS:

```bash
OPEN_COWORK_GATEWAY_HOST=0.0.0.0
OPEN_COWORK_GATEWAY_PUBLIC_URL=https://gateway.example.com
OPEN_COWORK_GATEWAY_TELEGRAM_MODE=webhook
OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET=replace-with-random-secret
OPEN_COWORK_GATEWAY_ADMIN_TOKEN=replace-with-random-admin-token
```

The global Gateway public URL populates the Telegram provider public URL unless
`OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL` is set. Startup fails if webhook mode
does not have a public HTTPS URL and webhook secret.

## Service Management

Linux, VPS, and Raspberry Pi:

1. Install the repo under `/opt/open-cowork`.
2. Store env values in `/etc/open-cowork/gateway.env` with mode `0600`.
3. Copy `deploy/gateway-appliance/systemd/open-cowork-gateway.service` to
   `/etc/systemd/system/open-cowork-gateway.service`.
4. Run `systemctl daemon-reload`, `systemctl enable --now open-cowork-gateway`.
5. Read logs from `/var/log/open-cowork/gateway.log` or `journalctl -u
   open-cowork-gateway`.

macOS and Mac mini:

1. Install the repo under `/opt/open-cowork`.
2. Store config at `/etc/open-cowork/gateway.json` or use a private wrapper
   that exports environment values before launching.
3. Copy `deploy/gateway-appliance/launchd/com.open-cowork.gateway.plist` to
   `/Library/LaunchDaemons/com.open-cowork.gateway.plist`.
4. Load it with `launchctl bootstrap system
   /Library/LaunchDaemons/com.open-cowork.gateway.plist`.
5. Read logs from `/var/log/open-cowork/gateway.log` and
   `/var/log/open-cowork/gateway-error.log`.

## Public Security Checklist

- Use HTTPS for every public Cloud and Gateway URL.
- Keep Gateway loopback-bound unless a reverse proxy terminates TLS.
- Configure `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` before exposing operator
  endpoints: `/metrics`, `/diagnostics`, `/deliveries`, and delivery retry or
  dead-letter actions.
- Gateway `/deliveries` lists only enabled provider `channelBindingId` values
  from the local daemon config. Retry and dead-letter actions are protected by
  the Gateway admin token locally and by the Cloud service-token owner of the
  last delivery claim in Cloud, so one gateway token cannot operate on another
  gateway shard's backlog.
- Public reverse proxies must strip untrusted
  `x-open-cowork-gateway-admin-token` headers and either block operator
  endpoints or require the Gateway admin bearer token.
- If Gateway is behind a reverse proxy and must use forwarded client IPs for
  webhook abuse controls, set `OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS=true`
  and restrict `OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS` to the proxy hops.
- Route public `/webhooks/*` only for providers with provider-native signing or
  shared-secret verification enabled. Webhook auth is provider auth, not the
  Gateway operator token.
- Keep the fake provider disabled outside explicit loopback smoke tests.
- Configure a shared secret for the generic webhook and bridge providers.
- Keep provider `maxAttachmentBytes` at or below
  `OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES`; startup rejects inline
  attachment limits that exceed the daemon request-body cap.
- Rotate Telegram bot tokens and Cloud service tokens after exposure.
- Restrict inbound firewall rules to HTTPS and SSH management.
- Keep env files out of git and command history.

## Operator Auth Threat Model

| Deployment | Operator endpoint contract |
| --- | --- |
| Loopback development | `OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS=true` is allowed only when the daemon is self-hosted, bound to loopback, has no public URL, and the request is not proxy-forwarded. |
| VPS behind reverse proxy | Prefer keeping the daemon on `127.0.0.1`; set `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`; proxy `/webhooks/*` to providers and block or separately protect `/metrics`, `/diagnostics`, and `/deliveries*`. |
| Public bind | Set `OPEN_COWORK_GATEWAY_PUBLIC_URL=https://...` and `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`; never enable loopback bypass, fake provider, or CLI provider. |
| Kubernetes/managed | Use the Helm chart with `replicaCount: 1`, `gateway.existingSecret`, HTTPS ingress, and an admin token. Use one release per channel-binding shard until distributed stream ownership is implemented. |

## Migration Notes

Existing deployments that use only `OPEN_COWORK_GATEWAY_MODE=self-host` or
`managed` continue to behave as Cloud Channel Gateway deployments. New configs
should add `OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel` or
`"productMode": "cloud_channel"` for clarity.

If you are migrating from the historical `opencode-agent-gateway` prototype,
read [OSS Packaging and Gateway Migration](oss-packaging-migration.md) before
moving state. The old Gateway-owned Postgres and OpenCode runtime state is not
safe to import into Cloud automatically.

Do not set `standalone` on this daemon. Standalone Team Gateway uses a separate
app/package layout at `apps/standalone-gateway` so it can own private
runtime state without weakening the Cloud Channel Gateway boundary. See
[Standalone Gateway](standalone-gateway.md).

## Delivery Drain And Local State

Cloud Channel Gateway keeps Cloud as the authoritative store for channel
bindings, cursors, deliveries, sessions, workflows, and audit events. The
appliance does not need a local database for production state. On shutdown,
Gateway closes new Cloud delivery subscriptions, drains in-flight delivery
sends, acknowledges completed deliveries, then stops providers. A restart
resumes from Cloud-owned cursors and delivery records.

Inbound provider events are also Cloud-owned. Before Gateway binds a channel
thread or sends a prompt to Cloud, it claims a durable provider event keyed by
organization, provider, provider instance, external workspace, event type, and
the provider event id. A duplicate or already processed event becomes a no-op
even if the Gateway process restarted and lost its provider-local replay cache.
A processing claim can be reclaimed only after its lease expires, and a failed
claim can be retried only when it was marked retryable.

Production providers must send stable inbound event ids. Telegram uses
`update_id`; Slack uses the signed event or interaction id; email and generic
webhook/bridge providers must provide a stable message, delivery, or webhook
`id`. Generic webhook payloads that omit `id` are accepted for developer
convenience but cannot receive durable duplicate suppression after a process
restart because the provider must synthesize a new event id.

Outbound delivery idempotency flows the other direction. Cloud delivery ids are
the canonical downstream idempotency keys. Gateway passes the Cloud
`deliveryId` to provider sends; webhook and bridge providers include it as
`deliveryId`, `idempotencyKey`, and
`x-open-cowork-gateway-delivery-id`. Multi-part text deliveries use stable
chunk ids in the form `<cloud-delivery-id>:chunk:<n>` so downstream bridges can
dedupe each chunk without conflating it with the parent delivery.

Webhook and bridge outbound delivery is fail-closed by default. Delivery URLs
must use HTTPS except for loopback development, cannot contain embedded
credentials, and cannot target private or reserved IP literals. Before every
send, the provider resolves the configured host, rejects private/reserved
answers, rejects localhost names that rebind to public addresses, and pins the
HTTP/S request to the validated address. Use delivery host allowlists for
managed bridge deployments. Private/internal bridge delivery requires an
explicit `allowPrivateDelivery` deployment option and should be treated as a
risk-bearing internal mode in downstream diagnostics and runbooks.
For env-based appliance config, use
`OPEN_COWORK_GATEWAY_WEBHOOK_ALLOW_PRIVATE_DELIVERY=true` or
`OPEN_COWORK_GATEWAY_<BRIDGE>_ALLOW_PRIVATE_DELIVERY=true` for bridge providers,
and scope public bridge hosts with `*_DELIVERY_ALLOWED_HOSTS`.

Gateway delivery retries use bounded exponential backoff with jitter. Webhook
providers retry HTTP 429/5xx, network, and timeout failures; HTTP 429 respects
`Retry-After` within the configured maximum delay. Persistent transient
failures open a provider delivery circuit, stop hot-looping the downstream
bridge, and surface the circuit as degraded provider health in `/ready` and
`/diagnostics`. URL/DNS policy failures and oversized delivery responses are
permanent and should dead-letter instead of retrying.

Operator delivery controls are intentionally shard-aware. The Gateway daemon
subscribes to Cloud deliveries with its enabled `channelBindingId` list, so it
does not claim unrelated provider backlog. Cloud records the API-token id that
last claimed each delivery. A gateway-scoped token can list, retry, or
dead-letter only deliveries last claimed by that same token; channel admins can
perform broader channel-management recovery from Cloud. Gateway `/diagnostics`
exposes a redacted `deliveryOperator` block with `listAllowed`, `retryAllowed`,
`deadLetterAllowed`, the scoped `channelBindingIds`, and a reason when a control
is unavailable.

Session-event rendering is ordered by Cloud event sequence. If provider
rendering fails transiently, Gateway reconnects from the last persisted cursor
and prevents later queued events from jumping the failed event. If retry budget
is exhausted, Gateway skips the poison event, advances the Cloud-owned cursor,
and exposes aggregate counters such as
`open_cowork_gateway_session_render_dead_letters_total` and
`open_cowork_gateway_dropped_session_events_total` for operator follow-up.

## Upgrade And Rollback

For Compose installs:

```bash
docker compose --env-file .env.gateway -f docker-compose.gateway-remote.yml pull
docker compose --env-file .env.gateway -f docker-compose.gateway-remote.yml up -d --build
docker compose --env-file .env.gateway -f docker-compose.gateway-remote.yml logs -f open-cowork-gateway
```

Rollback by checking out the previous git tag or image tag and running the same
`up -d` command. Gateway stores durable state in Cloud, so rollback should not
require local database migration.

For systemd or launchd installs, pull or checkout the target release, run
`pnpm install --frozen-lockfile && pnpm build:gateway`, then restart the
service. Keep the previous release directory or image tag until `/ready`
returns healthy and a test message reaches Cloud.

## Validation

Run these before treating an appliance as healthy:

```bash
pnpm deploy:validate
pnpm deploy:gateway:smoke
```

Then check the local endpoints:

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/ready
```

For public installs, query operator endpoints only with the admin token:

```bash
curl -H "Authorization: Bearer $OPEN_COWORK_GATEWAY_ADMIN_TOKEN" \
  https://gateway.example.com/metrics
```
