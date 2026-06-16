---
title: Claw-Like Agent Operations
description: Product plan for supervised agent-team operations in Open Cowork without replacing OpenCode.
---

# Claw-Like Agent Operations

This note translates OpenClaw and ZeroClaw patterns into concrete Open Cowork features.

The product target is:

> A beautiful desktop-first operations desk for supervised agent teams: agents and crews can run many tasks through OpenCode, use carefully-scoped capabilities, produce inspectable traces and evaluated outcomes, and improve through reviewed memory and SOP updates.

The architectural constraint is unchanged: **OpenCode executes; Open Cowork composes**. Open Cowork should become claw-like as a product and operations layer, not by building a second agent runtime.


## Operating Loop

The core product loop is delegated work with accountability:

1. A work item arrives from a user, schedule, inbox, channel, webhook, or future file trigger.
2. Open Cowork routes it to an agent, crew, SOP, or inbox.
3. A lead agent plans the work through OpenCode-native execution.
4. Policy decides whether each requested action is allowed, denied, or requires approval.
5. Agents execute through OpenCode sessions, tools, MCPs, and skills.
6. Open Cowork records trace events and artifact lineage.
7. A separate evaluator grades the output against a rubric when the workflow requires one.
8. The result is delivered as a draft, approval request, artifact, or completed action.
9. The improvement loop proposes memory, SOP, skill, eval-case, routing, or policy updates from the trace and outcome evidence.

Open Cowork should learn from work only after it can observe, evaluate, and explain that work.


## Research Review

The useful patterns are well supported by primary sources:

- OpenClaw presents itself as a local, always-on personal assistant with a gateway control plane and many messaging channels. Its README describes local device operation, gateway daemon setup, pairing for inbound DMs, a multi-channel inbox, multi-agent routing, first-class tools, and workspace skill loading.
- OpenClaw's agent docs confirm a workspace-root model with injected bootstrap files such as `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, and `USER.md`. They also document queued inbound steering behavior while a run is streaming.
- ZeroClaw's README and docs describe a Rust single-binary runtime with channels, providers, tools, memory, gateway/dashboard, SOPs, service install/start commands, autonomy levels, approval gates, command policy, and workspace boundaries.

Some pasted claims should be treated as directional, not as requirements:

- Exact benchmark, star-count, and resource numbers vary across mirrors and marketing pages. They support the principle "keep idle overhead low", but should not drive Open Cowork architecture by themselves.
- I did not find primary-source confirmation for every AIEOS/migration detail in the pasted research during this pass. Portable identity is still a useful concept, but Open Cowork should start with its own typed `cowork-agent-v2` bundle before adopting an external identity spec.
- "Self-learning" in these systems is not live fine-tuning. The practical pattern is reviewed evolution of memory, identity, SOPs, skills, routing, and capability settings.

Sources:

