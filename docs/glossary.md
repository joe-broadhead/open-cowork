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
    via `@opencode-ai/sdk` and ships the OpenCode CLI binary alongside the
    Electron app. All session execution, agents, approvals, and tool
    semantics belong to OpenCode.

Open Cowork
:   The desktop product layer on top of OpenCode. Owns the UI, configuration
    schema, workflow control plane, packaging, branding, and all
    main-process safety policies. Does **not** own execution.

Cowork
:   Used as a verb in the UI ("What shall we cowork on today?"). Refers to
    the act of a human and one or more agents working together inside a
    reviewed, structured workspace.

Composition
:   Open Cowork's job: choosing providers, models, branding, MCPs, skills,
    and permissions, then handing the resulting config to OpenCode at
    startup. Composition is config-driven and downstream-overridable.

## Sessions, threads & artifacts

Session
:   An OpenCode-owned conversation between the user and one or more agents.
    Sessions stream events (tool calls, text deltas, approvals) that the
    desktop app projects into a renderer-safe view model.

Thread
:   The user-facing container around a session. The sidebar lists threads,
    not raw sessions. Threads come in two flavors:

Project thread
:   A thread bound to a real directory on the user's filesystem. The agent
    has read/write access to that project. Use for code work and repo edits.

Sandbox thread
:   A thread bound to a private, Cowork-managed workspace. Outputs are
    presented as artifacts. Use for reports, drafts, charts, and
    experimentation that should not pollute a real project.

Artifact
:   A first-class output of a sandbox thread (or any sandboxed work). Has
    save-as, reveal-in-finder, and storage-cleanup affordances. Lives
    outside the chat transcript.

## Agents, skills & tools

Agent
:   An OpenCode role definition: instructions + permissions + tool/skill
    bindings. Built-in (`plan`, `build`, etc.) or custom. Custom agents
    compile into native OpenCode agent configs — there is no parallel
    execution path.

Skill bundle
:   A reusable instruction package built around a `SKILL.md` entry point,
    with optional templates / examples / references. Skills teach an agent
    a workflow or domain. Resolved through OpenCode's native skill loading
    so they can't be invoked through a Cowork-only path.

MCP (Model Context Protocol)
:   A protocol for exposing tools to a model. Open Cowork ships seven bundled
    MCPs: `agents` (custom-agent authoring), `charts` (Vega-Lite + Mermaid rendering),
    `clock` (time and calendar math), `knowledge` (knowledge-wiki proposals),
    `semantic-ui` (approval-gated UI actions), `skills` (skill-bundle management), and
    `workflows` (workflow preview and creation). Users can also add stdio or HTTP MCPs.
    See [Skills & MCPs](skills-and-mcps.md).

Capability
:   The internal umbrella term for tools, skills, and agents. The
    user-facing page is **Tools & Skills**; it is the visibility and
    permission surface for the tool and skill catalog.

Tool
:   An individual MCP-exposed function the model can call (e.g.
    `mcp__charts__bar_chart`, `mcp__skills__save_skill_bundle`,
    `mcp__skills__delete_skill_bundle`). Tools belong to MCPs;
    capabilities aggregate them.

## Workflows

Workflow
:   A saved repeatable task created from a Workflow Designer setup thread. It
    can run manually, on a schedule, or from a webhook. It reuses OpenCode
    agents, tools, skills, approvals, and sessions; Open Cowork stores only the
    definition, triggers, run records, and thread links. See
    [Workflows](workflows.md).

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

Home
:   The welcoming landing surface — single composer, recent threads,
    @-agent suggestion pills. Submitting a prompt creates a new session
    and routes to Chat in one motion.

Tools & Skills
:   The catalog page for tools, skills, and MCPs (built-in + custom).
    The visibility/permission surface.

Approval
:   A review gate that pauses an agent before a sensitive operation.
    OpenCode owns the approval primitive; Open Cowork surfaces it in
    chat.
