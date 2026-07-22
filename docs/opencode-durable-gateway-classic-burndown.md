# Durable Gateway classic SDK surface inventory (JOE-940 / JOE-941)

**Pin:** OpenCode `@opencode-ai/sdk` **1.18.1** (classic root entry)
**Date:** 2026-07-22 (façade collapse revalidated)
**Status:** Inventory complete; **production session I/O collapsed onto façade**;
**V2 migration blocked** on pin 1.18.1 ([JOE-941](https://linear.app/joe-broadhead/issue/JOE-941))

## Why classic here

Desktop / Cloud / Standalone construct clients via `@opencode-ai/sdk/v2` (shared
kernel: `packages/runtime-host/src/opencode-client-kernel.ts`). Durable Gateway
(`products/gateway`, package `cowork-gateway`) constructs a **classic root**
client via `createOpencodeClient` from `@opencode-ai/sdk` in
`src/opencode-client.ts` (peer allowlist + optional Basic auth).

Do **not** invent `client.v2.*` routes on 1.18.1. Reopen JOE-941 when OpenCode
exposes working V2 session APIs for these methods on a bumped pin **and**
Durable peer-client call shapes are proven against a real OpenCode process.

## Pre-migration progress (JOE-941 prep, 2026-07-22)

| Gate | Status |
| --- | --- |
| Classic root construction only | **Enforced** — `scripts/check-durable-opencode-classic-gate.mjs` |
| Session I/O single flip point | **Done** — all production `client.session.{get,list,abort,messages,prompt,create,delete}` live only in `opencode-session-runtime.ts` |
| No dual classic/V2 fiction | **Enforced** — façade + construction must not import `/v2` or call `client.v2` |
| Actual V2 session migration | **Blocked** on pin + real-process probe evidence |

When V2 is proven, migrate **inside** `opencode-session-runtime.ts` (and
`opencode-client.ts` construction) only; edges already call the façade.

## Client construction

| Symbol | File | Notes |
| --- | --- | --- |
| `createOpencodeClient` (classic root) | `products/gateway/src/opencode-client.ts` | Only Durable construction site |
| Type-only `OpencodeClient` | Multiple modules | Import from `@opencode-ai/sdk` root (not `/v2`) |

Session I/O façade: `products/gateway/src/opencode-session-runtime.ts`
(create / list / get / prompt / abort / delete / messages / admit).

## Method inventory (products/gateway/src, excl. tests)

After façade collapse, edge modules call `createOpenCodeSessionRuntime` /
`getOpenCodeSessionRuntime` rather than `client.session.*` directly.

| Classic method (façade only) | Role |
| --- | --- |
| `session.get` | Presence, channel bind, observability, admit verify |
| `session.list` | Hygiene, readiness, recovery, doctor, live poll |
| `session.abort` | Task control, channel actions, cleanup |
| `session.messages` | Supervisor complete, channel sync, traces |
| `session.prompt` | Scheduler / team progress (via façade) |
| `session.create` | Admit + channel new session |
| `session.delete` | Admit reconcile cleanup |

**Not used in Durable Gateway:** classic `mcp.*`, `file.*`, `find.*`, `tool.list`
(those remain Desktop allowlist residuals — see
`docs/opencode-classic-sdk-burndown.md`).

Residual non-façade OpenCode surfaces (not session CRUD): e.g.
`client.session.children` on admin routes when present — optional API, not on
the V2 reopen table.

## Reopen checklist (JOE-941)

On every OpenCode pin bump:

1. Keep `@opencode-ai/sdk` lockstep across desktop, standalone-gateway,
   cloud-server, runtime-host, **and products/gateway**
   (`scripts/check-opencode-pin-lockstep.mjs` — JOE-945, wired into
   `pnpm boundaries:check`).
2. Probe V2 session list/get/messages/abort/prompt/create/delete against a real
   OpenCode process (not a mock). Prefer shapes used by
   `packages/runtime-host/src/opencode-v2.ts` (`sessionID` / double envelope).
3. When a method works on V2: migrate **only** inside
   `opencode-session-runtime.ts` (+ construction in `opencode-client.ts`) →
   update this table → same commit. Keep
   `scripts/check-durable-opencode-classic-gate.mjs` green or update it when
   classic root is intentionally retired.
4. Never claim Durable “is V2” while classic root `createOpencodeClient` remains.
5. Do not fake classic HTTP under `client.v2` names.

## Related

| Doc / code | Role |
| --- | --- |
| `docs/opencode-classic-sdk-burndown.md` | Desktop classic residual allowlist (JOE-845 / JOE-937) |
| `docs/opencode-sdk-v2-boundary.md` | Product boundary + import rules |
| `packages/runtime-host/src/opencode-client-kernel.ts` | Shared V2 client construction (JOE-943) |
| `packages/runtime-host/src/opencode-v2.ts` | Desktop/Cloud native session helpers |
| `apps/standalone-gateway/src/opencode.ts` | Appliance adapter decision (JOE-966) |
| `scripts/check-opencode-pin-lockstep.mjs` | Pin skew fail-closed (JOE-945) |
| `scripts/check-durable-opencode-classic-gate.mjs` | Façade-only classic I/O + no premature V2 (JOE-941) |
