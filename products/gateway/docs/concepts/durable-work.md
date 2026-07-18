# Durable Work

Durable work is the core Gateway object model.

Agents and users enter durable work through the [Delegation Contract](delegation-contract.md) when a request needs persistence, scheduling, supervision, evidence, gates, or callbacks instead of remaining in the current conversation.

## Objects

| Object | Purpose |
| --- | --- |
| Roadmap | Groups related tasks and tracks aggregate status. |
| Roadmap supervisor | Binds an OpenCode session to a roadmap with durable cadence, event cursor, completion policy, and notification policy metadata. |
| Project binding | Stable project alias and surface binding that resolves a user/chat/session context to one roadmap and supervisor session. See [Identity Graph](identity-graph.md). |
| Completion proposal | Evidence-backed request to mark a roadmap done, pending explicit approval unless the roadmap policy allows local auto-completion. |
| Task | A durable unit of work with priority, agent, pipeline, current stage, and status. |
| Run | One OpenCode session dispatch for one task stage. |
| Workflow event | Append-only record of Gateway-owned state transitions. |
| Channel binding | Link between an external chat/thread and a session, task, or roadmap. |

## Task Statuses

| Status | Meaning |
| --- | --- |
| `pending` | Ready for the scheduler. |
| `running` | A stage is active in an OpenCode session. |
| `done` | Pipeline completed successfully. |
| `blocked` | Requires human action or failed beyond automatic progress. |
| `paused` | Intentionally held. |
| `cancelled` | Stopped and should not be scheduled. |
| `archived` | Hidden from active work views. |

## Readiness

Task status describes durable lifecycle state. Readiness describes whether a pending task is actually runnable right now.

| Readiness | Meaning |
| --- | --- |
| `runnable` | Dependencies and gates are satisfied; scheduler may dispatch it. |
| `blocked` | A blocking dependency or blocked task state prevents dispatch. |
| `waiting` | A manual gate such as approval, credentials, external dependency, or user input is open. |
| `scheduled` | `earliestStartAt` is in the future. |
| `paused` | Operator intentionally paused the task. |
| `running` | A run is already active. |
| `done` | The task is done, cancelled, or archived. |

Scheduler ordering is deterministic: runnable work is considered first, then priority, deadline, and age.

## Dependencies And Gates

Tasks may depend on other tasks through `task_dependency_add` or `POST /tasks/:id/dependencies`. Blocking dependency types are `blocks`, `blocked_by`, and `parent`. Non-blocking relationship types are `child`, `related`, and `duplicate`.

Before a blocked task dispatches, Gateway hydrates its execution environment with dependency patch artifacts from completed prerequisite tasks. Successful dependency runs should publish unified diff artifacts as `patch:<path>` or `patch-file:<path>`; `.patch` and `.diff` refs in diff evidence are also accepted. Missing or conflicting dependency patches block the dependent task before an OpenCode session is created.

Manual gates are task metadata and create durable Gateway human-gate records that prevent dispatch until approved, rejected, or timed out:

- `approval_required`
- `credentials_required`
- `external_dependency`
- `waiting_for_user`

Schedule metadata can include:

- `earliestStartAt`
- `deadlineAt`
- `recurrence`
- `slaClass`

Quality metadata can include `qualitySpec` with objective, constraints, acceptance criteria, definition of done, verification commands, rollback plan, evidence requirements, and required artifacts. See [Quality Contracts](../operations/quality-contracts.md).

Gateway stores durable work in the current SQLite schema. Invalid dependency cycles are rejected before persistence.

## Roadmap Supervisors

Roadmap supervisors are durable controllers, not a separate runtime. Gateway stores the supervisor record and OpenCode owns the session, questions, permissions, tools, and model execution.

A roadmap may have one default active supervisor and optional watchers. The default active supervisor is selected deterministically and is the one wakeup scheduling uses for roadmap-level decisions. See [Roadmap Supervision](roadmap-supervision.md).

## Project Bindings

Project bindings give assistant surfaces an ID-light way to find the right roadmap. A binding stores an alias, roadmap ID, OpenCode session ID, scope, and optional Telegram/WhatsApp chat/thread. Channel-scoped bindings also mirror the underlying channel binding so existing sends and `/open` links continue to work.

Context resolution is deterministic: bound chat/thread, explicit alias, explicit session ID, explicit roadmap ID, single active supervisor, then ambiguity or not found. Rebinding an existing alias or chat/thread requires explicit rebind behavior through `allowRebind` or `/project bind ... --rebind`.

## Default Pipeline

The default scheduler pipeline is:

```text
implement -> review -> verify
```

Each stage is dispatched to an OpenCode session using the configured scheduler profile. The stage agent returns a fenced JSON result. Gateway reads that result and advances, retries, blocks, or completes the task deterministically. Review and verify stages measure the produced artifact against the implementation spec and definition of done, whether the artifact is code, docs, slides, research, operations work, or another deliverable.

To run a task in a specific checkout, include an absolute `Workdir: /path/to/repo` line in the task note, description, or quality-spec constraints/systems. Gateway passes that directory to OpenCode when creating, prompting, checking, and aborting the stage session.

## Stage Result Contract

Stage agents must end with JSON shaped like:

```json
{
  "status": "pass",
  "summary": "Implemented and verified the requested change.",
  "artifacts": ["src/example.ts", "npm test"]
}
```

`status` may be `pass`, `fail`, or `blocked`.

## Durable Entry Points

Create durable work through:

- `gateway_task_create`
- `gateway_roadmap_create`
- `gateway_roadmap_create_with_tasks`
- `gateway_project_binding_upsert` for project aliases and surface context
- `opencode-gateway task add <text>` for simple local CLI tasks
- Channel commands such as `/project`, `/tasks`, `/roadmaps`, `/retry`, `/done`, `/block`, and `/cancel`

Gateway intentionally does not expose direct ephemeral spawn tools. Work that should persist belongs in the durable task queue.
