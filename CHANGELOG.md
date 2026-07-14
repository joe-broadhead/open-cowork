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
- Focused runtime accessibility smoke tests for login, approval cards, and the
  settings shell.
- Bundled `clock` MCP and `clock` skill for timezone-aware date, duration,
  calendar, and current-time reasoning.
- Custom MCP trace-label configuration so downstream builds and user-added
  tools can control chat timeline summaries without hardcoded tool-name rules.
- Optional detached `SHA256SUMS.txt.asc` checksum signatures for tagged
  releases when a release GPG key is configured.
- Configurable update release sources for downstream signed macOS builds,
  including public GitHub Releases, generic HTTPS feeds, and private GCS feeds
  authenticated through Google OAuth or a signed-URL broker.

### Changed

- Upgraded the bundled OpenCode SDK and embedded runtime to `1.17.20`.
- Updated CI/development to Node `22.23.1` and production container images to
  the Node `24.18.0` LTS line; Docker dependency automation now requires
  deliberate review before crossing Node major versions.
- Moved all OpenCode capabilities covered by the native V2 SDK onto
  `client.v2`, including global event streaming, provider/model discovery,
  credential connection, session lifecycle, questions, and permissions. The
  few upstream V2 capability gaps now have an exact source-and-count allowlist
  plus a documented removal path.
- Refreshed the bundled OpenWiki and opencode-gateway skills and contract
  fixtures against their July 2026 upstream interfaces. OpenWiki ingestion now
  follows proposal/approval semantics and gateway execution uses a scoped
  operator token instead of an administrator credential.
- Hardened the production GCP reference around private Cloud SQL connectivity,
  IAM database authentication, role-specific probes, explicit high
  availability, least-privilege secret access, and Cloud SQL Auth Proxy
  `2.23.0` across Terraform and Helm deployments.
- Reduced the fresh browser startup graph from 219.7 KB to 204.0 KB gzipped by
  moving setup authentication, diff inspection, home review, telemetry, and
  studio-only UI behind explicit lazy boundaries. The 220 KB budget now has a
  measured 16 KB safety margin and guards those boundaries in CI.
- Simplified the product surface around Chat, Team, Tools & Skills, Projects,
  and Playbooks so Open Cowork stays a product layer on top of OpenCode rather
  than a second runtime or team-operations platform.
- CI now runs unpackaged Electron e2e tests on Linux, reports all failed smoke
  files in one pass, pins artifact retention to 14 days, and raises the
  renderer branch-coverage gate to 58%.
- Renamed the user-facing capability catalog to Tools & Skills across product
  docs while keeping `capabilities` as the internal route/module name.
- Runtime config diagnostics are emitted by the runtime orchestration wrapper
  instead of being logged inside the config-building calculation path.
- Custom MCP and custom skill form tests now cover invalid input, linked-skill
  persistence, trusted-tool save paths, and save-error surfacing.

### Security

- Workflow webhook trigger URLs no longer embed secrets. Local webhook requests
  now require a bearer/header secret or timestamped HMAC signature, with replay
  bounds and constant-time comparison. Workflows copied before the auth-format
  change must be recopied; old secret-bearing URLs now return 401. Supported
  auth is `Authorization: Bearer`, `x-open-cowork-webhook-secret`, or
  timestamped HMAC.
- Workflow webhooks now rate-limit repeated local auth failures, reject replayed
  HMAC signatures, and log structured rejection diagnostics.
- Packaged builds reject localhost HTTP update feeds; localhost update feeds
  remain available only for development.
- Release policy now requires a configured checksum-signing key for Linux
  releases at `v1.0.0` and later.
- Private update release source credentials stay in the main process; renderer
  IPC receives only safe source labels/status, and signed URL query strings are
  redacted from logs and diagnostics.
- Channel interaction approvals are scoped to the chat the request was sent to,
  so an approve-capable member in a different chat can no longer approve using a
  leaked token (previously token possession plus role was sufficient).
- Desktop E2E test hooks can no longer be enabled from command-line arguments
  alone; remote debugging and config/data-dir overrides now require a real
  environment marker that argv cannot forge.
- Cloud token hashing (API tokens, channel-interaction, SCIM, worker
  credentials) runs off the event loop, and cloud secret envelopes without a key
  id fail closed instead of being trial-decrypted against the key ring.
- Signed-out browser clients now bootstrap only public configuration and defer
  protected settings until authentication completes; unrelated API failures no
  longer masquerade as expired sessions.
- Desktop permission replies validate the requesting session and use native V2
  response semantics. File snippets resolve real paths inside the workspace,
  chart data URLs/spec sizes are bounded, and external links open without an
  opener relationship.
- Gateway-managed external execution is disabled unless an explicit
  capability-scoped operator token file is configured; administrator token
  material is no longer propagated to the managed runtime.

### Fixed

- Fixed workflow webhook copy behavior so the UI copies an authenticated `curl`
  command instead of exposing a secret-bearing URL.
- Fixed stale docs that still described removed Pulse, crew, governance,
  improvement, and operations-queue surfaces as active product features.
- Bundled MCP command resolution on Windows now uses the platform PATH
  delimiter and PATHEXT instead of assuming a POSIX `:` separator.
- Bounded the session-status reconciler polling, session lineage tracking, and
  the cloud projection view cache so long-running sessions cannot grow them
  without limit.
