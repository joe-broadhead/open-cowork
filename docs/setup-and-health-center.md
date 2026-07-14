---
title: Setup And Health Center
description: First-run paths, authority-aware readiness, and recovery checks for Desktop, Gateway, and Cloud.
---

# Setup And Health Center

Open Cowork has three first-class product surfaces: Desktop, Cloud Web, and
Gateway. The Setup and Health Center makes those surfaces explicit instead of
assuming one deployment shape.

The contract is authority-aware: every thread belongs to one workspace and one
execution authority. Health checks tell an operator or end user which authority
owns execution, which control plane owns state, and what recovery action is
safe.

## First-Run Setup Paths

The shared setup contract in `packages/shared/src/setup-health.ts` defines these
paths:

| Intent | Topology | Execution authority | Use when |
| --- | --- | --- | --- |
| `desktop-local` | `desktop-only` | `desktop_local` | A developer wants to Run Desktop locally with local OpenCode execution. |
| `gateway-only` | `gateway-only` | `gateway_standalone` | A solo user wants a headless agent on a VPS or private server. |
| `cloud-connect` | `cloud-only` | `cloud_worker` | A user wants Desktop and Cloud Web synced through Open Cowork Cloud. |
| `desktop-pairing` | `desktop-gateway` | `desktop_paired` | An opted-in Desktop should receive remote prompts without exposing a listener. |
| `full-hybrid` | `full-hybrid` | mixed | An org runs Desktop, Cloud Web, Cloud Channel Gateway, and optional Gateway-only or paired authorities. |

Desktop first run shows these paths before provider setup. Selecting a path does
not upload local state or secrets. Local Desktop remains the default; Cloud and
Gateway paths point users to deployer-owned setup, doctor, and smoke commands.

## Health Center Surface

The Desktop Health Center reads existing product APIs:

- `runtime.status()` for Desktop runtime readiness.
- `app.runtimeInputs()` for provider/model metadata, capability provenance,
  conflicts, and stable reason codes without raw secret values.
- `workspace.list()` and `workspace.support()` for workspace authority and
  policy verdicts.
- `desktopPairing.list()` for outbound pairing status.

It shows these states:

- `ready`
- `action_required`
- `degraded`
- `offline`
- `unknown`

The page intentionally shows metadata, not raw credentials. It must not render
provider API keys, OAuth tokens, gateway service tokens, desktop pairing tokens,
MCP secrets, local file bodies, or env files.

Runtime capability provenance rows show why provider, model, MCP, skill, agent,
tool, workflow, and OpenCode-plugin capabilities are active or unavailable.
Rows include source, product mode, status, reason code, and redacted evidence.
Conflict rows show the winning source and losing sources. This is the
operator-facing view for reason codes such as `mcp.awaiting-oauth-opt-in`,
`mcp.stdio-policy-blocked`, `plugin.product-mode-unsupported`, and
`model.source-conflict-winner`.

## Recovery Actions

Health states should be actionable:

- Desktop runtime not ready: restart the runtime, then verify provider and model
  configuration.
- Provider credentials missing: open first-run setup or Settings and configure a
  provider.
- Cloud auth required: sign in to the Cloud org or rotate the desktop token.
- Cloud offline: check URL, bearer token, network, and `/readyz`.
- Cloud database not migrated: run deploy validation and Postgres migration
  checks before routing traffic.
- Cloud object store missing: configure provider-backed object storage for
  artifacts, checkpoints, uploads, and diagnostics.
- Gateway private OpenCode unreachable: run the standalone doctor and keep
  OpenCode loopback/private.
- Gateway provider unhealthy: check provider token, signing secret, webhook URL,
  and provider readiness.
- Gateway operator auth missing: set an admin token before exposing diagnostics,
  metrics, readiness, or delivery controls.
- Pairing expired or offline: reconnect or revoke and recreate the pairing.

## Solo Gateway Path

For a solo Gateway-only deployment:

```bash
pnpm standalone-gateway:setup -- \
  --admin-token "$OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN" \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN" \
  --opencode-url http://127.0.0.1:4096 \
  --runtime-root /var/lib/open-cowork/standalone-gateway \
  --output .env.standalone-gateway

pnpm build:standalone-gateway
pnpm --filter @open-cowork/standalone-gateway doctor
pnpm deploy:standalone-gateway:smoke
pnpm deploy:standalone-gateway:validate
```

The setup script writes env files with mode `0600`, refuses public OpenCode
URLs, and refuses to print provided secrets unless `--allow-secret-print` is
explicitly set. Keep generated env files out of git.

## Cloud Channel Gateway Path

For a Gateway that is a Cloud channel adapter:

```bash
pnpm gateway:setup -- \
  --mode remote \
  --cloud-url https://cloud.example.com \
  --service-token "$OPEN_COWORK_GATEWAY_SERVICE_TOKEN" \
  --telegram-bot-token "$TELEGRAM_BOT_TOKEN" \
  --output .env.gateway

pnpm deploy:gateway:smoke
pnpm deploy:validate
pnpm ops:validate
```

Public webhook mode requires HTTPS, provider signing/HMAC, and an operator admin
token. The Gateway service token authenticates the Gateway process; inbound
channel actor identity is still resolved separately.

## Org Cloud Readiness

Org admins should verify Cloud before inviting users:

```bash
pnpm deploy:validate
pnpm ops:validate
pnpm test:cloud-continuation
```

Before public or enterprise rollout, also run load, soak, failover, backup, and
restore evidence gates from the launch readiness runbooks.

## Validation

The setup and health contract is covered by:

```bash
node --no-warnings --experimental-strip-types --test tests/setup-health-contract.test.ts
node --no-warnings --experimental-strip-types --test tests/standalone-gateway-setup.test.ts
node --no-warnings --experimental-strip-types --test tests/runtime-input-diagnostics.test.ts
pnpm test:renderer -- HealthCenterPage
pnpm deploy:validate
pnpm ops:validate
pnpm docs:build
```

The release expectation is simple: Desktop-only users can start immediately,
solo Gateway users can generate safe config and run doctor/smoke checks, and org
admins can see Cloud/Gateway readiness before routing real traffic.
