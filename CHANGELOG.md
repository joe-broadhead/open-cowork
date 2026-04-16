# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Public project documentation with MkDocs configuration and detailed docs pages for getting started, configuration, architecture, desktop behavior, packaging, releases, and contribution workflow.
- Contributor-facing governance files including issue templates, a pull request template, `SECURITY.md`, and `SUPPORT.md`.
- Automated GitHub Actions workflows for CI validation, docs deployment, and tagged macOS/Linux release builds.
- History-backed home dashboard summaries with time-range filtering.
- Sandbox artifact storage management and artifact-first UI actions.
- Broader chart support including Mermaid rendering, zoom controls, and additional chart MCP tools.
- Runtime/client cache, token refresh, CSP, window lifecycle, and dashboard summary helper modules with direct tests.

### Changed

- Refactored the Electron main process into smaller modules for IPC registration, runtime composition, event handling, and startup lifecycle management.
- Refactored large renderer components like `ChatInput`, `SessionInspector`, `ToolTrace`, and `CommandPalette` into smaller testable seams.
- Moved fully onto the OpenCode v2 SDK surface.
- Tightened Cowork-managed MCP, skill, and agent boundaries so the app exposes Cowork-configured capabilities instead of inheriting unrelated local tool/skill catalogs.
- Improved packaged app startup by showing a lightweight startup shell before handing off to the full renderer and runtime boot.
- Hardened runtime permissions, destructive action confirmations, config validation, and artifact handling.

### Fixed

- Multiple packaged-app launch and window visibility regressions on macOS.
- Packaged chart rendering regressions related to CSP and Mermaid loading.
- Streaming prompt-echo issues where user text appeared at the start of assistant responses.
- Sandbox thread behavior that previously wrote files into runtime app directories instead of Cowork-managed sandboxes.
- Homepage usage/cost summary wiring that only became correct after visiting individual threads.
