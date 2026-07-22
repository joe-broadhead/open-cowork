# Durable Gateway OpenCode V2 surface (JOE-940 / JOE-941)

**Pin:** OpenCode `@opencode-ai/sdk` **1.18.1** (V2 entry)
**Date:** 2026-07-22
**Status:** **JOE-941 migrated** — Durable constructs V2 client; session I/O prefers `client.v2.session.*` via façade

## Construction

| Symbol | File | Notes |
| --- | --- | --- |
| `createOpencodeClient` from `@opencode-ai/sdk/v2` | `products/gateway/src/opencode-client.ts` | Peer allowlist + Basic auth |
| Session façade | `products/gateway/src/opencode-session-runtime.ts` | Prefers V2; classic `session.*` fallback for partial mocks |

## Session I/O (façade only)

| Operation | V2 path | Classic fallback |
| --- | --- | --- |
| create | `v2.session.create` (+ location.directory) | `session.create` |
| get | `v2.session.get({ sessionID })` | `session.get({ path: { id } })` |
| list | `v2.session.list` | `session.list` |
| messages | `v2.session.messages` | `session.messages` |
| prompt | `v2.session.prompt` (text delivery) | `session.prompt` / `promptAsync` |
| abort | `v2.session.interrupt` | `session.abort` |
| delete | `v2.session.delete` when present | `session.delete` |

Production edges call only the façade (gate: `scripts/check-durable-opencode-classic-gate.mjs`).

## Related

| Doc / code | Role |
| --- | --- |
| `docs/opencode-classic-sdk-burndown.md` | Desktop classic residual allowlist |
| `packages/runtime-host/src/opencode-v2.ts` | Desktop/Cloud native helpers (reference shapes) |
| `scripts/check-opencode-pin-lockstep.mjs` | Pin skew fail-closed |
| `scripts/check-durable-opencode-classic-gate.mjs` | V2 construction + façade-only I/O |
