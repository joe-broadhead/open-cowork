# Worker-scoped runtime adapter

Cloud multi-tenant workers cache per-session OpenCode runtime adapters with
idle TTL reaping and session-id remapping so native child sessions project onto
Cowork session ids.

## Lifecycle

1. **Key** — `tenantId + sessionId` (see `runtimeKey` in
   `packages/cloud-server/src/worker-scoped-runtime-adapter.ts`).
2. **Create** — first use calls `runtimeFactory` with BYOK-aware runtime config.
3. **Use counting** — `activeUses` / `executionActive` prevent idle eviction of
   in-flight work.
4. **Idle TTL** — default 30 minutes (`DEFAULT_RUNTIME_IDLE_TTL_MS`). A timer
   reaps idle entries even without a cache miss.
5. **Max entries** — default 100; excess closes least-recently-used idle runtimes.
6. **Unexpected exit** — managed OpenCode death evicts the entry so the next
   access rebuilds.

## Session id remapping

Native OpenCode events may carry child session ids. The adapter maps events to
the Cowork root session and avoids projecting child idle/error onto a still-running
root. Operators diagnosing “stuck idle” should check whether the event was a
child-scoped idle suppressed for the root.

## Operator knobs

| Option | Meaning |
| --- | --- |
| `runtimeIdleTtlMs` | Idle close threshold |
| `maxRuntimeEntries` | Hard cap on concurrent adapters per worker process |

## Tests

Regression coverage lives under cloud runtime / worker-scoped adapter tests
(idle reaping, remapping edge cases). Prefer fake timers over wall-clock sleeps.
