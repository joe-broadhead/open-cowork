# Team Orchestration Protocol

The team orchestration protocol defines how a main agent asks Gateway to form a deterministic, bounded team for scoped durable work. It is a contract for future implementation, not a second agent runtime.

The product direction is profile-bounded agents, precise skills/tools/permissions, eval-backed promotion, and auditable orchestration. A team request never gives every agent every tool. Each role receives only the profile, skills, MCP servers, tools, permissions, environment, budget, gates, and evidence requirements needed for that role.

## Relationship To Delegation

The [Delegation Contract](delegation-contract.md) decides when work leaves the current conversation and becomes durable Gateway work. This protocol decides how a main agent composes a bounded team for that durable work.

Use team orchestration when the main agent needs more than a single profile or stage routing decision:

- different roles need different profiles, tools, or permissions;
- review, verification, audit, support, or reporting must be independently attributable;
- the work needs bounded parallelism, staged gates, or per-role budgets;
- Mission Control needs a visible work graph from request to profile selection to role runs and completion receipt.

Do not use this protocol for loose autonomous swarms, free-form subagent spawning, or prompt-only tool sharing. Gateway must be able to replay the request, profile selection, grants, dispatches, gates, progress, and receipt from durable state and workflow events.

## Owners

| Concern | Main agent | Gateway | OpenCode |
| --- | --- | --- | --- |
| User intent and scope | Builds the bounded request from user context. | Validates that the request can be represented durably. | Owns conversation history. |
| Profile and team selection | Names preferred team/profile constraints and required capabilities. | Resolves promoted/evaluated profiles deterministically and records the selection receipt. | Owns native agent definitions, model providers, skills, tools, MCP servers, and permission prompts. |
| Least-privilege grants | Requests only role-specific capabilities with reasons. | Enforces deny-by-default grants, validates references, and blocks unsafe or excessive grants. | Executes only the tools and permissions exposed to the selected session/profile. |
| Budget and gates | States budget limits, approval thresholds, and required human decisions. | Enforces limits, creates gates, records budget state, and blocks dispatch when a gate is required. | Surfaces questions and permission requests through native OpenCode mechanisms. |
| Dispatch and progress | Monitors briefings and decides whether to ask the user, narrow scope, or accept completion. | Creates durable runs/wakeups, appends workflow events, and emits progress receipts. | Owns session execution, token accounting, messages, and request/permission UI. |
| Completion | Accepts, rejects, or escalates the completion receipt against the original request. | Checks evidence requirements and emits a deterministic receipt. | Stores final role messages and artifacts in session history. |

## Deterministic State Machine

Gateway owns state transitions. The main agent proposes intent; Gateway validates, persists, dispatches, blocks, resumes, or completes through explicit states.

Gateway advances a team request through explicit states: `requested`, `validating`, `rejected`, `blocked`, `accepted`, `planned`, `dispatching`, `running`, `waiting`, `gated`, `reviewing`, `verifying`, `completed`, `failed`, and `cancelled`.

State rules:

- `idempotencyKey` is required on every team request. Replays return the same durable mapping or an idempotent conflict.
- Profile selection happens before session creation. Missing profiles, blocked promotion state, or unsatisfied capabilities block or reject the request before spending tokens.
- Grant validation happens before dispatch. Gateway denies unknown, broad, secret-bearing, or role-inappropriate grants by default.
- Gateway records every durable transition as a workflow event and includes stable object IDs in the payload.
- A run can advance only from the state Gateway believes is current. Stale role results, expired leases, duplicate receipts, and mismatched run IDs are ignored and audited.
- Completion requires a `TeamCompletionReceipt` that cites role results, evidence, budget state, gates, residual risks, and follow-up work.

## Request Object

`TeamOrchestrationRequest` version `1` is the main-agent-to-Gateway envelope.

The full request envelope is a design sketch, not yet implemented; the required fields and validation rules below are the durable contract.

Required fields:

| Field | Meaning |
| --- | --- |
| `version` | Protocol version. Current version is `1`. |
| `idempotencyKey` | Caller-generated stable key for this team request. |
| `objective` | Outcome statement that can be checked against evidence. |
| `scope.target` | Durable target: `issue`, `project`, `initiative`, or `delegation`. |
| `parent.sessionId` | Main OpenCode session that requested orchestration. |
| `team.roles` | Requested role list with purpose and capabilities. |
| `grants` | Role-scoped grant requests. Empty means no dispatchable role access. |
| `budget` | Bounded cost/runtime/token/attempt/concurrency limits. |
| `evidenceRequirements` | Proof the completion receipt must cite. |
| `completionPolicy` | How Gateway and the main agent decide completion. |

