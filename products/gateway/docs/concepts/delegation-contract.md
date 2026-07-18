# Delegation Contract

Delegation is the handoff from a conversational agent or user surface into Gateway durable work. The contract decides when work remains in the current OpenCode conversation and when Gateway must persist it as tasks, roadmaps, project bindings, supervisors, gates, and notifications.

This contract does not replace OpenCode-native subagents. Use native subagents for bounded, in-turn assistance where the parent conversation can still own context, review, and completion. Use Gateway delegation when the work needs durable state, scheduling, supervision, evidence, cross-session callbacks, channel notifications, or an auditable definition of done.

When durable delegated work needs multiple bounded roles with separate profiles, grants, budgets, gates, and evidence requirements, use the [Team Orchestration Protocol](team-orchestration-protocol.md) on top of this delegation envelope.

## Decision Rules

Keep work conversational when all of these are true:

- The request can finish in the current session without waiting for a later scheduler turn.
- The parent agent can verify the result directly.
- No durable project, channel callback, supervisor, budget gate, credential gate, or schedule is needed.
- Losing the current context would not lose the user's work plan or decision state.

Delegate to Gateway when any of these are true:

- The work has acceptance criteria, definition of done, dependencies, or evidence requirements that should survive the current turn.
- The work should run later, recur, respect a deadline, or be resumed by a scheduler.
- The work belongs to a project or roadmap that needs status, digest, completion, or supervisor review.
- The work requires a human gate for approval, credentials, external side effects, budget exceptions, or unsafe operations.
- Progress or completion must be sent back to a parent OpenCode session or originating Telegram/WhatsApp channel.
- Multiple issues, an initiative, or an agent-team proposal must be tracked as auditable durable objects.

If the agent is only trying to ask another model to inspect local context before continuing, use OpenCode-native subagents. If the agent is asking Gateway to own lifecycle, state, scheduling, or callbacks, use this contract.

## Request Shape

`DelegationRequest` version `1` is the durable handoff envelope.

Required fields:

| Field | Meaning |
| --- | --- |
| `version` | Contract version. Defaults to `1`. |
| `idempotencyKey` | Stable caller-generated key for this intended handoff. Retrying the same request with the same key must return the same durable mapping or an idempotent conflict. |
| `target` | One of `issue`, `project`, `initiative`, or `agent_team_blueprint`. |
| `objective` | Short outcome statement. This becomes the task or roadmap objective, not a vague instruction. |
| `context.summary` | Bounded context the receiving worker needs without rereading the whole parent session. |
| `acceptanceCriteria` | Deterministic list of user-visible success conditions. |
| `definitionOfDone` | Deterministic list of completion requirements. |

Optional fields:

| Field | Meaning |
| --- | --- |
| `context.references` | Issue IDs, URLs, file paths, docs, session IDs, or decision refs. |
| `context.constraints` | Safety, scope, architecture, privacy, or style constraints. |
| `context.nonGoals` | Explicit exclusions. |
| `desired.profile` | Preferred Gateway profile for default stage routing. |
| `desired.agentTeam` | Preferred Gateway agent team for roadmap/task routing. |
| `desired.stageProfiles` | Per-stage profile overrides such as `review` or `verify`. |
| `environment` | Execution environment selector or named environment. |
| `schedule.earliestStartAt` | ISO timestamp before which the work must not run. |
| `schedule.deadlineAt` | ISO deadline used for ordering and SLA displays. |
| `schedule.recurrence` | Recurrence expression for repeated work. |
| `schedule.supervisorCadenceMs` | Desired roadmap supervisor review interval. |
| `budget` | Cost/runtime/attempt limits and approval threshold. |
| `evidence` | Required proof, with optional type/ref/summary. |
| `notificationTarget` | Callback target: parent session, project binding, channel, custom, or none. |
| `parentSession` | Originating OpenCode session and optional channel surface. |
| `completionPolicy` | Roadmap completion policy: `manual`, `assistant_proposes_user_approves`, `auto_when_evidence_complete`, or `never_auto_complete`. |

The TypeScript schema lives in `src/delegation-contract.ts`. The delegation adapter accepts only this envelope or a lossless equivalent translated into it.

## Targets

### Issue

