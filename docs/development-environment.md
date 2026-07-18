---
title: Development Environment
description: Local-only environment variables and test hooks for Open Cowork development.
---

# Development Environment

These variables are for local development, downstream packaging tests, and CI.
They are not required for normal users.

## Toolchain floor (JOE-913)

| Tool | Monorepo policy |
| --- | --- |
| **Node** | Floor `>=22.22.3` (`package.json` `engines.node`). Pin exact CI/dev with the repository-root `.nvmrc`. |
| **pnpm** | Exact `10.32.1` via Corepack (`packageManager` + `engines.pnpm`). No mixed majors. |
| **npm** | Disabled for workspace install (`engines.npm: "0"`). Use only for standalone tarball consumer smokes. |
| **Lockfile** | Single root `pnpm-lock.yaml`. No per-product `package-lock.json`. |

If Corepack reports a pnpm major mismatch, fix `packageManager` / invoke Corepack
pins — do not bypass with a global pnpm 11 for product packages.

## Renderer and app shell

| Variable | Purpose | Notes |
|---|---|---|
| `VITE_DEV_SERVER_URL` | Points Electron at the Vite dev server during `pnpm dev`. | Ignored in packaged builds before CSP, navigation, and IPC trust checks are configured. |
| `OPEN_COWORK_E2E` | Skips the single-instance lock for smoke tests. | Test-only. |
| `OPEN_COWORK_SCREENSHOT_EXECUTABLE` | App executable used by the screenshot script. | Local visual capture. |
| `OPEN_COWORK_PACKAGED_EXECUTABLE` | App executable used by packaged smoke tests. | CI and release validation. |
| `OPEN_COWORK_SMOKE_RETRIES` | Overrides smoke-test retry count. | Test-only. |

## Local data and config

| Variable | Purpose | Notes |
|---|---|---|
| `OPEN_COWORK_USER_DATA_DIR` | Overrides Electron `userData` for tests or isolated local runs. | Do not use for normal packaged installs. |
| `OPEN_COWORK_SANDBOX_DIR` | Overrides the sandbox workspace root. | Defaults to the app's standard sandbox path. |
| `OPEN_COWORK_CONFIG_PATH` | Loads one explicit config file. | Highest-priority config override. |
| `OPEN_COWORK_CONFIG_DIR` | Loads `config.json` or `open-cowork.config.json` from a directory. | Used by downstream builds and tests. |
| `OPEN_COWORK_DOWNSTREAM_ROOT` | Downstream root for config, bundled skills, and bundled MCPs. | See [Downstream Customization](downstream.md). |

## Runtime bridges

These are set by Open Cowork when it spawns bundled MCPs. They are documented so
developers can understand test fixtures, not so users can set them manually.

| Variable | Owner | Purpose |
|---|---|---|
| `OPEN_COWORK_CUSTOM_SKILLS_DIR` | Main process | App-managed custom skill directory for the `skills` MCP. |
| `OPEN_COWORK_AGENT_TOOL_URL` | Main process | Loopback bridge URL for the `agents` MCP. |
| `OPEN_COWORK_AGENT_TOOL_TOKEN` | Main process | Bearer token for the `agents` MCP bridge. |
| `OPEN_COWORK_WORKFLOW_TOOL_URL` | Main process | Loopback bridge URL for the `workflows` MCP. |
| `OPEN_COWORK_WORKFLOW_TOOL_TOKEN` | Main process | Bearer token for the `workflows` MCP bridge. |
| `OPEN_COWORK_MANAGED_RUNTIME` | Main process | Marker used to find and clean managed OpenCode subprocesses. |

## Diagnostics

| Variable | Purpose | Notes |
|---|---|---|
| `OPEN_COWORK_LOG_FORMAT=json` | Writes structured JSON log lines. | Default is readable text. |
| `OPEN_COWORK_CHART_TIMEOUT_MS` | Overrides main-process chart render timeout. | Clamped to `[250, 10000]` ms. |

## Documentation tooling

`pnpm docs:build` is self-contained for contributors. It creates or reuses
`.venv-docs/`, installs the pinned packages from `docs/requirements.txt`, and
checks the vendored Mermaid docs bundle before running `mkdocs build --strict`.
`pnpm docs:serve` uses the same virtual environment for local preview and the
same vendor check. Do not commit `.venv-docs/` or the generated `site/`
directory.

If Python is not on `PATH`, set `DOCS_PYTHON` to an explicit Python 3
executable before running either command.

## Release variables

Release-only variables are documented in
[Packaging and Releases](packaging-and-releases.md) and
[Release Checklist](release-checklist.md). Keep them in GitHub repository
variables or secrets, not in local shell profiles.

Desktop tags (`v*`) use `.github/workflows/release.yml` and do **not** publish
Gateway/Wiki by default. Product tags:

| Tag pattern | Workflow |
| --- | --- |
| `gateway@v*` / `gateway-v*` | `.github/workflows/release-gateway.yml` |
| `wiki@v*` / `wiki-v*` | `.github/workflows/release-wiki.yml` |

Manual dispatch is supported on both product release workflows.

## Development credential storage

Packaged builds require Electron `safeStorage` and refuse to persist credentials
when encryption is unavailable. In development only, Open Cowork may fall back
to owner-only plaintext files (`0600`) so contributors can run the app on
systems where `safeStorage` is unavailable. Do not treat a development data
directory as portable or shareable.
