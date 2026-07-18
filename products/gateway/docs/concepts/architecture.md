# Architecture

Gateway runs as a local daemon next to OpenCode. The daemon exposes a localhost HTTP API and a browser dashboard. The Gateway MCP server is a local stdio process that proxies tool calls to that daemon.

```text
OpenCode Web/TUI (:4096)
  sessions, messages, agents, skills, MCPs, tools, permissions, questions
        ^
        | OpenCode SDK calls and Gateway MCP tools
        v
Gateway Daemon (:4097)
  HTTP API, scheduler, heartbeat, dashboard, channel adapters, channel sync
        ^
        | SQLite + audited local state sources
        v
~/.config/opencode-gateway/gateway.db
  roadmaps, tasks, runs, workflow events, channel bindings

Telegram / WhatsApp
  inbound messages -> linked OpenCode sessions -> outbound sync
```

## Runtime Processes

The canonical ownership boundary lives in the [Product Contract](product-contract.md); this table maps it to the local runtime processes.

| Process | Responsibility |
| --- | --- |
| OpenCode | Owns agent runtime, sessions, tools, permissions, questions, and UI. |
| Gateway daemon | Owns durable state, scheduler, dashboard, channels, and service API. |
| Gateway MCP | Stdio MCP server that exposes deterministic `gateway_*` tools to OpenCode. |
| Channel adapters | Translate Telegram, WhatsApp, and future channel messages into OpenCode session prompts under the [Channel Adapter Contract](channel-adapter-contract.md). |

## Core Domain Navigation

Use this table before editing. Start at the owner module, then update the edge adapter only when the
owner cannot express the behavior yet. The deeper agent workflow and worker briefs are in the
[Architecture Handoff Map](../development/architecture-handoff-map.md).

| Domain | Start in | Edges | First validation |
| --- | --- | --- | --- |
| Orchestration and stage planning | `src/orchestration-kernel.ts` | `src/scheduler.ts`, `src/daemon-routes/work.ts` | Orchestration kernel and scheduler tests. |
| Scheduler and durable leases | `src/scheduler.ts`, `src/capacity.ts`, `src/work-store/run-lease-port.ts` | Heartbeat, worker dispatch, daemon work routes | Scheduler, run/lease port, and work-store invariant tests. |
| Storage, backup, recovery | `src/work-store/schema.ts`, `src/work-store/repositories.ts`, `src/storage.ts` | CLI storage/backup commands, readiness, backup doctor | Storage and work-store invariant tests. |
| Runtime environments | `src/environments.ts`, `src/runtime-isolation.ts` | Scheduler runtime selection | Environments and runtime isolation tests. |
| Channels and trusted commands | `src/channel-commands.ts`, `src/channels/renderer.ts`, `src/channels/capabilities.ts`, `src/channels/provider.ts` | Telegram, WhatsApp, Discord adapters and setup routes | Channel command, renderer, adapter contract, and provider tests. |
| Security and capability policy | `src/security-policy.ts`, `src/security.ts` | HTTP exposed mode, MCP, channel commands, packages, secrets | Security policy, route/security tests. |
| Evidence, readiness, and redaction | `src/evidence-export.ts`, `src/incident-bundle.ts`, `src/operational-redaction.ts`, `src/readiness.ts` | CLI, docs, readiness, incident bundle, release notes | Evidence export, incident bundle, readiness, redaction and claim sweeps. |
| Agent Factory, profiles, teams | `src/agent-catalog.ts`, `src/team-assembly.ts` | Profile promotion, team assignment | Agent catalog and team assembly tests. |
| Mission Control and MCP summaries | `src/mission-control-view-model.ts`, `src/mission-data.ts` | `src/dashboard.ts`, `src/mcp.ts`, daemon system routes | Mission Control view-model, dashboard, and MCP tests. |
| OpenCode asset governance | `src/opencode-assets.ts`, `src/opencode-defaults.ts` | Setup, asset apply/rollback, readiness | Setup, asset, and profile drift tests. |
| CLI and HTTP routes | `src/cli.ts`, `src/daemon-router.ts`, `src/daemon-routes/` | Local operator commands, JSON routes, MCP proxy | Route-specific tests, daemon route tests, CLI smoke where applicable. |
| Docs and release operations | `docs/`, `mkdocs.yml`, `scripts/check-release.mjs` | README, changelog, CI/release checks | Strict MkDocs, release check, redaction/no-secrets sweep, unsupported-claim audit. |

