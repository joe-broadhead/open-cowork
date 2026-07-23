# HTTP API

The Gateway daemon binds to `127.0.0.1` and exposes a JSON API on `http://127.0.0.1:4097` by default. The API is primarily used by the Gateway MCP server, CLI, dashboard, and channel adapters.

Non-local HTTP access is denied unless explicitly configured in `security`. Exposed API/dashboard access requires `Authorization: Bearer <token>` with the capability required by the route unless `security.unsafeAllowNoAuth=true` is set for an isolated test network.

Scoped token environment variables:

| Variable | Capability |
| --- | --- |
| `OPENCODE_GATEWAY_HTTP_READ_TOKEN` | `read` |
| `OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN` | `operator` |
| `OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN` | `asset_write` |
| `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN` | `admin` |
| `OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN` | `webhook` |

`admin` satisfies every route. `operator` and `asset_write` also satisfy `read`.

## Contract And Versioning

A machine-readable OpenAPI 3.1 contract is generated from the route table below and published at [`openapi.json`](openapi.json). Regenerate it with `npm run docs:api` after editing this route table so the two stay in sync.

The generated OpenAPI request bodies and route-specific response statuses come from runtime-adjacent route contracts that reuse the daemon's Zod validators. Authentication capability metadata comes from the runtime HTTP capability classifier.

Routes are currently served unprefixed and are treated as **v1**. A future `/v1` alias prefix (keeping the existing unprefixed routes working as back-compat aliases) is a planned additive change in the daemon router. The generated `openapi.json` documents the v1 surface as it exists today.

## Dashboard And Live View

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Dashboard HTML. |
| `GET` | `/dashboard` | Dashboard HTML. |
| `GET` | `/live` | Minimal live event HTML page. |
| `GET` | `/live/events` | Server-sent event stream. |

