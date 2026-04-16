# Architecture

## First principle

Open Cowork is not a second runtime.

It is a desktop product layer built on top of OpenCode.

The clean architectural split is:

- **OpenCode owns execution**
- **Open Cowork owns composition, packaging, and UI**

## What OpenCode owns

- session execution
- child sessions
- agent runtime behavior
- approvals
- MCP execution
- event streaming
- tool semantics
- native skill loading

## What Open Cowork owns

- branding and configuration
- provider/model selection UX
- desktop shell and session UI
- custom MCP, skill, and agent authoring surfaces
- sandbox artifact UX
- runtime composition for the packaged app
- event projection into a renderer-safe state model

## High-level layers

### 1. Configuration layer

Configuration starts from:
- `open-cowork.config.json`
- `open-cowork.config.schema.json`

This layer defines:
- branding
- auth mode
- providers
- bundled tools
- bundled skills
- bundled MCPs
- built-in agents
- default permissions

### 2. Runtime composition layer

The desktop app builds the OpenCode runtime configuration at startup.

This includes:
- provider/model resolution
- permission composition
- bundled content sync
- Cowork-managed MCP integration
- directory-scoped runtime behavior

### 3. Main-process integration layer

The Electron main process:
- starts and stops the runtime
- bridges IPC
- manages window lifecycle
- owns local storage and session registry access
- enforces desktop-side policy and safety boundaries

### 4. Event projection layer

OpenCode events are normalized and projected into a renderer-safe session model.

This layer is responsible for:
- streamed text updates
- tool call projection
- task run projection
- approval and question state
- notifications

### 5. Renderer layer

The renderer owns:
- navigation
- chat UX
- home dashboard
- capabilities and agents UI
- settings
- artifact presentation

The renderer does not access the local filesystem or network directly. It goes through the preload bridge and IPC contract.

## Sessions and thread model

Open Cowork uses OpenCode sessions as the execution source of truth.

Thread types:

### Project thread

- bound to a real directory
- appropriate for code and file work

### Sandbox thread

- bound to a private Cowork-managed workspace
- surfaced to the user as artifacts
- designed to avoid polluting a real project by default

## MCPs, skills, and agents

### MCPs

MCPs provide tools.

Open Cowork can surface:
- bundled MCPs
- user-added custom MCPs

### Skills

Skills are OpenCode skill bundles.

Open Cowork can ship bundled skills and let users add custom skills, but skills are still used through OpenCode’s native model rather than a parallel Cowork invocation system.

### Agents

Agents package:
- role
- instructions
- permissions

Built-in and custom agents compile into OpenCode-native agent definitions.

## Sandbox artifacts

Sandbox workspaces are real Cowork-managed directories under private app control.

The UI presents them as artifacts first:
- save as
- reveal
- storage accounting
- cleanup controls

This keeps the runtime practical while preserving the user-facing sandbox mental model.

## Design goals

1. Keep OpenCode as the execution runtime.
2. Keep Open Cowork configurable for downstream builds.
3. Keep main-process boundaries explicit and testable.
4. Keep sandbox behavior safe and understandable.
5. Keep renderer state derived from projected runtime events instead of ad hoc local state.