An `issue` target creates one durable Gateway task. It must include `roadmapId` or `projectAlias`; otherwise Gateway returns `ambiguous_project_context`.

Mapping:

- `objective`, target title, and context map to `gateway_task_create` `title`, `description`, and `note`.
- `acceptanceCriteria`, `definitionOfDone`, constraints, evidence, required artifacts, and verification commands map to task `qualitySpec`.
- `desired.profile`, `desired.agentTeam`, and `desired.stageProfiles` map to `agent`, `agentTeam`, and `stageProfiles`.
- `environment`, `schedule`, and manual gates map to task environment, schedule fields, and `manualGate`.

### Project With Issues

A `project` target creates or resolves a supervised project and may create child tasks atomically.

Mapping:

- New project: `gateway_project_create` or `POST /projects` creates a roadmap, default supervisor, project binding, and optional channel binding.
- Existing project: resolve through `gateway_project_context_resolve` or `GET /project-bindings/resolve`.
- Child issues: `gateway_roadmap_create_with_tasks` or `gateway_task_bulk_create`.
- Roadmap-level quality and completion policy map to roadmap `qualitySpec`.

### Initiative

An `initiative` target is a roadmap-level durable outcome that may later fan out into projects or tasks. Current Gateway storage has no separate initiative table, so the delegation adapter represents initiatives as roadmaps with initiative context in the title, quality spec, milestones, and workflow events.

Mapping:

- `gateway_roadmap_create` or `gateway_roadmap_create_with_tasks`.
- Optional default supervisor through `gateway_roadmap_supervisor_create`.
- Optional alias/channel surface through `gateway_project_binding_upsert`.
- Milestones are stored in roadmap context/evidence until a first-class initiative primitive exists.

### Agent Team Or Blueprint Proposal

An `agent_team_blueprint` target proposes project/domain routing. It must not silently mutate runtime config.

Mapping:

- Validate with `gateway_agent_team_validate`.
- Open an auditable proposal with `gateway_agent_team_propose`.
- Apply only through `gateway_agent_team_apply` after the required human gate.
- Bind to a roadmap or task with `gateway_agent_team_bind` after approval.

## Callback And Progress Events

Delegation must always produce an auditable callback path unless `notificationTarget.mode` is `none`.

Parent session behavior:

- `parentSession.sessionId` identifies the OpenCode session that requested delegation.
- Gateway should post or surface status back to that session through the existing OpenCode session and attention surfaces.
- If `parentSession.channel` is present, Gateway also resolves or creates the matching project/channel binding before sending channel notifications.
- If the parent session no longer exists, Gateway keeps the durable work and records a callback failure event instead of cancelling work.

Channel behavior:

- Channel callbacks go through project bindings and channel send primitives, not through ad hoc provider calls.
- `notificationMode=immediate` sends delegated progress as lifecycle changes are recorded.
- `notificationMode=digest` batches non-critical progress and still sends critical gates, blockers, failures, and completion proposals.
- `muted` suppresses delivery but not workflow events.
- Quiet-hours policy defers normal progress and records the deferral reason and next delivery time on suppression events. Critical delegated progress can bypass digest and quiet hours according to the shared progress update policy.

See [Progress Update Policy](progress-update-policy.md) for policy resolution, escalation defaults, and operator controls.

Progress events are Gateway-owned workflow events. Gateway appends these event types with `idempotencyKey`, durable subject IDs, parent session ID, channel target/policy, summary, and evidence where applicable:

| Event | Expectation |
| --- | --- |
| `delegation.accepted` | Request parsed, validated, and accepted for mapping. |
| `delegation.rejected` | Request refused before mutation, with failure mode. |
| `delegation.mapped` | Durable objects were created or resolved. Include task/roadmap/supervisor/binding IDs. |
| `delegation.progress` | Lifecycle update for created, dispatched, stage advanced, blocked, gate opened, completed, failed, or completion proposed. |
| `delegation.blocked` | Work needs user input, credentials, approval, project disambiguation, or budget decision. |
| `delegation.completed` | Definition of done satisfied, with evidence and completion policy result. |
| `delegation.failed` | Terminal failure that is not waiting on user action. |

