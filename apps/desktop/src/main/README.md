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
- `workspace/` — cloud-workspace cache safety and Gateway credential-state
  helpers shared by the desktop workspace authority.

Thread indexing now lives in `packages/runtime-host/src/thread-index/` so the
desktop and cloud paths share one runtime substrate.

## Top-Level Prefixes

Top-level files are intentional exceptions. `tests/desktop-main-source-map.test.ts`
enforces a non-growth budget on the flat layout without preserving a filename
snapshot. Prefer a domain folder when new behavior has more than one file or
clear lifecycle ownership; adding a top-level file requires removing or moving
another one so the ratchet never increases.

- `runtime-*` — OpenCode SDK/server composition and runtime-home isolation.
- `session-*` — session registry, replay, view projection, and reconciliation.
- `event-*` — runtime event handlers and task-run lineage projection.
- `cloud-workspace-*` / `gateway-workspace-*` / `workspace-gateway*` /
  `local-workspace-session` / `workspace-session-port` — local/cloud/gateway
  workspace control-plane adapters and progressive local session port wiring.
- `chart-*` / `artifact-*` — chart rendering and private artifact handling.
- `main-window-*` / `window-*` — BrowserWindow lifecycle, state, zoom, and
  security policy.
- `project-*` — recent project registry and project-source snapshots.

## Folderization Backlog

These clusters are explicitly too large to keep growing at top level:

- Remaining `workspace-gateway*`, `cloud-workspace-*`, and
  `gateway-workspace-*` entry points should continue moving into `workspace/`
  as their desktop-specific responsibilities are split.
- `event-*` and `session-*` should move into event projection and session
  lifecycle folders once the remaining desktop-specific responsibilities are
  split from `@open-cowork/runtime-host`.
- `chart-*` and `artifact-*` should move into an artifact surface folder if the
  chart pipeline gains more entry points.

Until then, keep changes prefix-grouped and reduce the flat-file count whenever
an owned domain seam becomes clear.
