---
name: agent-creator
description: Design and author custom OpenCode agents for Open Cowork, including routing, skills, tools, and permission boundaries.
---

# Agent Creator

Use this skill when a user wants to create or update a custom OpenCode agent in Open Cowork.

## Purpose

- Turn a rough specialist role into a reusable custom agent.
- Keep the agent focused enough for reliable delegation.
- Attach only the skills and tools the agent actually needs.
- Save through the Agents MCP after preview and explicit confirmation.

## Workflow

1. Clarify the agent's job:
   - what work it should own
   - when the main agent should delegate to it
   - what output it should return
   - whether it may change files or product metadata
2. Choose a clean agent id:
   - lowercase
   - hyphenated
   - stable and descriptive
   - not a built-in or existing custom agent id
3. Select capabilities:
   - skills for reusable judgment or workflow instructions
   - tools for concrete external actions
   - read-only tools by default
   - write-capable tools only when the job requires them
4. Draft agent instructions:
   - start with the role
   - state the expected inputs and outputs
   - include tool and skill usage guidance
   - include stop/ask conditions for missing context
   - avoid broad rules that duplicate the main Build agent
5. Use the Agents MCP:
   - `mcp__agents__list_agents` and `mcp__agents__get_agent` before updating an existing custom agent
   - `mcp__agents__preview_agent` before saving any new or changed agent
   - `mcp__agents__save_agent` only after the user explicitly confirms the preview
   - `mcp__agents__delete_agent` only after explicit deletion confirmation

## Guardrails

- Built-in agents are read-only. Do not try to edit Build, Plan, General, Explore, Executive Assistant, Autoresearch, or configured bundled agents.
- Prefer one focused custom agent over a broad catch-all.
- Do not grant write-capable tools just because they might be useful.
- If a skill or tool is missing, ask the user whether to create/connect it first instead of inventing an id.
- Do not save an agent that cannot explain when it should be delegated to.

## Output

- Agent id.
- One-sentence routing description.
- Selected skills and tools.
- Any write-capable permissions that will require approval.
- Confirmation that the preview was shown before saving.
