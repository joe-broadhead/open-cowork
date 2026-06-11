---
title: Coordination Model
description: Shared product vocabulary for workflows, projects, tasks, runs, schedules, watches, delegation, artifacts, questions, and permissions.
---

# Coordination Model

Open Cowork coordination is the product layer around OpenCode execution. It
does not replace OpenCode sessions, agents, tools, permissions, questions, MCPs,
or child sessions.

The shared contract lives in `packages/shared/src/coordination.ts`.
Workspace authority and sync boundaries remain governed by the
[Product Contract](product-contract.md).

## Core Nouns

| Noun | Meaning | Source of truth |
| --- | --- | --- |
| Project | Durable grouping of related team work with a human objective and assigned agent team. | Owning workspace authority. |
| Task | Durable work item inside a project with a task spec, board column, priority, assignee, and optional OpenCode session/run link. | Owning workspace authority. |
| Workflow | Saved repeatable automation definition. | Existing workflow store/control plane. |
| Run | Authority-scoped execution attempt for a workflow, task, background prompt, delegation, schedule, or watch trigger. | Owning workspace authority. |
| Schedule | Time trigger that starts a run. | Owning workspace authority. |
| Watch | Delivery subscription for progress from a conversation, project, task, workflow, run, or session. | Owning workspace authority or Cloud delivery records. |
| Delegation | Product-layer relationship from parent work to an OpenCode-native child session or explicit managed delegate session. | Owning workspace authority. |
| Artifact | Durable output or input object linked to a project, task, workflow, run, or session. | Workspace artifact owner. |
| Question | Human clarification request from OpenCode or product coordination tools. | Workspace question owner. |
| Permission | Human authorization request for an OpenCode tool/runtime action. | Workspace permission owner. |

These nouns are intentionally separate from lower-level runtime objects:

- `CoordinationTask` is durable product work. It is not `TaskRun`, which is the
  chat/session projection of an OpenCode child-session or task-tool run.
- `CoordinationProject` is a product planning container. It is not a local `projectDirectory`, Git checkout, host path, or Cloud project source.
- `CoordinationRun` points at OpenCode sessions when execution exists, but it
  does not own OpenCode tool semantics.

## Projects And Tasks

The Desktop Local coordination store persists the first concrete
Projects->Tasks model:

- `CoordinationProject.objective` is the human-readable outcome the project is
  organized around.
- `CoordinationProject.team` is a list of assigned agent ids. It is product
  planning state; it does not change OpenCode's configured agent registry.
- `CoordinationTask.spec` is the task brief Cleo or the user gives to the
  assignee.
- `CoordinationTask.column` is the stored Kanban lane:
  `backlog`, `planning`, `doing`, `review`, or `done`.
- `CoordinationTask.priority` is `high`, `med`, or `low`.
- `CoordinationTask.assignedSessionId` and `assignedRunId` reference real
  OpenCode-backed work when execution exists. The task remains product state
  around that execution; it does not become the runtime.

`status` and `column` are deliberately separate axes. The board groups cards by
stored `column`. `status` describes execution lifecycle and drives card badges
or timeline state. Convenience status mapping is only used by service/store
updates when execution reports a lifecycle change:

| Status | Column behavior |
| --- | --- |
| `open` | Moves to `backlog`, unless already in `planning`. |
| `running` | Moves to `doing`. |
| `completed` | Moves to `review`; `done` is reserved for human acceptance. |
| `blocked` | Stays in the current column. |
| `failed` | Stays in the current column and renders an error badge. |
| `cancelled` | Stays in the current column and renders a cancelled badge. |

## Watches

`CoordinationWatch` is the durable subscription record for channel delivery.
It does not execute OpenCode. It selects progress events from owned
coordination/runtime state and asks the existing channel delivery primitive to
enqueue a message.

Watch records include:

- `target`: the subscribed object. Supported targets are `conversation`,
  `playbook`, `project`, `task`, `workflow`, `run`, and `session`.
- `events`: one or more event names from the shared taxonomy:
  `task.moved`, `task.review_ready`, `run.finished`, `needs_input`, and
  `daily_summary`.
- `channel`: the delivery target, including provider, headless agent id,
  channel binding id, optional session binding id, and provider target
  metadata.
- `recipient`: optional identity/role metadata used to apply channel role
  rules before delivery. Owners, admins, and members can receive all watch
  events; approvers can receive interactive/progress events except daily
  summaries; viewers receive non-interactive progress only.
