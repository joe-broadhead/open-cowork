# WorkspaceSessionPort dual-path inventory (JOE-965 / JOE-921)

**Date:** 2026-07-21  
**Linear:** JOE-921, JOE-965, JOE-967, JOE-970  
**HEAD package:** `fix/milestone-post-958-quality-signal`  
**Surfaces:** `apps/desktop/src/main/workspace-session-port.ts`, `cloud-workspace-adapter.ts`, `workspace-gateway.ts`, `gateway-workspace-adapter.ts`, local `sessionEngine` / pairing executor

## Authority matrix

| Workspace kind | Session authority | On port? | Notes |
| --- | --- | --- | --- |
| `local` | `runtime-host` SessionEngine + IPC handlers | **core via memory fixture / deferred wiring** | Local sessions stay on SessionEngine; port provides shared contract + memory fixture for parity |
| `cloud` | `CloudWorkspaceAdapter` | **full** | Factory asserts `mode: 'full'` |
| `gateway` | `GatewayWorkspaceStatusAdapter` | **N/A (status only)** | health/ready/sync; Desktop session API deferred (support matrix) |
| `paired_desktop` | pairing connector | **N/A (deferred)** | Explicit deferred reasons in support matrix |

## Operation matrix (session / dual-path focus)

| Operation | Port method | Cloud adapter | Local SessionEngine / IPC | Gateway status | Migration status |
| --- | --- | --- | --- | --- | --- |
| policy | `policy` | yes | LOCAL_WORKSPACE_POLICY on gateway | remote policy N/A | **on-port** |
| list sessions | `listSessions` | yes | session registry / pairing executor | deferred | **on-port** |
| create session | `createSession` | yes | local create IPC | deferred | **on-port** |
| get session info | `getSessionInfo` | yes | session registry | deferred | **on-port** |
| get session view / projection | `getSessionView` | yes | SessionEngine.getSessionView | deferred | **on-port** |
| prompt | `promptSession` | yes | session prompt IPC | deferred | **on-port** |
| abort | `abortSession` | yes | session abort IPC | deferred | **on-port** |
| question reply/reject | `replyToQuestion` / `rejectQuestion` | yes | pairing local-executor | deferred | **on-port (optional full)** |
| permission respond | `respondToPermission` | yes | permission tracker / IPC | deferred | **on-port (optional full)** |
| workflows CRUD-ish | `list/get/run/pause/resume/archiveWorkflow` | yes | local workflow paths | deferred | **on-port (optional full)** |
| import session | `importSession` | yes | local export → cloud import | N/A | **on-port extended (JOE-967)** |
| list/upload/read artifacts | `listArtifacts` / `uploadArtifact` / `readArtifactAttachment` | yes | chart/artifact IPC | deferred | **on-port extended (JOE-967)** |
| sync cache | `sync` | yes | n/a local | gateway sync status | **on-port extended (JOE-967)** |
| SSE session/workspace events | transport subscribe* | cloud-only transport | local event bus | N/A | **off-port (transport-specific)** |
| admin / entitlements / BYOK admin | cloud admin methods | cloud-only | N/A | N/A | **off-port (cloud admin surface)** |
| thread tags / smart filters | cloud thread methods | cloud-only | N/A | N/A | **off-port (cloud thread surface)** |
| pairing register/revoke | pairing service | N/A | pairing service | N/A | **off-port (pairing)** |

## Ordered migration list

1. **Done (#958 / JOE-921 foundation):** core + interaction + workflow on port; cloud factory assert; gateway `cloudSessionPort`.  
2. **Done (this package):** import + artifact + sync extended methods; memory full-port fixture; parity contract runner.  
3. **Next (optional progressive):** wrap local SessionEngine behind a thin `LocalWorkspaceSessionPort` used by IPC when active workspace is local (non-breaking dual-call until cutover).  
4. **Out of scope for port:** gateway status adapter remains health-only until Standalone Gateway exposes Desktop-safe session APIs; cloud admin/thread/SSE stay cloud-transport extensions.

## Complexity note

| File | LOC (approx) | Role after this package |
| --- | --- | --- |
| `workspace-session-port.ts` | ~350 | Contract + memory fixture + exercise runner |
| `cloud-workspace-adapter.ts` | ~945 | Full port implementer |
| `workspace-gateway.ts` | ~1690 | Kind routing + cloud session modules; still large (LOC epic) |
| `gateway-workspace-adapter.ts` | ~130 | Status only (documented N/A) |
