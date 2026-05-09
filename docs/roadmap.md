# Roadmap

Last updated: 2026-05-10.

> **Status: forward-looking.** This document describes where Open Cowork is
> headed, not what it ships today. Nothing here is a commitment. Items may be
> reshaped, deferred, or dropped as the product evolves. For the current
> feature set, see [Desktop App Guide](desktop-app.md),
> [Threads](threads.md), [Automations](automations.md), and
> [Architecture](architecture.md).

Open Cowork is becoming a desktop-first operations desk and control plane for
supervised OpenCode agent teams.

The first principle does not change:

- **OpenCode owns execution:** agents, subagents, sessions, child sessions,
  permissions, approvals, compaction, MCP execution, streaming events, tool
  semantics, and native skills.
- **Open Cowork owns composition:** desktop UX, crews, work items, SOPs,
  automations, trace projection, eval records, improvement proposals,
  capability packs, workspace profiles, integration bundles, skills packaging,
  built-in/custom agents, and user-facing operations state.

If a roadmap item starts to replace OpenCode runtime behavior rather than
compose it, simplify it before shipping.

## Product Target

The product is an operator console for accountable local agent work:

```text
work item -> route -> plan -> policy -> execute -> trace -> evaluate -> deliver -> improve
```

The stable vocabulary is:

- **Agents** are workers.
- **Work items** are intake.
- **Crews** are teams.
- **SOPs** are repeatable processes.
- **Runs** are work instances.
- **Artifacts** are work products.
- **Approvals** are human control points.
- **Policy decisions** explain authority.
- **Traces** are accountability, not transcripts.
- **Evals** are quality control and release gates.
- **Improvement proposals** are governed learning.
- **Capabilities** are scoped authority.
- **Pulse** becomes mission control.

## Source Of Truth Boundaries

OpenCode and Open Cowork keep separate sources of truth:

- OpenCode session history is the source of truth for execution transcripts.
- OpenCode events are the source stream for runtime activity.
- Open Cowork trace events are the source of truth for product accountability:
  work items, crew/SOP runs, policy decisions, approvals, artifacts, evals,
  deliveries, and improvement proposals.
- Open Cowork operational views should rebuild high-level state without
  hydrating full OpenCode transcripts.
- Crew membership and Crew Run participation are Open Cowork product state.
  OpenCode `permission.task` narrows model delegation, but it is not the only
  source of truth for crew boundaries.

User-initiated `@agent` calls, lead-agent delegation, SOP nodes, and system
steps must be distinguishable in traces.

## First-Principles Operating Questions

Use these questions when deciding whether a feature belongs in the next
milestone:

- What execution behavior is already owned by OpenCode?
- What product state must survive restart, replay, export, or audit?
- What authority did the run have, and who granted it?
- What evidence proves the output is good enough?
- What changed because of the run?
- What would make this safe if it were triggered by a schedule or channel?
- What must be visible before autonomy increases?

## Roadmap Sequence

The order is intentional:

- Memory without traceability becomes folklore.
- Autonomy without evals becomes risk.
- Channels without policy become an attack surface.
- Crews without observability become chaos.

### 0. Stabilize The Local Substrate

