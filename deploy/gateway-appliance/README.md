# Open Cowork Gateway Appliance

This directory contains copyable deployment assets for running Open Cowork
Gateway as a headless appliance on a VPS, Mac mini, Raspberry Pi, internal
server, or local Docker host.

Gateway remains a Cloud client. It does not spawn OpenCode and does not own
control-plane Postgres state.

## VPS/Local Compose Recipe

Use this path for self-hosted Gateway appliances and small local Cloud pilots:

| Mode | Compose file | Backing services | Intended use |
| --- | --- | --- | --- |
| Remote Cloud | `docker-compose.gateway-remote.yml` | Existing managed Cloud plus this host's Gateway process | VPS, Mac mini, Raspberry Pi, or internal server channel appliance |
| Local all-in-one | `docker-compose.cloud-gateway.yml` | Cloud, Postgres, MinIO, and Gateway on one Docker host | Local demos, OSS self-host pilots, and internal installs |

The Compose files are provider-config only. Keep real domains, tokens, bot
tokens, SMTP credentials, and webhook secrets in a private `.env.gateway` file
or host secret store. Do not commit generated env files. Local all-in-one mode
uses the same `open-cowork-cloud` and `open-cowork-gateway` images as the
managed provider recipes.

## Modes

Remote Cloud mode runs only Gateway on this host:

```bash
node scripts/gateway-appliance-setup.mjs \
  --mode remote \
  --cloud-url https://cowork.example.com \
  --service-token "$OPEN_COWORK_GATEWAY_SERVICE_TOKEN" \
  --telegram-bot-token "$OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN" \
  --output .env.gateway

docker compose --env-file .env.gateway -f docker-compose.gateway-remote.yml up -d --build
```

Local all-in-one mode runs Cloud, Postgres, MinIO, and Gateway together:

```bash
node scripts/gateway-appliance-setup.mjs \
  --mode local \
  --telegram-bot-token "$OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN" \
  --output .env.gateway

docker compose --env-file .env.gateway -f docker-compose.cloud-gateway.yml up -d --build
```

The local all-in-one path is for self-hosted OSS pilots and internal installs.
It does not require commercial billing.

## Shared Validation

Run the same deployment validators and smokes as the managed provider recipes:

```bash
pnpm deploy:validate

OPEN_COWORK_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_SMOKE_GATEWAY_URL=https://gateway.example.com \
pnpm deploy:smoke

OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL=https://gateway.example.com \
OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN=... \
pnpm deploy:gateway:smoke

OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL=https://cowork.example.com \
OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN=... \
OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION=true \
pnpm deploy:continuation:smoke
```

For local all-in-one smoke checks, use localhost URLs and keep
`OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true` loopback-only.

## Files

- `remote-cloud.env.example`: remote Cloud Gateway env template.
- `local-all-in-one.env.example`: local Cloud + Gateway env template.
- `systemd/open-cowork-gateway.service`: Linux, VPS, and Raspberry Pi unit.
- `launchd/com.open-cowork.gateway.plist`: macOS and Mac mini LaunchDaemon.
- `reverse-proxy/Caddyfile.example`: TLS reverse proxy example for public
  Telegram webhook mode.

## Public Installs

Keep the Gateway bound to `127.0.0.1` unless a reverse proxy, firewall, TLS
certificate, and admin token are configured. Public Telegram webhook mode
requires:

- `OPEN_COWORK_GATEWAY_PUBLIC_URL=https://gateway.example.com`
- `OPEN_COWORK_GATEWAY_TELEGRAM_MODE=webhook`
- `OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET`
- `OPEN_COWORK_GATEWAY_ADMIN_TOKEN`

Rotate the Cloud service token and bot token if any env file, shell history, or
process dump is exposed.
