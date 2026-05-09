# Claw-Like Agent Operations Strategy

Last updated: 2026-05-10.

This page explains the product rationale behind the
[Roadmap](roadmap.md). It is a strategy document, not an implementation spec.
If this page conflicts with the roadmap, the roadmap wins.

Open Cowork should borrow the useful operating patterns from OpenClaw,
ZeroClaw, Anthropic-style agent operations research, and enterprise agent
control-plane work without copying runtime semantics or building a second
execution engine.

The boundary remains:

- **OpenCode executes.**
- **Open Cowork composes, observes, evaluates, and governs.**

## Operating Loop

The product loop is:

```text
work item -> route -> plan -> policy -> execute -> trace -> evaluate -> deliver -> improve
```

Each step answers a product question:

- **Work item:** what entered the system, from where, and with what requested
  outcome?
- **Route:** which crew, SOP, agent, or inbox owns it?
- **Plan:** what work graph will be attempted?
- **Policy:** what authority is allowed, denied, or approval-gated?
- **Execute:** what OpenCode sessions and child sessions performed the work?
- **Trace:** what accountability record proves what happened?
- **Evaluate:** did the output meet the rubric?
- **Deliver:** what artifact, draft, notification, or external output was
  produced?
- **Improve:** what reviewable proposal should make the next run better?

## Patterns To Borrow

### OpenClaw / ZeroClaw Style Operations

Useful patterns:

- always-visible intake and run state
- specialist workers coordinated by a lead
- explicit operational lanes for active, blocked, reviewing, failed, and
  delivered work
- bounded autonomy instead of invisible background action
- delivery records separate from execution transcripts

What not to copy:

- a second session runtime
- hidden delegation semantics that bypass OpenCode
- channel-triggered write execution before policy, queues, and workspace
  isolation exist

### Anthropic-Style Dreaming And Outcomes

Useful patterns:

- post-run reflection as a separate process
- outcome scoring and evidence gathering
- memory consolidation from observed work
- candidates reviewed before live mutation

Open Cowork adaptation:

- dream/consolidation runs produce candidate improvement sets
- live memory, skills, SOPs, crews, evals, routing, and policy are never
  changed silently
- every accepted lesson has provenance and an approving user/action

### Enterprise Agent Research Patterns

Useful patterns:

- agents and crews have owners, lifecycle states, scopes, tools, memory
  boundaries, eval suites, and offboarding paths
- risky actions produce policy decisions and approval records
- audit export is structured, redacted, and replayable enough for review
- operators supervise by exception instead of reading every transcript

Open Cowork adaptation:

- start local and desktop-first
- add organization controls only after local Crews, traces, evals, SOPs,
  improvement proposals, queues, workspaces, and channels are proven

## Current Substrate

Open Cowork already has useful foundations:

- sandboxed Electron renderer and strict preload IPC
- OpenCode-managed session execution
- OpenCode child-session projection into task cards
- custom agents, skills, MCPs, and capability surfaces
- durable automation scheduling, inbox, runs, work items, retry, heartbeat,
  and delivery records
- chart and skill MCP packaging
- trace-like event projection in the session engine
- cost/token and status projection in the UI

The roadmap turns these pieces into an accountable operations model rather
than replacing them.

## Capability Catalog By Build Dependency

### Foundation

- reliable multi-thread streaming
- child-session lineage and reload parity
- frame-batched session-scoped updates
- no fuzzy session-id matching
- restart-safe task cards, tool calls, approvals, questions, and timing

### Crew Operations

- `CrewDefinition`, `CrewVersion`, `CrewMember`
- `CrewRun` and `CrewRunNode`
- lead/specialist/evaluator roles
- branch/join workflow
- Crew Run Detail
- crew artifacts and approvals

### Accountability

- `CoworkTraceEvent`
- `PolicyDecision`
- trace export
- redaction state
- input/output hashes
- causation/correlation ids
- cost/token attribution

### Quality

- `OutcomeRubric`
- `OutcomeEvaluation`
- `EvalSuite`
- `EvalCase`
- bounded revision on failed eval
- eval certification gates for sensitive crews

### Process Reuse

- `SopDefinition`
- versioned SOPs
- manual/scheduled/inbox/future webhook triggers
- reusable approval, retry, delivery, and failure policy
- save successful run as SOP

### Governed Learning

- `AgentMemoryEntry`
- `ImprovementProposal`
- Improvement Inbox
- dream/consolidation runs
- proposal diffs for memory, agents, skills, SOPs, crews, eval cases,
  routing, and policy

### Autonomy And Safety

- autonomy ladder: observe, draft, approve, supervised, bounded-auto
- per-tool and per-capability risk metadata
- per-agent, per-crew, per-project, and per-channel queues
- serialized write-side effects
- workspace profiles and retention policy

### Channels And Delivery

- sender/source allowlists
- local webhook receiver
- channel sandbox
- draft-first external sends
- desktop notifications, email drafts, Slack/Teams drafts, webhook callbacks,
  and report artifacts
- delivery audit records

### Organization Controls

- tenants, users, groups, roles, owners, approvers
- agent and crew lifecycle states
- registry and dependency map
- policy engine and RBAC
- audit export and OpenTelemetry export
- incident controls
- durable workers or managed nodes

## UX Direction

Open Cowork should feel like mission control for agent work.

Crew Run Detail should be an operational timeline, not a transcript clone. It
should show:

- run status and blockers
- lead and specialist swimlanes
- active, blocked, completed, failed, and evaluating states
- tool calls and approvals
- artifacts and delivery records
- policy decisions and authority
- evaluator scores and evidence
- token and cost usage
- trace timeline

Transcripts should remain available on demand, but operators should not need to
hydrate every OpenCode message to understand whether work is safe, stuck, or
good enough.

Pulse should become the top-level operations dashboard:

- active crews and SOP runs
- blocked approvals and questions
- stuck or over-budget work
- failing evals
- unsafe channel inputs blocked
- improvement proposals waiting for review

## HR And Regulated Workflows

HR is a useful example vertical because it stresses governance, privacy, and
human approval. It is not the core product.

Open Cowork should not claim regulated HR readiness until the regulated
workflow bar in the [Roadmap](roadmap.md#hr-and-regulated-workflow-bar) is met:
owners, identities, scopes, eval suites, case intake, SLA, priority,
confidentiality, PII handling, named approvals, policy checks, audit-grade
traces, and durable service-plane execution.

## Non-Goals

- Do not build a second runtime beside OpenCode.
- Do not copy OpenClaw or ZeroClaw runtime semantics.
- Do not treat transcripts as the product trace ledger.
- Do not let memory mutate live behavior without review.
- Do not let external channels trigger write-capable execution before policy,
  queues, traces, approvals, and workspace isolation exist.
- Do not position Open Cowork as enterprise-ready or HR-ready before the
  control-plane prerequisites are real.

## Relationship To Implementation

Implementation order lives in [Roadmap](roadmap.md). This page explains why the
sequence exists.

When implementing a feature from this strategy:

1. Start at the owning layer in [Architecture](architecture.md).
2. Prefer OpenCode-native execution surfaces.
3. Persist only Open Cowork product accountability state.
4. Add schema versions and migration paths before durable storage.
5. Add tests that prove replay, restart, redaction, policy, and eval behavior
   for the specific product object being introduced.