- `status`: `active`, `paused`, or `expired`.

The bridge from event to delivery is intentionally guarded: if the runtime
surface does not provide `createChannelDelivery`, the event is skipped rather
than inventing a parallel delivery path.

## Gateway Vocabulary Mapping

Standalone Gateway's prototype vocabulary maps into the shared model:

| Gateway term | Shared noun |
| --- | --- |
| manager team | Project, Task, Delegation |
| `team_projects` | Project |
| `team_tasks` | Task |
| background job | Run |
| cron job or scheduled job | Schedule plus Run |
| native delegation hint | Delegation with `opencode_native` mode |
| gateway delegate session/job | Delegation with `gateway_delegate` mode plus Run |
| `/watch` or channel subscription | Watch |
| `/enter` handoff | Delegation interaction, not a top-level durable noun |
| agent question | Question |
| OpenCode permission wait | Permission |
| diff/report/upload | Artifact |

In short, manager teams are Project/Task/Delegation, cron jobs are Schedule plus Run, background jobs are Runs, native delegation hints are Delegations, and `/watch` subscriptions are Watches.

Gateway can keep authority-specific table names internally, but user-facing
docs, APIs, dashboard labels, and future Cloud/Desktop bridges should use the
shared nouns.

## Authority Support

Support is capability-scoped, not a promise that every surface implements every
feature immediately.

| Authority | Projects | Tasks | Workflows | Runs | Schedules | Watches | Delegation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Desktop Local | supported | supported | supported | supported | supported | supported | supported |
| Cloud Worker | deferred | deferred | supported | supported | supported | deferred | deferred |
| Cloud Channel Gateway | deferred | deferred | supported | supported | read-only | supported | deferred |
| Standalone Team Gateway | supported | supported | supported | supported | supported | supported | supported |
| Paired Desktop | read-only | read-only | deferred | read-only | deferred | deferred | read-only |

Artifacts, questions, and permissions follow the existing workspace authority:
Desktop Local stores them locally; Cloud stores them in the Cloud control plane;
Standalone Gateway stores them in Gateway Postgres/artifact storage; Cloud
Channel Gateway renders Cloud-owned versions through channel delivery.

## Rules

- A durable coordination object belongs to exactly one workspace authority.
- The owner authority stores state and audit. The execution authority runs
  OpenCode when execution is required.
- Cross-authority movement is explicit import, export, registration, or
  pairing. It is never implicit runtime-home replication.
- Schedules are time triggers. Watches are delivery subscriptions. Neither is
  itself a workflow.
- Workflows are saved repeatable automations. Background prompts are runs until
  saved as workflows.
- Delegation prefers OpenCode-native child sessions and subagents. Explicit
  Gateway-created delegate sessions are a secondary authority-specific mode.
- Questions and permissions remain human decision points. Channel tokens,
  dashboard actions, or paired-device commands do not bypass OpenCode policy.
- Artifacts may sync as metadata, but body access follows the workspace
  artifact policy.

## Implementation Shape

Use shared types for product contracts and UI/API boundaries:

- `CoordinationProject`
- `CoordinationTask`
- `CoordinationRun`
- `CoordinationSchedule`
- `CoordinationWatch`
- `CoordinationDelegation`
- `CoordinationArtifactRef`
- `CoordinationQuestionRef`
- `CoordinationPermissionRef`

Authority-specific stores may have narrower schemas until the product surface
ships. For example, Desktop can keep the current workflow SQLite store, Cloud
can keep the existing workflow/run control-plane rows, and Standalone Gateway
can keep Gateway-owned tables. When these states cross a public boundary, they
should map to the shared coordination contract.

Desktop Local now stores projects, tasks, and watches in `coordination.sqlite` through
`apps/desktop/src/main/coordination/coordination-store.ts` and exposes service,
IPC, preload, AppAPI, and Cloud HTTP routes for the same shared contract.

## Validation

Every implementation that adds coordination persistence or API routes should
prove:

- ownership remains with the authority named in the object
- local host paths are not implied by `Project`
- `CoordinationTask` is not conflated with session `TaskRun`
- schedules and watches do not double-fire across replicas
- delegation links remain references around OpenCode sessions, not a parallel
  agent runtime
- artifacts, questions, permissions, and audit records redact secrets and local
  paths according to the workspace contract
