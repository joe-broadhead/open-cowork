# Main Process Source Map

The main process owns Electron lifecycle, runtime composition, IPC handlers,
durable desktop state, and event projection. Keep new files close to the
domain that owns the behavior.

## Domain Folders

- `desktop-pairing/` — outbound Desktop pairing credentials, transport,
  redaction, and local execution support.
- `ipc/` — renderer-to-main handlers and argument schemas.
- `update/` — release-source validation, update checks, and installer
  capability state.
- `workflow/` — durable workflow definitions, run orchestration, webhook
  intake, and the local Workflows MCP bridge.

Thread indexing now lives in `packages/runtime-host/src/thread-index/` so the
desktop and cloud paths share one runtime substrate.

## Top-Level Prefixes

Top-level files are intentional exceptions. `tests/desktop-main-source-map.test.ts`
guards the current allowlist; adding a new top-level `.ts` file requires updating
that test and this source map in the same change. Prefer a domain folder when a
new behavior has more than one file or clear lifecycle ownership.

- `runtime-*` — OpenCode SDK/server composition and runtime-home isolation.
- `session-*` — session registry, replay, view projection, and reconciliation.
- `event-*` — runtime event handlers and task-run lineage projection.
- `cloud-workspace-*` / `gateway-workspace-*` / `workspace-gateway*` —
  local/cloud/gateway workspace control-plane adapters.
- `chart-*` / `artifact-*` — chart rendering and private artifact handling.
- `main-window-*` / `window-*` — BrowserWindow lifecycle, state, zoom, and
  security policy.
- `project-*` — recent project registry and project-source snapshots.

## Folderization Backlog

These clusters are explicitly too large to keep growing at top level:

- `workspace-gateway*`, `cloud-workspace-*`, and `gateway-workspace-*` should
  move into a workspace authority folder.
- `event-*` and `session-*` should move into event projection and session
  lifecycle folders once the remaining desktop-specific responsibilities are
  split from `@open-cowork/runtime-host`.
- `chart-*` and `artifact-*` should move into an artifact surface folder if the
  chart pipeline gains more entry points.

Until then, keep changes prefix-grouped and avoid adding new flat files without
an intentional source-map exception.
