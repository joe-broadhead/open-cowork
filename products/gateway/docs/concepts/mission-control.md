# Mission Control 2.0

Mission Control is the operator console for the Gateway work graph. It should evolve from a status dashboard into a dense, reliable control surface for scanning work, drilling into evidence, approving gates, moving context between channels, and monitoring progress across OpenCode-owned sessions and Gateway-owned durable orchestration.

This page is a production information architecture and data-contract spec. It does not require a large frontend rewrite by itself. Implementation work should treat the current dashboard routes as compatibility surfaces and add Mission Control 2.0 capabilities incrementally.

## Product Position

Mission Control sits on the boundary defined by the [Product Contract](product-contract.md): OpenCode owns sessions and model execution; Gateway owns the durable work graph, scheduler decisions, channel links, and dashboard/API projections.

Mission Control should use the [Gateway Method](gateway-method.md) vocabulary in UI copy and API-facing specs. Current implementation names stay visible where they are stable compatibility contracts:

| Mission Control noun | Current source | Stable ID or key |
| --- | --- | --- |
| Initiative | `roadmaps` | `roadmap.id`, shown as `roadmap_...` |
| Project | `projectBindings` plus one Initiative and default Supervisor | `projectBinding.id`, `alias`, `roadmapId`, `sessionId` |
| Issue | `tasks` | `task.id`, shown as `task_...` |
| Session | OpenCode session plus Gateway links | `session.id`, shown as `ses_...` |
| Channel Target | Channel provider/chat/thread binding | `provider`, `chatId`, optional `threadId`, optional `channelBinding.id` |
| Run | `runs` | `run.id`, `taskId`, `sessionId` |
| Supervisor | Roadmap supervisor | `supervisorId`, `roadmapId`, `sessionId` |
| Gate | Gateway human gate or OpenCode request | `gate.id`, OpenCode `requestId` |
| Alert | Alert engine record | `alert.id`, `dedupeKey` |
| Profile | Gateway profile config | profile name |
| Team | Gateway agent team config | team name, generated `revision` |
| Blueprint | Blueprint preview/apply recipe | blueprint `name` and `version` |
| Eval | Proposed eval suite/case/run | future `evalId`, suite/case IDs |
| Promotion | Profile/team/blueprint trust decision | future `promotionId`, scope key |

## Navigation Model

Mission Control 2.0 should use a persistent left navigation with compact count badges and a top command/filter bar. The default route remains `/dashboard#/overview` until a first-class route alias is added.

Primary views:

| Route | Label | Purpose |
| --- | --- | --- |
| `#/overview` | Overview | Global operating picture, attention, current work, health, and latest progress. |
| `#/operator` | Operator | Public-beta cockpit for scheduler safety, queue/lease state, attention, validated surfaces, safe commands, and deferred release gates. |
| `#/work-graph` | Work Graph | Relationship map across Initiatives, Projects, Issues, Runs, Sessions, Supervisors, Gates, Alerts, Teams, and Channels. |
| `#/sessions` | Sessions / Channels | OpenCode sessions, channel targets, bindings, handoff state, and callback health. |
| `#/initiatives` | Initiatives / Projects / Issues | Durable planning hierarchy, progress, blockers, completion proposals, and issue queues. |
| `#/runs` | Runs | Stage attempts, throughput, environments, artifacts, cost/runtime, and retry/block reasons. |
| `#/supervisors` | Supervisors | Initiative and Project supervision health, leases, wake cadence, last results, and audit trail. |
| `#/gates` | Gates / Alerts | Human gates, OpenCode questions/permissions, completion proposals, incidents, and alert action history. |
| `#/agent-factory` | Agent Factory | Profiles, Teams, Blueprints, validation diffs, capability coverage, and gated apply/bind flows. |
| `#/arena` | Arena / Evals | Eval suites, arena comparisons, scorecards, and promotion evidence. This is a future-storage view. |
| `#/settings` | Settings | Redacted config, scheduler controls, channel allowlists, security, backups, and local operating readiness. |

The existing dashboard routes map into this structure as follows:

