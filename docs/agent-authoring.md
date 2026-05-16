---
title: Agent Authoring
description: How to create and improve OpenCode-native agents from Open Cowork.
---

# Agent Authoring

Open Cowork agents are OpenCode-native agent configs. The desktop app helps
compose the instructions, skills, tools, and permission profile; OpenCode still
owns execution, routing, approvals, tool semantics, and child sessions.

## Authoring paths

There are two supported paths:

1. Use the **Agents** page to create or edit a custom agent with the builder.
2. Start a chat with an agent that has the `agent-creator` skill and the
   bundled `agents` MCP, then let it preview and save the custom agent after
   explicit confirmation.

Both paths write the same custom-agent bundle and pass through the same main
process validation before the runtime is refreshed.

## Chat-based creation

The chat path is useful when the user knows the job but not the final shape of
the agent.

1. Describe the role in normal language.
2. The setup agent clarifies the routing description, required skills, required
   tools, write access, model preferences, and permission boundaries.
3. The setup agent calls `mcp__agents__preview_agent` to show exactly what will
   be saved.
4. The setup agent waits for explicit user confirmation.
5. The setup agent calls `mcp__agents__save_agent`.

The `agents` MCP can only create, preview, read, update, or delete custom
agents. Built-in agents are code-owned and read-only.

## Skills and tools

Use skills for reusable judgement and process. Use tools for external actions
or data access.

Good custom agents usually have:

- one focused job
- a short routing description
- only the skills needed for that job
- only the MCP tools needed for that job
- write access only when the job genuinely edits files, records, or external
  systems

Avoid creating one broad catch-all custom agent. Use the default build agent for
general work and create specialists for repeated, high-value jobs.

## Autoresearch

The built-in `autoresearch` agent is for measured improvement loops over
agents, skills, prompts, and benchmarks. It loads the `autoresearch` skill and
can use the `skills` and `agents` MCPs to propose improvements.

Autoresearch should still keep Open Cowork's boundary intact:

- benchmark first
- change one thing at a time
- preview proposed skill or agent edits
- require user confirmation before saving
- keep logs and evidence tied to the run

## Runtime refresh

Saving or deleting a custom agent refreshes the managed OpenCode runtime so the
next session sees the updated OpenCode-native config. Existing sessions keep
their current runtime context; start a new session to test a changed agent from
a clean state.

## Downstream distributions

Downstream builders can ship configured agents in `open-cowork.config.json`.
Those agents are read from config, surfaced in the catalog, and compiled into
OpenCode agent config at runtime. Custom agents created by users remain in the
user data directory and can be disabled, exported, or removed by the user.
