# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/).

Open Cowork is in the `v0.x` public-preview line. Expect rapid iteration and
possible breaking changes before `v1.0.0`; signed macOS release support is
planned before broad distribution.

<!--
  When cutting a release, rename the [Unreleased] heading below to
  [X.Y.Z] - YYYY-MM-DD and add a fresh, empty [Unreleased] section
  above it with the Added / Changed / Fixed / Removed subheadings.
  Leave unused subheadings out of the released entry.
-->

## [Unreleased]

### Added

- Workflow Designer setup threads and the bundled `workflows` MCP for creating
  durable repeatable tasks from normal chat, then running them manually, on a
  schedule, or from a local webhook.
- Bundled `clock` MCP and `clock` skill for timezone-aware date, duration,
  calendar, and current-time reasoning.
- Custom MCP trace-label configuration so downstream builds and user-added
  tools can control chat timeline summaries without hardcoded tool-name rules.
- Optional detached `SHA256SUMS.txt.asc` checksum signatures for tagged
  releases when a release GPG key is configured.

### Changed

- Simplified the product surface around Chat, Agents, Tools & Skills, Threads,
  and Workflows so Open Cowork stays a product layer on top of OpenCode rather
  than a second runtime or team-operations platform.
- Renamed the user-facing capability catalog to Tools & Skills across product
  docs while keeping `capabilities` as the internal route/module name.
- Runtime config diagnostics are emitted by the runtime orchestration wrapper
  instead of being logged inside the config-building calculation path.
- Custom MCP and custom skill form tests now cover invalid input, linked-skill
  persistence, trusted-tool save paths, and save-error surfacing.

### Security

- Workflow webhook trigger URLs no longer embed secrets. Local webhook requests
  now require a bearer/header secret or timestamped HMAC signature, with replay
  bounds and constant-time comparison.
- Release policy now requires a configured checksum-signing key for Linux
  releases at `v1.0.0` and later.

### Fixed

- Fixed workflow webhook copy behavior so the UI copies an authenticated `curl`
  command instead of exposing a secret-bearing URL.
- Fixed stale docs that still described removed Pulse, crew, governance,
  improvement, and operations-queue surfaces as active product features.

### Removed

- Removed dormant product-surface references to Pulse, crews, channels,
  governance, autonomous dreaming/improvement loops, and operations queues from
  current release notes. The active `v0.x` product is Chat, Agents, Tools &
  Skills, Threads, and Workflows.

## [0.0.0] - 2026-04-28

### Added

- Welcoming Home landing surface — brand mark, greeting ("What shall we cowork on today?"), composer with drag-and-drop + paste-to-attach file handling, agent suggestion pills, recent-thread cards, and a compact status strip. Typing and hitting Send creates a session, activates it, navigates to chat, and fires the first prompt in one motion.
- CycloneDX + SPDX SBOM generation wired into the release workflow; `sbom.cdx.json` and `sbom.spdx.json` are attached to every tagged release alongside `SHA256SUMS.txt` and the SLSA provenance attestation.
- `docs/security-model.md` documents data-at-rest, MCP sandbox boundaries, CSP rationale (including why the chart iframe needs `unsafe-eval`), and supply-chain posture.
- `docs/versioning.md` covers semver rules, release cadence, RC flow, breaking-change definition, and downstream support policy.
- `docs/assets/README.md` documents the capture process for README screenshots and the language-switch demo GIF.
- Hot-path unit tests for `session-view-model.ts` (timeline derivation, LRU prune, compaction-notice flow, streaming merge), `session-engine.ts` (LRU cap, view-cache identity, busy invalidation), and `dashboard-summary.ts` (planner split, emit cadence).
- Customization-flow smoke tests: `settings-round-trip`, `custom-mcp-add` (incl. SSRF-guard coverage), and `large-history-replay` seeding 60 sessions to exercise the sidebar virtualizer.
- `planDashboardBackfill` and `shouldEmitBackfillProgress` helpers extracted from the dashboard orchestrator for unit-testable backfill planning.
- Public project documentation with MkDocs configuration and detailed docs pages for getting started, configuration, architecture, desktop behavior, packaging, releases, and contribution workflow.
- Contributor-facing governance files including issue templates, a pull request template, `SECURITY.md`, and `SUPPORT.md`.
- Automated GitHub Actions workflows for CI validation, docs deployment, and tagged macOS/Linux release builds.
- Sandbox artifact storage management and artifact-first UI actions.
- Broader chart support including Mermaid rendering, zoom controls, and additional chart MCP tools.
- Runtime/client cache, token refresh, CSP, and window lifecycle helper modules with direct tests.

### Changed

- Aligned MCP package versions (`@open-cowork/mcp-charts`, `@open-cowork/mcp-skills`) to `0.0.0` so the full monorepo agrees on one release line.
- Legacy "Welcome to {brand}" quick-start tiles are gone — the fallback render path in `ChatView` now returns `null` when there's no active session, and `App.tsx` bounces the view to Home so deleting the last thread lands on the welcoming surface instead of a dead screen.
- `pnpm lint:a11y` now runs in the main CI gate with `--max-warnings=0`; the two previously warn-only rules (`click-events-have-key-events`, `label-has-associated-control`) are promoted to errors.
- The chart-frame CSP policy has an inline comment block explaining the `unsafe-eval` requirement and the mitigations (sandbox attr, empty preload, `postMessage` origin/source checks, inline-spec validation, `connect-src 'none'`) that bound the blast radius.
- Refactored the Electron main process into smaller modules for IPC registration, runtime composition, event handling, and startup lifecycle management.
- Refactored large renderer components like `ChatInput`, `SessionInspector`, `ToolTrace`, and `CommandPalette` into smaller testable seams.
- Moved fully onto the OpenCode v2 SDK surface.
- Tightened Cowork-managed MCP, skill, and agent boundaries so the app exposes Cowork-configured capabilities instead of inheriting unrelated local tool/skill catalogs.
- Improved packaged app startup by showing a lightweight startup shell before handing off to the full renderer and runtime boot.
- Hardened runtime permissions, destructive action confirmations, config validation, and artifact handling.

### Security

- Bumped `dompurify` to `^3.4.0` to pick up the `ADD_TAGS` short-circuit fix (GHSA-39q2-94rc-95cp). Our config never passed the function form of `ADD_TAGS`, so the app was not exploitable, but the upgrade closes the advisory at the package level.
- Added a pnpm override forcing transitive `hono` to `>=4.12.14` (GHSA-458j-xx4x-4375). The JSX-SSR injection path is not exercised by our renderer — `@modelcontextprotocol/sdk` uses `@hono/node-server` only — but the override removes the advisory from `pnpm audit`.

### Fixed

- Composer focus ring on Home no longer bleeds the theme accent through the wrapper border. Added a `data-no-focus-ring` opt-out for surfaces that own their own focus affordance (`globals.css`); the global `*:focus-visible` accent outline still applies everywhere else.
- Multiple packaged-app launch and window visibility regressions on macOS.
- Packaged chart rendering regressions related to CSP and Mermaid loading.
- Streaming prompt-echo issues where user text appeared at the start of assistant responses.
- Sandbox thread behavior that previously wrote files into runtime app directories instead of Cowork-managed sandboxes.
- Homepage usage/cost summary wiring that only became correct after visiting individual threads.