## Service

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Basic daemon health. |
| `GET` | `/gateway/health` | Component health report for daemon, leadership, dashboard, storage, scheduler, channel adapters, OpenCode connectivity, and config validity, including remediation hints. Preserves legacy queue `counts`; component counts are exposed as `serviceCounts`. |
| `GET` | `/gateway/leadership` | Redacted local writer lease status: this daemon identity, current leader fingerprint, lease age/expiry, writer/standby mode, and remediation. |
| `POST` | `/gateway/leadership/recover` | Re-check the local writer lease and recover leadership only when the stored leader lease is stale. Returns `409` while another daemon still owns a fresh lease. |
| `GET` | `/doctor` | Diagnostic report. |
| `GET` | `/alpha-health` | Workspace health summary (`alphaHealth`): service health, scheduler recovery, channel delivery, open gates, eval scorecards, backup/restore, and blocker indicators. |
| `GET` | `/readiness` | Local operating readiness state, checks, and operating mode. |
| `GET` | `/operator/status` | Redacted beta operator cockpit with scheduler safety, queue state, attention, channel scope, and deferred release gates. |
| `GET` | `/operator/hygiene` | Read-only live-state hygiene report for stale claim codes, expired gates, stale OpenCode session links, and stale parent receipts. |
| `POST` | `/operator/actions` | Apply a supported operator action: `status`, `hygiene`, `pause`, `resume`, `recover`, or `reset-stale`. |
| `POST` | `/operator/runs/:runId/actions` | Apply one lease-safe active-run control: `cancel`, `stop`, `retry`, or `restart`. Requires operator capability for exposed mode. |
| `GET` | `/governance` | Budget, quota, cost, token, and runtime governance state. |
| `GET` | `/analytics?window=30&by=profile&view=summary&roadmapId=...&profile=...&agent=...&stage=...&since=...&until=...&limit=5` | Read-only run-history analytics over a bounded, indexed `started_at` window. Default `view=summary` returns spend/usage grouped by `by` (`profile`, `agent`, or `roadmap`), outcome distribution, retry hotspots, and budget trend; `view=scorecard` returns the per-dimension completion + cost scorecard with derived underperformers. |
| `GET` | `/attention` | Unified Needs Attention report for Gateway gates, tasks, stale runs, and OpenCode-native requests. |
| `GET` | `/triage` | Read-only composite of the whole operator attention set (gates, questions, permissions, blocked tasks, stale runs, completion proposals) plus active alerts, in one payload. Backs `gateway_triage`. |
| `GET` | `/briefing?limit=8` | Latest main-agent briefing with changed work, active runs, blockers, gates, OpenCode requests, completions, delegated work, alerts, supervisor receipts, and recommended next actions. |
| `GET` | `/alerts` | Read the durable active-alert snapshot plus read-only metrics without running alert evaluation or mutating state. |
| `POST` | `/alerts/evaluate` | Run alert evaluation and persist the resulting alert lifecycle updates. Requires operator capability and daemon writer leadership. |
| `POST` | `/alerts/:id/action` | Acknowledge, resolve, or suppress an alert. |
| `GET` | `/observability` | Local metrics, active alerts, redacted trace correlation, and SLO snapshot. |
| `GET` | `/metrics` | Prometheus-format runtime, scheduler, auth, channel, and alert metrics for local scraping. |
| `GET` | `/incident-report?alertId=...` | Generate a local incident report. |
| `GET` | `/incident-bundle?alertId=...&format=json\|markdown` | Generate a redacted local incident bundle with manifest, trace correlation, SLO state, alert summaries, and nested evidence export. |
| `GET` | `/logs?lines=100` | Recent daemon logs. |
| `GET` | `/artifacts?ref=file:...` | Open a redacted text view of a file artifact ref already attached to a known Gateway run. |
| `GET` | `/artifacts/manifest?runId=...` | Inspect a redacted bounded local run artifact manifest by run ID. Use `taskId` and `limit` to list recent manifests without raw local file paths. |
| `GET` | `/evidence/export?taskId=...&format=json\|markdown` | Export a deterministic redacted operator evidence bundle for a task, run, session, roadmap, project, or recent Gateway evidence. `redact=false` or `unredacted=true` requires `admin` for non-local requests and `localAdmin=true` explicit intent. |
| `GET` | `/config?redact=true` | Read redacted config. `redact=false` requires `admin` for non-local requests and is audited. |
| `PATCH` | `/config` | Patch config. Requires `admin` for non-local requests and a destructive human gate when approval gating is enabled; retry with `approvedGateId` after approval. |
| `GET` | `/storage/backups` | List Gateway state backups. |
| `GET` | `/storage/doctor?backupPath=...` | Redacted storage source inventory and consistency scanner for database integrity, schema drift, sidecar corruption, channel checkpoint/outbox mismatch, and backup coverage. Returns `503` only for critical storage failures. |
| `POST` | `/storage/backups` | Create a timestamped backup. Refuses while runs or starting dispatches are active unless `allowActiveRuns=true`; requires `admin` for non-local requests. |
| `POST` | `/storage/backups/verify` | Verify backup metadata, checksums, and SQLite integrity. Requires `admin` for non-local requests. |
| `POST` | `/storage/recovery-drills` | Restore a backup into isolated state and write scheduler/storage/channel recovery evidence. Requires `admin` for non-local requests. |
| `GET` | `/storage/export?localAdmin=true` | Export durable Gateway state as JSON. Requires `admin` for non-local requests **and** explicit `localAdmin=true` dual-intent (JOE-952; always treated as unredacted; rate-limited). |
| `POST` | `/storage/restore` | Restore a verified backup; requires stopped daemon or `maintenanceMode=true`. Requires `admin` for non-local requests and a destructive human gate when approval gating is enabled; retry with `approvedGateId` after approval. |
| `POST` | `/restart` | Request restart. Requires `admin` for non-local requests; the action is audited and no human approval gate applies. A service manager must be installed for the daemon to come back automatically. |
| `POST` | `/shutdown` | Request shutdown. Requires `admin` for non-local requests; the action is audited and no human approval gate applies. |

