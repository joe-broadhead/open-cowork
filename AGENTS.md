# Open Cowork Repository

This file is for coding contributors and local coding agents working in the Open Cowork repository.

## First principle

Open Cowork is a **product layer on top of OpenCode**, not a second runtime.

Preserve this split:
- **OpenCode owns execution**: sessions, child sessions, MCP execution,
  approvals, questions, agent runtime behavior, streaming events, tool
  semantics, native skills.
- **Open Cowork owns composition**: desktop UI, packaging, branding,
  configuration, capability curation, event projection, workflow control plane, and user-facing ergonomics.

If a change starts to mirror or replace OpenCode runtime behavior rather than compose it, stop and simplify first.

## Scope and sources of truth

- Product runtime behavior lives in
  [apps/desktop/runtime-config/AGENTS.md](apps/desktop/runtime-config/AGENTS.md).
- Built-in agent policy lives in
  [packages/runtime-host/src/agent-config.ts](packages/runtime-host/src/agent-config.ts).
- Architecture and ownership boundaries live in
  [docs/architecture.md](docs/architecture.md).
- Workflow product behavior lives in
  [docs/workflows.md](docs/workflows.md) plus the durable `workflow-*` control-plane files in `apps/desktop/src/main/`.

Do not duplicate product agent behavior across multiple prompt files when code or generated prompts are the real source of truth.

## Where concepts live

Start changes in the layer that owns the concept.

### Runtime composition

Use these files when the change is about the OpenCode runtime boundary:
- `packages/runtime-host/src/runtime.ts`
- `packages/runtime-host/src/runtime-config-builder.ts`
- `packages/runtime-host/src/runtime-mcp.ts`
- `packages/runtime-host/src/effective-skills.ts`
- `packages/runtime-host/src/agent-config.ts`

Rules:
- Prefer SDK-native config surfaces over app-side reinvention.
- Treat custom agents as OpenCode-native agents generated into runtime config.
- Keep managed skill/MCP discovery app-owned and deterministic.

### Event projection and session replay

Use these files when the change is about chat state, subagents, replay, or
hydration:
- `apps/desktop/src/main/event-runtime-handlers.ts`
- `apps/desktop/src/main/event-message-handlers.ts`
- `apps/desktop/src/main/event-task-state.ts`
- `packages/runtime-host/src/session-engine.ts`
- `packages/runtime-host/src/session-history-loader.ts`
- `packages/runtime-host/src/session-history-projector.ts`
- `packages/shared/src/session-view-model.ts`

Rules:
- Preserve the separation between parent-session UI and delegated child-session task runs.
- Preserve reopen parity: approvals, questions, task state, and timing must survive reload/history hydration.
- Do not introduce fuzzy or suffix-based session-id matching.

### Workflow control plane

Workflows are a durable product layer wrapped around OpenCode-native
execution.

Primary files:
- `packages/runtime-host/src/workflow/workflow-store.ts`
- `apps/desktop/src/main/workflow/workflow-service.ts`
- `packages/runtime-host/src/workflow/workflow-tool-actions.ts`
- `packages/shared/src/node/workflow-webhook-server.ts`
- `mcps/workflows/src/index.ts`
- `packages/app/src/components/workflows/`

Rules:
- Workflow setup is thread-based: the Workflow Designer agent clarifies the task, then creates the saved workflow through the Workflows MCP.
- Keep saved workflow execution simple and OpenCode-native: create a run thread, prompt the selected agent, and project the result back into workflow state.
- Keep workflow state durable and transactional; do not turn it into a thin wrapper around transient chat UI state.

### Renderer and navigation

Primary files:
- `packages/app/src/App.tsx`
- `packages/app/src/components/`
- `packages/app/src/stores/`

Rules:
- Keep navigation state app-owned, not trapped inside a leaf component.
- Prefer lazy loading and fast surface transitions.
- When changing nav wiring, update or extend `apps/desktop/tests/navigation-wiring.smoke.test.ts`.

## Editing guidance

- Prefer changing runtime behavior in code and generated agent config rather
  than patching prompts alone.
- Keep the runtime prompt high-level and stable; keep exact orchestration rules
  centralized in code.
- Prefer MCP tools over shell behavior when a target system already has an MCP.
- Keep product-layer policy explicit and typed where possible.
- Add the narrowest test that proves the behavior you changed.

## Documentation and naming conventions

