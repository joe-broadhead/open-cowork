# Roadmap

Last updated: 2026-05-14.

> **Status: focused roadmap.** Open Cowork is narrowing around the product
> surfaces that create direct user value: Chat, Agents, Tools & Skills, and
> Workflows. Non-core dashboards and self-directed meta-work loops are outside
> the active product until the core loop is simple, reliable, and obvious.

## First Principle

Open Cowork is a product layer on top of OpenCode, not a second runtime.

- **OpenCode owns execution:** sessions, child sessions, MCP execution,
  approvals, questions, compaction, native skills, streaming events, tool
  semantics, and agent runtime behavior.
- **Open Cowork owns composition:** desktop UI, packaging, branding,
  configuration, capability curation, event projection, workflow state, and
  user-facing ergonomics.

If a roadmap item starts to replace OpenCode runtime behavior, it should be
simplified or removed.

## Product Thesis

The app should help a teammate describe work, choose or build the right agent,
connect approved tools and skills, and review the output.

The stable loop is:

```text
intake -> setup thread -> agent/tool selection -> saved workflow -> run thread -> history
```

The stable vocabulary is:

- **Chat** for direct work with OpenCode.
- **Agents** for reusable workers.
- **Tools & Skills** for scoped authority and repeatable know-how.
- **Workflows** for reviewed recurring work.
- **Threads** for history and recall.
- **Artifacts** for generated files, charts, reports, and saved outputs.

Everything in primary navigation should support one of those concepts.

## Non-Goals For The Core Roadmap

These concepts are intentionally out of the active app surface:

- Team dashboards as first-class multi-agent management.
- Specialized audit and incident-control dashboards.
- Self-directed proposal loops that create work without a user-defined workflow.
- A parallel work runtime outside OpenCode.

They can return only if they are explained through the core concepts above and
have a concrete user job that cannot be solved more simply.

## Phase 1: Make Chat Excellent

Goal: make direct OpenCode work fast, transparent, and reliable.

Scope:

- model, provider, agent mode, reasoning, and attachment controls in both Home
  and Chat
- robust markdown, tables, charts, and artifact rendering
- clear task cards for OpenCode-native delegated agents
- reliable approval and question UX
- fast thread switching and reload parity
- simple session inspection without turning Chat into a dashboard

Acceptance:

- Home and Chat composer behavior match.
- Rapid prompts, file attachments, and agent mentions are non-regressive.
- Sub-agent runs are readable without exposing runtime internals.
- Charts and markdown render consistently before and after streaming finishes.
- Reloaded sessions preserve approvals, questions, tool calls, task runs, and
  artifacts.

## Phase 2: Make Agents Understandable

Goal: let users build and trust the workers they delegate to.

Scope:

- a polished built-in/custom/runtime agent catalog
- grounded agent cards showing real tools, skills, model, reasoning, and write
  authority
- search and filtering by job, skill, tool, and authority
- shared validation between renderer and main process
- sandbox testing for draft agents before saving
- clearer links from an agent to the Tools & Skills it can use

Acceptance:

- Users can explain what an agent can do from its card.
- Saving an agent never succeeds in the UI and fails in main validation.
- Draft agents can be tested without disrupting normal runtime state.
- Enabled/disabled state uses SDK-native configuration where possible.

## Phase 3: Make Tools & Skills Concrete

Goal: show the real capability graph behind agents and workflows.

Scope:

- group skills by linked tools
- highlight which tools a skill may call
- show which agents and workflows depend on each tool or skill
- make credential and permission requirements visible
- keep MCP and skill management deterministic and bounded

Acceptance:

- A user can answer “why can this agent do that?” from the UI.
- Adding a skill or tool makes its downstream agent/workflow impact visible.
- Skill import/save paths use the same validation and size limits everywhere.

## Phase 4: Make Workflows Thread-Native

Goal: make recurring work feel like saved conversations, not a second product.

Scope:

- Add workflow opens a normal Workflow Designer setup thread.
- The user talks through the task until the workflow is clear.
- Workflow Designer previews the workflow with a bundled Workflows MCP tool.
- Workflow Designer saves the workflow only after explicit user confirmation.
- Workflows run manually, on a schedule, or from a local webhook.
- The Workflows page stays a compact list of saved workflows, triggers, latest
  run state, and setup/run thread links.

Acceptance:

- A non-technical teammate can add a repeatable task by talking to Workflow
  Designer.
- The saved workflow definition is inspectable from the setup thread and page.
- Webhook payloads appear in the run prompt.
- Workflows use OpenCode agents, tools, skills, approvals, and delegation
  rather than a Cowork-owned execution loop.

## Phase 5: Reconsider External Intake

Only after Chat, Agents, Tools & Skills, and Workflows are simple and reliable,
reassess whether external events belong in the app. The first version should
create reviewed workflow drafts only; it must not introduce a separate product
surface or bypass human review.

## Phase 6: Reconsider Advanced Organizational Features

Only after the core loop is excellent, reassess whether the app needs:

- team templates
- specialized audit dashboards
- advanced agent-run summaries
- proposal loops that are explicitly anchored to saved workflows

The bar for reintroduction is high: each feature must collapse into Chat,
Agents, Tools & Skills, Workflows, or Threads without adding a new mental model.

## HR And Regulated Workflow Bar

HR, finance, compliance, and other regulated workflows should wait until the
core loop is proven: explicit setup threads, durable saved definitions,
bounded tools and skills, clear outputs, and auditable thread history.
Those teams need less surface area, not more.
