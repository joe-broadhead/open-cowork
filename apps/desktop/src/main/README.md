# Main Process Source Map

The main process owns Electron lifecycle, runtime composition, IPC handlers,
durable desktop state, and event projection. Keep new files close to the
domain that owns the behavior.

## Domain Folders

- `ipc/` — renderer-to-main handlers and argument schemas.
- `thread-index/` — SQLite thread search/index persistence and query
  normalization.
- `update/` — release-source validation, update checks, and installer
  capability state.
- `workflow/` — durable workflow definitions, run orchestration, webhook
  intake, and the local Workflows MCP bridge.

## Top-Level Prefixes

Top-level files are legacy flat modules that should stay prefix-grouped until
their cluster is moved into a domain folder:

- `runtime-*` — OpenCode SDK/server composition and runtime-home isolation.
- `session-*` — session registry, replay, view projection, and reconciliation.
- `event-*` — runtime event handlers and task-run lineage projection.
- `custom-*` — user-managed MCP, skill, and agent stores.
- `config-*` — app config schema, loading, and public projections.

When a cluster grows or receives a substantial feature, prefer moving the
cluster into a folder with behavior-preserving imports rather than adding more
top-level files.
