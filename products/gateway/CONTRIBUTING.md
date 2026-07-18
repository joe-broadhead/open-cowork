# Contributing To OpenCode Gateway

Thanks for investing time in OpenCode Gateway. This guide describes the local workflow, product boundaries, and release expectations for high-quality changes.

## Scope

Good contributions include:

- Durable scheduler, task, roadmap, run, and channel state improvements.
- Gateway MCP tool improvements.
- OpenCode asset installation and profile-management improvements.
- Dashboard, observability, diagnostics, and documentation improvements.
- Tests that catch real product regressions.

Open an issue first for large behavior or architecture changes.

## Development Setup

```bash
git clone https://github.com/joe-broadhead/opencode-gateway.git
cd opencode-gateway
npm install
npm run verify
```

## Common Commands

```bash
npm run dev       # Run daemon in foreground through tsx
npm test          # Run Vitest suite
npm run build     # Compile TypeScript
npm run typecheck # Type check only
npm run verify    # Typecheck, tests, build, release contract
```

## Docs Preview

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
mkdocs serve
```

## Source Layout

| Path | Purpose |
| --- | --- |
| `src/daemon.ts` | Runtime wiring: OpenCode client, channels, dashboard, live view, route dispatch. |
| `src/daemon-router.ts` | Shared route dispatcher, JSON/body helpers, typed HTTP errors. |
| `src/daemon-routes/` | Explicit JSON route modules. |
| `src/scheduler.ts` | Durable scheduler over SQLite tasks/runs. |
| `src/work-store.ts` | SQLite roadmaps, tasks, runs, events, channel bindings. |
| `src/workflow.ts` | Stage prompt, result parsing, lifecycle decisions. |
| `src/channel-commands.ts` | Telegram/WhatsApp command surface. |
| `src/channel-sync.ts` | OpenCode session to channel delivery checkpoints. |
| `src/channel-sessions.ts` | SQLite-backed channel binding helpers. |
| `src/channels/` | Telegram and WhatsApp adapters. |
| `src/opencode-assets.ts` | OpenCode config asset CRUD. |
| `src/opencode-defaults.ts` | Shipped Gateway agents, skills, and MCP defaults. |
| `src/opencode-requests.ts` | OpenCode-native question/permission bridge. |
| `src/opencode-web.ts` | OpenCode Web URL helpers. |
| `src/dashboard.ts` | Local HTML dashboard. |
| `src/mission-data.ts` | Dashboard data aggregation. |
| `src/observability.ts` | Gateway execution traces under config dir. |
| `src/heartbeat.ts` | Scheduler heartbeat. |
| `src/routing.ts` | Channel/user message to agent routing. |
| `src/config.ts` | Gateway config and scheduler profiles. |
| `src/cli.ts` | CLI commands. |
| `src/cli-setup.ts` | Interactive setup wizard. |
| `src/mcp.ts` | Gateway MCP proxy. |
| `src/__tests__/` | Vitest suite. |

## Product Boundaries

- OpenCode owns sessions, agents, skills, MCPs, tools, permissions, questions, model execution, and UI.
- Gateway owns durable scheduling, routing/channel sync, SQLite state, dashboard, observability, and deterministic MCP control tools.
- Do not add a second agent runtime or persona layer inside Gateway.
- Do not create a parallel permission/question system.
- Do not make markdown files a source of execution truth; durable work state belongs in `gateway.db`.
- Do not ship optional downstream MCPs or skills as base Gateway assets.

## Pull Request Checklist

- Tests pass with `npm run verify`.
- Docs are updated for user-facing changes.
- `mkdocs build --strict` passes when docs change.
- `CHANGELOG.md` is updated for behavior, API, or product-surface changes.
- No new direct worker-spawn routes or MCP tools.
- No service files or docs embed secrets.

## Release

```bash
npm version patch  # or minor | major
git push --follow-tags
```

CI runs `npm run verify`, builds the Docker image, and creates GitHub releases for version tags.
