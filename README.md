# Open Cowork

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

## Install

Prebuilt binaries are published from GitHub Releases.

Current release targets:
- macOS: `.zip` and `.dmg`
- Linux: `.AppImage` and `.deb`

The repository currently produces unsigned release artifacts by default. For public distribution, downstream maintainers can add signing and notarization in their own release environment.

## Quick start

1. Download a release for your platform.
2. Launch `Open Cowork`.
3. Choose a provider and model on first run.
4. Start a:
   - `Project thread` for real repo/file work
   - `Sandbox thread` for private Cowork-managed work
5. Add MCPs, skills, or agents from the UI as needed.

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
