# Roadmap

Last updated: 2026-05-08.

> **Status: forward-looking.** This document describes where Open Cowork is
> headed, not what it ships today. Nothing here is a commitment — items may be
> reshaped, deferred, or dropped as the product evolves. For the current
> feature set, see [Desktop App Guide](desktop-app.md) and
> [Architecture](architecture.md).
> Items called out in the pre-release audit but deliberately scoped out of
> v0.0.0 are kept here so readers can see they were considered, not missed.

## Summary

Open Cowork should stay a thin product harness on top of OpenCode.

Decisions locked:
- Roadmap shape: `3-phase buildout`
- Execution posture: `desktop-first` in phase 1
- Reuse posture: `reuse-first`

Architecture rule:
- OpenCode owns execution: agents, subagents, sessions, child sessions, permissions, approvals, compaction, MCP execution, streaming events.
- Open Cowork owns product composition: integration bundles, skills packaging, built-in/custom agents, narrow deterministic team policy, and the UI/state model.

Non-goals:
- Do not build a second runtime beside OpenCode.
- Do not mirror product execution state into fake OpenCode todos.
- Do not push large branch context back into root sessions.
- Do not build custom compaction logic when OpenCode-native `session.summarize()` and compaction hooks already exist.

## Phase 1 — Harden The Local Agent Team Product

Goal: make the desktop app reliably handle many concurrent threads and 10-way branch fanout with fast, correct UI.

### Platform shape
- Keep execution local and OpenCode-native.
- Make native OpenCode subagent/task delegation the default path.
- Keep Open Cowork deterministic team orchestration only for clearly explicit multi-branch work.
- Keep child session id as the canonical branch identity everywhere in the UI and reload path.

### Runtime and orchestration
- Reduce deterministic team mode to a thin wrapper around:
  - `session.create({ parentID })`
  - concurrent child `session.prompt/promptAsync`
  - `session.messages`, `session.children`, `session.status`, `session.todo`
  - helper-session synthesis
  - short root handoff
- Remove any remaining synthetic root-context inflation.
- Keep helper synthesis outside the real root session.
- Use OpenCode-native approvals with `ask` permissions for all side effects.
- Keep real OpenCode todos separate from Open Cowork `executionPlan`.

### UI and state
- Split state cleanly into:
  - session index
  - warm session detail cache
  - lazily hydrated child-session detail
- Make task cards collapsed by default, with ordered child text + tool calls on expand.
- Keep background threads lightweight and avoid full transcript hydration unless the user opens the thread or card.
- Make thread-switch reconciliation append-safe so stale history never overwrites newer live state.
- Keep optimistic busy state instant across multiple threads.
- Make all stream updates frame-batched and session-scoped.

### Acceptance bar
- 10 parallel subagents in one thread render correctly and finish cleanly.
- 20 active threads can stream simultaneously without status flicker or cross-thread corruption.
- No false task completion on thread switches.
- Root user messages never disappear during rehydrate.
- Parent threads always synthesize after child completion.
- Real todos render correctly; execution plan renders separately and consistently.

## Phase 2 — First-Class Team Workflows

Goal: move from “parallel subagents in chat” to “reusable teams that complete multi-step business work.”

### Team model
- Introduce first-class workflow plans for multi-step team jobs:
  - branch fanout
  - join/synthesis
  - approval gates
  - retries
  - failure states
- Add reusable team templates:
  - research team
  - meeting prep team
  - code audit team
  - reporting team
  - workspace delivery team
- Add branch summaries and artifact summaries without requiring full branch transcript loading.

### Artifact and execution model
- Add a durable artifact graph per root session:
  - docs
  - sheets
  - slides
  - email drafts
  - links
  - structured branch findings
- Add branch-level output contracts so synthesis uses structured findings first and prose second.
- Add optional child-session todos only when the child agent actually has `todowrite`.

### UX
- Add a unified team status surface:
  - root progress
  - branch progress
  - approvals pending
  - artifacts produced
- Add notifications for long-running team completion and approval waits.
- Add “open branch detail” on demand without eager hydration.

### Acceptance bar
- A multi-agent workflow can produce multiple real deliverables and preserve them in one root view.
- Branch failures and retries are explicit.
- Parent synthesis is artifact-aware, not transcript-only.
- Team templates can be reused across threads.

## Phase 3 — Company-Scale Agent Operations

Goal: evolve from a powerful desktop agent product into a durable system for many teams and many projects.

### Control plane
- Add durable background execution outside the foreground desktop window.
- Introduce a job/control plane for:
  - long-running tasks
  - retries
  - resumability
  - schedules
  - triggers
- Keep OpenCode as the execution runtime for actual sessions; Open Cowork adds orchestration and operations around it.

### Org and governance
- Add workspace-level integrations and agent definitions.
- Add role-based access control for integrations, agents, and side effects.
- Add budgets and guardrails for token/cost usage.
- Add auditable logs for:
  - who launched what
  - what approvals were granted
  - which external systems were changed

### Observability and quality
- Add operator views for:
  - active teams
  - stuck teams
  - branch error rates
  - approval bottlenecks
  - MCP health
  - cost and token usage by agent and workflow
- Add an evaluation suite for:
  - routing
  - delegation
  - approval behavior
  - branch synthesis quality
  - compaction continuity
  - multi-thread concurrency

### Acceptance bar
- 100+ active teams can exist across projects without the foreground UI needing full detail for all of them.
- Background execution survives app restarts.
- Admin/operator views can identify stuck or costly workflows quickly.
- Quality regressions are caught by automated evals before release.

