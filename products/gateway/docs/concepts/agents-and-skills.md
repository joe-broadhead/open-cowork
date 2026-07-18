# Agents And Skills

Gateway ships only Gateway-native OpenCode assets. Optional downstream MCPs and skills remain user-managed. Governed extension packages remain future work; public marketplace and automatic third-party install are not current release claims.

## Agents

| Agent | Mode | Purpose |
| --- | --- | --- |
| `gateway-assistant` | primary | User-facing Gateway assistant for OpenCode and channels. |
| `gateway-planner` | primary | Plans durable roadmaps and tasks. |
| `gateway-coordinator` | primary | Coordinates queues, runs, channels, OpenCode requests, config, health, and logs. |
| `gateway-implementer` | all | Executes implementation stages. |
| `gateway-reviewer` | all | Reviews stage work against the implementation spec and definition of done without editing. |
| `gateway-verifier` | all | Verifies stage work against the implementation spec and definition of done without editing. |
| `gateway-supervisor` | all | Supervises durable roadmaps and proposes next actions without owning state. |
| `gateway-auditor` | all | Audits release/readiness evidence without edits or shell commands. |

## Skills

| Skill | Used by |
| --- | --- |
| `gateway-assistant` | User-facing Gateway assistant. |
| `gateway-planner` | Planner profile and planning flows. |
| `gateway-coordinator` | Coordinator profile and service operations. |
| `gateway-stage` | Implementer, reviewer, verifier, and auditor stage agents. |
| `gateway-review-gate` | Reviewer and verifier spec-driven completion gates. |
| `gateway-supervisor` | Roadmap supervisor turns. |

## Permissions

Gateway agent definitions prefer deterministic Gateway MCP tools and deny ephemeral subagent delegation. Stage agents use OpenCode permissions appropriate to their role: implementation can edit and run commands, review/verify cannot edit, and audit cannot edit or run shell commands. Reviewer, verifier, and supervisor defaults use OpenAI `gpt-5.5` variant `xhigh`. Reviewer/verifier load `gateway-review-gate` so the gate applies to code, docs, slides, research, operations, and other deliverables. `opencode-gateway doctor` and readiness warn when Gateway-owned profile defaults are stale or missing.

Agent profiles and teams are Gateway production contracts around OpenCode-native assets. A team maps workflow roles to Gateway profiles; each profile selects the OpenCode agent/model/skills/permissions for the session and can declare bounded tools, MCP references, budgets, output contracts, and promotion state. See [Agent Contracts](../configuration/agent-contracts.md) for the schema and [Agent Teams](../configuration/agent-teams.md) for domain-team examples.

At team scale, profiles, teams, skills, MCPs, tools, connectors, and blueprints become extension-package surfaces. The governance rule is fail closed: every package must declare capability grants, integrity, compatibility, lifecycle state, approval, and rollback before it can be trusted beyond the local operator boundary.

## Asset Installation

Setup installs assets into the configured OpenCode profile. You can inspect and manage them through Gateway MCP tools:

- `gateway_opencode_agent_list`
- `gateway_opencode_agent_upsert`
- `gateway_opencode_skill_list`
- `gateway_opencode_skill_upsert`
- `gateway_opencode_mcp_list`
- `gateway_opencode_mcp_upsert`
