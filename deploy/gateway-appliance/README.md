# Open Cowork Gateway Appliance

This directory contains copyable deployment assets for running Open Cowork
Gateway as a headless appliance on a VPS, Mac mini, Raspberry Pi, internal
server, or local Docker host.

Gateway remains a Cloud client. It does not spawn OpenCode and does not own
control-plane Postgres state.

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