| Current route | Mission Control 2.0 home |
| --- | --- |
| `#/overview` | Overview |
| `#/operator` | Operator and Settings. |
| `#/usage` | Runs and Settings, depending on whether the operator is reading execution cost or OpenCode usage. |
| `#/pipeline` | Initiatives / Projects / Issues plus Runs. |
| `#/environments` | Runs. |
| `#/channels` | Sessions / Channels. |
| `#/health` | Gates / Alerts and Settings. |

## Density And Layout

Mission Control should feel like an operator console, not a landing page.

- Use tight tables, split panes, row details, and summary strips instead of oversized cards.
- Keep the left nav and top filter bar stable across views.
- Use view-local tabs only when they switch data subsets inside the current object family.
- Prefer sortable tables with pinned key columns: status, severity, title, primary ID, owner, updated time, and next action.
- Use badges for counts and severity, not decorative blocks.
- Keep copy short and specific. Rows should expose the reason an item matters: blocked by gate, run stale, supervisor due, alert critical, team invalid, promotion pending.
- Preserve keyboard-friendly scanning: row focus, enter to open details, escape to close details, slash or command key focus for search when implemented.

Recommended default frame:

1. Left nav with route badges.
2. Top bar with global search/filter, time window, environment/scope filters, scheduler state, and live connection state.
3. Main grid with a summary strip, primary table or graph, and optional right detail drawer.
4. Detail drawer with identity, relationships, evidence, actions, and audit events for the selected object.

## Interaction Model

Mission Control interactions should be explicit, reversible where possible, and auditable.

| Interaction | Behavior |
| --- | --- |
| Scan | Default sort puts critical attention first, then active work, then recently changed rows. |
| Drill in | Selecting a row opens a detail drawer without losing list context. Deep links should encode view and selected stable ID. |
| Cross-link | Related IDs link to their owning view: Issue to Runs, Run to Session, Project to Channel Target, Gate to Issue, Alert to evidence. |
| Handoff | Channel and session detail views show where a conversation is bound and allow explicit handoff or rebind flows through existing project/channel binding APIs. |
| Approve | Gate decisions require a visible scope, actor, decision, optional note, and the exact command or route that will run. |
| Monitor | Live updates should refresh counts and selected rows while preserving filters and selection. |
| Explain | Every blocked, waiting, stale, or not-running state should show the Gateway reason and the source route or event. |

Actions should be grouped by safety:

- Read-only actions: open, copy ID, view evidence, inspect session, inspect config, export filtered rows.
- Workflow actions: retry, pause, resume, block, mark done, request supervisor review, decide completion proposal.
- Gated mutations: approve/reject gate, apply team, bind team, apply blueprint, delete profile/team, change channel allowlist, restore backup.
- Destructive actions: delete, archive, abort session, release environment, restore backup. These need confirmation and audit evidence.

## Empty And Error States

Empty states should tell the operator what is true and where data would come from.

| State | Required copy pattern |
| --- | --- |
| No data | "No active Issues. Source: `/tasks`." |
| Feature future | "Arena storage is not implemented yet. Existing quality specs and run evidence are still shown." |
| Source unavailable | "OpenCode sessions unavailable from `/opencode/sessions`; durable Gateway work is still available." |
| Unauthorized | "Dashboard API requires the configured HTTP token." Do not show secret names or values beyond documented env var names. |
| Partial data | Show the available Gateway-owned data and mark the unavailable source inline. |
| Stale live connection | Keep last rendered data visible, show last update time, and retry SSE or polling. |
| Redacted | Show that credentials, permissions, and secret-like metadata were redacted, not silently omitted. |

Error rows should include a stable ID, status, source route, timestamp, and next action. Avoid raw stack traces in the main UI; keep detailed diagnostics behind logs or incident report links.

## Operator Workflows

### Morning Scan

1. Open Overview.
2. Check attention count, critical alerts, paused/blocked Issues, due Supervisors, and stalled Runs.
3. Filter to the active Project or Initiative if needed.
4. Open each critical item in the detail drawer and follow the next action.
5. Leave resolved items with an audit event or decision note.

### Drill From Goal To Evidence