Validation rules:

- `grants` are deny-by-default. A role receives only the explicit skills, MCP servers, tools, and permissions on its grant after Gateway validation.
- Broad grants such as `tools: ["*"]`, `mcpServers: ["*"]`, `skills: ["*"]`, or blanket `permission: { "*": "allow" }` are invalid unless a named profile has a promoted, operator-approved exception and the request includes a human gate. The default behavior is to reject them.
- Grant reasons are required and are stored in audit events. A missing reason blocks dispatch.
- Role purposes, capability requirements, and evidence requirements must be bounded strings. They must not contain secrets or raw credentials.
- A role cannot request permissions that contradict its profile contract. For example, a review-only profile cannot receive `edit=allow`.
- `requiredPromotionState` defaults to `["promoted"]` for production work and may include `evaluated` only when the main agent states why staged rollout is acceptable.
- `maxConcurrentRoles` must be finite and must not exceed Gateway scheduler policy.

## Profile Selection Receipt

Gateway resolves the request into a deterministic selection receipt before creating any role session.

The `profile_selection` receipt envelope (selected team/revision/promotion state, per-role profile/agent/revision/`grantHash`, blocked roles, and audit inputs) is a design sketch, not yet implemented. The deterministic selection order below is the durable contract.

Selection is deterministic:

1. Resolve an explicitly named team when present.
2. Resolve explicitly requested role profiles.
3. Resolve team role mappings.
4. Resolve task or roadmap agent-team bindings.
5. Resolve scheduler stage defaults.
6. Block on ambiguity, unavailable profile, blocked promotion state, missing capability, or invalid grant.

Gateway must record the team revision, profile revisions, grant hashes, promotion states, and selection inputs. Later run attribution must point back to this receipt.

## Eval And Promotion Checks

Team orchestration is covered by deterministic unit suites (`src/__tests__/team-assembly.test.ts` and the work-store promotion tests). They do not call a live model; they drive the Gateway assembly, assignment, receipt, progress briefing, and promotion APIs directly so future regressions fail against durable contracts rather than prompt text.

Required scenarios cover team assembly, scoped assignment, permission denial, gate failure, progress briefing, successful completion, and Agent Factory promotion/rollback guardrails. Promotion scorecards are recorded through the `promotion_scorecard_create` MCP tool and the `POST /promotion/scorecards` route. A failed required check is persisted as blocked promotion evidence, and Gateway refuses to promote a team/profile from that blocked scorecard.

## First Supported Assembly Path

The first implemented path is deterministic assembly without dispatch:

- MCP: `gateway_team_assemble`
- HTTP: `POST /agent-factory/teams/assemble`

The request names an Agent Factory blueprint and team:

```json
{
  "idempotencyKey": "team:req:delivery:2026-06-15",
  "blueprintName": "delivery",
  "blueprintVersion": "1.0.0",
  "teamName": "delivery",
  "roles": [
    { "role": "implement", "requiredCapabilities": ["repo-write"] },
    { "role": "verify", "requiredCapabilities": ["review"] }
  ],
  "grants": [
    {
      "role": "implement",
      "skills": ["gateway-stage"],
      "mcpServers": ["gateway"],
      "tools": ["gateway_task_update"],
      "permission": { "read": "allow", "edit": "ask" },
      "reason": "Implement needs scoped repo edits and task updates."
    }
  ],
  "budget": { "maxTokens": 250000, "maxConcurrentRoles": 2 },
  "gates": [{ "gate": "review_pass", "requiredBefore": "complete" }]
}
```

Executable team work is created as a second, fail-closed step:

- MCP: `gateway_team_assignment_create`
- HTTP: `POST /team-assignments`

Assignments link assembled members to durable Gateway work (`taskId`, `roadmapId`, `runId`), OpenCode sessions (`sessionId`), and delegation receipts (`delegationId`). Each assignment records the selected member, budget limits (`maxRuntimeMs`, token/cost placeholders, `retryLimit`), exact skill/tool/MCP/permission scope, required evidence, and gates for review, evidence, eval, human approval, and completion quality.

Gate and review outcomes are recorded as durable receipts:

- MCP: `gateway_team_assignment_receipt_record`
- HTTP: `POST /team-assignments/:id/receipts`

Completion receipts fail closed until required completion gates have passing review or gate receipts and required evidence is present. Mission Control exposes recent assignments and receipt history alongside the work graph.