## Durable Work

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/tasks` | List queue snapshot. |
| `POST` | `/tasks` | Create task. |
| `POST` | `/delegations` | Accept a DelegationRequest v1 and create or replay durable Gateway work with a stable receipt. |
| `POST` | `/tasks/bulk` | Create tasks atomically. |
| `PATCH` | `/tasks/bulk` | Update tasks atomically. |
| `GET` | `/tasks/:id` | Get task. |
| `PATCH` | `/tasks/:id` | Update task. |
| `DELETE` | `/tasks/:id` | Delete task. |
| `POST` | `/tasks/:id/action` | Pause, resume, cancel, retry, done, or block. |
| `POST` | `/tasks/:id/archive` | Archive task. |
| `GET` | `/tasks/:id/readiness` | Explain whether a task is runnable, blocked, waiting, scheduled, paused, running, or done. |
| `GET` | `/tasks/:id/dependencies` | List dependencies for a task. |
| `POST` | `/tasks/:id/dependencies` | Add a dependency. |
| `DELETE` | `/tasks/:id/dependencies?dependsOnTaskId=...` | Delete a dependency. |
| `GET` | `/roadmaps` | List roadmaps. |
| `POST` | `/roadmaps` | Create roadmap. |
| `POST` | `/roadmaps/with-tasks` | Create roadmap and tasks atomically. |
| `POST` | `/workflows/plan-initiative` | Atomically create an Initiative, its Issues, their dependency edges, and an optional supervisor in one all-or-nothing call. Backs `gateway_plan_initiative`. |
| `POST` | `/workflows/dispatch-now` | Run a scheduler cycle now, dispatching all ready work up to maxConcurrent; honors a paused scheduler (truthful no-op when paused, no durable config change). A taskId/roadmapId ensures that target is eligible and highlights whether it dispatched, and the report always lists the full dispatched set. Backs `gateway_dispatch_now`. |
| `GET` | `/roadmaps/:id` | Get roadmap. |
| `PATCH` | `/roadmaps/:id` | Update roadmap. |
| `DELETE` | `/roadmaps/:id` | Delete roadmap. |
| `POST` | `/roadmaps/:id/archive` | Archive roadmap. |
| `POST` | `/roadmaps/:id/recompute` | Recompute roadmap status. |
| `GET` | `/roadmaps/:id/memory` | Summarized roadmap memory: decisions, evidence, failures, and recent tasks. |
| `GET` | `/roadmap-supervisors?roadmapId=...` | List roadmap supervisors, optionally filtered by roadmap or status. |
| `POST` | `/roadmap-supervisors` | Create a roadmap supervisor for a roadmap and OpenCode session. |
| `GET` | `/roadmap-supervisors/:id` | Get one roadmap supervisor. |
| `PATCH` | `/roadmap-supervisors/:id` | Update supervisor session, profile, status, cadence, cursor, completion, notification, or note fields. |
| `POST` | `/roadmap-supervisors/:id/archive` | Archive a supervisor. |
| `GET` | `/roadmap-completion-proposals?roadmapId=...` | List roadmap completion proposals, optionally filtered by roadmap or status. |
| `POST` | `/roadmap-completion-proposals` | Propose roadmap completion with evidence, residual risks, and recommendation. |
| `GET` | `/roadmap-completion-proposals/:id` | Get one roadmap completion proposal. |
| `POST` | `/roadmap-completion-proposals/:id/decision` | Approve or reject a pending completion proposal. |
| `GET` | `/project-bindings?roadmapId=...` | List project aliases and surface bindings, optionally filtered by roadmap, scope, alias, or provider/chat/thread. |
| `POST` | `/project-bindings` | Create or rebind a project alias to a roadmap, OpenCode session, and optional Telegram/WhatsApp surface. |
| `GET` | `/project-bindings/resolve` | Resolve project context by bound chat/thread, alias, roadmap ID, session ID, or single active supervisor. |
| `GET` | `/project-bindings/:id` | Get one project binding. |
| `PATCH` | `/project-bindings/:id` | Update alias, roadmap, session, scope, channel fields, title, or rebind behavior. |
| `DELETE` | `/project-bindings/:id` | Delete one project binding. |
| `POST` | `/projects` | Create a supervised project with a roadmap, default supervisor, project alias, and optional surface binding. |
| `GET` | `/projects/summary` | Resolve current project context and return formatted project status. |
| `GET` | `/projects/digest` | Resolve current project context and return recent project events and decisions. |
| `POST` | `/projects/review-now` | Queue the resolved project's default supervisor for immediate review. |
| `POST` | `/projects/completion-decision` | Approve or reject the resolved project's pending completion proposal. |
| `POST` | `/projects/supervisor-action` | Pause or resume the resolved project's default supervisor. |
| `GET` | `/runs` | List recent runs. |
| `GET` | `/runs/:id` | Get run by run ID or session ID. |
| `GET` | `/dispatch-acquisitions?status=...&kind=...&taskId=...&dispatchId=...` | List dispatch acquisition journal rows for recovery inspection. |
| `POST` | `/dispatch-acquisitions/:dispatchId/:kind/settle` | Admin force-settle a dispatch acquisition after operator cleanup verification. |
| `GET` | `/environments?status=...&backend=...&runId=...` | List redacted execution environment snapshots and cleanup state. |
| `GET` | `/environments/:id` | Inspect one execution environment by environment ID or run ID. |
| `POST` | `/environments/:id/action` | Retain, release, abort, or cleanup an execution environment. `abort` also aborts the active OpenCode session when applicable. |
| `POST` | `/environments/reconcile` | Reconcile active, retained, and cleanup-failed environments by backend. |
| `GET` | `/events` | List Gateway workflow events. |
| `GET` | `/human-gates?status=open` | List Gateway-level human approval gates. |
| `POST` | `/human-gates` | Create a durable human gate. |
| `GET` | `/human-gates/:id` | Read one human gate. |
| `POST` | `/human-gates/:id/decision` | Approve or reject a gate with `once` or `always` scope. |

`POST /delegations` is the durable handoff entrypoint for Gateway-owned work. It validates `docs/concepts/delegation-contract.md` before mutation, creates issues or projects through the same task/roadmap/supervisor/binding primitives listed above, records `delegation.accepted`, `delegation.mapped`, and `delegation.progress` workflow events, then routes progress to the parent session and configured channel/project binding according to notification policy. Rejected delegation returns a structured failure mode and does not create partial durable state. Agent-team blueprint requests still use the existing human-gated agent-team proposal/apply flow; this endpoint does not introduce a full Agent Factory registry or replace OpenCode-native subagents.

## Scheduler And Profiles

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/scheduler` | Scheduler settings and queue counts. |
| `POST` | `/scheduler` | Pause, resume, run once, or update scheduler config. |
| `POST` | `/scheduler/pause` | Pause new scheduler dispatch without changing existing active runs. |
| `POST` | `/scheduler/resume` | Resume scheduler dispatch. |
| `POST` | `/scheduler/run` | Run one scheduler cycle immediately and return counts, leases, active tasks, and recent runs. |
| `GET` | `/profiles` | List profiles. |
| `GET` | `/profiles/:name` | Get one profile with compact promotion projection. |
| `GET` | `/profiles/:name/inspection` | Inspect effective profile access, grants, and least-privilege warnings. |
| `PUT`/`POST` | `/profiles/:name` | Upsert profile. |
| `DELETE` | `/profiles/:name` | Delete profile. |
| `GET` | `/agent-factory/catalog` | List the Agent Factory profile, team, and persisted blueprint catalog with stable IDs, versions, capability summaries, promotion state, and source metadata. |
| `POST` | `/agent-factory/teams/assemble` | Assemble a bounded team from a named Agent Factory blueprint/team definition without dispatching sessions. Returns stable team/member IDs, selected profile versions, grants, budget/gate placeholders, rejection reasons, and a durable audit receipt. |
| `GET` | `/team-assignments` | List durable team assignments. Supports `receiptId`, `taskId`, `roadmapId`, `runId`, `sessionId`, `memberId`, and `limit` filters. |
| `POST` | `/team-assignments` | Create deterministic executable assignments for assembled team members. Fails closed unless team assembly, work links, budgets, scope, evidence requirements, and gate definitions are valid. |
| `GET` | `/team-assignments/:id` | Read one team assignment with gate, review, and completion receipt history. |
| `POST` | `/team-assignments/:id/receipts` | Record a durable `gate_result`, `review_outcome`, or `completion` receipt. Completion receipts require required gates and evidence to be satisfied. |
| `GET` | `/promotion/scorecards?subjectKind=profile&subjectName=...` | List profile/team scorecards. |
| `POST` | `/promotion/scorecards` | Create or update deterministic scorecard evidence. |
| `GET` | `/promotion/scorecards/:id` | Read one scorecard. |
| `GET` | `/promotion/state?subjectKind=team&subjectName=...` | Read promotion state, latest scorecard, and decision history. |
| `POST` | `/promotion/decisions` | Open or apply a human-gated promote, deprecate, rollback, or block decision. |

