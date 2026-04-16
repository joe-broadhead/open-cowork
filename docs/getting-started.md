# Getting Started

## Requirements

- Node `>=22`
- pnpm `>=10`
- Python `>=3.11` for documentation work

## Install from source

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

## Install from a release artifact

Download a release artifact for your platform from GitHub Releases.

Current targets:
- macOS: `.zip`, `.dmg`
- Linux: `.AppImage`, `.deb`

## First run

On first launch, Open Cowork will ask you to choose:
- a provider
- a model
- any required provider credentials

The app then boots the OpenCode runtime with your selected configuration.

## Thread types

Open Cowork supports two main thread modes.

### Project thread

Use this when you want real filesystem access in a chosen working directory.

Project threads are for:
- repository work
- file editing
- code generation into a project
- structured tool work tied to a real folder

### Sandbox thread

Use this when you want Cowork-managed private work.

Sandbox threads:
- use a private Cowork workspace
- surface generated outputs as artifacts
- avoid polluting a user project by default

## First things to try

1. Create a sandbox thread and ask the model to generate a report or a chart.
2. Open `Capabilities` and inspect built-in tools and skills.
3. Add a custom MCP from the UI.
4. Create a custom agent with a narrow tool set.

## Next

- [Configuration](configuration.md)
- [Desktop App Guide](desktop-app.md)
