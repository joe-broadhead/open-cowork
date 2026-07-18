---
title: Glossary
description: Definitions for the core concepts that appear across Open Cowork's docs and UI.
---

# Glossary

A single page for the terms that show up across the rest of these docs. If a
concept's first definition is unclear elsewhere, it lives here.

## Runtime & composition

OpenCode
:   The upstream open-source AI coding agent runtime. Open Cowork embeds it
    via `@opencode-ai/sdk/v2` (native V2 client) and ships the OpenCode CLI
    binary alongside Desktop, Cloud workers, and gateway appliances. All
    session execution, agents, approvals, and tool semantics belong to
    OpenCode. A small classic-client allowlist remains only where V2 routes
    are still unavailable (see `docs/opencode-sdk-v2-boundary.md`).

Open Cowork
:   The multi-surface product layer on top of OpenCode: **Desktop** (local
    Electron), **Cloud** (web + control plane + workers), **Channel Gateway**
    and **Standalone Gateway** appliances, plus optional family products
    **Gateway** (durable work) and **Wiki**. Owns UI, configuration schema,
    workflow control plane, packaging, branding, workspaces, and safety
    policies. Does **not** own model execution.

Cowork
:   Used as a verb in the UI ("What shall we cowork on today?"). Refers to
    the act of a human and one or more agents working together inside a
    reviewed, structured workspace.

Composition
:   Open Cowork's job: choosing providers, models, branding, MCPs, skills,
    and permissions, then handing the resulting config to OpenCode at
    startup. Composition is config-driven and downstream-overridable.

## Sessions, project chats & artifacts

Session
:   An OpenCode-owned conversation between the user and one or more agents.
    Sessions stream events (tool calls, text deltas, approvals) that the
    desktop app projects into a renderer-safe view model.

Project chat (thread)
:   The user-facing container around a session. The sidebar and **Projects**
    page list project chats, not raw OpenCode sessions. Internally the code
    and IPC still say *thread* (`threads:search`, `thread-index.sqlite`).
    Project chats come in two flavors:

Project-bound chat
:   A project chat bound to a real directory on the user's filesystem. The
    agent has read/write access to that project. Use for code work and repo
    edits.

Sandbox chat
:   A project chat bound to a private, Cowork-managed workspace. Outputs are
    presented as artifacts. Use for reports, drafts, charts, and
    experimentation that should not pollute a real project.

Artifact
:   A first-class output of a sandbox chat (or any sandboxed work). Has
    save-as, reveal-in-finder, and storage-cleanup affordances. Lives
    outside the chat transcript. The **Artifacts** Studio surface is the
    library for browsing them.

## Team, skills & tools

Coworker (agent)
:   An OpenCode role definition presented in the product as a **coworker** on
    the **Team** page: instructions + permissions + tool/skill bindings.
    Built-in (`plan`, `build`, etc.) or custom. Custom coworkers compile into
    native OpenCode agent configs — there is no parallel execution path.
    Prefer **Team** / **coworker** in user-facing copy; **agent** remains the
    OpenCode and code-level term.

Skill bundle
:   A reusable instruction package built around a `SKILL.md` entry point,
    with optional templates / examples / references. Skills teach an agent
    a workflow or domain. Resolved through OpenCode's native skill loading
    so they can't be invoked through a Cowork-only path.

MCP (Model Context Protocol)
:   A protocol for exposing tools to a model. Open Cowork ships seven MCPs out
    of the box: `agents` (custom-agent authoring), `charts` (Vega-Lite + Mermaid
    rendering), `knowledge` (knowledge-wiki proposals), `semantic-ui`
    (approval-gated UI actions), `skills` (skill-bundle management),
    `workflows` (workflow preview and creation), and `time-keep` (IANA
    timezones, calendar math, business days, holidays, and local timers).
    Users can also add stdio or HTTP MCPs. See [Skills & MCPs](skills-and-mcps.md).

Capability
:   The internal umbrella term for tools, skills, and agents. The
    user-facing page is **Tools & Skills**; it is the visibility and
    permission surface for the tool and skill catalog.

Tool
:   An individual MCP-exposed function the model can call. OpenCode 1.18+
    registers ids as `${server}_${tool}` (e.g. `charts_bar_chart`,
    `skills_save_skill_bundle`, `time-keep_current_time`); Open Cowork
    permission patterns also accept the Claude-style `mcp__server__tool`
    form and dual-expand it. Tools belong to MCPs; capabilities aggregate
    them.

## Playbooks & workflows

Playbook
:   The user-facing name for a saved repeatable task. A playbook is created
    from a Workflow Designer setup thread, then run manually, on a schedule,
    or from a webhook. The Playbooks page is the product surface for creating,
    running, pausing, and reviewing these saved tasks.

Workflow
:   The internal durable record behind a playbook. It reuses OpenCode agents,
    tools, skills, approvals, and sessions; Open Cowork stores only the
    definition, triggers, run records, and thread links. See
    [Playbooks and workflows](workflows.md).

