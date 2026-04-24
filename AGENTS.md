# Open Cowork Repository

This file is for coding contributors and local coding agents working in the
Open Cowork repository.

## First principle

Open Cowork is a **product layer on top of OpenCode**, not a second runtime.

Preserve this split:
- **OpenCode owns execution**: sessions, child sessions, MCP execution,
  approvals, questions, agent runtime behavior, streaming events, tool
  semantics, native skills.
- **Open Cowork owns composition**: desktop UI, packaging, branding,
  configuration, capability curation, event projection, automation control
  plane, and user-facing ergonomics.

If a change starts to mirror or replace OpenCode runtime behavior rather than
compose it, stop and simplify first.

## Scope and sources of truth

- Product runtime behavior lives in
  [apps/desktop/runtime-config/AGENTS.md](apps/desktop/runtime-config/AGENTS.md).
- Built-in agent policy lives in
  [apps/desktop/src/main/agent-config.ts](apps/desktop/src/main/agent-config.ts).
- Architecture and ownership boundaries live in
  [docs/architecture.md](docs/architecture.md).
- Automation product behavior lives in
  [docs/automations.md](docs/automations.md) plus the `automation-*` files in
  `apps/desktop/src/main/`.

Do not duplicate product agent behavior across multiple prompt files when code
or generated prompts are the real source of truth.

## Where concepts live

Start changes in the layer that owns the concept.

### Runtime composition

Use these files when the change is about the OpenCode runtime boundary:
- `apps/desktop/src/main/runtime.ts`
- `apps/desktop/src/main/runtime-config-builder.ts`
- `apps/desktop/src/main/runtime-mcp.ts`
- `apps/desktop/src/main/effective-skills.ts`
- `apps/desktop/src/main/agent-config.ts`

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
- `apps/desktop/src/main/session-engine.ts`
- `apps/desktop/src/main/session-history-loader.ts`
- `apps/desktop/src/main/session-history-projector.ts`
- `apps/desktop/src/lib/session-view-model.ts`

Rules:
- Preserve the separation between parent-session UI and delegated child-session
  task runs.
- Preserve reopen parity: approvals, questions, task state, and timing must
  survive reload/history hydration.
- Do not introduce fuzzy or suffix-based session-id matching.

### Automation control plane

Automations are a durable product layer wrapped around OpenCode-native
execution.

Primary files:
- `apps/desktop/src/main/automation-store.ts`
- `apps/desktop/src/main/automation-service.ts`
- `apps/desktop/src/main/automation-prompts.ts`
- `apps/desktop/src/main/automation-prompt-contract.ts`
- `apps/desktop/src/main/automation-run-output.ts`
- `apps/desktop/src/renderer/components/automations/`

Rules:
- Keep `plan` for enrichment and `build` for execution unless there is a very
  strong reason not to.
- Use SDK structured output for automation enrichment / heartbeat decisions
  instead of relying on free-form assistant text.
- Keep automation state durable and transactional; do not turn it into a thin
  wrapper around transient chat UI state.

### Renderer and navigation

Primary files:
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/components/`
- `apps/desktop/src/renderer/stores/`

Rules:
- Keep navigation state app-owned, not trapped inside a leaf component.
- Prefer lazy loading and fast surface transitions.
- When changing nav wiring, update or extend
  `apps/desktop/tests/navigation-wiring.smoke.test.ts`.

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

If you change a user-visible product surface, update the relevant docs:
- `README.md`
- `docs/index.md`
- `docs/getting-started.md`
- `docs/desktop-app.md`
- `docs/automations.md`
- `docs/architecture.md`
- `docs/operations.md`
- `docs/release-checklist.md`

## Validation expectations

For meaningful changes, run the smallest relevant subset first, then the full
repo checks before release-sensitive commits.

Common commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
uv run mkdocs build --strict
git diff --check
```

Use extra targeted checks when relevant:
- `pnpm perf:check` for renderer/runtime performance-sensitive changes
- `pnpm audit --prod --audit-level high` for dependency/security work
- `pnpm --dir apps/desktop dist:ci` for packaging / release-path changes

## Branch and repo conventions

- The default branch is `master`.
- The canonical public remote is `origin` -> `joe-broadhead/open-cowork`.
- The old `opencowork` repo may still exist as a legacy remote; do not treat it
  as the public source of truth.

## Anti-patterns

Avoid these unless the change explicitly requires them:
- adding prompt-only behavior when code/config should own it
- inventing a parallel agent runtime beside OpenCode
- rebuilding durable automation state out of ephemeral renderer state
- hardcoding local user paths, repo paths, or machine-specific assumptions
- silently changing repo/public naming back toward `opencowork` outside
  back-compat boundaries
