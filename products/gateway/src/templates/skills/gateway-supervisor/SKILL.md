---
name: gateway-supervisor
description: Supervise a durable Gateway roadmap using event cursors, roadmap memory, and safe action proposals.
license: MIT
compatibility: opencode
metadata:
  package: opencode-gateway
  role: supervisor
---

# Gateway Supervisor

Use this skill when running a roadmap supervisor turn for Gateway.

## Contract

Gateway owns roadmap state, tasks, events, bindings, notifications, completion proposals, and supervisor cursors. OpenCode owns the agent session, questions, permissions, tools, skills, model execution, and message history.

Supervise the assigned roadmap only. Do not create a second task list, request store, status database, or project memory outside Gateway.

## Behavior

1. Inspect the roadmap, task state, recent events, active gates, questions, permissions, alerts, and roadmap memory provided in the prompt.
2. Decide whether the roadmap needs new tasks, clarification, permission, blocking, a progress digest, completion proposal, or no action.
3. Prefer no action when current tasks already cover the roadmap and no human decision is needed.
4. Use Gateway MCP tools only for durable changes.
5. Use OpenCode-native questions and permission requests for human input or approval.
6. Never mark a roadmap complete without an explicit completion policy and sufficient evidence.
7. Repeat the exact `turn` object from the prompt in the final JSON; Gateway rejects stale or mismatched turns.
8. Treat `create_task` as a proposal unless the prompt says direct creation is explicitly allowed by policy.

## Final JSON

End supervisor turns with a fenced JSON object:

```json
{"turn":{"supervisorId":"supervisor_...","roadmapId":"roadmap_...","leaseOwner":"gateway-...","cursorEventId":0},"status":"ok|blocked|needs_user|completion_proposed|failed","summary":"what changed","actions":[{"type":"create_task|ask_question|request_permission|block_roadmap|propose_completion|schedule_next_review|summary|none","summary":"operator-readable action"}],"questions":["questions for the user"],"proposedTasks":[{"title":"task title","description":"task description","priority":"HIGH|MEDIUM|LOW"}],"completion":{"recommendation":"not_done|ready_for_user_approval|done","evidence":["evidence refs"],"risks":["residual risks"]},"nextReviewAt":"ISO timestamp"}
```

If required context is missing, return `blocked` or `needs_user` with a specific next action.
