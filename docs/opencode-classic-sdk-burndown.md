# Classic SDK Allowlist Burn-Down Runway (JOE-845)

## Status on OpenCode pin `1.18.1`

**Revalidated 2026-07-22 (post-#959 / pin-gated residual):** still **Won't Do (full burn-down)** while pinned to OpenCode 1.18.1. Prior revalidation 2026-07-21 (JOE-937). No residual desktop classic method gained a working
native V2 route on this pin; allowlist + registry below remain authoritative.

OpenCode 1.18.1 does not expose working native V2 routes for the remaining
classic methods (summarize/compaction, MCP group, explorer gaps, `tool.list`,
and several `session.*` mutations). Inventing client-side V2 shims or fake
routes would violate the product boundary: OpenCode owns execution; Open Cowork
only composes.

What *is* done on this pin:

- Exact file+method+count allowlist in `tests/opencode-sdk-boundary.test.ts`
  (`classicSdkGapAllowlist`) — silent expansion fails CI.
- Every allowlist method is documented in `docs/opencode-sdk-v2-boundary.md`.
- Residual registry below is the reopen checklist for every OpenCode bump.

What is **not** done on this pin (and must not be faked):

- Switching call sites to non-working `client.v2.*` routes.
- Removing allowlist rows without a proving integration against a newer pin.
- Emulating OpenCode MCP / session / explorer semantics in Open Cowork.

## Residual registry (pin-gated)

Each row is one classic method family. **Reopen** means: bump `@opencode-ai/sdk`
+ `opencode-ai` together, prove the V2 route against a real runtime, switch the
call site, delete the allowlist entry, update this table and the boundary doc.

| Method | Allowlist sites (counts) | Why classic on 1.18.1 | Reopen when |
| --- | --- | --- | --- |
| `session.summarize` | `session-action-handlers.ts` (1) | `v2.session.compact` returns `OperationUnavailable` | Compact succeeds end-to-end on new pin |
| `session.command` | `session-command-handlers.ts` (1) | No working V2 route | Native V2 command admission works |
| `session.delete` | `session-action-handlers.ts` (1) | No working V2 route | V2 delete works |
| `session.diff` | `session-action-handlers.ts` (1), `session-history-loader.ts` (1) | No working V2 route | V2 diff works |
| `session.fork` | `session-handlers.ts` (1) | No working V2 route | V2 fork works |
| `session.share` / `session.unshare` | `session-action-handlers.ts` (1 each) | No working V2 route | V2 share/unshare work |
| `session.todo` | `session-command-handlers.ts` (1), `session-history-loader.ts` (2) | No working V2 route | V2 todo read/write work |
| `session.update` | `session-action-handlers.ts` (1), `session-history-loader.ts` (1) | No working V2 route | V2 update works |
| `mcp.auth.authenticate` | `ipc-handlers.ts` (1), `catalog-handlers.ts` (1) | No V2 MCP group | V2 MCP auth group lands |
| `mcp.auth.remove` | `catalog-handlers.ts` (1) | No V2 MCP group | V2 MCP auth group lands |
| `mcp.connect` | `catalog-handlers.ts` (1), `runtime-mcp-recovery.ts` (2) | No V2 MCP group | V2 MCP connect lands |
| `mcp.disconnect` | `catalog-handlers.ts` (1) | No V2 MCP group | V2 MCP disconnect lands |
| `mcp.status` | `events.ts` (1) | No V2 MCP group | V2 MCP status lands |
| `file.read` | `explorer-handlers.ts` (1) | `v2.fs.read` missing wildcard path | V2 fs.read addresses `/api/fs/read/*` |
| `file.status` | `explorer-handlers.ts` (1) | No working V2 equivalent | V2 status lands |
| `find.symbols` | `explorer-handlers.ts` (1) | No working V2 equivalent | V2 symbols land |
| `find.text` | `explorer-handlers.ts` (1) | No working V2 equivalent | V2 text search lands |
| `tool.list` | `runtime-tools.ts` (1) | V2 catalogs agents/commands/skills/providers/models only | V2 effective tool catalog lands |

## OpenCode bump checklist (required)

On **every** OpenCode SDK/runtime pin change:

1. Bump `@opencode-ai/sdk` and `opencode-ai` to the same version in all runtime
   authority packages (`apps/desktop`, `apps/standalone-gateway`,
   `packages/cloud-server`, `packages/runtime-host`, **`products/gateway`**).
2. Run `node --no-warnings --experimental-strip-types scripts/check-opencode-compatibility.ts`.
3. For each residual method above, probe whether a native `client.v2.*` route
   exists and works against a real OpenCode process (not a mock).
4. When a method works: switch the call site → remove the exact allowlist row →
   update this registry + `docs/opencode-sdk-v2-boundary.md` in the **same**
   commit.
5. Keep `tests/opencode-sdk-boundary.test.ts` green: allowlist must match the
   code exactly (no silent expansion, no stale rows).
6. Prefer integration/smoke proof for each burned method before claiming
   completion.

## Ratchet policy

- **No silent allowlist expansion.** New classic calls fail CI until they gain
  both an allowlist entry *and* a documented residual row with a reopen condition.
- **No fake V2.** Do not wrap classic HTTP under `client.v2` names.
- **Burn one method at a time** with proving tests; do not bulk-delete rows.

## Durable Gateway surface (JOE-941 complete on this pin)

Desktop / Cloud / Standalone use `@opencode-ai/sdk/v2`. **Durable Gateway**
(`products/gateway`) now constructs the **V2** client on the same pin and routes
session I/O through a façade that prefers `client.v2.session.*` (classic
`session.*` remains only as a partial-mock fallback). Desktop allowlist
burn-down above stays separate from Durable:

- **Inventory + migration proof:** `docs/opencode-durable-gateway-classic-burndown.md` (JOE-940 / JOE-941)
- **Classic-session gate:** `scripts/check-durable-opencode-classic-gate.mjs`
- **Pin lockstep CI:** `scripts/check-opencode-pin-lockstep.mjs` (JOE-945; includes `products/gateway`)