Gateway resolves the named persisted blueprint file, previews it with the normal Agent Factory validator, selects the named team, resolves role profiles, intersects requested grants with profile contracts, validates access with least-privilege inspection, and records a durable audit event containing a `team_assembly` receipt.

Assembly fails closed before dispatch when the blueprint is invalid, the team/profile is missing, a profile or team is not in an allowed promotion state, a role capability is unsatisfied, or a requested grant is unknown, wildcarded, unsafe, or broader than the selected profile. The response includes deterministic rejection reasons with an action field so the main agent can repair the request.

The returned receipt includes stable `teamRequestId`, selected team ID, role member IDs, selected profile versions/revisions, effective grants, grant hashes, budget and gate placeholder fields, blocked roles, selection inputs, and the audit event ID. This path does not create OpenCode sessions or Gateway runs; later runtime paths can attach run plans to the assembly receipt.

## Role Assignment And Run Plan

After selection, Gateway creates a run plan. The plan binds roles to stages, dependencies, sessions, budgets, gates, and evidence obligations.

The `teamRunPlan` envelope (with per-role `roleRunId`, `stage`, `profile`, `sessionPolicy`, `dependsOn`, `budget`, and `requiredEvidence` fields) is a design sketch, not yet implemented. A future first-class `team_runs` table can aggregate role run IDs. The run-plan rules below are the durable contract.

Run plan rules:

- `roleRunId` is stable for a team request, role, stage, and attempt generation.
- Gateway may parallelize roles only when their `dependsOn` lists and gates allow it.
- Each role run maps to an OpenCode session and a Gateway run. A future first-class `team_runs` table can aggregate those run IDs without changing the role contract.
- The session prompt for each role includes only that role's grant, objective, bounded context, evidence requirements, gates, and dependencies.
- A role result is invalid if it claims artifacts or evidence outside the assigned scope without declaring them as discovered follow-up work.

## Least-Privilege Grants

Least privilege is a hard requirement, not an optimization.

Grant rules:

- Default permission is `deny`.
- Every allowed skill, MCP server, tool, and permission key must appear in the role grant or in the selected profile contract.
- Gateway intersects the requested grant with the selected profile. The effective grant can only be narrower than either input, unless a human-approved profile override explicitly expands it.
- Review, verify, audit, support, and reporting roles default to no file edits.
- External side effects, destructive commands, credential use, channel sends, PR creation, production deploys, and remote environment mutations require an explicit gate.
- Secret values must not appear in grants, team descriptions, role purposes, quality defaults, workflow events, or Mission Control payloads. Store only references to credential gates or environment selectors.

Example effective grant:

```json
{
  "role": "review",
  "requestedGrantHash": "grant_f017",
  "profileGrantHash": "profile_grant_921c",
  "effectiveGrantHash": "effective_grant_4dd1",
  "effective": {
    "skills": ["gateway-stage", "gateway-review-gate"],
    "mcpServers": ["gateway"],
    "tools": ["read", "grep", "gateway_task_update"],
    "permission": { "read": "allow", "grep": "allow", "edit": "deny", "bash": "ask", "gateway_*": "allow" }
  },
  "denied": [
    { "tool": "edit", "reason": "review role is read-only by profile contract" }
  ]
}
```

## Progress Briefings

The main agent should not poll every child session or replay full logs. It should consume Gateway briefings that are bounded, cursored, and event-aware.

Scheduled briefing expectations:

- Include the `teamRequestId`, `teamRunId`, current state, cursor, and generation.
- Summarize changed work since the last briefing cursor.
- List active role runs, blocked roles, open gates, open OpenCode questions or permissions, recent role completions, failed attempts, budget used/remaining, and recommended next actions.
- Cite durable IDs: task, roadmap, run, role run, session, gate, alert, supervisor receipt, and workflow event IDs.
- Include no raw secrets, hidden prompts, or unrelated session transcript.
- Keep the briefing short enough for the main agent to act without redispatching context.

Event-driven briefing expectations:

- Trigger on role blocked, gate opened, permission/question required, budget threshold crossed, run stalled, role completed, team completed, team failed, human approval needed, and completion proposed.
- Use a deterministic dedupe key made from `teamRequestId`, event type, subject ID, state generation, and cursor.
- Explain why this event woke the main agent and what decision is needed now.
- Include enough evidence for the main agent to decide whether to continue, narrow scope, ask the user, or cancel.

Briefing example:

```json
{
  "briefingKind": "team_progress",
  "teamRequestId": "team_req_123",
  "teamRunId": "team_run_456",
  "reason": "event:gate_opened",
  "cursor": { "fromEventId": 880, "toEventId": 887 },
  "summary": "Review passed, but PR creation requires human approval before the publishing role can continue.",
  "state": "gated",
  "roles": [
    { "roleRunId": "role_run_impl", "role": "implement", "status": "completed", "latestRunId": "run_1" },
    { "roleRunId": "role_run_review", "role": "review", "status": "completed", "latestRunId": "run_2" },
    { "roleRunId": "role_run_publish", "role": "publish", "status": "waiting", "gateId": "gate_3" }
  ],
  "budget": { "tokensUsed": 194000, "costUsd": 4.65, "runtimeMs": 5100000 },
  "nextActions": [
    { "kind": "human_gate", "id": "gate_3", "summary": "Approve or reject PR creation." }
  ],
  "links": {
    "task": "/tasks/task_456",
    "teamRun": "/team-runs/team_run_456",
    "gate": "/human-gates/gate_3"
  }
}
```

## Completion Receipt

Completion receipts close the loop for auditability. The main agent uses the receipt to accept completion, ask for more work, or escalate.

The full `team_completion` receipt is a design sketch, not yet implemented. The receipt rules below are the durable contract: it names the final state of every role, cites the original `evidenceRequirements` by ID, and records budget state, gate decisions, residual risks, and follow-ups.

Receipt rules:

- `status` is one of `completed`, `completed_with_followups`, `failed`, `cancelled`, or `blocked`.
- The receipt must include the final state of every role in the run plan.
- Evidence must cite the original `evidenceRequirements` by ID.
- Residual risks and follow-ups are part of the receipt, not hidden in free-form final prose.
- The main agent may not mark the parent task complete when required gates are open, required role runs are non-terminal, or required evidence is missing.

## Existing Primitive Mapping

This protocol can be implemented incrementally on top of current Gateway primitives.

| Protocol object | Existing primitive or projection |
| --- | --- |
| `TeamOrchestrationRequest` | Extends `DelegationRequest` for durable work that needs role composition. |
| `teamRequestId` | Future receipt row; initially a workflow event subject ID and delegation receipt metadata. |
| `ProfileSelectionReceipt` | `agentTeams`, `profiles`, generated team revision, profile validation events. |
| Role assignment | Task stage, `task.stageProfiles`, `task.agentTeam`, roadmap agent-team binding, scheduler stage profile. |
| Role run | Existing `runs` row with `stage`, `resolvedProfile`, `agentTeam`, `agentTeamVersion`, OpenCode `sessionId`. |
| Effective grants | Profile permission/skill/tool references plus future per-run grant snapshot. |
| Budget | Existing governance config, profile budget hints, task/run metadata, human gates for over-threshold work. |
| Gates | `human_gates`, OpenCode questions, OpenCode permissions, attention routing. |
| Evidence | `qualitySpec`, stage result evidence, artifacts, workflow events, supervisor receipts. |
| Progress briefing | `GET /briefing`, `gateway_briefing`, progress update policy, supervisor wakeup receipts. |
| Mission Control work graph | Existing tasks, runs, sessions, gates, alerts, teams, profiles, workflow events; future team-run nodes and edges. |
| Completion receipt | Future `team_completion_receipts`; initially a deterministic workflow event plus task/roadmap completion evidence. |

## Mission Control Work Graph

Mission Control should represent team orchestration as edges, not hidden prompt text.

Required nodes:

- Team request
- Profile selection receipt
- Team run
- Role run
- Effective grant
- OpenCode session
- Gateway run
- Gate
- Evidence artifact
- Completion receipt

Required edges:

| Edge | Meaning |
| --- | --- |
| `team_request -> profile_selection_receipt` | Gateway resolved profiles and grants for this request. |
| `profile_selection_receipt -> role_run` | The role run used that resolved profile/grant. |
| `role_run -> opencode_session` | OpenCode executed the role in that session. |
| `role_run -> gateway_run` | Gateway tracked durable stage execution. |
| `role_run -> gate` | Dispatch or completion waited for that gate. |
| `role_run -> evidence` | The role produced or checked that artifact/evidence. |
| `team_run -> completion_receipt` | The receipt closed or blocked the team run. |

Rows and drawers should show team/profile revisions, promotion states, grant hashes, state generation, budget status, and latest progress briefing cursor. Operators must be able to answer "who had which tools, why, and what did they prove?" without reading every OpenCode message.

## Failure Modes

Gateway returns deterministic failure modes. When possible, it fails before mutation. After durable objects exist, the same failure class appears in role state, gates, attention, briefings, and workflow events.

