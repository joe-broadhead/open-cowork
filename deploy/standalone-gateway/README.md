# Open Cowork Standalone Gateway

This directory contains deployment assets for the Gateway-only execution
appliance. It is separate from the Cloud Channel Gateway under
`deploy/gateway-appliance`.

This is the `gateway-only` topology profile from
`deploy/topologies/topology-profiles.json`. Use
`deploy/topologies/README.md` when comparing it with Desktop-only, Cloud-only,
Cloud Channel Gateway, Desktop pairing, edge registration, and full-hybrid
deployments.

Standalone Gateway owns private OpenCode execution and Gateway Postgres. It
does not require Open Cowork Cloud.

## Minimal VPS Shape

1. Run Postgres on a private network.
2. Run `opencode serve` bound to `127.0.0.1` or another private address.
3. Generate a private env file:

```bash
pnpm standalone-gateway:setup -- \
  --opencode-url http://127.0.0.1:4096 \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN" \
  --output .env.standalone-gateway
```

4. Run:

```bash
pnpm build:standalone-gateway
set -a
. ./.env.standalone-gateway
set +a
pnpm --filter @open-cowork/standalone-gateway start
```

## Files

- `standalone.env.example`: private environment template.

## Production Requirements

- OpenCode must stay loopback/private. Never expose the OpenCode port publicly.
- `OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL` must point to durable Postgres.
- Dashboard access requires `OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN`.
- Provider webhook ingress must use shared-secret/HMAC verification.
- Backups must cover Postgres and artifact storage.
- Retention windows must be explicit for sessions, artifacts, and audit events.

Validate the static deployment contract with:

```bash
pnpm deploy:standalone-gateway:validate
```
