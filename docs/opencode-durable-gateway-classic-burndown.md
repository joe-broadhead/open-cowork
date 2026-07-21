# Durable Gateway classic SDK surface inventory (JOE-940)

**Pin:** OpenCode `@opencode-ai/sdk` **1.18.1** (classic root entry)  
**Date:** 2026-07-21 (revalidated)  
**Status:** Inventory complete; **V2 migration blocked** on pin 1.18.1 ([JOE-941](https://linear.app/joe-broadhead/issue/JOE-941))

## Why classic here

Desktop / Cloud / Standalone construct clients via `@opencode-ai/sdk/v2` (shared
kernel: `packages/runtime-host/src/opencode-client-kernel.ts`). Durable Gateway
(`products/gateway`, package `cowork-gateway`) constructs a **classic root**
client via `createOpencodeClient` from `@opencode-ai/sdk` in
`src/opencode-client.ts` (peer allowlist + optional Basic auth). Runtime call
shape is classic `client.session.*` throughout the daemon.

Do **not** invent `client.v2.*` routes on 1.18.1. Reopen JOE-941 when OpenCode
exposes working V2 session APIs for these methods on a bumped pin.

## Client construction

| Symbol | File | Notes |
| --- | --- | --- |
| `createOpencodeClient` (classic root) | `products/gateway/src/opencode-client.ts` | Only Durable construction site |
| Type-only `OpencodeClient` | Multiple modules | Import from `@opencode-ai/sdk` root (not `/v2`) |

Preferred façade for new session I/O: `products/gateway/src/opencode-session-runtime.ts`
(create / list / prompt / abort / delete / messages). Edge modules still call
`client.session.*` directly in several places; migration should collapse onto
the façade when V2 lands.

## Method inventory (products/gateway/src, excl. tests)

Counts are approximate production call sites (regex on
`client|c|sessionClient.session.<method>(`).

| Classic method | Approx. sites | Primary files |
| --- | --- | --- |
| `session.get` | 12 | channel-commands, heartbeat, observability, daemon, scheduler, daemon-routes/opencode, opencode-session-runtime |
| `session.list` | 8 | scheduler, live, live-state-hygiene, service-health, readiness, daemon-routes/system, daemon-routes/opencode, opencode-session-runtime |
| `session.abort` | 8 | channel-commands, daemon-routes/work, daemon-routes/opencode, opencode-session-runtime |
| `session.messages` | 6 | channel-sync, scheduler, observability, daemon-routes/opencode, opencode-session-runtime |
| `session.prompt` | 3 | delegation-progress, team-progress, opencode-session-runtime |
| `session.create` | 1 | opencode-session-runtime |
| `session.delete` | 1 | opencode-session-runtime |
| Client construction | 1 | opencode-client.ts |

**Not used in Durable Gateway:** classic `mcp.*`, `file.*`, `find.*`, `tool.list`
(those remain Desktop allowlist residuals — see
`docs/opencode-classic-sdk-burndown.md`).

## Reopen checklist (JOE-941)

On every OpenCode pin bump:

1. Keep `@opencode-ai/sdk` lockstep across desktop, standalone-gateway,
   cloud-server, runtime-host, **and products/gateway**
   (`scripts/check-opencode-pin-lockstep.mjs` — JOE-945, wired into
   `pnpm boundaries:check`).
2. Probe V2 session list/get/messages/abort/prompt/create/delete against a real
   OpenCode process (not a mock).
3. When a method works on V2: migrate Durable call sites (prefer
   `opencode-session-runtime.ts`) → update this table → same commit.
4. Never claim Durable “is V2” while classic root `createOpencodeClient` remains.
5. Do not fake classic HTTP under `client.v2` names.

## Related

| Doc / code | Role |
| --- | --- |
| `docs/opencode-classic-sdk-burndown.md` | Desktop classic residual allowlist (JOE-845 / JOE-937) |
| `docs/opencode-sdk-v2-boundary.md` | Product boundary + import rules |
| `packages/runtime-host/src/opencode-client-kernel.ts` | Shared V2 client construction (JOE-943) |
| `apps/standalone-gateway/src/opencode.ts` | Appliance adapter decision (JOE-966) |
| `scripts/check-opencode-pin-lockstep.mjs` | Pin skew fail-closed (JOE-945) |
