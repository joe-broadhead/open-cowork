# Worker-scoped runtime adapter

Cloud multi-tenant workers cache per-session OpenCode runtime adapters with
idle TTL reaping and session-id remapping so native child sessions project onto
Cowork session ids.

## Lifecycle

1. **Key** — `tenantId + sessionId` (see `runtimeKey` in
   `packages/cloud-server/src/worker-scoped-runtime-adapter.ts`).
2. **Create** — first use calls `runtimeFactory` with BYOK-aware runtime config.
3. **Admission** — one permit covers every cached, active, or creating runtime.
   Concurrent misses for the same session share one creation. Distinct sessions
   wait in a bounded FIFO; queue exhaustion and deadlines return a typed,
   retryable capacity error.
4. **Use counting** — a cached runtime is claimed before asynchronous
   observability work. `activeUses` / `executionActive` prevent eviction while
   a request owns it.
5. **Idle TTL** — default 30 minutes (`DEFAULT_RUNTIME_IDLE_TTL_MS`). A timer
   reaps idle entries even without a cache miss.
6. **Cleanup debt** — a permit remains held until the execution boundary closes.
   Failed or timed-out teardown stays retryable and cannot make replacement
   capacity appear.
7. **Unexpected exit** — managed OpenCode death evicts the entry so the next
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
| `maxRuntimeEntries` | Hard cap across cached, active, and creating boundaries |
| `maxAdmissionQueueEntries` | Maximum distinct sessions waiting for capacity |
| `admissionQueueTimeoutMs` | Maximum wait for a runtime permit |
| `runtimeProvisionTimeoutMs` | End-to-end preparation and provision deadline |
| `runtimeTeardownTimeoutMs` | Shared deadline for one close/recovery pass |

## Tests

Regression coverage lives under Cloud runtime admission, capacity recovery,
execution isolation, and worker-scoped adapter tests. It covers saturation,
FIFO admission, same-session coalescing, cancellation, cleanup debt, idle
reaping, unexpected exits, and remapping edge cases. Prefer controlled promises
and fake timers over wall-clock sleeps.
