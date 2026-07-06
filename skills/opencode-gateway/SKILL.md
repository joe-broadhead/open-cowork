---
name: opencode-gateway
description: Coordinate durable work through the opencode-gateway MCP - Initiatives, Issues, scheduler runs, human gates, and Mission Control state that outlives any one session.
---

# Gateway Work Coordination

Use the opencode-gateway MCP when work must outlive the current session:
multi-step plans, scheduled runs, delegated tasks, and anything a human
should be able to inspect later in Mission Control.

## Core loop

1. Orient first: `mcp__opencode-gateway__gateway_briefing` and
   `mcp__opencode-gateway__gateway_attention` show changed work, active runs,
   blockers, and pending gates before you act.
2. Structure work as Issues under Initiatives:
   `mcp__opencode-gateway__gateway_roadmap_list` to find the right Initiative, then
   `mcp__opencode-gateway__gateway_task_create` (asks for approval by design) with
   a clear title, priority, and pipeline.
3. Watch execution with `mcp__opencode-gateway__gateway_run_list` /
   `mcp__opencode-gateway__gateway_run_get`; explain run outcomes from their
   receipts rather than guessing.
4. Route human decisions honestly: `mcp__opencode-gateway__gateway_permission_list`
   and `mcp__opencode-gateway__gateway_question_list` show pending OpenCode
   requests — surface them to the user; replies require approval.

## Boundaries

- Gateway coordinates; OpenCode executes. Never describe Gateway as a
  second agent runtime.
- This deployment runs the **operate** tier: scheduler configuration,
  profile/team mutation, OpenCode asset management, restore, and restart
  are admin-tier tools that are not exposed here.
- Mutations (task/roadmap creation, delegation, channel sends, gate
  decisions, scheduler pause/resume) ask for the user's approval by
  design — propose, do not accumulate unreviewed state.
- The daemon must be running (`opencode-gateway start`); if tools fail with
  connection errors, say so and suggest `opencode-gateway doctor`.
