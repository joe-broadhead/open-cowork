---
title: Deployment Topologies
description: First-class deployment profiles for running Open Cowork as Desktop, Cloud, Gateway, paired, edge, or full hybrid systems.
---

# Deployment Topologies

Open Cowork supports multiple deployment shapes without changing the runtime
boundary: OpenCode owns execution, and Open Cowork owns product composition,
policy, projection, deployment, and ergonomics.

The public topology contract lives in
`deploy/topologies/topology-profiles.json`. The operator-facing kit lives in
`deploy/topologies/README.md`.

## Profile Matrix

| Profile | Use when | Execution authority | Primary kit | Validation |
| --- | --- | --- | --- | --- |
| `desktop-only` | a user wants private local work | Desktop Local | [Desktop App](desktop-app.md) | `pnpm test:e2e` |
| `gateway-only` | a user wants a Telegram-to-VPS OpenCode team | Standalone Team Gateway | [Standalone Gateway](standalone-gateway.md) | `pnpm deploy:standalone-gateway:validate` |
| `cloud-only` | an org wants browser Cloud workspaces | Cloud worker | [Open Cowork Cloud](open-cowork-cloud.md) | `pnpm deploy:validate` |
| `cloud-channel-gateway` | Cloud workspaces need chat channels | Cloud worker; Gateway is a channel adapter | [Gateway Appliance](gateway-appliance.md) | `pnpm deploy:gateway:smoke` |
| `desktop-gateway` | a remote surface reaches an opted-in Desktop | Desktop Local; broker is a connector | [Desktop Outbound Pairing](desktop-outbound-pairing.md) | `pnpm test:e2e` |
| `cloud-gateway-edge` | Cloud registers an external Gateway/edge authority | Cloud worker or Standalone Gateway per workspace | [Cloud Gateway Registration](cloud-gateway-registration.md) | `pnpm deploy:validate` |
| `full-hybrid` | enterprise combines all surfaces | Desktop Local, Cloud worker, or Standalone Gateway per workspace | this matrix plus the smaller kits | `pnpm test:cloud-continuation` |

## Choosing A Path

For solo users, start with the smallest topology:

- `desktop-only` for private local development.
- `gateway-only` for an always-on private server or VPS agent.
- `cloud-channel-gateway` only after Cloud is already running.

For organizations, start from the authority that must own execution:

- choose `cloud-only` when Cloud workers should run OpenCode for org sessions
- choose `gateway-only` when an internal team wants a private headless appliance
- choose `desktop-gateway` when the user machine must remain the execution
  authority
- choose `full-hybrid` only after the smaller profiles are independently
  validated

## Production Boundaries

Every topology has a different security boundary:

- Desktop Local keeps local files, local MCPs, local sessions, and provider
  credentials local unless the user explicitly connects Cloud or imports data.
- Standalone Gateway owns private Gateway Postgres and private OpenCode
  execution; OpenCode must stay loopback/private.
- Cloud owns Cloud workspace state, durable event projection, BYOK metadata,
  artifacts, workflow runs, and worker leases.
- Cloud Channel Gateway is a Cloud client. It owns channel I/O, not execution.
- Desktop pairing is outbound from Desktop and does not expose Desktop or
  OpenCode publicly.
- Cloud Gateway edge registration is explicit metadata or edge-execution trust;
  it is not implicit runtime-home sync.

These boundaries are visible in the workspace support matrix. If a capability
is deferred, read-only, or not supported for an authority, the product should
say so rather than pretending all surfaces are equivalent.

## Required Validation

Run topology-level validators before provider rollout:

```bash
pnpm deploy:validate
pnpm deploy:launch:validate
pnpm ops:validate
```

Add surface smokes based on the selected profile:

```bash
pnpm test:e2e
pnpm test:cloud-web
pnpm test:cloud-continuation
pnpm deploy:gateway:smoke
pnpm deploy:standalone-gateway:smoke
```

Provider-specific preflight/smoke commands such as `pnpm deploy:gcp:preflight`
and `pnpm deploy:gcp:smoke` belong in a private deployment repo when they
produce raw cloud evidence. Public docs and templates must keep placeholders
such as `PROJECT`, `ACCOUNT`, `REGION`, `OPEN_COWORK_BUCKET`, and
`cowork.example.com`.