Setup thread
:   The setup thread where the user and Workflow Designer clarify a workflow.
    Workflow Designer previews the proposed workflow, then saves it only after
    explicit user confirmation.

Webhook trigger
:   A local HTTP URL with a per-workflow secret. Posting a JSON object to the
    URL starts a workflow run and passes the payload into the run prompt.

Run
:   A single execution attempt for a workflow, linked back to the
    OpenCode session that produced it.

## Product partitions (Gateway family & Wiki)

Channel Gateway
:   Cloud channel adapter (`apps/gateway` today; target
    `apps/channel-gateway`). Connects chat providers (Telegram, Slack, email,
    …) to Open Cowork Cloud over HTTP/SSE. **Never** spawns OpenCode. OCI
    image historically `open-cowork-gateway`; target
    `open-cowork-channel-gateway`. See
    [Packaging and product modes](packaging-and-product-modes.md).

Standalone Gateway
:   Gateway-only execution appliance (`apps/standalone-gateway`) with a
    private OpenCode runtime and Gateway Postgres. CLI:
    `open-cowork-gateway-standalone`.

Gateway
:   Optional durable work coordinator product (import target
    `products/gateway`; historically opencode-gateway). Owns Initiatives,
    Issues, scheduler, Mission Control, and durable MCP tools beside
    OpenCode. Install bin target: **`cowork-gateway`**. Not default-on in
    public Desktop. See [Gateway](opencode-gateway.md) and
    [Product partitions ADR](adr/product-partitions.md).

Wiki
:   Optional git-backed knowledge product (import target `products/wiki`;
    historically open-wiki). CLI target: **`cowork-wiki`**. Distinct from
    in-app **Knowledge**. See [Wiki](openwiki.md) and
    [Knowledge vs Wiki ADR](adr/knowledge-vs-wiki.md).

Knowledge
:   In-app knowledge store and Studio surface: app-owned SQLite (desktop) or
    Postgres (cloud), proposals via `mcps/knowledge`. Not the Wiki product.
    See [Knowledge store ownership](knowledge-store-ownership.md).

## Configuration & distribution

Downstream
:   A custom branded distribution of Open Cowork — its own config, skills,
    MCPs, branding, and packaging. Achieved through environment variables
    and config overlay, not by forking the source. See
    [Downstream Customization](downstream.md).

Config merge order
:   The fixed sequence the app uses to build the active config: defaults
    → bundled `open-cowork.config.json` → `OPEN_COWORK_CONFIG_PATH` →
    `OPEN_COWORK_DOWNSTREAM_ROOT` → per-user → managed system. Later
    layers override earlier ones via deep merge.

Allowed env placeholder
:   A name listed under `allowedEnvPlaceholders` in config. Only listed
    names can be expanded via `{env:NAME}` in config strings, so a
    downstream config can't implicitly pull arbitrary host secrets.

## UI surfaces

Default Studio navigation (user-facing names):

| Nav label | Purpose |
| --- | --- |
| **Home** | Landing composer and recent work |
| **Projects** | Indexed project-chat history, tags, filters |
| **Knowledge** | In-app knowledge spaces, pages, and proposals (not Wiki) |
| **Approvals** | Cross-session review queue for permissions and questions |
| **Team** | Built-in and custom coworkers |
| **Playbooks** | Saved repeatable tasks (workflow definitions) |
| **Channels** | Channel Gateway connections and deliveries |
| **Tools & Skills** | MCP tools, skills, and capability catalog |
| **Artifacts** | Generated files, charts, and deliverables library |
| **Settings** | Appearance, models, permissions, storage |

Home
:   The welcoming landing surface — single composer, recent project chats,
    @-coworker suggestion pills. Submitting a prompt creates a new session
    and routes to Chat in one motion.

Projects
:   The full-history workspace for search, facets, tags, and saved filters
    over project chats. See [Projects](projects.md).

Team
:   The coworker catalog (built-in + custom OpenCode agents). See
    [Team](agent-authoring.md).

Playbooks
:   The product surface for saved repeatable tasks. See
    [Playbooks and workflows](workflows.md).

Tools & Skills
:   The catalog page for tools, skills, and MCPs (built-in + custom).
    The visibility/permission surface.

Knowledge
:   In-app knowledge spaces and proposal review (secondary Studio surface).
    See [Knowledge store ownership](knowledge-store-ownership.md). For the
    optional standalone git-backed product, see [Wiki](openwiki.md).

Approvals
:   Studio queue for pending permissions and questions across sessions.
    OpenCode still owns the approval primitive; Chat also surfaces in-thread
    gates.

Channels
:   Channel Gateway setup, bindings, and delivery status.

Artifacts
:   Library of generated outputs across chats (charts, files, reports).

Chat
:   The live OpenCode session transcript (streamed events, in-thread
    approvals, coworker tasks, artifacts).

Approval (in-chat)
:   A review gate that pauses a coworker before a sensitive operation.
    OpenCode owns the approval primitive; Open Cowork surfaces it in
    Chat and on the Approvals page.
