# Product Contract

OpenCode Gateway is intentionally OpenCode-native.

The [Surface Capability Matrix](#surface-capability-matrix) below is the living user-facing contract for what this product can and cannot do across OpenCode TUI, OpenCode Web, Telegram, WhatsApp, Discord, dashboard, CLI, and MCP surfaces.

## OpenCode Owns

- Sessions and message history.
- Agents, skills, MCP servers, and tools.
- Model execution and provider routing.
- Permission and question requests.
- Web and TUI behavior.

## Gateway Owns

- Durable roadmaps, tasks, runs, workflow events, and channel bindings.
- Scheduler decisions, stage transitions, retries, blocks, and completion.
- Telegram and WhatsApp ingress, session binding, and outbound sync.
- Local dashboard and deterministic service APIs.
- Gateway MCP proxy tools.
- Gateway OpenCode asset installation and updates.

## Non-Goals

Gateway does not provide:

- A separate model runtime.
- A separate persistent assistant persona layer.
- A second permission or question system.
- A markdown-backed execution queue.
- Multi-user tenancy or hosted authorization in the default daemon.
- Hosted control-plane, multi-tenant, remote-worker, or marketplace-safety claims; these remain blocked in the claim registry until their evidence exists.

## Primary Agent

`gateway-assistant` is the user-facing default for OpenCode, Telegram, and WhatsApp. It answers simple requests directly and creates durable Gateway work when a request should survive restarts, run through review gates, or remain visible in the dashboard.

## Stage Agents

Specialist agents handle scheduler stages:

| Agent | Role |
| --- | --- |
| `gateway-planner` | Creates durable roadmaps and tasks. |
| `gateway-coordinator` | Coordinates queues, runs, channels, requests, config, and service state. |
| `gateway-implementer` | Executes implementation stage work. |
| `gateway-reviewer` | Reviews stage output against the implementation spec and definition of done without editing files. |
| `gateway-verifier` | Verifies stage output with focused checks and definition-of-done evidence. |
| `gateway-supervisor` | Supervises durable roadmaps and proposes next actions without owning durable state. |
| `gateway-auditor` | Audits release/readiness evidence without edits or shell commands. |

## Source Of Truth

SQLite at `~/.config/opencode-gateway/gateway.db` is Gateway's durable source of truth for roadmaps, tasks, runs, events, and channel bindings.

OpenCode remains the source of truth for sessions, messages, questions, permissions, agents, skills, and MCP configuration.

## Release Metadata Contract

The release identity is single-sourced from `package.json`. `package-lock.json`, CLI help, `CHANGELOG.md`, README quick-start examples, and MkDocs pages must describe the same product version and product surface before a release is considered valid.

Configuration examples must use the current profile-based schema:

- Global daemon settings live at `opencodeUrl`, `httpPort`, `heartbeat`, `channelSync`, `security`, `scheduler`, and `channels`.
- Model and agent choices live under named `profiles` entries.
- Scheduler stages map to profiles through `scheduler.stageProfiles`.

Legacy flat top-level `models` or `agents` configuration is not part of the supported product contract.

## Surface Capability Matrix

This matrix is the user-facing contract for what an operator can and cannot do with Gateway today across each surface. It is grounded in the current product contract, the [Channel Adapter Contract](channel-adapter-contract.md), the `src/channel-actions.ts` action registry, and `opencode-gateway channel status` / `opencode-gateway readiness`. Runtime readiness is stricter than this matrix: a surface can be a real product path while the current machine is `not_ready` because a human gate, missing proof, missing credential, alert, or local config blocker is active.

Status labels used below:

| Label | Meaning |
| --- | --- |
| `works now` | The capability exists in the current product and has deterministic validation or accepted live evidence. It may still require documented local setup. |
| `works but rough` | The capability works, but the experience has manual steps, awkward permissions, weak discoverability, or recovery friction. |
| `scaffolded/planned` | The product path, docs, config, or adapter metadata exists, but required provider exchange, backend flow, or UI polish is missing. Do not claim live readiness. |
| `not supported` | Gateway intentionally does not provide the capability today, or it belongs to OpenCode/provider infrastructure. |

Capability states used by the operator guide, readiness catalog, and doctor output: `supported`, `partial`, `waived`, `blocked`, `unknown`, `future`.

| Surface | Status | Capability state | User can do | User cannot do yet |
| --- | --- | --- | --- | --- |
| OpenCode TUI | `works now` | `supported` | Use native OpenCode sessions, agents, skills, tools, MCP, questions, permissions, and Gateway MCP tools. Continue work against Gateway Initiatives, Issues, Runs, and evidence. | It is not a hosted/shared UI. Gateway does not replace OpenCode's TUI state, permissions, or session storage. |
| OpenCode Web | `works but rough` | `partial` | Open Gateway-provided session links, inspect the same OpenCode session when it exists, and use fallback TUI/Mission Control/session evidence when the Web route is unavailable. Gateway does not emit stale Web deep links when OpenCode cannot resolve a session. | Gateway does not own the Web app. An old URL can still show OpenCode's upstream missing-session page; Gateway-provided recovery links are the supported path. |
| Telegram | `works but rough` | `supported` for the audited target; `partial` for broader provider UX | Use trusted chat binding, typed project commands, provider-registered slash command verbs, durable delegation, progress/final receipts, structured rich cards/buttons, bounded trusted-inbound typing, `/open`, `/status`, `/attention`, gates, and alerts. | Telegram argument/subcommand autocomplete is not provider-native and remains typed/copy fallback. Any new target needs its own trusted binding. |
| WhatsApp | direct Cloud API setup path `works now` as local implementation; `scaffolded/planned` for external readiness | `partial` for implementation, `blocked` for external readiness | Run guided direct Cloud API setup, verifier diagnostics, claim/trust guidance, binding model, typed command routing, and plain-text/list fallback when provider prerequisites exist. | No current external live readiness. Embedded Signup/provider-managed no-setup onboarding is not live-enabled. WhatsApp must not be described as ready from config, metadata, or fixtures alone. |
| Discord | `scaffolded/planned` | `future` | Use adapter metadata, diagnostics, fixture concepts, component/callback metadata, and the same contract shape for future promotion work. | Disabled/deferred. No general user onboarding and no readiness claim. |
| Dashboard / Mission Control | `works but rough` | `partial` | Inspect health, readiness, channels, work, runs, gates, alerts, evidence, backups, and recovery signals. | The work graph, guided channel onboarding cockpit, and unified decision center are not fully complete. |
| CLI | `works now` | `supported` | Setup/update, service control, status, readiness, channel lifecycle, evidence export, backup/restore, soak, logs, and simple tasks. | CLI is not the primary agent experience. It should not become the only way to complete channel onboarding. |
| MCP / OpenCode tools | `works now` | `supported` | Manage Initiatives, Issues, Runs, projects, supervisors, gates, alerts, backups, channels, sessions, profiles, teams, blueprints, and evidence from OpenCode agents. Capacity-gated `session_admit` creates sessions with receipts (not free spawn). | Gateway does not expose ephemeral subagent spawning as a product primitive. Durable delegation and OpenCode-native subagents have different ownership. |
| AgentPresence (always-on assistants) | `works now` (local sticky chat) | `partial` | Create OpenCode primary-mode personas; bind durable AgentPresence to a sticky session and trusted Telegram/channel target; free-text routes to that agent/session. | Not a multi-tenant always-on agent OS. Cadence/wake scheduling of AgentPresence is reserved (sticky chat model, not roadmap supervisor wake leases). |
| Trusted OpenCode peers | `works now` (allowlist + Basic auth) | `partial` | Point `opencodeUrl` at allowlisted peer hosts via `opencodePeers`; inject Basic auth from env/file (never URL credentials). | Not multi-host production cert; peer auth requires configured password material when `basicAuth` is present. |

Before changing a surface status or closing a channel readiness gap: run `opencode-gateway readiness`, run `opencode-gateway channel status --json`, and export redacted evidence with `opencode-gateway evidence export` when work, runs, or channel receipts are part of the claim.
