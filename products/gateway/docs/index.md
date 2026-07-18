---
hide:
  - navigation
---

# OpenCode Gateway

OpenCode Gateway is a **local durable work coordinator for OpenCode**. It
gives OpenCode agents persistent Initiatives and Issues, a scheduler with
capacity admission and human-loop gates, Telegram channel bindings, a
Mission Control dashboard, and deterministic MCP control tools — without
creating a second agent runtime.

OpenCode owns sessions, agents, skills, tools, permissions, and model
execution; Gateway owns the durable work that outlives any one session. See
the [Product Contract](concepts/product-contract.md) for the full ownership
boundary.

## Start Here

1. [Operator Mental Model](getting-started/operator-mental-model.md) — the
   product contract, first workflow, and capability states in five minutes.
2. [Installation](getting-started/installation.md) and
   [Quickstart](getting-started/quickstart.md).
3. [OpenCode Setup](getting-started/opencode-setup.md) — give your agents
   the `gateway_*` MCP tools.
4. [CLI Reference](getting-started/cli.md).

## What You Can Do

- **Durable work** — create Initiatives and Issues that survive restarts;
  see [Durable Work](concepts/durable-work.md) and the
  [Gateway Method](concepts/gateway-method.md).
- **Deliberate scheduling** — capacity admission, budgets, retries, leases,
  and an emergency stop; see
  [Capacity And Backpressure](concepts/capacity-backpressure.md) and
  [Scheduler Profiles](configuration/scheduler-profiles.md).
- **Human-in-the-loop** — pipeline human gates plus OpenCode permission and
  question routing; see [Human Loop](operations/human-loop.md).
- **Agent teams** — profiles, team lifecycles, blueprints, and eval-driven
  promotion; see [Agent Teams](configuration/agent-teams.md) and
  deterministic promotion scorecards.
- **Channels** — Telegram commands, presence, and trusted-sender gating into
  linked OpenCode sessions; see [Channels](configuration/channels.md) and
  the [Channel Adapter Contract](concepts/channel-adapter-contract.md).
- **Mission Control** — the operator dashboard with live updates, alerts,
  attention routing, and release claims; see
  [Mission Control](concepts/mission-control.md).
- **Operations** — doctor, readiness, backup/restore, recovery drills,
  redacted incident bundles; see [Running Gateway](operations/running.md),
  [Backup And Restore](operations/backup-restore.md), and
  [Troubleshooting](operations/troubleshooting.md).

## Release Status

Gateway is a **public local beta for one trusted local operator**. The
claim boundary is machine-enforced: `opencode-gateway release claims`
prints it, and `npm run release:check` fails on any public copy that
exceeds it. Production certification remains blocked; hosted/team, SaaS,
and multi-tenant readiness remain blocked; universal-channel readiness
remains blocked; arbitrary scale remains blocked; unattended operation
remains blocked. The distilled decision history is in the
[Decision Log](history/decision-log.md).

## Architecture

See [Architecture](concepts/architecture.md),
[Product Contract](concepts/product-contract.md), and
[Codebase Boundaries](concepts/codebase-boundaries.md). The API surface is
documented in [MCP Tools](api/mcp-tools.md),
[HTTP API](api/http-api.md), and
[Channel Commands](api/channel-commands.md).