1. Start on Initiatives / Projects / Issues.
2. Select an Initiative to see Projects, child Issues, completion policy, and quality requirements.
3. Select an Issue to see dependencies, gates, stage pipeline, current stage, and latest Runs.
4. Select a Run to inspect session link, resolved Profile/Team, environment, artifacts, cost/runtime, result summary, and failure class.
5. Open artifacts through `/artifacts?ref=...` only when the ref is attached to a known Gateway run.

### Handoff Between Channels

1. Start on Sessions / Channels.
2. Select the source Session or Channel Target.
3. Inspect current Project, Initiative, Issue, and Supervisor links.
4. Resolve the destination Project with `/project-bindings/resolve` when an alias, session, or channel target is ambiguous.
5. Use `/project-bindings` or `/channels/bindings` to create or update the binding. Rebinds must be explicit.
6. Confirm callbacks are routed through project/channel notification policy, not ad hoc provider sends.

### Approval And Gate Handling

1. Start on Gates / Alerts.
2. Group by severity and owner: Gateway human gates, OpenCode questions, OpenCode permissions, completion proposals, and alerts.
3. Open the item and inspect subject IDs, evidence, scope, requested action, and fallback command.
4. Approve or reject through the owning route:
   - Gateway gate: `POST /human-gates/:id/decision`.
   - OpenCode question: `POST /questions/:id/reply` or `POST /questions/:id/reject`.
   - OpenCode permission: `POST /permissions/:id/reply`.
   - Completion proposal: `POST /roadmap-completion-proposals/:id/decision` or `POST /projects/completion-decision`.
   - Alert: `POST /alerts/:id/action`.
5. Preserve the actor, decision, scope, and note in the audit event.

### Progress Monitoring

1. Start on Overview or Runs.
2. Watch active Runs by stage, age, session, environment, and resolved Profile/Team.
3. Use Issue readiness and run explanations to distinguish "not scheduled" from "blocked", "waiting", "paused", and "capacity full".
4. Escalate stale Runs, repeated failures, environment cleanup failures, and supervisor leases through Alerts.
5. Use throughput, cost, runtime, and token gauges as trend signals, not as the durable source of work truth.

## View Specifications

