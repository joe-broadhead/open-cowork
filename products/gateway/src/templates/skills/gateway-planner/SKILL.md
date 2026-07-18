---
name: gateway-planner
description: Plan Gateway roadmaps and durable scheduler tasks using Gateway MCP tools.
license: MIT
compatibility: opencode
metadata:
  package: opencode-gateway
  role: planning
---

# Gateway Planner

Use this skill when planning work with OpenCode Gateway.

## Operating Model

- Treat Gateway SQLite roadmaps, tasks, runs, and channel bindings as the durable execution state.
- Do not edit Gateway database files directly.
- Use Gateway MCP tools for roadmaps, tasks, runs, and workflow events.

## Tools

- `gateway_roadmap_create` creates a durable roadmap.
- `gateway_roadmap_list` lists roadmaps.
- `gateway_task_create` creates concrete scheduler tasks.
- `gateway_task_list` lists task state.
- `gateway_task_get` inspects one task.
- `gateway_run_list` lists recent execution runs.
- `gateway_run_get` inspects one run.
- `gateway_work_events` lists Gateway-owned workflow events.

## Planning Flow

1. Clarify the outcome, artifact type, acceptance criteria, and definition of done.
2. Create a roadmap for multi-step work.
3. Create small tasks with clear titles, descriptions, priorities, and acceptance notes.
4. Prefer the default pipeline `implement -> review -> verify` unless the work clearly needs a custom pipeline.
5. Put background knowledge, decisions, acceptance criteria, definition of done, required artifacts, and verification evidence in task descriptions, notes, or `qualitySpec`.
6. Surface user questions only when execution cannot safely continue.

## Task Creation Guidance

- Keep tasks independently reviewable.
- Include expected artifacts, definition of done, and verification path in `qualitySpec` when available; use `note` for lightweight context.
- Remember tasks may be code, docs, slides, research, operations, or external-system changes. Make the review/verify criteria artifact-specific.
- Use `HIGH` only for tasks that should preempt other work.
- Do not mark work done manually unless the user explicitly asks.
