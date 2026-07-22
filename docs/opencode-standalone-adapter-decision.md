# Standalone Gateway OpenCode adapter decision (JOE-966)

**Date:** 2026-07-21
**Decision:** **Keep Standalone thin-special** — do **not** force a dependency on
`@open-cowork/runtime-host` for client construction on pin 1.18.1.

## Context

| Surface | Client entry | Notes |
| --- | --- | --- |
| Desktop runtime-host | `createOpencodeV2Client` via `runtime-host/opencode-client-kernel` | Spawns managed OpenCode |
| Cloud worker | Same kernel (re-export path) | Cloud runtime authority |
| Standalone Gateway | Dynamic `import('@opencode-ai/sdk/v2')` in `apps/standalone-gateway/src/opencode.ts` | Appliance + private OpenCode endpoint |
| Durable Gateway | Classic root `createOpencodeClient` | Separate product partition (JOE-940/941) |

#958 / JOE-943 shared kernel is intentionally **thin** today: V2 client
construction + auth config + health probe. Spawn, session API shapes, and event
pumps remain product-owned.

## Decision

**Compose the same factory, not the runtime-host package.**

1. Standalone already calls the **same** SDK V2 factory (`createOpencodeClient`
   from `@opencode-ai/sdk/v2`) that the monorepo kernel wraps. That is enough
   pin-lockstep surface for JOE-945 (package pins) and boundary docs.
2. Standalone must **not** depend on `runtime-host` for appliance isolation:
   private DNS policy, runtime-root normalization, interrupt settlement, and
   hermetic `loadSdk()` test injection live only in the appliance adapter.
3. Shared event classification already lives in `@open-cowork/shared`
   (`translateOpencodeEventForStandalone`); Standalone only shapes public
   payloads.

## Non-goals (this decision)

- Moving Standalone spawn into runtime-host (Standalone does not own desktop
  managed-server spawn).
- Migrating Durable Gateway onto this path (classic root until JOE-941).
- Expanding JOE-943 kernel into full spawn/event-pump without a separate design
  for cloud vs desktop (JOE-943 residual).

## Revisit when

| Trigger | Action |
| --- | --- |
| JOE-943 expands kernel with spawn/event-pump | Re-evaluate whether Standalone should import kernel helpers only (still no full runtime-host dependency) |
| Durable V2 migration (JOE-941) | Align Durable construction with V2 kernel; Standalone stays independent |
| Pin bump that changes V2 client config shape | Update kernel + Standalone constructor in the same change |

## Related code

- `apps/standalone-gateway/src/opencode.ts` — appliance adapter (+ JOE-966 comment)
- `packages/runtime-host/src/opencode-client-kernel.ts` — monorepo V2 construction
- `docs/opencode-sdk-v2-boundary.md` — import rules
