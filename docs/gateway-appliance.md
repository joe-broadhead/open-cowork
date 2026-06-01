---
title: Cloud Channel Gateway Appliance
description: Run the Cloud Channel Gateway on a VPS, Mac mini, Raspberry Pi, or internal server.
---

# Cloud Channel Gateway Appliance

The current `apps/gateway` daemon is the **Cloud Channel Gateway**. It is the
headless channel surface for Open Cowork Cloud. It lets users talk to their
cloud workspace from Telegram, Slack, email, webhooks, and future channels
while Cloud remains the source of truth.

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
- Configure `OPEN_COWORK_GATEWAY_ADMIN_TOKEN` before exposing metrics,
  diagnostics, delivery controls, or webhook endpoints.
- Keep the fake provider disabled outside explicit loopback smoke tests.
- Configure a shared secret for the generic webhook provider.
- Rotate Telegram bot tokens and Cloud service tokens after exposure.
- Restrict inbound firewall rules to HTTPS and SSH management.
- Keep env files out of git and command history.

## Migration Notes

Existing deployments that use only `OPEN_COWORK_GATEWAY_MODE=self-host` or
`managed` continue to behave as Cloud Channel Gateway deployments. New configs
should add `OPEN_COWORK_GATEWAY_PRODUCT_MODE=cloud_channel` or
`"productMode": "cloud_channel"` for clarity.

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
