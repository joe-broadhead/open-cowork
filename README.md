# Open Cowork

[![CI](https://github.com/joe-broadhead/opencowork/actions/workflows/ci.yml/badge.svg)](https://github.com/joe-broadhead/opencowork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](.nvmrc)

Open Cowork is an Electron desktop workspace built on top of OpenCode.

OpenCode owns execution. Open Cowork owns product composition.

That split is the core idea of the project:
- OpenCode runs sessions, agents, tools, approvals, MCP calls, and event streaming.
- Open Cowork adds a desktop UI, configuration, packaging, artifact UX, and a user-friendly layer for MCPs, skills, and custom agents.

## What Open Cowork provides

- Desktop chat workspace for OpenCode sessions
- Built-in and user-added MCP support
- Built-in and user-added OpenCode skill bundles
- Built-in and user-added agents
- Project threads and private sandbox threads
- Artifact-first sandbox UX with storage management
- Config-driven branding, auth mode, providers, and default capabilities
- Packaged macOS and Linux desktop builds

## Project goals

Open Cowork is meant to be:
- a usable upstream product, not just a demo shell
- configurable enough for downstream internal distributions
- thin enough that OpenCode stays the execution runtime
- safe enough that sandbox work does not pollute user projects by default

## Supported platforms

- macOS 11+ (`arm64` + `x64`) — `.zip` and `.dmg` artifacts
- Linux `x64` — `.AppImage` and `.deb` artifacts
- Windows — not currently supported; contributions welcome

## Install

Prebuilt binaries are published from GitHub Releases.

> **Note:** Current releases are **unsigned**. macOS will warn
> "cannot verify developer" on first launch; see Apple's
> [Gatekeeper guidance](https://support.apple.com/HT202491) for how
> to open an unsigned build, or build locally. Downstream
> distributions are expected to add their own code signing and
> notarization in their release pipeline.

## Quick start

1. Download a release for your platform (or run from source — see *Local development* below).
2. Launch **Open Cowork**.
3. First-run setup wizard asks for a **provider + model**:
   - Get a free [OpenRouter API key](https://openrouter.ai/keys) — one key
     unlocks Claude Sonnet 4, GPT-5, Gemini 2.5, and every other major model.
   - Paste it into the setup dialog, pick a default model, and you're done.
   - Anthropic / OpenAI / Azure / Vertex etc. can be configured via
     [downstream configuration](docs/downstream.md) if you want to bring your
     own credentials instead of going through OpenRouter.
4. Start a thread:
   - **Project thread** — grounded in a real directory on disk
   - **Sandbox thread** — private Cowork-managed workspace
5. Type `@` in the composer to invoke a sub-agent directly, or let the
   primary orchestrator delegate. Add custom agents, MCPs, or skills from
   the **Agents** / **Capabilities** pages.

## Local development

Requirements:
- Node `>=22`
- pnpm `>=10`
- Python `>=3.11` for docs builds

Install dependencies:

```bash
pnpm install
```

Core validation:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm perf:check
```

Run the desktop app in development:

```bash
pnpm dev
```

Package desktop builds locally:

```bash
pnpm --dir apps/desktop dist:ci:mac
pnpm --dir apps/desktop dist:ci:linux
```

Build the documentation site locally:

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
```

## Documentation

Project docs live in [`docs/`](docs/) and are built with MkDocs.

Start here:
- [Getting Started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Downstream Customization](docs/downstream.md)
- [Desktop App Guide](docs/desktop-app.md)
- [Architecture](docs/architecture.md)
- [Packaging and Releases](docs/packaging-and-releases.md)
- [Release Checklist](docs/release-checklist.md)
- [Roadmap](docs/roadmap.md) — forward-looking, not a commitment
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Repository layout

- `apps/desktop` — Electron main process, preload bridge, renderer UI, packaging
- `packages/shared` — shared types, IPC contracts, and shortcuts
- `mcps/charts` — bundled charts MCP
- `mcps/skills` — bundled skill bundle MCP
- `skills` — bundled OpenCode skill bundles
- `docs` — MkDocs documentation source
- `tests` — repo-level Node test suite

## Release automation

The repo includes GitHub Actions for:
- CI validation
- documentation deployment
- tagged release builds for macOS and Linux artifacts

See [docs/packaging-and-releases.md](docs/packaging-and-releases.md) for the exact workflow model.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md).

## Support

See [SUPPORT.md](SUPPORT.md).

## License

[MIT](LICENSE)