- [OpenClaw README](https://github.com/openclaw/openclaw)
- [OpenClaw Agent Runtime docs](https://openclawlab.com/en/docs/concepts/agent/)
- [ZeroClaw README](https://github.com/zeroclaw-labs/zeroclaw)
- [ZeroClaw docs](https://docs.zeroclawlabs.ai/en/)
- [Claude Managed Agents dreaming announcement](https://claude.com/blog/new-in-claude-managed-agents)
- [Claude Managed Agents Dreams API docs](https://platform.claude.com/docs/en/managed-agents/dreams)
- [Claude Managed Agents Memory Stores docs](https://platform.claude.com/docs/en/managed-agents/memory)
- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Managed Agents multiagent sessions](https://platform.claude.com/docs/en/managed-agents/multi-agent)
- [Anthropic Trustworthy agents in practice](https://www.anthropic.com/research/trustworthy-agents)
- [OpenAI Codex](https://openai.com/codex/)
- [OpenAI Codex cloud docs](https://platform.openai.com/docs/codex)
- [OpenAI AgentKit docs](https://platform.openai.com/docs/guides/agents)
- [OpenAI Agent Builder docs](https://platform.openai.com/docs/guides/agent-builder)
- [OpenAI safety in building agents](https://platform.openai.com/docs/guides/agent-builder-safety)
- [OpenAI Agent evals](https://platform.openai.com/docs/guides/agent-evals)
- [ServiceNow Action Fabric](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-opens-its-full-system-of-action-to-every-AI-Agent-in-the-enterprise/default.aspx)
- [ServiceNow Autonomous Workforce](https://newsroom.servicenow.com/press-releases/details/2026/ServiceNow-brings-Autonomous-Workforce-to-every-major-business-function/default.aspx)
- [Microsoft Agent 365](https://www.microsoft.com/microsoft-agent-365)
- [Microsoft Employee Self-Service Agent](https://learn.microsoft.com/en-us/microsoft-365/copilot/employee-self-service/overview)
- [Workday Illuminate Agents](https://newsroom.workday.com/2025-05-19-Workday-Unveils-Next-Generation-of-Illuminate-Agents-to-Transform-HR-and-Finance-Operations)
- [Gemini Enterprise Agent Designer](https://cloud.google.com/gemini/enterprise/docs/agent-designer)
- [Gemini Enterprise agents overview](https://cloud.google.com/gemini/enterprise/docs/agents-overview)
- [Klarna AI assistant case study](https://openai.com/index/klarna/)
- [Clay AI sales agent case study](https://openai.com/index/clay/)


## Anthropic Dreaming Update

Anthropic announced "dreaming" for Claude Managed Agents on May 6, 2026. The useful product pattern is more precise than "the agent thinks overnight":

- Dreaming is a research-preview feature for Managed Agents.
- It is a scheduled or requested memory-curation process that reviews previous agent sessions and memory stores.
- It extracts patterns, recurring mistakes, convergent workflows, and shared preferences across agents.
- It reorganizes memory so it stays high-signal as it grows.
- The API treats a dream as an asynchronous job with `pending`, `running`, `completed`, `failed`, and `canceled` states.
- A dream takes a pre-existing memory store plus optionally up to 100 past sessions.
- The dream writes a separate output memory store. It does not mutate the input store, so users can review, attach, discard, archive, or delete the result.
- The underlying dream session is observable while it runs, and the transcript remains available afterward.
- Billing is token-based and scales with the amount of session history reviewed.

Anthropic also paired dreaming with two related Managed Agents ideas:

- **Outcomes:** a separate grader evaluates work against a rubric in its own context window, then the agent can revise.
- **Multiagent orchestration:** a lead agent delegates to specialist agents, with persistent events and console traceability.

For Open Cowork, the key lesson is that self-learning should produce an inspectable candidate memory state, not silently rewrite the agent's identity or rules. Dreaming is best understood as a governed compaction/reconciliation pass over memory, outcomes, and run history.


## Enterprise Agent Research Update

The broader market points in one direction: organizations are moving from "employees use AI assistants" to "employees supervise governed agents attached to business systems."

Useful patterns:

- **Claude Managed Agents:** packaged agent harness for long-running, asynchronous work. Core concepts are agent, environment, session, and events. Multiagent sessions use a coordinator plus specialist agents, isolated session threads, persistent events, and cross-posted permission requests.
- **Codex:** command center for coding agents across app, IDE, terminal, cloud, Slack, and GitHub. Key product patterns are parallel cloud sandboxes, worktrees, background tasks, skills, automations, PR review, environment controls, admin monitoring, and analytics.
- **OpenAI AgentKit:** visual workflow builder, connector registry, ChatKit, guardrails, trace grading, evals, datasets, and prompt optimization. The important organizational pattern is that agent workflows must be designed, versioned, evaluated, deployed, and monitored like software.
- **ServiceNow:** an "action fabric" where agents act through governed workflows, approvals, catalogs, audit trails, metering, OAuth, session management, and role-based tool packages. This is the strongest signal that enterprise agents need a system-of-action layer, not only data access.
- **Microsoft Agent 365:** agent registry, agent map, analytics, onboarding, integration management, least-privilege access, lifecycle rules, audit trails, and role-specific oversight. This is effectively an identity/governance plane for agents.
- **Microsoft Employee Self-Service Agent:** HR and IT starter agents with system connectors, audit logs, least-privilege access, deployment pipelines, environment isolation, and escalation for sensitive HR/legal/personnel decisions.
- **Workday Illuminate Agents:** HR and finance agents such as recruiting, payroll, talent mobility, frontline, self-service, and process optimization, managed through an agent system of record.
- **Gemini Enterprise:** no-code/low-code agent creation, centralized oversight, agent registration, HR use cases, connectors, security/governance, and an agent designer with subagents.
- **Klarna and Clay:** proof that agents can absorb large volumes of repeatable service/research work, but only where the workflow, data sources, quality expectations, and fallback paths are clear.

The consistent gap between a powerful local agent app and an organizational agent platform is governance. A company does not just need agents. It needs to know who owns each agent, what it can access, what it changed, whether it is performing well, and when a human must take over.


## Current Open Cowork Substrate

Open Cowork already has the right foundation:

- Durable automations with schedules, inbox, work items, runs, deliveries, retry policy, heartbeat, execution briefs, and review-first defaults. See `docs/automations.md`, `packages/shared/src/automation.ts`, and `apps/desktop/src/main/automation-*`.
- Native OpenCode runtime composition through `@opencode-ai/sdk/v2`. See `apps/desktop/src/main/runtime-config-builder.ts` and `apps/desktop/src/main/agent-config.ts`.
- Custom agents that compile into OpenCode-native agent config rather than a parallel execution mechanism. See `apps/desktop/src/main/custom-agents.ts` and `apps/desktop/src/renderer/components/agents/`.
- Capability curation for tools, MCPs, and skills. See `apps/desktop/src/main/capability-catalog.ts`, `apps/desktop/src/main/effective-skills.ts`, and `apps/desktop/src/renderer/components/capabilities/`.
- A security posture for local credentials, MCP URL/stdio policy, custom MCP approvals, project directory grants, and a managed OpenCode runtime home. See `docs/security-model.md`.
- Threads and Pulse as rebuildable, local operational views over session history, usage, agents, tools, and runtime health. See `docs/threads.md` and `docs/desktop-app.md`.

The gap is not a missing runtime. The gap is a set of first-class product surfaces for crews, work items, traces, evals, SOPs, policy decisions, memory, channels, autonomy, and fleet operations.


## Capability Catalog

This catalog is ordered by build dependency. The canonical roadmap sequence is in [Roadmap](roadmap.md).


### 1. Cowork Crews

A Crew is a versioned team of agents, capabilities, workflow rules, evals, budgets, and supervision policies.

Core model:

- mission
- owner
- lead agent
- specialist agents
- evaluator / critic agent
- default SOP or workflow
- capability grants
- workspace profile
- memory scope
- autonomy policy
- outcome rubric
- budget and run caps
- lifecycle state: draft, active, paused, retired

Implementation shape:

- Add `CrewDefinition`, `CrewVersion`, `CrewMember`, `CrewRun`, and `CrewRunNode` shared types.
- Compile crew members into OpenCode-native agent/session configuration.
- Let the lead agent plan and delegate to specialists through OpenCode-native sessions.
- Represent each run as a graph of nodes: plan, delegate, tool task, join, evaluate, revise, approve, deliver.
- Store run events in a durable trace/event store.
- Add Crew Builder and Crew Run Detail surfaces.

Acceptance criteria:

- A user can create a crew with a lead, specialists, and evaluator.
- A crew can execute a simple branch/join workflow.
- Each specialist works in a bounded session/workspace.
- The run shows who did what, which artifacts were produced, what tools were used, what approvals were requested, and whether the evaluator passed the result.
- Crew edits create new versions and do not rewrite run history.


### 2. Work Items And Cases

Add a lightweight work-item primitive before full enterprise case management. Work items are the common object that can come from manual requests, automations, channels, webhooks, file triggers, or future case-system integrations.

Minimum model:

```ts
type CoworkWorkItem = {
 schemaVersion: number
 id: string
 source: 'manual' | 'schedule' | 'inbox' | 'webhook' | 'channel' | 'file'
 sourceExternalId?: string
 sourceMetadataRef?: string
 title: string
 description?: string
 createdByUserId?: string
 ownerUserId?: string
 requesterId?: string
 projectId?: string
 assigneeKind?: 'user' | 'agent' | 'crew' | 'sop'
 assigneeId?: string
 assignedAgentId?: string
 assignedCrewId?: string
 assignedSopId?: string
 priority: 'low' | 'normal' | 'high' | 'urgent'
 confidentiality: 'normal' | 'sensitive' | 'restricted'
 status: 'new' | 'triaged' | 'queued' | 'running' | 'blocked' | 'resolved' | 'canceled'
 slaStartedAt?: string
 slaDueAt?: string
 dueAt?: string
 blockedReason?: string
 resolutionCode?: string
 linkedRunIds: string[]
 linkedArtifactIds: string[]
 createdAt: string
 updatedAt: string
}
```

 Acceptance criteria:

 - Manual prompts, automation schedules, and future channel messages can all become work items.
- A work item can be routed to an agent, crew, SOP, or inbox.
- Work items separate human ownership from current assignee, so a person can remain accountable while an agent or crew prepares the work.
- Work items track status, priority, SLA dates, blocked reason, resolution code, linked runs, linked artifacts, and confidentiality.
- The product can later evolve work items into HR-style cases without rewriting runs or sessions.


### 3. Trace Events And Artifact Graph

 Full observability needs a canonical event stream. OpenCode session history remains the execution transcript source of truth. Cowork trace events are the product accountability layer over runs, approvals, policy decisions, artifacts, evals, deliveries, and improvement proposals. Pulse and Operations Dashboard should project primarily from Cowork traces, with lazy links into OpenCode transcripts.

 Core event types:

 - run created
- plan proposed
- task delegated
- specialist session started
- tool requested / completed
- approval requested / granted / denied
- artifact created
- evaluator started / completed
- improvement proposal created
- policy decision made
- delivery attempted / completed
- run completed / failed / canceled

 Minimum model:

 ```ts
type CoworkTraceEvent = {
  schemaVersion: number
  id: string
  sequence: number
  runId: string
  runKind: 'chat' | 'automation' | 'sop' | 'crew' | 'dream'
  parentRunId?: string
  source: 'opencode_event' | 'cowork_policy' | 'cowork_eval' | 'cowork_ui' | 'cowork_worker'
  sourceEventId?: string
  correlationId?: string
  causationId?: string
  projectId?: string
  agentId?: string
  crewId?: string
  crewVersionId?: string
  sopId?: string
  sopVersionId?: string
  sessionId?: string
  parentSessionId?: string
  eventKind:
    | 'run.created'
    | 'plan.proposed'
    | 'task.delegated'
    | 'tool.requested'
    | 'tool.completed'
    | 'approval.requested'
    | 'approval.granted'
    | 'approval.denied'
    | 'artifact.created'
    | 'eval.started'
    | 'eval.completed'
    | 'improvement.proposed'
    | 'policy.allowed'
    | 'policy.denied'
    | 'delivery.attempted'
    | 'delivery.completed'
    | 'run.completed'
    | 'run.failed'
    | 'run.canceled'
  actorKind: 'user' | 'agent' | 'system' | 'tool' | 'evaluator'
  actorId?: string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  artifactIds?: string[]
  approvalId?: string
  policyDecisionId?: string
  inputHash?: string
  outputHash?: string
  payloadRef?: string
  payloadHash?: string
  redactionState: 'none' | 'partial' | 'full'
  tokenUsage?: { input: number; output: number }
  costUsd?: number
  startedAt?: string
  completedAt?: string
  createdAt: string
}
```

Acceptance criteria:

- The app can reconstruct a run timeline from trace events.
- Trace events survive restart.
- Trace replay can reconstruct the same run timeline after restart without duplicate events, missing parent/child relationships, or transcript hydration.
- Run details do not require hydrating full transcripts.
- Evals can grade a trace.
- Users can export trace JSON for debugging or audit.
- Sensitive content can be redacted while preserving event structure.


### 4. Outcomes And Evals

Evals are not a lab feature. They are part of the operating loop for crews and SOPs. No repeatable workflow should become trusted until it has a success rubric.

Minimum models:

```ts
type OutcomeRubric = {
 schemaVersion: number
 id: string
 name: string
 appliesTo: 'automation' | 'sop' | 'crew'
 dimensions: Array<{
   key: string
   label: string
   description: string
   scale: 'pass-fail' | '1-5'
   required: boolean
 }>
 maxRevisionAttempts: number
}

type OutcomeEvaluation = {
 schemaVersion: number
 id: string
 runId: string
 rubricId: string
 evaluatorAgentId?: string
 scores: Array<{
   dimensionKey: string
   score: boolean | number
   evidenceSummary?: string
   evidenceRefs: Array<{
     kind: 'trace_event' | 'artifact' | 'message' | 'tool_call' | 'policy_decision'
     id: string
     quote?: string
     quoteHash?: string
   }>
 }>
 verdict: 'pass' | 'revise' | 'escalate' | 'fail'
 revisionAttempt: number
 createdAt: string
}

type EvalSuite = {
 schemaVersion: number
 id: string
 name: string
 appliesTo: 'agent' | 'crew' | 'sop'
 targetId: string
 rubricIds: string[]
 caseIds: string[]
 requiredForActivation: boolean
 createdAt: string
 updatedAt: string
}

type EvalCase = {
 schemaVersion: number
 id: string
 name: string
 inputWorkItem: Partial<CoworkWorkItem>
 expectedBehavior: string
 forbiddenBehavior?: string[]
 tags: string[]
 createdAt: string
}
```

 Acceptance criteria:

 - Every Crew can optionally require a rubric before activation.
- Evaluator runs are isolated from the producing agent's hidden reasoning.
- Failed evals can trigger bounded revision.
- Eval results are visible in Pulse / Operations Dashboard.
- Eval failures can generate test cases for future regression suites.
- Eval suites and eval cases make certification concrete before sensitive crews are activated.


### 5. SOPs As Durable Workflow Products

 Promote automations from "scheduled prompts" to versioned SOPs:

 - trigger: schedule, manual, webhook, inbox event, or future file/watch trigger
- eligibility and required inputs
- agent/crew assignment
- work graph
- success criteria and rubric
- approval boundaries
- delivery target
- rollback/failure policy

 Implementation shape:

 - Extend `ExecutionBrief` in `packages/shared/src/automation.ts` toward a reusable `SopDefinition`.
- Add SOP templates beside `AUTOMATION_TEMPLATES` in `apps/desktop/src/renderer/components/automations/automation-view-model.ts`.
- Version SOPs and attach run records to the SOP version that produced them.
- Keep each execution as OpenCode-native `plan`, `build`, and specialist sessions.

 Acceptance criteria:

 - A user can save a successful automation brief as a reusable SOP.
- SOP runs show version, inputs, approvals, artifacts, evals, outputs, and failure state.
- Editing an SOP does not rewrite history for earlier runs.


### 6. Agent Identity Profiles

 Add a richer profile model behind custom agents, tied to ownership and operational scope rather than persona alone:

 - mission and responsibilities
- owner and lifecycle state
- role in crews
- communication preferences
- operating boundaries and refusal rules
- default capability grants and autonomy ceiling
- memory scope
- eval expectations
- optional project-scoped profile overrides

 Implementation shape:

 - Extend `CustomAgentConfig` and `AgentBundle` in `packages/shared/src/custom-content.ts`.
- Render a new Identity tab in `apps/desktop/src/renderer/components/agents/AgentBuilderPage.tsx`.
- Compile the profile into OpenCode agent prompts in `apps/desktop/src/main/agent-prompts.ts`.
- Keep export/import as Open Cowork-owned `cowork-agent-v2` JSON. Do not adopt an external identity format until there is a real interoperability need.

 Acceptance criteria:

 - A user can create an agent with a stable identity without editing markdown.
- Export/import preserves identity, tool/skill bindings, inference settings, memory scope, and ownership metadata.
- The generated OpenCode agent remains a native SDK agent definition.


### 7. First-Class Agent Memory

 Introduce memory as a typed product subsystem, subordinate to observed and evaluated work:

 - identity memory: human-authored agent profile fields
- user memory: stable preferences and facts
- procedural memory: SOPs, checklists, and learned routines
- episodic memory: summarized outcomes from threads and automation runs
- capability memory: notes about which tools worked for which jobs

 Implementation shape:

 - Add `agent-memory-store.ts` with machine, project, agent, and crew scopes, probably backed by SQLite sidecars under the app data directory.
- Add `AgentMemoryEntry` shared types with source, scope, confidence, status, createdAt, updatedAt, and linked thread/run ids.
- Add a Memory tab under Agents and Crews plus a global Memory or Improvement Inbox.
- Inject only selected memory slices into generated OpenCode prompts. Keep retrieval and summarization app-owned; keep execution OpenCode-owned.

 Acceptance criteria:

 - Memory entries are inspectable, editable, rejectable, archivable, and deletable.
- No memory is promoted from a run without an explicit policy path.
- Memory injection is bounded, deterministic, and visible in diagnostics.


### 8. Reviewed Improvement Proposals

 Make "self-learning" a governed improvement workflow, not automatic self-modification. Proposals can target memory, SOPs, skills, agents, capability routing, eval cases, or policy suggestions.

 Minimum model:

 ```ts
type ImprovementProposal = {
  schemaVersion: number
  id: string
  sourceRunIds: string[]
  sourceTraceEventIds: string[]
  targetKind:
    | 'memory_entry'
    | 'agent_profile'
    | 'skill'
    | 'sop'
    | 'crew'
    | 'capability_route'
    | 'eval_case'
    | 'policy_rule'
  proposalKind: 'create' | 'update' | 'archive' | 'delete'
  before?: unknown
  after: unknown
  confidence: number
  rationale: string
  status: 'proposed' | 'approved' | 'edited' | 'rejected' | 'archived'
  createdAt: string
  reviewedAt?: string
  reviewedBy?: string
}
```

Acceptance criteria:

- The app can show what an agent proposed to improve, where the evidence came from, and who approved or rejected it.
- User can disable improvement proposals globally, per agent, per project, and per crew.
- Accepted proposals update custom skills, agents, SOPs, crews, memory, or eval cases only through existing persistence paths and review gates.


### 9. Dream / Consolidation Runs

Add Open Cowork's version of Anthropic dreaming as an app-owned consolidation job over traces, outcomes, memory, SOPs, and run history.

Dream output should be a separate candidate improvement set, not only a candidate memory store.

Implementation shape:

- Add `AgentDreamRun` / `MemoryConsolidationRun` shared types and a durable store in the same spirit as automation runs.
- Reuse trace events, session history projection, and automation run records as input selectors.
- Run dreams through OpenCode-native `plan` or a dedicated OpenCode agent session, depending on SDK support, so execution still belongs to OpenCode.
- Store results as `ImprovementProposal` records, never as direct mutation of live memory, skills, SOPs, crews, or policy.
- Allow manual, scheduled, and post-N-runs triggers, all bounded by run caps and cost limits.

Acceptance criteria:

- Live memory and SOPs are never overwritten by a dream run.
- A user can compare before/after candidate updates before accepting them.
- Dream output includes provenance: source sessions, trace events, model, instructions, timestamps, token/cost usage, and accepting user/action.
- Failed or canceled dream runs leave their partial output inspectable or cleanly discardable.


### 10. Policy Decisions And Approval Gates

The autonomy ladder is useful, but every risky action also needs a concrete policy decision record. For actions Open Cowork can mediate, policy decisions are pre-action authorization. For OpenCode-native events that already executed under an allow rule, Open Cowork records the effective policy/config snapshot as post-action evidence.

Minimum model:

```ts
type PolicyDecision = {
 schemaVersion: number
 id: string
 subjectKind: 'agent' | 'crew' | 'automation' | 'sop'
 subjectId: string
 actionKind:
   | 'read_file'
   | 'write_file'
   | 'run_command'
   | 'launch_subagent'
   | 'load_skill'
   | 'call_mcp_tool'
   | 'web_fetch'
   | 'web_search'
   | 'ask_user'
   | 'touch_external_directory'
   | 'send_external_message'
   | 'update_memory'
   | 'update_skill'
   | 'deliver_artifact'
 rawOpenCodePermissionKey?:
   | 'read'
   | 'edit'
   | 'bash'
   | 'task'
   | 'skill'
   | 'webfetch'
   | 'websearch'
   | 'question'
   | 'external_directory'
   | 'doom_loop'
   | string
 target?: {
   kind: 'workspace' | 'file' | 'mcp_server' | 'channel' | 'memory_store' | 'external_system'
   id?: string
   label?: string
 }
 decision: 'allow' | 'deny' | 'require_approval'
 decisionTiming: 'pre_action' | 'post_action_projection'
 reason: string
 riskLevel: 'low' | 'medium' | 'high' | 'critical'
 autonomyLevel: 'observe' | 'draft' | 'approve' | 'supervised' | 'bounded-auto'
 createdAt: string
}
```

 Acceptance criteria:

 - Every risky tool call or external side effect has a policy decision.
- Approval requests link to policy decisions.
- The UI can explain why an action was allowed, blocked, or sent for approval.
- Higher autonomy levels cannot bypass global policy.
- Policy decisions appear in run traces.


### 11. Autonomy Ladder

 Replace the current two automation policies with a clearer ladder:

 - `observe`: summarize and file inbox items only
- `draft`: prepare artifacts or replies, never execute side effects
- `approve`: plan and request approval before execution
- `supervised`: continue through low-risk allowlisted steps, ask for medium/high risk
- `bounded-auto`: run within budgets, allowlists, workspace scope, and rollback rules

 Acceptance criteria:

 - The UI explains what each level can do in concrete terms.
- A higher autonomy level cannot exceed build-level global permissions.
- Risky external effects still require explicit approval unless narrowly allowlisted.


### 12. Queueing And Backpressure

 Add explicit queue semantics at the product layer:

 - per-agent queue
- per-crew queue
- per-project queue
- per-channel queue
- read-only parallel fanout
- serialized side effects for the same workspace or external target
- run caps and budgets by queue

 Acceptance criteria:

 - Two write-capable agents cannot mutate the same target concurrently unless the user explicitly allows it.
- Read-only work can still fan out in parallel.
- Queue state survives app restart.


### 13. Workspace And Sandbox Profiles

 Make workspace scoping obvious and reusable:

 - personal sandbox
- project workspace
- automation workspace
- channel sandbox
- high-risk isolated workspace

 Acceptance criteria:

 - Every run shows its filesystem authority clearly.
- External channel work never lands in a real project directory by default.
- Workspace cleanup and retention are visible in Settings.


### 14. Capability Packs

 Package tools, MCPs, skills, agents, and defaults as installable capability packs:

 - research analyst
- code maintainer
- release manager
- support triage
- personal admin
- future domain packs such as HR operations or finance ops

 Acceptance criteria:

 - A user can install a pack, see exactly what it grants, and assign it to one or more agents or crews.
- Pack install does not bypass existing MCP approval or credential policy.
- Pack updates show a diff before applying.


### 15. Channel And Gateway Surface

 Add channels only after trace, eval, policy, queue, and workspace foundations exist:

 - webhooks first, then email/Slack/Telegram/Matrix as integrations or MCP-backed connectors
- pairing or allowlist for every inbound sender/source
- per-channel activation mode: ignore, draft reply, ask user, run SOP, run crew
- channel-to-crew and channel-to-SOP routing
- delivery policy for replies and summaries

 Acceptance criteria:

 - Unknown senders never trigger execution.
- Every inbound item has source, sender, route, allowed capabilities, and audit status.
- External sends default to drafts or approvals.


### 16. Delivery Channels

 Expand delivery beyond in-app records:

 - desktop notifications
- email drafts
- Slack/Teams drafts
- webhook callbacks
- document/report artifacts

 Acceptance criteria:

 - Successful work can reach the user where they want it.
- Failed delivery does not mark the underlying run as lost.
- External sends are auditable and reversible where the platform allows it.


### 17. Operations Dashboard

 Evolve Pulse into mission control for agents, crews, SOPs, channels, queues, approvals, evals, costs, improvement proposals, and incidents.

 Acceptance criteria:

 - A user can answer "what are my agents and crews doing right now?" in one screen.
- 100+ historical runs do not require full detail hydration.
- Stuck, risky, or expensive workflows are visible without opening each thread.


### 18. Organization Control Plane

 Add organization-level concepts only after the desktop/team product proves the core operations loop:

 - workspaces / tenants
- users, groups, and roles
- agent and crew owners and approvers
- lifecycle: draft, review, approved, active, paused, retired
- agent map: which agents depend on which tools, memories, SOPs, and channels
- RBAC, audit export, OTel export, incident controls, and durable workers

 Acceptance criteria:

 - Every agent and crew has an owner, scope, tools, memory boundary, eval suite, and offboarding path.
- The organization can pause, retire, or offboard an agent as easily as it can disable a user account.


## UX Direction

 The app should feel like an operations desk for trusted workers, not a chat app with more buttons.

 Core surfaces:

 - Agents: portrait cards with identity, memory status, autonomy level, assigned capability packs, recent outcomes, and current queue state.
- Crews: team cards with mission, owner, lead agent, active runs, blocked approvals, last eval score, budget, capability health, and lifecycle state.
- Crew Builder: tabbed workbench for Mission, Team, Workflow, Capabilities, Autonomy, Memory, Evals, Budget, and Delivery.
- Crew Run Detail: swimlanes for lead, specialist agents, evaluator, human approvals, tools/MCPs, artifacts, and improvement proposals.
- Crew Run Detail is an operational timeline and artifact/eval view, not a raw transcript viewer. Users can drill into transcripts on demand, but the default view should answer status, blockers, outputs, authority, and quality.
- Agent Builder: tabbed workbench for Identity, Instructions, Memory, Capabilities, Autonomy, and Inference.
- Improvement Inbox: diff-oriented review surface for proposed memories, SOP edits, skill updates, eval cases, crew changes, routing lessons, and policy suggestions.
- Operations Dashboard: dense, scannable lanes for active agents, blocked work, approvals, channel inbox, cost, and reliability.
- SOP Builder: structured workflow editor with triggers, inputs, work graph, approval boundaries, deliveries, and test run history.
- Channels: connector grid with pairing state, sender allowlists, route targets, last inbound event, and delivery policy.
- Capabilities: pack-oriented library where users understand risk before granting tools to agents.

 Interaction principles:

 - Use icons, status chips, and compact timelines for scanning.
- Put irreversible actions behind approval drawers with exact target, tool, agent, and workspace authority.
- Prefer side-by-side diffs for anything the agent wants to learn or change.
- Let users drill into detail on demand without hydrating every transcript.
- Keep background work visible but quiet unless user action is needed.


## Relationship To Roadmap

 This document explains the research and product rationale. The canonical implementation order lives in [Roadmap](roadmap.md). If this page conflicts with the roadmap, the roadmap wins.

 The priority order is:

 1. Stabilize the local substrate: concurrent sessions, child-session projection, approvals, and reload parity.
2. Ship Cowork Crews with traceability and evals: crew definitions, crew runs, trace events, evaluator passes, artifact graph, and run swimlanes.
3. Unify SOPs and automations: scheduled/manual/channel-triggered SOP or crew runs with versioned work graphs and approval gates.
4. Add governed memory and dream runs: typed memory, Improvement Inbox, candidate memory diffs, provenance, privacy classification, and reviewed learning.
5. Add autonomy, queues, and workspace profiles: risk metadata, serialized writes, read-only fanout, run caps, and visible authority.
6. Add channels and delivery: pairing, allowlists, draft-first external sends, delivery audit, and channel sandboxes.
7. Add the organization control plane: tenants, users, groups, roles, owners, approvers, policy engine, audit/OTel export, incident controls, and durable service workers.

 The sequencing matters: memory without traceability becomes folklore; autonomy without evals becomes risk; channels without policy become an attack surface; crews without observability become chaos.


## Example Vertical: HR And Regulated Workflows

 HR is a useful stress test for the product because it combines high-volume repeatable work with sensitive data, policy obligations, and human accountability. It should remain an example vertical until the general platform primitives are working.


### HR Team Example

 A mature HR operations crew could help with:

 - employee self-service triage
- policy lookup and answer drafting
- onboarding checklist preparation
- benefits or payroll case preparation
- recruiting coordination and candidate-summary drafts
- manager briefing packets
- employee document collection and routing

 Humans should remain accountable for employment-impacting decisions such as hiring, firing, compensation, disciplinary action, protected-class handling, and legal or compliance judgments.


### Organizational Readiness Gaps

 For a company to move an HR team toward agent-managed work, Open Cowork would need the same foundations required by the broader platform:

 - owned agents and crews with lifecycle states
- case/work-item intake with SLA, priority, confidentiality, requester, and escalation state
- strict PII handling, redaction, retention, and access boundaries
- policy decisions before sensitive tool calls or external writes
- named human approvals for sensitive actions
- durable traces, artifact lineage, delivery records, and audit export
- eval suites before activation and after major model, prompt, memory, skill, policy, or connector changes
- governed connectors to systems of record rather than ad-hoc browser or shell behavior
- a durable service plane for scheduled and background work independent of one desktop session


### HR-Ready Product Bar

 Open Cowork should not be positioned as a regulated HR automation platform until an organization can answer:

 1. Which human owns this agent or crew?
2. What cases is it allowed to touch?
3. What data classes can it read, quote, store, or send?
4. What external systems can it change?
5. Which actions require approval?
6. What evidence proves the work was correct?
7. What eval suite certified the workflow?
8. What trace and audit export explain the result?
9. How can the organization pause, revoke, quarantine, or retire it?


## Non-Goals

 - Do not build a second runtime beside OpenCode.
- Do not copy OpenClaw or ZeroClaw's daemon semantics into Open Cowork when OpenCode already owns session execution.
- Do not auto-edit identity, memory, skills, or SOPs without a visible approval path.
- Do not expose unrestricted host shell or filesystem access to remote channel input.
- Do not make "self-learning" mean background model fine-tuning.


## Product Bar

 Open Cowork becomes claw-like when a user can:

 1. Create agents and crews with identity, ownership, scoped capabilities, evals, memory boundaries, budgets, and autonomy policy.
2. Route work items into agents, crews, SOPs, inboxes, or drafts.
3. See who did what through durable traces, artifact lineage, policy decisions, approvals, and eval results.
4. Let repeatable work run through durable schedules, queues, retries, and supervised background execution.
5. Review improvement proposals and promote only approved lessons into memory, SOPs, skills, eval cases, crew config, or policy.
6. Route controlled inbound work from channels only after allowlists, policy, workspace profiles, and draft-first delivery are in place.
7. Trust that every capability is scoped, logged, inspectable, evaluated, and revocable.

 That is the path to an always-on agent product without violating the core Open Cowork boundary.
