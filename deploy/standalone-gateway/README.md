# Open Cowork Standalone Gateway

This directory contains deployment assets for the Gateway-only execution
appliance. It is separate from the Cloud Channel Gateway under
`deploy/gateway-appliance`.

This is the `gateway-only` topology profile from
`deploy/topologies/topology-profiles.json`. Use
`deploy/topologies/README.md` when comparing it with Desktop-only, Cloud-only,
Cloud Channel Gateway, Desktop pairing, edge registration, and full-hybrid
deployments.

For product naming, release channels, and migration from the historical
`opencode-agent-gateway` prototype, see
`docs/oss-packaging-migration.md`.

Standalone Gateway owns private OpenCode execution and Gateway Postgres. It
does not require Open Cowork Cloud.

## Minimal VPS Shape

1. Run Postgres on a private network.
2. Run `opencode serve` bound to `127.0.0.1` or another private address.
3. Generate a private env file:

```bash
pnpm standalone-gateway:setup -- \
  --admin-token "$OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN" \
  --opencode-url http://127.0.0.1:4096 \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN" \
  --output .env.standalone-gateway
```

The helper refuses public OpenCode URLs and writes the env file with mode
`0600`. It will not print provided secrets unless `--allow-secret-print` is set.

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
- If webhook ingress is reverse-proxied and forwarded client IPs are needed for
  abuse controls, set `OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS=true`
  with `OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS` restricted to those
  proxy hops.
- Backups must cover Postgres and artifact storage.
- Retention windows must be explicit for sessions, artifacts, and audit events.

Validate the static deployment contract with:

```bash
pnpm --filter @open-cowork/standalone-gateway doctor
pnpm deploy:standalone-gateway:smoke
pnpm deploy:standalone-gateway:validate
```