These events complement existing `task.*`, `roadmap.*`, `human_gate.*`, `project.binding.*`, `roadmap.supervisor.*`, and `project.notification.*` events. Delivery records `delegation.progress.notified`, `delegation.progress.suppressed`, or `delegation.progress.failed` with stable dedupe keys so retries do not duplicate user-visible sends.

## Failure Modes

Delegation adapters must return deterministic failure modes before mutating state when possible:

| Failure mode | When to return it | Expected handling |
| --- | --- | --- |
| `insufficient_scope` | Missing objective, context, acceptance criteria, definition of done, target title, or blueprint content. | Ask the parent session/user for the missing contract fields. |
| `unsafe_operation` | Request would perform destructive, external, privacy-sensitive, or policy-restricted work without an explicit gate/safety plan. | Refuse or create a human gate before scheduling. |
| `missing_credentials` | Required credentials are unavailable or cannot be represented safely. | Create `credentials_required` gate or ask through OpenCode-native credential flow. |
| `ambiguous_project_context` | More than one project/roadmap/session/channel could match, or an issue has no project context. | Return candidates and require alias or roadmap ID. |
| `invalid_profile_or_team` | Requested profile/team does not exist or cannot satisfy capability requirements. | Validate with profile/team config and block before session creation. |
| `budget_or_gate_required` | Budget exceeds approval threshold, attempts are exhausted, or requested side effects require approval. | Create human gate or reject until approval is supplied. |

Once durable objects exist, the same conditions should also appear in task `manualGate`, human-gate records, attention items, and progress events so the parent can audit the reason for waiting.

## Current Primitive Mapping

| Contract field | Current Gateway primitive |
| --- | --- |
| `objective` | `TaskQualitySpec.objective`, `RoadmapQualitySpec.objective`, task/roadmap title and description. |
| `context.summary` | Task `description`, task `note`, roadmap quality objective, supervisor note. |
| `context.references` | Task note, quality evidence requirements, workflow event payload refs. |
| `acceptanceCriteria` | Task or roadmap `qualitySpec.acceptanceCriteria`. |
| `definitionOfDone` | Task or roadmap `qualitySpec.definitionOfDone`. |
| `desired.profile` | Task `agent`, supervisor `profile`, or scheduler stage profile choice. |
| `desired.agentTeam` | Task or roadmap `agentTeam`. |
| `desired.stageProfiles` | Task `stageProfiles`. |
| `environment` | Task or roadmap `environment` selector. |
| `schedule.earliestStartAt` | Task `earliestStartAt`. |
| `schedule.deadlineAt` | Task `deadlineAt`. |
| `schedule.recurrence` | Task `recurrence`. |
| `schedule.supervisorCadenceMs` | Supervisor `cadence.intervalMs`. |
| `budget.maxAttempts` | Scheduler retry limit policy or task-specific gate note until per-task retries exist. |
| `budget.maxCostUsd`, `budget.maxRuntimeMs` | Governance/human gate metadata until per-delegation budgets exist. |
| `evidence` | Task/roadmap `evidenceRequirements`, required artifacts, and stage result evidence. |
| `notificationTarget` | Project binding notification mode, channel binding, `channel_send_to_task`, `channel_send_to_roadmap`. |
| `parentSession` | Supervisor `sessionId`, project binding `sessionId`, callback event payload. |
| `completionPolicy` | Roadmap `qualitySpec.completionPolicy` and completion proposal workflow. |
| `idempotencyKey` | Adapter-level dedupe key stored in `delegation_receipts` and mirrored on `delegation.*` event payloads. |

## Implementation Notes

The delegation adapter is a narrow adapter around the current primitives:

1. Parse and validate `DelegationRequest`.
2. Check `delegation_receipts` idempotency before mutation.
3. Resolve project context deterministically.
4. Validate requested profile/team and environment before creating sessions.
5. Create required human gates before scheduling unsafe, credentialed, or budget-exceeding work.
6. Map to task, roadmap/project, initiative-as-roadmap, or agent-team proposal primitives.
7. Append `delegation.accepted`, `delegation.mapped`, and future progress events with durable object IDs.
8. Send callbacks through parent session/project/channel surfaces.
9. Return a stable mapping response that callers can poll or replay.

Do not encode delegation as prompt text alone. The contract must be parseable, validated, persisted through durable primitives, and replayable from workflow events.