Every view maps rows to Gateway Method nouns and current compatibility IDs, and every action names its owning HTTP route or MCP tool. The current per-view sources are the routes documented in [HTTP API](../api/http-api.md) and [MCP Tools](../api/mcp-tools.md); the bounded windowing they render is the [Current High-Volume Dashboard Contract](#current-high-volume-dashboard-contract). Credentials, tokens, and raw transcripts are never included in any view payload.

### Overview

Purpose: one screen that answers "What needs attention, what is moving, and is Gateway healthy?" It combines attention, active-work, health, progress, and recent-update strips over `/attention`, `/tasks`, `/roadmaps`, `/runs`, `/readiness`, `/gateway/health`, `/alerts`, `/roadmap-supervisors`, and `/events`, with a future `GET /mission-control/overview` aggregate. Required stable links: `roadmapId`, `projectBindingId`/`projectAlias`, `taskId`, `runId`, `sessionId`, `supervisorId`, `gateId`, `alertId`, `eventId`.

### Workspace Health (Local Beta Health)

Purpose: one compact area that answers "Is this local Gateway instance healthy right now, and what evidence proves it?"

The `#/alpha-health` route summarizes workspace health without asking the operator to read raw logs. It uses durable Gateway state and evidence artifacts first, then live service projections where the route itself is the evidence source. A local Gateway instance is shown as healthy only when every indicator is current, no indicator is blocked, and no unresolved blocker is open.

| Indicator | Meaning | Evidence source |
| --- | --- | --- |
| Service Health | Daemon, dashboard, storage, scheduler, channel adapter, OpenCode connectivity, and config health. | `GET /gateway/health` and the readiness projection. |
| Scheduler And Recovery | Scheduler enabled state, heartbeat, duplicate active-run detection, supervisor stale/blocked state, and latest recovery drill signal. | `/gateway/health`, `/runs`, `/roadmap-supervisors`, and `state/recovery-drills/*/evidence.json`. |
| Channel Delivery | Trusted adapter availability, channel binding mirror counts, delivery checkpoints, and pending inbound queue. | `/channels/bindings`, project bindings, and channel-sync state. |
| Open Gates | Gateway human gates, OpenCode questions/permissions, and pending completion proposals requiring operator decision. | `/human-gates`, `/opencode/requests`, and roadmap completion proposal records. |
| Eval Scorecards | Recent profile/team promotion scorecards, blocking recommendations, failed thresholds, and promotion evidence freshness. | `promotion_scorecards` durable storage. |
| Backup And Restore Drill | Latest verified backup metadata plus latest recovery drill result. Missing backup or drill evidence is shown as not proven, not silently healthy. | `state/backups/*/metadata.json` and `state/recovery-drills/*/evidence.json`. |
| Unresolved Blockers | Critical alerts, blocked or paused Issues, failed latest recovery drill, blocking scorecards, service-down state, and duplicate active runs. | Alerts, tasks, drills, scorecards, service health, and run records. |

Empty states must remain useful during first-run setup. For example, no backup should name the backup metadata directory; no scorecards should explain that durable promotion evidence appears after `gateway_promotion_scorecard_*` writes scorecards.

### Work Graph

Purpose: show relationships and bottlenecks across the whole Gateway work graph, combining `/tasks`, `/roadmaps`, `/project-bindings`, `/runs`, `/roadmap-supervisors`, `/human-gates`, `/alerts`, `/channels/bindings`, `/events`, and `/agent-teams` into a table-first relationship explorer. The future `GET /mission-control/work-graph?scope=&status=&since=&limit=` aggregate returns `nodes[]`, `edges[]`, `attention[]`, and `cursors`.

### Agent Factory Access Inspection

Purpose: make profile and team access legible before an operator promotes, binds, or dispatches them, using `GET /profiles/:name/inspection`, `GET /agent-teams/:name/inspection`, and `GET /agent-factory/catalog` (and the matching `gateway_profile_inspect`, `gateway_agent_team_inspect`, and `gateway_agent_catalog_list` tools). Blocked inspection rows stay visible and fail closed on unknown assets or missing capability requirements.

### Sessions / Channels

Purpose: inspect OpenCode sessions and cross-channel continuity across `/opencode/sessions`, `/session-state`, `/channels/bindings`, `/project-bindings` (and `/project-bindings/resolve`), `/questions`, and `/permissions`. Channel Target identity is `provider + chatId + threadId`; credentials and tokens are never included.

### Initiatives / Projects / Issues

Purpose: manage durable work planning and completion state across `/roadmaps`, `/project-bindings`, `/projects/summary`, `/projects/digest`, `/tasks` (with `/tasks/:id/readiness` and `/tasks/:id/dependencies`), and `/roadmap-completion-proposals`, plus the `/tasks/:id/action`, `/roadmaps/:id/recompute`, `/projects/review-now`, and `/projects/completion-decision` workflow routes. Rows show canonical labels with compatibility IDs.

### Runs

Purpose: understand execution attempts and scheduler behavior across `/runs`, `/environments` (with `/environments/:id/action`), `/tasks/:id/readiness`, `/opencode/sessions/:id`, `/artifacts?ref=...` for refs attached to known runs, and `/governance`. Distinguish not-scheduled from blocked, waiting, paused, and capacity-full.

### Supervisors

Purpose: make durable supervision visible and controllable across `/roadmap-supervisors` (list/detail), the `gateway_roadmap_supervisor_observability` tool, and the `PATCH /roadmap-supervisors/:id`, `/roadmap-supervisors/:id/archive`, `/projects/review-now`, and `/projects/supervisor-action` routes. Distinguish an Initiative Supervisor from a Project Supervisor projection.

### Gates / Alerts

Purpose: one operator queue for decisions and incidents across `/attention`, `/human-gates` (with `POST /human-gates/:id/decision`), `/questions`, `/permissions`, `/roadmap-completion-proposals`, `/alerts` (with `POST /alerts/:id/action`), and `/incident-report?alertId=...`. Gateway gates and OpenCode requests stay separate systems with explicit action routes and ownership labels.

### Agent Factory

Purpose: configure and validate Gateway routing contracts around OpenCode-native assets across `/profiles`, `/agent-teams` (`/validate`, `/propose`, `/:name/apply`, `/:name/bind`, `DELETE /:name`), the `gateway_blueprint_preview`/`gateway_blueprint_apply` tools, the `/opencode/agents|skills|mcp|tools` asset routes, and `/human-gates`. Profile permissions are summarized, never dumped, and secret-like metadata is never included.

### Arena / Evals

Purpose: compare Profiles, Teams, Blueprints, models, and skills using repeatable scenarios and evidence. This view is future-storage oriented: until eval storage exists it surfaces existing quality specs, run evidence, promotion state, and blueprint validation history. Future routes include `GET /evals`, `GET /eval-runs`, `GET /arenas`, `GET /scorecards`, and `GET /promotions` (plus `gateway_eval_*`, `gateway_arena_*`, and `gateway_promotion_*`). Eval and Arena implementation must reuse Runs and artifacts rather than creating a second execution runtime.

### Settings

Purpose: safe operational configuration and service controls across `/config?redact=true` (and `PATCH /config`), `/scheduler`, `/readiness`, `/governance`, `/logs`, the `/storage/backups`, `/storage/backups/verify`, `/storage/export`, and `/storage/restore` routes, and `/restart` / `/shutdown`. Dangerous changes route through explicit confirmations and, for future remote or shared deployments, human gates.

## Aggregate Payload Shape

The current dashboard can continue to call `getMissionData()` server-side. A future Mission Control API should add bounded aggregate routes instead of making the browser fan out across every route.

Recommended route family:

```text
GET /mission-control/overview
GET /mission-control/work-graph
GET /mission-control/sessions
GET /mission-control/initiatives
GET /mission-control/runs
GET /mission-control/supervisors
GET /mission-control/gates
GET /mission-control/agent-factory
GET /mission-control/arena
GET /mission-control/settings
```

Every aggregate response should include:

| Field | Purpose |
| --- | --- |
| `generatedAt` | ISO timestamp for freshness. |
| `sources` | Route/tool names used and per-source status. |
| `scope` | Applied filters: project, initiative, issue, session, channel target, team, profile, time window. |
| `items` or typed collections | Bounded rows for the view. |
| `links` | Stable cross-view links using canonical object kind and ID. |
| `actions` | Allowed actions with route/tool, method, required gate, and disabled reason. |
| `redactions` | Names of fields redacted from the payload. |
| `errors` | Source-specific errors that do not invalidate the whole response. |
| `cursor` | Pagination or event cursor when needed. |

Rows should not contain raw credentials, raw unbounded prompt history, raw stack traces, or full artifact contents. Use IDs, summaries, and redacted refs.

## Current High-Volume Dashboard Contract

The current `/dashboard` implementation keeps using `getMissionData()` server-side, but primary views now render bounded windows for high-cardinality sources. This is the compatibility contract until the future `/mission-control/*` aggregate routes exist.

Operators can pass global or source-specific window parameters on the dashboard URL:

```text
/dashboard?q=blocked
/dashboard?tasksLimit=100&tasksOffset=200
/dashboard?runsSearch=verify&runsLimit=50
/dashboard?workGraphNodesLimit=300&workGraphEdgesLimit=300
```

Supported source keys:

| Source key | View families | Default limit | Maximum limit |
| --- | --- | ---: | ---: |
| `tasks` | Pipeline, Work Graph | 250 | 500 |
| `roadmaps` | Pipeline, Work Graph | 120 | 250 |
| `projectBindings` | Channels, Work Graph | 120 | 250 |
| `runs` | Pipeline, Arena, Work Graph | 120 | 500 |
| `events` | Overview, Channels | 200 | 500 |
| `sessions` | Overview, Channels, Work Graph | 100 | 250 |
| `environments` | Environments | 100 | 250 |
| `alerts` | Health, Work Graph | 100 | 250 |
| `channelBindings` | Channels, Work Graph | 100 | 250 |
| `teamAssignments` | Agent Factory, Work Graph | 100 | 250 |
| `agentProfiles` | Agent Factory, Health | 50 | 100 |
| `agentTeams` | Agent Factory, Health | 50 | 100 |
| `evidence` | Arena, Evidence | 100 | 250 |
| `supervisors` | Health, Work Graph | 100 | 250 |
| `gates` | Health, Work Graph | 100 | 250 |
| `workGraphNodes` | Work Graph | 300 | 600 |
| `workGraphEdges` | Work Graph | 300 | 600 |

Every rendered source contract includes `total`, `matched`, `shown`, `limit`, `offset`, `hasMore`, `truncated`, `available`, `state`, `severity`, `nextAction`, and the source route. Sources may also include `checkedAt`, `freshnessMs`, and `ageMs` when an adapter can prove recency. The source `state` is a calculation-only contract that can represent `loading`, `ready`, `empty`, `partial`, `stale`, `degraded`, `missing`, `blocked`, and `error` without making the HTML renderer infer source health from row counts. The Work Graph renders its own bounded node and edge windows so graph output stays stable even when the underlying task, run, channel, and alert sets are large. Current regression coverage renders at least 500 Issues, 1,000 Runs, 2,000 Events, 100 Channel bindings, and 50 Profiles/Teams without unbounded HTML growth.

The compatibility dashboard now routes this high-volume calculation through `src/mission-control-view-model.ts`. That module owns window specs, URL option parsing, source contracts, source summaries, observability source contracts, and evidence-window selection as pure view-model calculations. `src/dashboard.ts` remains the server-side renderer and should consume those contracts rather than reimplementing pagination, source-state, or search behavior inline. MCP dashboard text consumes the same source summary contract when provided, so stale, degraded, blocked, and partial source states use the same safe next-action language as Mission Control.

`opencode-gateway performance budgets` verifies the same bounded-rendering contract as a warning-only local proof. (The milestone-era `operator cockpit-scale` CLI subcommand was removed in the v1.3.0 consolidation.)

Global search uses `q` or `search`; source-specific search uses `<source>Search`. Source-specific settings win over global search for that source. Limits and offsets accept either camel-case parameters such as `runsLimit` or dotted aliases such as `runs.limit`.

Source availability is explicit. If a source is marked stale, degraded, missing, blocked, or error, Mission Control shows a source contract and safe next action instead of treating an empty row set as success. Missing optional sources are not automatically reported as failures; unavailable diagnostics require a source availability flag or a provided diagnostic row. This keeps first-run dashboards calm while making real upstream failures visible.

High-volume rendering remains redacted. Dashboard windows must not expose raw channel targets, tokens, private prompts, unbounded OpenCode transcript text, or raw run evidence. Use summarized IDs, safe aliases, and redacted artifact refs, and keep raw/local-admin inspection behind the explicit local admin routes documented elsewhere.

## Stable Link Contract

Mission Control links should use canonical object kinds and compatibility IDs:

```text
mc://initiative/roadmap_123
mc://project/project_binding_123
mc://project-alias/payments
mc://issue/task_123
mc://run/run_123
mc://session/ses_123
mc://channel-target/telegram/chat-123/thread-456
mc://supervisor/supervisor_123
mc://gate/gate_123
mc://alert/alert_123
mc://profile/implementer
mc://team/default
mc://blueprint/warehouse@1.0.0
mc://eval/eval_123
mc://arena/arena_123
mc://promotion/promotion_123
```

The UI may translate these to hash routes such as `/dashboard#/runs?runId=run_123`. The link contract gives channels, MCP output, incident reports, and future API responses a stable way to refer to Mission Control objects without exposing internal component names.

## Interactive Drill-Down And Analytics Views

The dashboard exposes server-rendered drill-down and analytics pages driven by the `view` query parameter. They are read-only, fully offline (no external CDNs, fonts, or scripts), and progressive-enhancement first: the server renders every row so the pages work with JavaScript disabled, and a thin inline vanilla-JS layer adds instant filtering plus the shared live-update behavior. All interpolated data (task, roadmap, and run titles, run result text, profile and agent names) is escaped through the safe `html`/`attr` template, so agent-authored content cannot inject markup.

| Route | Shows | Source |
| --- | --- | --- |
| `/dashboard?view=analytics` | Outcome distribution, spend/usage by dimension, completion scorecard, retry hotspots, underperformers, and budget trend for a selectable window (`window=7\|30\|90`) and dimension (`by=profile\|agent\|roadmap`, optional `roadmapId`/`profile`/`agent` scope). | `buildAnalyticsSummary` / `buildAnalyticsScorecard` (the same read-only aggregates behind `GET /analytics`). |
| `/dashboard?view=roadmap&id=<roadmapId>` | The roadmap's tasks (filterable by `status=`), dependencies, completion state, team, and its runs and window spend. | `loadWorkStateReadOnly`, `getRunsForRoadmap`, `buildAnalyticsSummary`. |
| `/dashboard?view=task&id=<taskId>` | Task status, priority, stage, readiness, upstream dependencies, downstream dependents, human gates, and full run history. | `listWorkTaskViews`, `listHumanGatesReadOnly`, `getRunsForTask`. |
| `/dashboard?view=run&id=<runId>` | Run status, cost, tokens, runtime, attempt, session, and stage result (summary, feedback, raw). | `getRunReadOnly` (read-only; a drill-down never creates the store or schema). |

The overview and pipeline lists (tasks, roadmaps, run attribution), the Work Graph edges, and the analytics tables link into these views, and each detail page carries a breadcrumb plus a "Back to Mission Control" link. Two kinds of filtering are available: server-side query-param filters (the analytics window/dimension/scope and the roadmap-detail `status`), and an instant client-side filter box that narrows the currently rendered table rows without a round trip and degrades gracefully when scripting is off. Because live SSE updates reload the current `?view=...&id=...` URL, a drill-down survives live refreshes instead of bouncing back to the overview.

## Sequencing

Recommended implementation order:

1. Add IA route labels and detail drawer foundations while keeping existing dashboard data and current routes.
2. Split current Pipeline, Channels, Health, Environments, Usage, and Certification content into the Mission Control 2.0 view model.
3. Add Work Graph as a table-first relationship explorer using existing routes.
4. Add detail drawers and stable deep links for Initiative, Project, Issue, Run, Session, Channel Target, Supervisor, Gate, Alert, Profile, Team, and Blueprint.
5. Add aggregate `/mission-control/*` JSON routes once browser fan-out or server-side `getMissionData()` becomes too broad.
6. Add Agent Factory blueprint workflows around existing validation/apply gates.
7. Add Arena/Evals only after storage and route contracts exist.
8. Add promotion decision workflows after eval evidence, gates, and rollback contracts exist.

## Non-Goals

Mission Control 2.0 must not:

- Replace OpenCode Web or TUI.
- Create a second model runtime, agent runtime, question system, or permission system.
- Rename or remove `gateway_task_*`, `gateway_roadmap_*`, `/tasks`, `/roadmaps`, or existing database compatibility names.
- Store channel credentials, profile secrets, or raw private session transcripts in dashboard payloads.
- Make destructive or external-side-effect changes without explicit operator action and audit evidence.
- Implement hosted multi-user tenancy or remote authorization in the default local daemon.
- Require Arena, Eval, Promotion, Cycle, or first-class Project storage before the current work graph is useful.
- Turn this spec slice into a broad frontend redesign.

## Acceptance Checklist For Implementation Issues

Follow-on implementation should prove:

- Every view maps rows to Gateway Method nouns and current compatibility IDs.
- Every action names the owning HTTP route or MCP tool.
- Empty, partial, unauthorized, and source-unavailable states are visible and testable.
- The dashboard can scan dense work without hiding critical gates, alerts, or stale runs.
- Drilling from Initiative to Issue to Run to Session to artifact works with stable links.
- Handoffs between channel targets and sessions go through project/channel binding routes.
- Agent Factory surfaces profiles, teams, blueprint diffs, gates, and promotion state without exposing secrets.
- Arena/Evals surfaces are clearly marked as future-storage until routes exist.
- Release/docs checks continue to pass.