- Fixed workflow archive/restore controls, exact run-to-session navigation,
  scheduler startup races, notification quiet hours, and failure isolation so
  a delegated child failure cannot incorrectly terminalize its parent run.
- Fixed post-login initialization and Health Center error handling so protected
  settings are loaded before entering the app and partial service outages stay
  visible instead of being reported as healthy empty results.
- Improved keyboard and screen-reader behavior across the application shell,
  command palette, avatar editor, new-thread dialog, and delegated-task drill-in
  overlays, including stacked Escape handling and focus restoration.
- Update discovery now selects platform-correct artifacts and rejects release
  payloads that do not satisfy the current update schema.
- Bounded renderer test concurrency to four workers so jsdom, axe, and
  user-event suites remain deterministic under host CPU pressure.

### Removed

- Removed the legacy cloud `/healthz` alias. Deployments must use `/livez` for
  process liveness and `/readyz` for dependency readiness.
- Removed the legacy `closed` cloud signup-mode alias. Deployments must use
  `disabled`; invalid signup modes now fail configuration instead of silently
  falling back.
- Removed deprecated gateway cloud/timeout configuration, the obsolete update
  schema-v1 install marker, old thread-index schema alteration paths, fabricated
  workflow-step summaries, a dead cross-tenant session-listing API, and the
  classic provider payload normalizer superseded by native V2 discovery.
- Rebased the pre-release cloud and standalone-gateway databases onto clean
  schema baselines. Historical compatibility DDL, data backfills, purge steps,
  trigger replacements, and retired-index cleanup are no longer shipped; the
  remaining two-phase cloud bootstrap separates transactional DDL from the
  PostgreSQL-required concurrent-index phase. Only empty databases initialize a
  missing clean-baseline ledger entry. If product tables already exist without
  that entry, startup fails before schema mutation or stamping and operators
  must recreate the pre-release database or restore a matching backup. Current
  ledger-backed databases boot only after required production tables and Cloud
  concurrent indexes pass physical integrity checks; an interrupted current
  concurrent-index phase remains safely repairable under the migration lock.
- Removed implicit local preview-store upgrades for settings, thread indexing,
  workflows, coordination, artifact lifecycle/index metadata, and knowledge.
  Empty stores create the current clean baseline; non-empty stores must declare
  the exact current version and pass physical table/column/index validation or
  fail before any DDL/version write with scoped backup/export and reset guidance.
- Removed dormant product-surface references to Pulse, governance, and
  autonomous dreaming/improvement loops from current release notes. Channels and
  Team ship as default-enabled Studio surfaces and were not removed. The active
  `v0.x` product spans Chat, Projects, Knowledge, Approvals, Team, Playbooks,
  Channels, Tools & Skills, and Artifacts.
- Removed back-compat shims and dead code: the `enableBash`/`enableFileWrite`
  boolean settings (superseded by the permission enums), renamed-view route
  aliases, the `providerInstanceId` channel-message field, and several unused
  modules and legacy decode/migration paths.

## [0.0.0] - 2026-04-28

### Added

- Welcoming Home landing surface — brand mark, greeting ("What shall we cowork on today?"), composer with drag-and-drop + paste-to-attach file handling, agent suggestion pills, recent-thread cards, and a compact status strip. Typing and hitting Send creates a session, activates it, navigates to chat, and fires the first prompt in one motion.
- CycloneDX + SPDX SBOM generation wired into the release workflow; `sbom.cdx.json` and `sbom.spdx.json` are attached to every tagged release alongside `SHA256SUMS.txt` and the SLSA provenance attestation.
- `docs/security-model.md` documents data-at-rest, MCP sandbox boundaries, CSP rationale (including why the chart iframe needs `unsafe-eval`), and supply-chain posture.
- `docs/versioning.md` covers semver rules, release cadence, RC flow, breaking-change definition, and downstream support policy.
- `docs/assets/README.md` documents the capture process for README screenshots and the language-switch demo GIF.
- Hot-path unit tests for `session-view-model.ts` (timeline derivation, LRU prune, compaction-notice flow, streaming merge) and `session-engine.ts` (LRU cap, view-cache identity, busy invalidation).
- Customization-flow smoke tests: `settings-round-trip`, `custom-mcp-add` (incl. SSRF-guard coverage), and `large-history-replay` seeding 60 sessions to exercise the sidebar virtualizer.
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
- Added a pnpm override forcing transitive `hono` to `>=4.12.25` (GHSA-458j-xx4x-4375). The JSX-SSR injection path is not exercised by our renderer — `@modelcontextprotocol/sdk` uses `@hono/node-server` only — but the override removes the advisory from `pnpm audit`.

### Fixed

- Composer focus ring on Home no longer bleeds the theme accent through the wrapper border. Added a `data-no-focus-ring` opt-out for surfaces that own their own focus affordance (`globals.css`); the global `*:focus-visible` accent outline still applies everywhere else.
- Multiple packaged-app launch and window visibility regressions on macOS.
- Packaged chart rendering regressions related to CSP and Mermaid loading.
- Streaming prompt-echo issues where user text appeared at the start of assistant responses.
- Sandbox thread behavior that previously wrote files into runtime app directories instead of Cowork-managed sandboxes.
- Homepage usage/cost summary wiring that only became correct after visiting individual threads.
