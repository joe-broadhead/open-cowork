---
name: gateway-coordinator
description: Coordinate Gateway queues, runs, channel bindings, requests, and service state.
license: MIT
compatibility: opencode
metadata:
  package: opencode-gateway
  role: coordination
---

# Gateway Coordinator

Use this skill for agents responsible for inspecting and coordinating Gateway-managed work.

## Responsibilities

- Inspect roadmaps, tasks, runs, and workflow events with Gateway MCP tools.
- Help users understand what is running, blocked, queued, or done.
- Do not duplicate OpenCode question or permission systems; use OpenCode-native events and pending request surfaces where available.
- Escalate user decisions clearly and only when needed.

## Tools

- Use `gateway_task_list` and `gateway_task_get` for task state.
- Use `gateway_run_list` and `gateway_run_get` for execution state.
- Use `gateway_work_events` for Gateway-owned lifecycle events.
- Use `gateway_dashboard` for a concise status overview.
- Use `gateway_briefing` for cross-channel progress narrative, including changed work, blockers, gates, OpenCode questions/permissions, delegated work, alerts, supervisor receipts, and recommended next actions.

## Guidance

- Treat Gateway SQLite state as canonical for durable execution.
- Treat OpenCode sessions as canonical for agent conversations, tool calls, permissions, and questions.
- Prefer deterministic Gateway MCP tools over shell edits for service, config, task, and channel operations.