## Agent Teams

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/agent-teams` | List normalized project/domain agent teams. |
| `POST` | `/agent-teams/validate` | Validate an agent-team proposal without mutating config. Optional `taskId` and `stage` validate dispatch resolution. |
| `POST` | `/agent-teams/propose` | Validate a proposal and create a human gate for applying it. |
| `GET` | `/agent-teams/:name` | Get one team and its roadmap/task references. |
| `GET` | `/agent-teams/:name/inspection` | Inspect effective team access across resolved profiles, requirements, grants, and least-privilege warnings. |
| `PUT` | `/agent-teams/:name` | Apply a team definition after an approved human gate. Without a gate, returns `202` and a pending gate. |
| `POST` | `/agent-teams/:name/apply` | Same gated apply flow as `PUT /agent-teams/:name`. |
| `POST` | `/agent-teams/:name/bind` | Bind a team to exactly one `roadmapId` or `taskId` after an approved human gate. |
| `DELETE` | `/agent-teams/:name` | Delete an unreferenced team after an approved human gate. |

Agent-team responses are sanitized for operator use. They include role/profile/agent routing, revisions, references, compact promotion state, and validation errors, but not credentials. Mutation gates use scope keys such as `agent_team:apply:<name>`, `agent_team:delete:<name>`, and `agent_team:bind:<name>:<kind>:<id>`. Promotion decisions use scope keys such as `promotion:promote:team:<name>:<scorecardId>`.

## Blueprints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/blueprints` | List persisted blueprint files from the Agent Factory catalog. Invalid files are returned as blocked entries with validation errors. |
| `POST` | `/blueprints/preview` | Validate one blueprint and return diff, validation, rollback, and apply-safety data without mutating config. |
| `POST` | `/blueprints/apply` | Apply a valid blueprint after an approved human gate. Without a gate, returns `202` and a pending blueprint apply gate. |

