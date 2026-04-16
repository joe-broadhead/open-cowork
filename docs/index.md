# Open Cowork

Open Cowork is a desktop AI workspace built on top of OpenCode.

It is designed to keep the runtime boundary clean:
- **OpenCode executes**
- **Open Cowork composes**

## What that means in practice

OpenCode still owns:
- sessions
- MCP execution
- approvals
- agent execution
- event streaming
- tool semantics

Open Cowork adds:
- a desktop UI
- packaging and distribution
- config-driven branding and provider setup
- user-friendly MCP, skill, and agent management
- sandbox artifact UX
- downstream customization points

## Who this is for

Open Cowork is useful for:
- individual developers who want a desktop OpenCode workspace
- teams who want a configurable internal build
- downstream distributors who want a branded product layer without forking the runtime model

## Core features

- OpenCode-powered desktop chat and session UI
- Built-in and custom MCP support
- Built-in and custom skills
- Built-in and custom agents
- Project threads for real repository work
- Private sandbox threads for artifact-driven work
- Configurable providers, models, branding, and auth mode

### What are skills and MCPs?

- **Skills** are reusable workflow prompts bundled as a folder with a
  `SKILL.md` entry point. The bundled `chart-creator` skill (for
  example) teaches the model how to pick the right chart tool and
  prepare chart-ready data. You can add your own from the app or ship
  them as part of a downstream distribution.
- **MCPs** (Model Context Protocol servers) are tools the model can
  call. The upstream build ships a `charts` MCP (Vega-Lite rendering)
  and a `skills` MCP (manage skill bundles from chat). You can add
  third-party or internal MCPs from Settings.

Neither is required to get started — the app works with the default
provider, agents, and empty custom catalog. See
[Configuration](configuration.md) for how to add more.

## Read next

- [Getting Started](getting-started.md)
- [Configuration](configuration.md)
- [Downstream Customization](downstream.md)
- [Desktop App Guide](desktop-app.md)
- [Architecture](architecture.md)
- [Packaging and Releases](packaging-and-releases.md)
- [Roadmap](roadmap.md) — forward-looking, not a commitment