Issue: [#244](https://github.com/joe-broadhead/open-cowork/issues/244)

Goal: keep the desktop app reliable while the agent-operations primitives land.
This milestone makes Open Cowork a stable local cockpit over OpenCode-native
execution before adding Crews, traces, evals, and governed learning.

Scope:

- local, OpenCode-native execution
- native OpenCode subagent/task delegation as the default execution path
- child session id as the canonical branch identity everywhere
- real OpenCode todos separate from Open Cowork product workflow state
- lightweight background threads unless opened
- frame-batched, session-scoped stream updates
- reload parity for task cards, tool calls, approvals, questions, child
  sessions, and timing

Acceptance bar:

- 10 parallel subagents in one thread render correctly and finish cleanly.
- 20 active threads can stream simultaneously without status flicker or
  cross-thread corruption.
- No false task completion on thread switches.
- Root user messages never disappear during rehydrate.
- Parent threads synthesize after child completion.
- Task cards, tool calls, approvals, and child sessions survive reload/history
  hydration.
- No fuzzy or suffix-based session-id matching is introduced.

### 1. Ship Cowork Crews, Trace Events, And Evals

Issue: [#245](https://github.com/joe-broadhead/open-cowork/issues/245)

Goal: turn Open Cowork from an agent cockpit into an operations desk for
accountable OpenCode agent teams. Crews should ship together with
traceability and evals, not as a loose group-of-agents feature.

Core product objects:

- `CoworkWorkItem`
- `CrewDefinition`
- `CrewVersion`
- `CrewMember`
- `CrewRun`
- `CrewRunNode`
- `CoworkTraceEvent`
- `CrewArtifact`
- `CrewApproval`
- `PolicyDecision`
- `OutcomeRubric`
- `OutcomeEvaluation`
- `EvalSuite`
- `EvalCase`

Every durable primitive must include a schema version and migration path before
it is persisted in user data.

Minimum Lovable Crew MVP:

- one lead agent
- two or more specialist agents
- one evaluator agent
- one workspace profile
- one outcome rubric
- one budget cap
- one fixed workflow: `plan -> delegate -> join -> evaluate -> deliver`

Non-scope for the MVP: arbitrary graph editing, external channels, autonomous
memory mutation, org RBAC, HR connectors, cloud workers, or a complex policy
engine.

Acceptance bar:

- A user can create a crew with a lead, specialists, and evaluator.
- A crew can run a branch/join workflow using OpenCode-native sessions.
- Every plan, approval, tool call, artifact, evaluator result, and delivery is
  traceable.
- Trace export preserves structure while supporting redacted payloads.
- A 10-agent local run remains inspectable without hydrating every transcript.
- Crew Run Detail shows status, blockers, outputs, authority, quality,
  active/blocked agents, specialist swimlanes, tool calls, approval requests,
  artifacts, evaluator results, token/cost usage, and trace timeline.
- Failed evals can trigger bounded revision or human escalation.
- Crew edits create new versions and do not rewrite run history.

### 2. Unify SOPs And Automations

Issue: [#246](https://github.com/joe-broadhead/open-cowork/issues/246)

Goal: stop treating automations and team workflows as separate concepts.
Automations become scheduled, manual, inbox-triggered, and future
channel-triggered SOP or Crew runs while preserving the durable automation
control plane that already exists.

Scope:

- `SopDefinition` and versioned SOPs
- trigger types: manual, schedule, inbox item, future webhook
- required inputs and eligibility checks
- work graph, approval gates, retries, failure policy, and delivery policy
- rubric attachment
- save successful run as SOP
- edit SOP without rewriting prior run history
- automation UI as the operational view over SOP/Crew runs

Implementation rule: extend the existing automation model rather than replacing
it. Preserve inbox, work items, runs, deliveries, retry, heartbeat,
max-duration, and review-first behavior.

Acceptance bar:

- A successful automation can become a reusable SOP.
- Every SOP run links to the exact SOP version.
- Runs show inputs, outputs, approvals, artifacts, evaluator results, and
  failures.
- Editing an SOP does not rewrite history for earlier runs.
- Existing automation durability remains intact.

### 3. Govern Memory And Improvement Proposals

Issue: [#247](https://github.com/joe-broadhead/open-cowork/issues/247)

Goal: add self-improvement safely after traces and evals provide evidence. The
product should learn from work only after it can observe, evaluate, and explain
that work.

Scope:

- typed `AgentMemoryEntry`
- memory scopes: machine, project, agent, crew
- memory statuses: proposed, approved, rejected, archived
- provenance links to runs, artifacts, evals, traces, and threads
- Improvement Inbox with memory as one proposal type
- post-run improvement proposals
- manual and scheduled dream/consolidation runs
- candidate memory and improvement diffs
- privacy classification metadata
- disable learning globally, per agent, per project, and per crew

Improvement proposals may target memory entries, agent profiles, skills, SOPs,
crews, capability routing, eval cases, and policy rules. Memory proposals are
one type of governed improvement proposal, not the center of the product.

Dream/consolidation runs remain app-owned and review-first:

- input memory remains immutable
- output is a separate candidate improvement set
- output never mutates live memory, skills, SOPs, crews, evals, routing, or
  policy directly
- output includes provenance: source sessions, trace events, model,
  instructions, timestamps, token/cost usage, and accepting user/action
- failed or canceled dreams leave partial output inspectable or cleanly
  discardable

Acceptance bar:

- No run silently changes live memory.
- Every accepted lesson has source evidence and approving user.
- Dream output is a candidate improvement set, never a mutation.
- Memory injection is bounded, deterministic, and visible in diagnostics.
- Approved improvement proposals update live objects only through existing
  persistence paths and review gates.
- Users can disable improvement proposals globally, per agent, per project, and
  per crew.

### 4. Add Autonomy, Queues, And Workspace Profiles

Issue: [#248](https://github.com/joe-broadhead/open-cowork/issues/248)

Goal: make many simultaneous agents and crews operationally sane. Autonomy
should be explicit, queueing should prevent unsafe concurrency, and every run
should show its authority.

Scope:

- autonomy ladder: observe, draft, approve, supervised, bounded-auto
- per-tool and per-capability risk metadata
- per-agent, per-crew, per-project, and per-channel queues
- read-only parallel fanout
- serialized write-side effects for the same workspace or external target
- workspace profiles: personal sandbox, project workspace, automation
  workspace, channel sandbox, high-risk isolated workspace
- run, cost, retry, duration, and parallelism caps per queue
- stuck-run and budget alerts

Autonomy semantics:

- `observe`: summarize and file inbox items only
- `draft`: prepare artifacts or replies, never execute side effects
- `approve`: plan and request approval before execution
- `supervised`: continue through low-risk allowlisted steps, ask for medium or
  high risk
- `bounded-auto`: run within budgets, allowlists, workspace scope, and rollback
  rules

Higher autonomy must never exceed global OpenCode permissions, project grants,
or capability policy.

Acceptance bar:

- Two write-capable agents cannot mutate the same target concurrently unless
  the user explicitly allows it.
- Read-only research can fan out in parallel.
- Every run shows filesystem and external-system authority.
- Higher autonomy never exceeds global OpenCode permission policy or project
  grants.
- Queue state survives app restart.
- Workspace cleanup and retention are visible in Settings.

### 5. Add Channels And Delivery

Issue: [#249](https://github.com/joe-broadhead/open-cowork/issues/249)

Goal: add the OpenClaw/ZeroClaw always-on feel only after trace, eval, policy,
queue, and workspace foundations are strong enough.

Channels are an attack surface. Inbound Slack, email, or webhook input should
not trigger write-capable execution until Crews, policy, traceability,
approvals, queueing, and workspace isolation are solid.

Scope:

- local webhook receiver
- sender/source allowlists and pairing flow
- route inbound item to inbox, draft, SOP, or Crew
- external delivery as draft-first
- Slack/email/Teams drafts before direct sends
- delivery audit records
- channel-specific capability scopes
- channel sandbox workspace profile

Channel activation modes should include ignore, draft reply, ask user, run SOP,
and run Crew. Unknown senders never trigger execution.

Acceptance bar:

- Every inbound item records source, sender, route, allowed capabilities, and
  audit state.
- External sends default to drafts or explicit approval.
- Channel-triggered work uses a channel sandbox by default.
- Delivery records link to work items, runs, artifacts, policy decisions, and
  approvals.

### 6. Build The Organization Control Plane

Issue: [#250](https://github.com/joe-broadhead/open-cowork/issues/250)

Goal: evolve from a powerful local agent operations product into a durable
system for teams, departments, and eventually regulated workflows.

Scope:

- organizations / tenants
- users, groups, roles, owners, and approvers
- agent and crew lifecycle states: draft, review, approved, active, paused,
  retired
- agent and crew registry
- agent map: dependencies on tools, memories, credentials, channels, SOPs, and
  eval suites
- policy engine and RBAC
- credential bindings and secrets-vault integration points
- audit export and OpenTelemetry export
- admin dashboard and incident controls: pause crew, revoke tool, quarantine
  memory, export audit
- durable server workers or managed nodes for background execution independent
  of one laptop

Acceptance bar:

- Every agent and crew has an owner, scope, tools, memory boundary, eval suite,
  and offboarding path.
- Admins can see which agents depend on which tools, memories, credentials,
  and channels.
- Risky actions produce policy decisions and approval records.
- The organization can pause or retire an agent as easily as it disables a user
  account.
- Audit export and OpenTelemetry export cover traces, approvals, policy
  decisions, tool calls, deliveries, evals, and incidents.

## Minimum Lovable Crew Demo

The public demo milestone is:

> Create a research crew. The lead decomposes the job, specialists run in child
> sessions, artifacts are produced, an evaluator grades the result, and the
> user sees swimlanes, tool calls, approvals, costs, trace events, and final
> score.

This proves agent teams, OpenCode-native execution, traces, artifacts, evals,
supervision, no second runtime, and no enterprise overreach.

## HR And Regulated Workflow Bar

HR is an example vertical, not the core product. Do not position Open Cowork as
regulated HR automation until:

- agents and crews have owners, identities, scopes, memory stores, tools, eval
  suites, and lifecycle states
- work enters through cases, queues, channels, or SOP triggers
- every work item has SLA, priority, requester, confidentiality level, and
  escalation path
- sensitive actions require named human approval
- PII and protected-class data are detected, redacted, scoped, and
  retention-managed
- tool calls and external writes are policy-checked
- every run has audit-grade traces
- evals run before activation and after major prompt/model/memory/skill or
  connector changes
- managers can supervise by exception
- a durable service plane exists for scheduled/background work independent of
  one laptop

## Deployment Stages

### Desktop Preview

Single-user, local-first execution. Focus on substrate stability, Crews MVP,
trace/eval foundations, and strong docs. No always-on external channels.

### Local Operations Desk

Single-user or small-team workflows where runs, queues, SOPs, evals, and
improvement proposals are durable and reviewable. Channels may draft work but
write-side effects stay approval-first.

### Managed Team Control Plane

Organization-owned agents, crews, policies, audit export, and durable workers.
This is the stage where enterprise governance and regulated workflow claims can
start to become credible.

## Success Metrics

Track operating quality, not feature count:

- **Local reliability:** run completion rate, stuck-run rate, restart recovery
  rate, approval reload parity, trace reconstruction success rate.
- **Agent productivity:** tasks completed per user, runs per active agent,
  crew runs per week, median time to useful artifact, human interventions per
  completed run.
- **Quality:** eval pass rate, revision rate, human override rate, rework rate,
  incorrect-action reports.
- **Safety:** denied policy decisions, approval-required actions, external
  side-effect attempts, improvement proposals rejected, unsafe channel inputs
  blocked.
- **Cost:** cost per run, cost per successful outcome, tokens by
  agent/crew/SOP, repeated failed-run cost.
- **UX:** time to create first agent, time to create first crew, time to
  understand what agents are doing, time from blocked approval to resolution.

## Reuse Strategy

Reuse OpenCode-native concepts before adding Cowork product state:

- agent config and permission model: `config.agent`, `permission.task`,
  `ask/allow/deny`
- native session tree: root sessions, child sessions, `session.children`
- native lifecycle: session creation, prompting, messages, status, todo, and
  summarize APIs through the current SDK/runtime wrapper
- native compaction and compaction hooks
- native event vocabulary: session, todo, permission, tool, compaction events

Use the OpenCode repository as an implementation reference for:

- server projector patterns
- desktop/client-server app structure
- event projection patterns
- theme primitives
- virtualization/performance patterns
- desktop shell behavior

Do not import OpenCode UI packages directly into Open Cowork by default.
OpenCode's UI stack and Open Cowork's React/Electron stack have different
constraints. Treat OpenCode UI code as a reference implementation first, not a
drop-in dependency.

## Test And Validation Plan

### Milestone 0

- Stress harness for 20 active threads, 10 concurrent branches in one root
  thread, and repeated fast thread switching.
- Assertions for ordered child transcript/tool rendering, no phantom
  completion, no missing root messages, no parent hang after child completion,
  and stable busy indicators.
- Performance target: thread switch feels immediate; event updates are
  frame-batched; background threads do not force full detail hydration.

### Milestone 1

- Crew run graph tests: branch, join, failure, retry, approval gate, evaluator
  pass, artifact preservation.
- Trace contract tests: every meaningful crew event emits a canonical trace
  record with crew/run/session/agent identity.
- Trace export tests: JSONL/NDJSON export is deterministic, redacted where
  required, and replayable enough for eval input.
- Trace replay tests: restart and replay reconstruct the same run timeline
  without duplicate events, missing parent/child relationships, or transcript
  hydration.
- Outcome rubric tests: evaluator runs in a separate context and produces
  structured scores, failures, evidence links, and recommended action.
- Eval certification tests: suites and cases can block activation for
  sensitive crews until required evals pass.

### Milestone 2

- SOP versioning tests: edits never rewrite previous run history.
- Automation migration tests: existing schedules, inbox items, runs, work
  items, deliveries, retry, heartbeat, and max-duration semantics survive SOP
  unification.
- Trigger tests for manual, scheduled, inbox, and future webhook entry points.
- Approval gate and failure-path tests over a reusable SOP run.

### Milestone 3

- Memory proposal tests: no accepted memory without provenance and approval.
- Dream run tests: input memory remains immutable; output is a candidate
  improvement set; failed/canceled dreams are inspectable or discardable.
- Privacy classification tests for memory redaction, retention, and restricted
  injection.
- Improvement Inbox tests for diff review, edit, approve, reject, and archive
  flows.

### Milestone 4

- Queue tests for per-agent, per-crew, per-project, and per-channel serialized
  write access.
- Parallel read-only fanout tests.
- Autonomy ladder tests: higher autonomy never exceeds global OpenCode
  permissions, project grants, or capability risk policy.
- Workspace profile tests: every run exposes its filesystem and
  external-system authority.

### Milestone 5

- Channel allowlist and pairing tests.
- Unknown-sender denial tests.
- Draft-first external delivery tests.
- Channel sandbox tests for inbound work.
- Delivery failure tests: failed delivery does not lose or falsely complete the
  run.

### Milestone 6

- RBAC and owner/approver policy tests.
- Audit export and OpenTelemetry export tests.
- Incident control tests: pause crew, revoke tool, quarantine memory.
- Durable worker tests: background resumability, queue recovery, scheduling,
  trigger execution, and cost governance.

## OpenCode Dependency Risks

The roadmap depends on OpenCode continuing to provide stable execution
semantics for sessions, child sessions, tool calls, approvals, questions,
events, compaction, and native skills.

Risk areas to monitor:

- event shape drift during SDK upgrades
- child-session lineage or status semantics changing
- permission model changes that affect `permission.task` or tool policy
- compaction and summarization API changes
- MCP execution behavior changes
- model/provider option compatibility changes

Mitigation:

- keep SDK versions pinned and documented
- typecheck SDK-facing config against exported SDK types
- maintain projection/replay tests around OpenCode event variants
- keep product traces separate from OpenCode transcripts
- prefer thin runtime wrappers over copied OpenCode logic

## Related Docs

- [Architecture](architecture.md) defines ownership boundaries.
- [Threads](threads.md) explains current session and thread UX.
- [Automations](automations.md) documents the current durable control plane
  that SOPs will extend.
- [Security Model](security-model.md) documents current trust boundaries and
  why channels wait for policy, traces, queues, and workspace isolation.
- [Desktop App Guide](desktop-app.md) is the current user-facing feature
  reference.
- [Claw-Like Agent Operations Strategy](claw-like-agents.md) explains the
  research/product rationale behind this sequence. If it conflicts with this
  roadmap, this roadmap wins.

## Non-Goals

- Do not build a second runtime beside OpenCode.
- Do not mirror product execution state into fake OpenCode todos.
- Do not push large branch context back into root sessions.
- Do not build custom compaction logic when OpenCode-native summarization and
  compaction hooks exist.
- Do not treat memory, channels, or enterprise connectors as safe before
  traceability, evals, policy, and approval semantics exist.
- Do not market regulated HR/workforce automation until case management, PII
  controls, audit export, eval certification, and governed connectors are real.