Blueprint catalog entries use stable IDs such as `blueprint:warehouse@1.0.0` and include file path, version, description, required skills/MCP/tools, profile/team counts, validation state, and last-updated metadata.

## OpenCode

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/questions` | Pending OpenCode questions. |
| `POST` | `/questions/:id/reply` | Reply to a question. |
| `POST` | `/questions/:id/reject` | Reject a question. |
| `GET` | `/permissions` | Pending OpenCode permissions. |
| `POST` | `/permissions/:id/reply` | Reply to a permission. |
| `POST` | `/permissions/:id/reject` | Reject a permission without granting the requested tool action. |
| `GET` | `/opencode/sessions` | List Gateway-owned sessions by default. `gatewayOnly=false` broadens the result to all OpenCode sessions and requires `admin`; `limit` is bounded from 1 through 500. |
| `GET` | `/opencode/sessions/:id` | Get session and Web/TUI links plus Mission Control/session evidence fallback text. Missing/stale OpenCode sessions return structured `404` recovery JSON instead of a raw OpenCode NotFound error or dead Web deep link. |
| `GET` | `/opencode/sessions/:id/messages?limit=20` | Recent session messages. `limit` must be an integer from 1 through 200 and is passed to OpenCode upstream. |
| `GET` | `/opencode/sessions/:id/children` | Child sessions. |
| `POST` | `/opencode/sessions/:id/abort` | Abort session. |
| `POST` | `/sessions/admit` | Capacity-gated OpenCode session admit with durable admission receipt. Not a free spawn surface. Returns `429` when capacity is full. |
| `GET` | `/personas` | List OpenCode agents (persona labels/modes). |
| `POST` | `/personas` | Create an OpenCode primary-mode persona agent (optional skill content). |
| `GET` | `/agent-presences` | List durable AgentPresence records (always-on assistant sticky bindings; not channel typing presence). |
| `POST` | `/agent-presences` | Create an AgentPresence (requires an existing OpenCode agent). |
| `GET` | `/agent-presences/:id` | Get one AgentPresence. |
| `PATCH` | `/agent-presences/:id` | Update AgentPresence status, sticky session, or channel bind. |
| `GET` | `/opencode/agents`, `/opencode/skills`, `/opencode/mcp`, `/opencode/tools` | List OpenCode assets. |
| `PUT`/`POST` | `/opencode/agents/:name`, `/opencode/skills/:name`, `/opencode/mcp/:name`, `/opencode/tools/:name` | Upsert OpenCode assets. Requires `asset_write` or `admin` for non-local requests. |
| `DELETE` | `/opencode/agents/:name`, `/opencode/skills/:name`, `/opencode/mcp/:name`, `/opencode/tools/:name` | Delete OpenCode assets. Requires `asset_write` or `admin` for non-local requests. |

## Channels

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/channels/capabilities` | Return the channel capability matrix for active adapters and planned surfaces plus the canonical channel action parity matrix (`actionParity`), native control coverage, and operator journeys used by typed commands, native slash commands, command menus, and Mission Control. |
| `GET` | `/channels/connectors?provider=...` | Return provider-neutral connector setup status, lifecycle state, missing prerequisites, redacted evidence refs, webhook readiness, and safe repair actions. Optional `provider` returns one connector. |
| `POST` | `/channels/claims` | Generate a short-lived provider-scoped trusted-target claim code for Mission Control or CLI setup flows. Request `provider` and optional `ttlSeconds`; response includes the one-time code, expiry, and redacted claim metadata. |
| `GET` | `/channels/bindings` | List bindings. |
| `POST` | `/channels/bindings` | Upsert binding. |
| `DELETE` | `/channels/bindings` | Delete binding. |
| `POST` | `/channels/send` | Send to a channel. |
| `POST` | `/channels/send-to-task` | Send to task-bound channels. |
| `POST` | `/channels/send-to-roadmap` | Send to roadmap-bound channels. |
| `GET` | `/webhooks/whatsapp` | WhatsApp verification challenge using the `hub.mode`, `hub.verify_token`, and `hub.challenge` query parameters; this setup request does not use POST body HMAC. |
| `POST` | `/webhooks/whatsapp` | WhatsApp inbound webhook authenticated with `X-Hub-Signature-256` HMAC over the raw request body. |
| `POST` | `/webhooks/discord` | Discord signed interaction webhook. |

Public webhook ingress requires `security.publicWebhookMode=true` when the daemon itself receives non-local provider requests without a Gateway HTTP token. That mode only exempts `GET /webhooks/whatsapp`, `POST /webhooks/whatsapp`, and `POST /webhooks/discord`; every other route still follows the normal HTTP boundary. Prefer tunneling only the provider webhook path to a localhost-bound daemon.

## Gateway Session State

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/session-state` | Recent Gateway OpenCode session sidecar state. |

Use `/opencode/sessions/:id` and `/opencode/sessions/:id/abort` for live OpenCode session inspection and aborts. Gateway does not expose `/spawn` or `/spawn-async`.