## Reuse Strategy

### Reuse directly from OpenCode
- Agent config and permission model: `config.agent`, `permission.task`, `ask/allow/deny`
- Native session tree: root sessions, child sessions, `session.children`
- Native lifecycle: `promptAsync`, `messages`, `status`, `todo`, `summarize`
- Native compaction and compaction hooks
- Native event vocabulary: session, todo, permission, tool, compaction events

### Reuse from the OpenCode repo as implementation patterns
- Server projector pattern from `packages/opencode/src/server/projectors.ts`
- Desktop/client-server app structure from the OpenCode desktop app and README
- Shared UI package and desktop package as references for:
  - event projection patterns
  - theme primitives
  - virtualization/performance patterns
  - desktop shell behavior

### Do not directly adopt unless justified
- Do not import OpenCode UI packages directly into Open Cowork by default.
- Reason: OpenCode’s UI stack is Solid/Tauri-oriented, while Open Cowork is React/Electron.
- Treat `@opencode-ai/ui`, `packages/desktop`, and `packages/web` as reference implementations first, not drop-in dependencies.

## Test and Validation Plan

### Phase 1 test harness
- Stress harness for:
  - 20 active threads
  - 10 concurrent branches in one root thread
  - repeated fast thread switching
- Assertions:
  - ordered child transcript/tool rendering
  - no phantom completion
  - no missing root messages
  - no parent hang after child completion
  - stable busy indicators
- Performance targets:
  - thread switch feels immediate
  - event updates are frame-batched
  - background threads do not force full detail hydration

### Phase 2 tests
- workflow retries and failure joins
- artifact preservation
- approval gates
- template execution consistency

### Phase 3 tests
- background resumability
- scheduling/trigger execution
- cost governance
- org-level auth/policy coverage

## Assumptions

- Phase 1 stays desktop-first and single-user.
- OpenCode remains the only execution runtime.
- Deterministic team orchestration stays narrow and explicit, not the default for every request.
- Real OpenCode todos remain session-native state; Open Cowork `executionPlan` remains product UI state.
- Reuse-first means we prefer OpenCode-native APIs, event shapes, and patterns before building new Open Cowork abstractions.

## Deferred Work And Follow-Ups

These are gaps and follow-ups called out in pre-release audits. Some
items from the original v0.0.0 list have since landed; this section
keeps the remaining work explicit so readers can distinguish current
product behavior from planned hardening.

### Accessibility (a11y)

Current state:

- CI runs the dedicated accessibility lint gate with
  `pnpm lint:a11y --max-warnings=0`.
- The main interactive surfaces now have focused keyboard, label, and
  role coverage in component tests where regressions were found.

Remaining work:

- Runtime accessibility checks with an axe-style test pass on the
  primary screens.
- Full focus-trap + focus-restore coverage for every modal and drawer.
- More `aria-live` coverage for streaming chat growth, long-running
  background work, and MCP status changes.
- Per-theme WCAG AA contrast validation, especially for light themes.

### Internationalization (i18n)

Current state:

- The renderer has a catalog-backed i18n runtime with built-in
  catalogs, downstream `config.i18n.strings` overrides, and a
  user-selectable Settings language.
- `config.i18n.locale` controls cached `Intl.NumberFormat`,
  `Intl.DateTimeFormat`, and currency formatting.
- Arabic is marked RTL and the runtime updates `document.lang` and
  `document.dir` when the active locale changes.

Remaining work:

- Continue migrating any newly introduced hardcoded UI strings to
  catalog keys.
- Add automated catalog completeness and placeholder-parity checks.
- Add RTL layout screenshots or smoke coverage for the highest-risk
  screens.

### In-app update discovery

Current state:

- Settings includes a read-only "Check for updates" control.
- The main process queries the configured GitHub Releases endpoint,
  reports the current/latest versions, and opens release notes when a
  newer release exists.
- This deliberately avoids auto-download and self-install for unsigned
  preview builds.

Remaining work:

- Add signed in-app update installation once macOS signing and
  notarization are available. Track this in issue
  [#40](https://github.com/joe-broadhead/open-cowork/issues/40).
- Keep manual release links as the fallback for unsigned, dev, and
  unsupported platform builds.

### Uninstall cleanup

Current state:

- Settings includes "Reset all app data" behind the shared
  destructive-confirmation flow.
- The reset path wipes app-owned sessions, credentials, custom
  content, chart artifacts, logs, and sandbox state, then relaunches
  into first-run setup.

Remaining work:

- Add a release/manual QA checklist item for verifying reset behavior
  in a packaged build before public tags.
- Keep downstream cleanup docs aligned with any future app-owned paths.

### Structured logging
Logs are plain text today (`[ISO timestamp] [category] message`).
Enterprise SIEM integration (Splunk, ELK, Datadog) wants JSON Lines
with consistent field names. Intended landing: optional
`--log-format=json` flag on the Electron binary + a config setting
that flips the writer to NDJSON while keeping the human-readable
format as the default.

## Reference Inputs

- OpenCode agents docs: https://opencode.ai/docs/agents/
- OpenCode tools docs: https://opencode.ai/docs/tools/
- OpenCode server docs: https://opencode.ai/docs/server/
- OpenCode plugins docs: https://opencode.ai/docs/plugins/
- OpenCode config docs: https://opencode.ai/docs/config/
- OpenCode repo README: https://github.com/anomalyco/opencode/blob/dev/README.md
- OpenCode repo packages: `packages/ui`, `packages/desktop`, `packages/web`, `packages/opencode/src/server/projectors.ts`