| Failure mode | When it happens | Expected handling |
| --- | --- | --- |
| `invalid_team_request` | Missing objective, parent session, role purposes, grants, budget, evidence requirements, or completion policy. | Reject before mutation and ask the main agent to repair the request. |
| `unavailable_profile` | Requested profile/team does not exist, is disabled, is blocked, or lacks an acceptable promotion state. | Block before session creation and return candidate profiles when safe. |
| `capability_unsatisfied` | The resolved profile cannot satisfy a role capability requirement. | Block with missing capabilities and profile/team references. |
| `denied_permission` | A grant asks for a tool, skill, MCP server, environment, or permission not allowed by policy/profile. | Block or reject, citing the denied grant item and reason. |
| `budget_exhausted` | Token, cost, runtime, attempt, or concurrency limit is reached. | Stop dispatch, record budget state, and open a budget gate only if policy allows extension. |
| `failed_gate` | Required review, verify, safety, credential, permission, or human gate is rejected or times out. | Mark affected role waiting, blocked, failed, or cancelled according to gate policy. |
| `stalled_agent` | A role run lease expires, heartbeat is stale, or no result arrives before timeout. | Record stale state, retry within budget, then block with recovery options. |
| `human_approval_needed` | External side effects, budget increases, unsafe environments, credentials, or publication need approval. | Create a human gate and surface it through attention, channels, and briefings. |
| `evidence_missing` | A role or completion receipt omits required proof. | Fail review/verify or block completion with missing evidence IDs. |
| `stale_or_duplicate_result` | Role result refers to an old lease, wrong role/run/session, or already-applied generation. | Ignore side effects, record audit event, and keep current state unchanged. |

## Main-Agent Contract

The main agent must:

- keep team requests scoped to the user's objective and current durable target;
- request the smallest useful set of roles;
- state role purposes, constraints, non-goals, budgets, gates, and evidence requirements explicitly;
- request least-privilege grants and explain each grant;
- consume scheduled and event-driven briefings instead of reading every child transcript by default;
- ask the user or open a gate when required information, credentials, permission, budget, or approval is missing;
- accept completion only from a receipt that satisfies the original evidence requirements and gate policy;
- preserve residual risks and follow-up implementation slices in the parent task or PR report.

The main agent must not:

- give broad default tool access to every role;
- bypass Gateway gates by asking OpenCode sessions to perform gated side effects directly;
- hide grants, budgets, or profile choices in prompt text only;
- mutate team/profile runtime config as part of selection unless the request is explicitly an approved config change;
- mark work complete when Gateway reports blocked, missing evidence, failed gate, or exhausted budget.

## Gateway Contract

Gateway must:

- validate team requests before dispatch;
- resolve teams/profiles deterministically and record selection receipts;
- intersect requested grants with profile contracts and policy;
- deny broad or unknown grants by default;
- create sessions/runs only after profile, grant, budget, gate, and environment checks pass;
- persist run plans, role state, budget use, gates, evidence, briefings, and completion receipts;
- emit workflow events for every durable transition;
- expose team state in Mission Control and the main-agent briefing;
- recover from duplicate scheduler passes, stale leases, and repeated wakeups without double-dispatching;
- keep OpenCode-owned questions, permissions, tool execution, and session history in OpenCode while projecting their status into Gateway attention.

Gateway must not:

- silently widen a grant to match a powerful profile;
- pick ambiguous profiles or projects by guessing;
- store secret values in team/grant/audit payloads;
- dispatch blocked, deprecated, or unevaluated profiles when policy requires promoted/evaluated profiles;
- treat successful role prose as completion without structured evidence and a receipt.

## Minimal Implementation Slices

Follow-up implementation issues can be cut from this spec:

1. Add `TeamOrchestrationRequest`, grant, run-plan, briefing, and completion-receipt schemas with fixture validation.
2. Persist team request, profile selection, effective grant, role run, and completion receipt records or equivalent receipt tables.
3. Add profile/team selection resolver that records revisions, promotion state, capability satisfaction, and denied grants.
4. Enforce least-privilege effective grants at dispatch by intersecting request grants with profile contracts and policy.
5. Map role runs onto existing task/run/session stages and expose role attribution in run records.
6. Add scheduled and event-driven team progress briefings to `GET /briefing` and `gateway_briefing`.
7. Add Mission Control work-graph nodes and edges for team requests, role runs, grants, gates, evidence, and receipts.
8. Add budget/gate enforcement for per-team and per-role limits.
9. Add completion receipt verification against evidence requirements and gate state.
10. Add eval/promotion checks so production dispatch can require promoted or evaluated profiles and teams.