## Route Modules

The daemon keeps runtime wiring in `src/daemon.ts` and JSON route behavior in explicit modules:

| Module | Routes |
| --- | --- |
| `daemon-routes/system.ts` | Health, doctor, logs, config, restart, shutdown. |
| `daemon-routes/work.ts` | Roadmaps, tasks, runs, workflow events, scheduler, profiles. |
| `daemon-routes/opencode.ts` | OpenCode sessions, questions, permissions, agents, skills, MCPs, tools. |
| `daemon-routes/channels.ts` | Channel bindings and outbound channel sends. |

## Storage Files

| Path | Purpose |
| --- | --- |
| `~/.config/opencode-gateway/config.json` | Gateway config and scheduler profiles. |
| `~/.config/opencode-gateway/gateway.db` | Authoritative SQLite source for durable work, runs, events, channel bindings, gates, alerts, and local daemon leadership. |
| `~/.config/opencode-gateway/channel-sync.json.sqlite` | Transactional channel sync outbox for pending, leased, and delivered outbound sync messages. |
| `~/.config/opencode-gateway/channel-sync.json` | Derived channel delivery checkpoint cache. |
| `~/.config/opencode-gateway/events.json` | Recent in-process activity events. |
| `~/.config/opencode-gateway/sessions.json` | Recent Gateway OpenCode session sidecar state. |
| `~/.config/opencode-gateway/backups/` | Operator-created verified local backups. |
| `~/.config/opencode-gateway/recovery-drills/` | Recovery drill evidence and reports. |
| `~/.config/opencode-gateway/observability/` | Execution traces and stage analysis artifacts. |

Gateway writes config and sidecar files with user-only permissions where the platform supports it. `opencode-gateway backup doctor` and `GET /storage/doctor` expose the redacted storage source inventory and consistency scanner. The scanner reports database integrity, corrupt JSON artifacts, missing derived caches, channel checkpoint/outbox mismatch, and backups that are missing expected state.

## Deterministic Operations

Gateway is designed for one local daemon process per user profile.

- Scheduler triggers share one in-process cycle promise, so heartbeat ticks, event wakeups, and manual scheduler runs do not dispatch duplicate work inside one daemon.
- Durable task transitions use SQLite `BEGIN IMMEDIATE` transactions. A task run only starts if the task is still `pending` and has no `currentRunId`; completion only applies if the run is still the task's active run.
- Scheduler runs carry durable leases: owner, generation, and expiration. Active checks renew leases; expired leases are recovered according to retry policy before new dispatch.
- Global, per-stage, and per-profile concurrency limits are enforced before dispatch. If a limit is reached, runnable work stays pending with its readiness reason visible.
- If a scheduler race creates an unused OpenCode session before the SQLite transition wins, Gateway aborts that unused session and does not prompt it.
- Channel sync shares one in-flight sync pass per daemon to avoid duplicate outbound delivery before checkpoints are saved.
- OpenCode question and permission channel notifications use an in-flight per-target lock before sending, then record the notification in `gateway.db`.

The SQLite work database is the durable source of truth. The channel sync outbox is a transactional SQLite companion. JSON sidecars such as session state, recent events, and channel-sync checkpoints are derived or compatibility views for a single daemon and should not be treated as a multi-writer cluster coordination layer.

## Scaling Model

Current production support is single-node, single-leader local operation. Running two daemons against the same `gateway.db` is not a recommended deployment, but SQLite transactions and durable run leases prevent duplicate task/run creation for the same pending task. The losing process may create and abort an unused OpenCode session, which is safer than double-prompting a task.

Future multi-host scheduling must follow the [Multi-Daemon Scaling Design Record](multi-daemon-scaling.md): add explicit coordinator leadership, move JSON sidecar coordination state into `gateway.db`, and keep local personal mode simple. Until that exists, Gateway should be scaled by increasing `scheduler.maxConcurrent`, `scheduler.stageConcurrency`, and `scheduler.profileConcurrency` within one daemon.