This repo is now the public `open-cowork` repo. Use that form in:
- docs
- README
- repo metadata
- GitHub links

Keep the historical `opencowork` form only where it is intentionally required
for back-compat, such as:
- bundle id / app id
- on-disk project namespace
- legacy migration notes

### Product language (user-facing)

Prefer product names in UI copy, docs, and PR titles. Keep code identifiers
when they are the real API surface.

| Prefer (product) | Avoid in user-facing copy | Code / internal OK |
| --- | --- | --- |
| **Projects** | Threads page / Threads workspace | `threads:search`, `thread-index`, route ids |
| **Team** / **coworker** | Agents page as the nav label | `agents` package paths, OpenCode agent ids |
| **Playbooks** | Workflows page as the nav label | `workflows` store/MCP, `workflow-*` files |
| **Tools & Skills** | Capabilities as the only label | `capabilities` routes/components |
| **Chat**, **Knowledge**, **Approvals**, **Channels**, **Artifacts** | Inventing alternate studio names | feature flags under `DesktopFeatureKey` |

Canonical UI surface list: [Desktop App Guide](docs/desktop-app.md). Glossary:
[docs/glossary.md](docs/glossary.md). Icon inventory: [docs/iconography.md](docs/iconography.md).

### Design-system adoption map

| Layer | Status | Where |
| --- | --- | --- |
| Tokens + CSS variables | **Adopted** | `packages/shared` design tokens → generated CSS; see [docs/design-system.md](docs/design-system.md) |
| Core primitives (`Button`, `Input`, `Select`, `Dialog`, `Icon`, …) | **Adopted** for new work | `@open-cowork/ui` (`packages/ui`) |
| Studio primitives (shell, coworker cards, lanes, wiki, channels, …) | **Partial** | Prefer `packages/ui` Studio exports; some renderer surfaces still half-adopted (see JOE-854) |
| Setup / Agent builder / Custom MCP forms | **Partial** | Migrate raw `<button>`/`<input>` to design-system controls (JOE-848, JOE-894) |
| `globals.css` / large surface CSS | **In progress** | Split and token-ratchet work (JOE-851); do not add new raw palette or ad-hoc type scales |

Rules for agents changing UI:
- Import from `@open-cowork/ui`; do not grow a private `components/ui` barrel.
- New chrome/nav icons go through `Icon` / `IconButton` and `docs/iconography.md`.
- Do not reintroduce demo-era copy (gated by `tests/product-language.test.ts`).

If you change a user-visible product surface, update the relevant docs:
- `README.md`
- `docs/index.md`
- `docs/getting-started.md`
- `docs/desktop-app.md`
- `docs/projects.md` (Projects history surface; formerly `threads.md`)
- `docs/workflows.md`
- `docs/architecture.md`
- `docs/iconography.md`
- `docs/glossary.md`
- `docs/release-checklist.md`

## Validation expectations

For meaningful changes, run the smallest relevant subset first, then the full repo checks before release-sensitive commits.

Common commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:gateway   # Durable Gateway (cowork-gateway); not included in root `pnpm test`
pnpm test:e2e
pnpm test:e2e:evals # Monthly UI journeys (admin/approvals/charts); needs display or xvfb
pnpm docs:build
git diff --check
```

Use extra targeted checks when relevant:
- `pnpm perf:check` for renderer/runtime performance-sensitive changes
- `pnpm audit:prod` / `pnpm audit:full` for dependency/security work
- `pnpm --dir apps/desktop dist:ci` for packaging / release-path changes
- Monthly UI evals: `.github/workflows/monthly-evals.yml` (cron + workflow_dispatch). Not a required release check; consecutive failures open a GitHub issue (`scripts/monthly-eval-failure-alert.mjs`). Operator notes: `docs/packaging-and-releases.md` → Monthly UI eval flows.

## Branch and repo conventions

- The default branch is `master`.
- The canonical public remote is `origin` -> `joe-broadhead/open-cowork`.
- Pull request titles should be plain, descriptive change titles. Do not add
  actor/tool prefixes such as `[codex]`.

## Anti-patterns

Avoid these unless the change explicitly requires them:
- adding prompt-only behavior when code/config should own it
- inventing a parallel agent runtime beside OpenCode
- rebuilding durable workflow state out of ephemeral renderer state
- hardcoding local user paths, repo paths, or machine-specific assumptions
- silently changing repo/public naming back toward `opencowork` outside
  back-compat boundaries
