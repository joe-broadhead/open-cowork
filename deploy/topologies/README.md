# Open Cowork Deployment Topology Kits

This directory is the deployment starting point for operators choosing how to
run Open Cowork. Provider recipes under `deploy/gcp/`, `deploy/aws/`,
`deploy/azure/`, `deploy/digitalocean/`, and `deploy/kubernetes/` are overlays
for these topology profiles. They are not separate product architectures.

The machine-readable source of truth is
`deploy/topologies/topology-profiles.json`. Keep it public-template safe:
placeholders only, no project ids, domains, account ids, credentials, customer
names, private evidence, or provider-specific runtime branches.

## Topology Matrix

| Topology | First-class for | Execution authority | Main kit | Production validation |
| --- | --- | --- | --- | --- |
| `desktop-only` | private local development | Desktop Local | `docs/desktop-app.md` | `pnpm test:e2e` |
| `gateway-only` | Telegram-to-VPS OpenCode team | Standalone Team Gateway | `deploy/standalone-gateway/README.md` | `pnpm deploy:standalone-gateway:validate` |
| `cloud-only` | browser/org Cloud workspaces | Cloud worker | `docs/open-cowork-cloud.md` and `helm/open-cowork-cloud/` | `pnpm deploy:validate` |
| `cloud-channel-gateway` | Cloud sessions through chat channels | Cloud worker; Gateway is a channel adapter | `deploy/gateway-appliance/README.md` and `helm/open-cowork-gateway/` | `pnpm deploy:gateway:smoke` |
| `desktop-gateway` | opted-in local Desktop pairing | Desktop Local; broker is a connector | `docs/desktop-outbound-pairing.md` | `pnpm test:e2e` |
| `cloud-gateway-edge` | registered external Gateway/edge authority | Cloud worker or Standalone Gateway per workspace | `docs/cloud-gateway-registration.md` | `pnpm deploy:validate` |
| `full-hybrid` | enterprise combined deployment | explicit per-workspace authority | this matrix plus all smaller kits | `pnpm test:cloud-continuation` |

## Operator Paths

### Desktop Only

Use this path when a user wants private local OpenCode execution with no Cloud
dependency. Desktop owns local sessions, local workflows, local artifacts, and
local settings. Production packaging can preconfigure branding or managed Cloud
connections, but fresh local use must continue to work without any remote
service.

Security boundary:

- no public Desktop or OpenCode port
- no implicit upload of local files, local MCPs, local sessions, or secrets
- renderer receives masked credential metadata

Validation:

```bash
pnpm test:e2e
```

### Gateway Only

Use this path for a solo VPS, private server, Mac mini, or internal host where
the operator wants a headless OpenCode team reachable from Telegram or another
provider without running Cloud.

Minimal solo shape:

1. Private Postgres.
2. `opencode serve` bound to loopback or private network.
3. Standalone Gateway with provider credentials and an admin token.
4. Dashboard/operator endpoints reachable only through a protected network or
   authenticated reverse proxy.

Reference kit:

- `docs/standalone-gateway.md`
- `deploy/standalone-gateway/README.md`
- `deploy/standalone-gateway/standalone.env.example`

Validation:

```bash
pnpm deploy:standalone-gateway:validate
pnpm deploy:standalone-gateway:smoke
```

### Cloud Only

Use this path for self-hosted or managed browser/org workspaces. Production
Cloud is split-role: `web`, `worker`, and `scheduler`. The all-in-one service
and root Compose files are local/demo references unless the deployment tier is
explicitly a focused pilot.

Production inputs:

- managed Postgres
- provider-backed object storage
- managed secret refs or Kubernetes secrets
- OIDC or trusted signed header auth
- worker checkpoints before multiple workers
- `/livez` and `/readyz` probes
- backup/restore evidence

Reference kit:

- `docs/open-cowork-cloud.md`
- `docs/deployment-readiness.md`
- `deploy/README.md`
- `deploy/kubernetes/README.md`
- `helm/open-cowork-cloud/`

Validation:

```bash
pnpm deploy:validate
pnpm deploy:launch:validate
pnpm ops:validate
pnpm test:cloud-web
```

### Cloud Channel Gateway

Use this path when Cloud owns sessions and workers, while Gateway only owns
channel I/O, rendering, provider webhooks/polling, and delivery retries.
Gateway is a Cloud client in this mode. It must not spawn OpenCode, import the
OpenCode SDK, or own Cloud control-plane Postgres state.

Reference kit:

- `docs/gateway-appliance.md`
- `deploy/gateway-appliance/README.md`
- `docker-compose.gateway-remote.yml`
- `docker-compose.cloud-gateway.yml`
- `helm/open-cowork-gateway/`
- `deploy/gateway-appliance/systemd/open-cowork-gateway.service`
- `deploy/gateway-appliance/launchd/com.open-cowork.gateway.plist`

Production requirements:

- scoped Cloud service token
- Gateway admin token for operator endpoints
- provider signing secrets
- HTTPS public URL for webhook providers
- one Gateway replica per shard until distributed stream ownership exists
- delivery drain and rollback plan

The systemd and launchd units are process-manager references for Gateway
appliances. Operators can use the same hardening shape for Cloud Channel
Gateway and Gateway Only hosts, but must keep OpenCode loopback/private unless
the selected topology explicitly assigns execution authority elsewhere.

Validation:

```bash
pnpm deploy:validate
pnpm deploy:gateway:smoke
pnpm deploy:continuation:smoke
```

### Desktop Gateway Pairing

Use this path when Desktop remains the execution authority but an opted-in
Gateway/mobile surface needs access through outbound pairing. This is a
connector, not Cloud sync.

The Desktop process opens the outbound connection. No Desktop or OpenCode port
is exposed publicly. Pairing brokers must implement command leases, revocation,
redacted event relay, and audit.

Reference kit:

- `docs/desktop-outbound-pairing.md`
- `docs/product-contract.md`

Validation:

```bash
pnpm test:e2e
pnpm test
```

### Cloud Gateway Edge

Use this path when Cloud can see or register an external Gateway authority
without automatically taking over its runtime. External workspace registration,
metadata visibility, and future edge execution are explicit. Do not sync raw
Gateway runtime homes, Gateway Postgres, channel credentials, or private
OpenCode state into Cloud.

Reference kit:

- `docs/cloud-gateway-registration.md`
- `docs/gateway-appliance.md`

Validation:

```bash
pnpm deploy:validate
pnpm deploy:gateway:smoke
```

### Full Hybrid

Use this path only after the smaller topologies validate independently. Full
hybrid combines Desktop Local, Cloud, Cloud Channel Gateway, optional
Standalone Gateway, and optional Desktop pairing.

Enterprise rule: every workspace has exactly one execution authority at a
time. Cross-authority movement is explicit import, sync, registration, or
pairing; it is never implicit runtime-home replication.

Validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm deploy:validate
pnpm deploy:launch:validate
pnpm ops:validate
pnpm test:cloud-continuation
```

## Fail-Closed Baseline

Every topology that leaves a laptop must fail closed on:

- unsafe auth or unsigned identity headers
- non-HTTPS public URLs
- missing durable Postgres where the control plane is remote
- filesystem object storage for scaled workers
- weak inline secrets in public production
- public Gateway operator endpoints without admin auth
- provider webhook ingress without signatures or shared secrets
- unbounded fake/demo providers on public binds
- missing backup and restore procedure
- mutable `latest` images in production overlays

Run `pnpm deploy:validate` after changing this directory. The validator checks
the topology profile contract, public-template hygiene, root Compose files,
Helm guardrails, provider recipes, Gateway appliance assets, and launch/ops
docs.
