# Desktop App Guide

## Main sections

The desktop app is centered around five areas:
- `Home` — welcoming landing surface
- `Chat` — where OpenCode sessions run
- `Agents` — manage built-in and custom agents
- `Capabilities` — browse tools, skills, and MCPs
- `Pulse` — diagnostic workspace dashboard

## Home

Home is the app's welcoming landing surface. It opens with a single ask
so business users aren't greeted by a wall of diagnostics on first
launch:

- a friendly greeting ("What shall we cowork on today?")
- a composer with drag-and-drop file attachment and paste-to-attach
  for screenshots
- @-agent suggestion pills that pre-fill the composer with a mention
- up to three recent-thread cards to jump back into prior work
- a quiet status strip that links to Pulse when users want the
  diagnostic view

Submitting from the Home composer creates and activates a new session,
routes the view to Chat, and fires the first prompt in a single motion.

## Pulse

Pulse is the workspace-at-a-glance surface. It's one click away in the
sidebar and is where the runtime / health / usage / agent telemetry
that used to live on Home now lives.

Pulse mixes:
- runtime health and provider / model status
- capability inventory (tools, skills, MCP connections)
- agent inventory (built-ins + enabled custom agents)
- usage summaries — history-backed, with time ranges:
  - last 7 days
  - last 30 days
  - year to date
  - all time
- agent cost + token breakdowns
- recent performance metrics

Power users and downstream evaluators can pin this page; it's the
fastest way to see the state of every moving part of the workspace.

## Chat

Chat is where OpenCode sessions run.

Important behavior:
- `@agent` selects a target agent for the prompt
- skills are OpenCode-native and are not invoked through a custom `$skill` syntax
- streamed text, tool calls, approvals, and task runs are projected into a UI-safe session model

## Project vs sandbox threads

### Project thread

A project thread is bound to a real directory and is appropriate for:
- code generation
- file editing
- repository work

### Sandbox thread

A sandbox thread uses a private Cowork-managed workspace and surfaces outputs as artifacts.

This is appropriate for:
- generated reports
- drafts
- charts
- private experimentation

## Artifacts

Sandbox-generated files are treated as artifacts first.

Artifact actions include:
- save as
- reveal in Finder/file manager
- storage cleanup from Settings

## Agents

The Agents page lets users:
- inspect built-in agents
- create custom agents
- bind custom agents to specific tools and skills

Custom agents compile into OpenCode-native agent configuration rather than a parallel Open Cowork execution system.

## Capabilities

The Capabilities page lets users inspect:
- built-in tools
- custom tools from MCPs
- bundled skills
- custom skills

This page is the main visibility surface for the tool and skill catalog.

## Settings

Settings currently cover:
- appearance
- models
- permissions
- sandbox storage

The storage section reports sandbox usage and provides cleanup controls for old or unused sandbox workspaces.
