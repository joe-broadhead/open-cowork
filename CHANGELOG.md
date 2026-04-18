# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/).

<!--
  When cutting a release, rename the [Unreleased] heading below to
  [X.Y.Z] - YYYY-MM-DD and add a fresh, empty [Unreleased] section
  above it with the Added / Changed / Fixed / Removed subheadings.
  Leave unused subheadings out of the released entry.
-->

## [Unreleased]

### Added

- Welcoming Home landing surface — brand mark, greeting ("What shall we cowork on today?"), composer with drag-and-drop + paste-to-attach file handling, agent suggestion pills, recent-thread cards, and a status strip linking to Pulse. Typing and hitting Send creates a session, activates it, navigates to chat, and fires the first prompt in one motion.
- New **Pulse** section (sidebar + command palette) that hosts the diagnostic workspace dashboard that used to live on Home — runtime pills, MCP status, usage metrics, and perf stats.
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
- History-backed home dashboard summaries with time-range filtering.
- Sandbox artifact storage management and artifact-first UI actions.
- Broader chart support including Mermaid rendering, zoom controls, and additional chart MCP tools.
- Runtime/client cache, token refresh, CSP, window lifecycle, and dashboard summary helper modules with direct tests.

### Changed

- Aligned MCP package versions (`@cowork/mcp-charts`, `@cowork/mcp-skills`) to `0.1.0` so the full monorepo agrees on one release line.
- Home no longer opens on the diagnostic dashboard. The old dashboard moved to Pulse; Home is now composer-first.
- Legacy "Welcome to {brand}" quick-start tiles are gone — the fallback render path in `ChatView` now returns `null` when there's no active session, and `App.tsx` bounces the view to Home so deleting the last thread lands on the welcoming surface instead of a dead screen.
- `pnpm lint:a11y` now runs in the main CI gate with `--max-warnings=0`; the two previously warn-only rules (`click-events-have-key-events`, `label-has-associated-control`) are promoted to errors.
- The chart-frame CSP policy has an inline comment block explaining the `unsafe-eval` requirement and the mitigations (sandbox attr, empty preload, `postMessage` origin check, `VegaSpecSchema` validation, `connect-src 'none'`) that bound the blast radius.
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
