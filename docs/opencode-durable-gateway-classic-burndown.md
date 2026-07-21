# Durable Gateway classic SDK surface inventory (JOE-940)

**Pin:** OpenCode `@opencode-ai/sdk` **1.18.1** (classic root entry)  
**Date:** 2026-07-21  
**Status:** Inventory complete; **V2 migration blocked** on pin 1.18.1 (JOE-941)

## Why classic here

Desktop / Cloud / Standalone use `@opencode-ai/sdk/v2`. Durable Gateway
(`products/gateway`) constructs a **classic** root client via
`createOpencodeClient` from `@opencode-ai/sdk` (`src/opencode-client.ts`) with
peer allowlist + optional Basic auth. Call shape is classic
`client.session.*` throughout the daemon.

Do **not** invent `client.v2.*` routes on 1.18.1. Reopen JOE-941 when OpenCode
exposes working V2 session APIs for these methods on a bumped pin.

## Method inventory (products/gateway/src, excl. tests)

| Classic method | Approx. call sites | Primary files |
| --- | --- | --- |
| `session.get` | 11 | channel-commands, heartbeat, observability, daemon, scheduler, daemon-routes/opencode |
| `session.list` | 7 | scheduler, live, live-state-hygiene, service-health, readiness, daemon-routes/* |
| `session.abort` | 7 | channel-commands, daemon-routes/work, daemon-routes/opencode |
| `session.messages` | 5 | channel-sync, scheduler, observability, daemon-routes/opencode |
| Client construction | 1 | `opencode-client.ts` (`createOpencodeClient` classic) |

No Durable Gateway call sites currently use classic `mcp.*`, `file.*`, `find.*`,
or `tool.list` (those remain Desktop allowlist items — see
`docs/opencode-classic-sdk-burndown.md`).

## Reopen checklist (JOE-941)

On every OpenCode pin bump:

1. Keep `@opencode-ai/sdk` lockstep across desktop, standalone-gateway,
   cloud-server, runtime-host, **and products/gateway**
   (`scripts/check-opencode-pin-lockstep.mjs`).
2. Probe V2 session list/get/messages/abort against a real OpenCode process.
3. When a method works on V2: migrate Durable call sites (prefer
   `opencode-session-runtime.ts` façade) → update this table → same commit.
4. Never claim Durable “is V2” while classic root `createOpencodeClient` remains.

## Related

- Desktop classic residual: `docs/opencode-classic-sdk-burndown.md` (JOE-845 / JOE-937)
- Shared V2 client kernel: `packages/runtime-host/src/opencode-client-kernel.ts` (JOE-943)
- Pin policy: OpenCode bump checklist in classic burndown doc
