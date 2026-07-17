# Desktop as pure composition shell (JOE-842)

Open Cowork Desktop should be a **composition shell**: Electron IPC, windowing,
packaging, and product UX on top of `@open-cowork/runtime-host`. It should not
grow new OpenCode execution edge unless a seam is desktop-only (Electron
lifecycle, BrowserWindow fan-out).

## Residual desktop SDK import paths

Enforced by `tests/opencode-sdk-boundary.test.ts` (`allowedSdkImportPaths`).

| Path | Why it still imports SDK | Removal plan |
| --- | --- | --- |
| `apps/desktop/src/main/events.ts` | Subscribes to `v2.event` + classic `mcp.status`; fans into SessionEngine | Keep until event subscribe helper moves to runtime-host with BrowserWindow-free callback; `mcp.status` blocked on classic gap (JOE-845) |
| `apps/desktop/src/main/event-subscriptions.ts` | Holds `OpencodeClient` for directory-scoped SSE | Move subscription manager to runtime-host; desktop only passes `getClient` + dispatch |
| `apps/desktop/src/main/durable-session-events.ts` | Per-session `v2.session.events` durable tails | Extract hub core to runtime-host (cursor helpers already shared); desktop keeps attach-to-window only |
| `apps/desktop/src/main/runtime-mcp-status-polling.ts` | Polls MCP status via client | Move poll loop to runtime-host; desktop maps results to IPC |
| `apps/desktop/src/main/ipc/context.ts` | Types `OpencodeClient` on IPC context | Replace with runtime-host client facade type when facade exists |
| `apps/desktop/src/main/ipc/provider-handlers.ts` | `v2.provider` / `v2.integration` OAuth + credential flows | Keep as desktop product seam (secure storage + UI) until cloud shares the same facade |

### Removed from desktop SDK edge

| Path | Change |
| --- | --- |
| `apps/desktop/src/main/question-normalization.ts` | Re-exports pure policy from `@open-cowork/runtime-host/question-normalization` — no SDK import (JOE-842) |

## Classic-call desktop files (not type-import only)

These files call classic `client.session.*` / `client.mcp.*` / explorer methods
and are listed in the JOE-845 allowlist. They are **execution edge** until the
OpenCode pin grows V2 routes — not free to move without a working V2 target.

- `ipc/session-action-handlers.ts`, `session-command-handlers.ts`, `session-handlers.ts`
- `ipc/catalog-handlers.ts`, `ipc/explorer-handlers.ts`
- `ipc-handlers.ts`, `runtime-mcp-recovery.ts`

See [opencode-classic-sdk-burndown.md](opencode-classic-sdk-burndown.md).

## Composition-safe rules

1. Prefer pure policy in `packages/shared` or `packages/runtime-host` over
   `apps/desktop/src/main`.
2. New SDK imports in desktop fail CI unless added to the allowlist **and** this
   inventory with a removal plan.
3. Do not reintroduce SDK types for pure string/list normalizers.
4. Electron `BrowserWindow` / IPC remain desktop-owned; runtime-host must not
   import Electron.
