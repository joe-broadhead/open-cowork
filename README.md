# Open Cowork

Open Cowork is a generic desktop AI workspace built on top of OpenCode.

It provides a fast Electron shell for:
- chat-based work with OpenCode sessions
- MCP-powered tools
- reusable skills
- built-in and custom agents
- concurrent sub-agent teams

The core repo stays intentionally thin:
- OpenCode owns execution, sessions, permissions, approvals, compaction, and event streaming
- Open Cowork owns product composition, UI, config, and optional team orchestration policy

## What ships in core

Open Cowork upstream ships with:
- the desktop app shell
- OpenCode SDK runtime integration
- session and thread UI
- custom MCP, skill, and agent support
- a generic built-in agent team:
  - `assistant`
  - `plan`
  - `research`
  - `explore`
- the Charts MCP

Open Cowork upstream does not bundle company-specific integrations, auth flows, skills, or agents by default.

## Configuration

The app is configured through [open-cowork.config.json](open-cowork.config.json).

That config controls:
- branding
- optional auth mode
- available providers and default model
- config-defined integration bundles
- extra built-in agent definitions
- global permission defaults

Downstream teams can customize Open Cowork by:
- editing `open-cowork.config.json`
- adding MCPs, skills, and agents in the app
- shipping their own downstream config and assets

## Optional plugins

The core repo is designed to work well with a companion plugin distribution such as `open-cowork-plugins`.

That companion can provide reusable packs for things like:
- GitHub
- Perplexity
- Google Workspace
- Atlassian

The core app does not require any of those bundles to run.

## Local development

Requirements:
- Node `>=22`
- pnpm `>=10`

Common commands:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build:desktop
```

Package the desktop app:

```bash
pnpm --filter @open-cowork/desktop dist:ci
```

## Architecture

See:
- [docs/architecture.md](docs/architecture.md)
- [future_plan.md](future_plan.md)

## Repo layout

- `apps/desktop` — Electron app, runtime wiring, renderer UI
- `packages/shared` — shared preload and renderer types
- `mcps/charts` — bundled Charts MCP
- `tests` — repo-level tests

## Status

This repo is the generic Open Cowork core.

It is intended to be a reusable upstream base for downstream distributions that want to add:
- custom branding
- MCP bundles
- providers
- auth flows
- custom agents and skills
