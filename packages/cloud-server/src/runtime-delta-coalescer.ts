/**
 * Runtime event delta coalescer extracted from app.ts bootstrap (JOE-870).
 * Buffers token-granular assistant.message appends per session before durable route.
 */
import type { CloudRuntimeEvent } from './runtime-adapter.ts'


// Token-granular `assistant.message` append deltas (projected from the SDK
// `message.part.delta`) arrive one per token. Materializing each one rewrites the WHOLE
// session projection (+ ~5 DB round-trips per event), so M streamed tokens cost O(M²)
// write amplification. This coalescer buffers consecutive append deltas per session and
// flushes them as ONE append on a short timer (a streaming window, not a debounce — so a
// long stream still advances every ~flushDelayMs) or at the next non-append boundary
// event, so a single materialize+persist covers many tokens.
//
// Correctness: the projection reducer appends each delta onto the same message, so
// `existing + (d1 + d2 + … + dN)` is byte-identical to `((existing + d1) + d2) … + dN`.
// Non-append events flush the session's pending delta FIRST so transcript order is
// preserved (deltas land before the snapshot/tool/idle that follows them). The coalescer
// serializes handling per session before invoking route(); the production route is also
// wrapped in createSessionSerializedRuntimeEventRouter as a durable-boundary safeguard.
// Pending deltas
// are flushed when the session goes idle (a boundary), and `flushAll` flushes any tail on
// shutdown, so no token is lost. Sequence ordering is preserved: coalescing only reduces
// the number of appended events; the survivors stay monotonic and in arrival order.
export const DEFAULT_RUNTIME_DELTA_FLUSH_MS = 60

type RuntimeDeltaPending = {
  event: CloudRuntimeEvent
  messageId: string
  timer: ReturnType<typeof setTimeout> | null
}

export type RuntimeDeltaCoalescer = {
  handle(event: CloudRuntimeEvent): Promise<void>
  flushAll(): Promise<void>
}

function isAppendDeltaEvent(event: CloudRuntimeEvent) {
  return event.type === 'assistant.message'
    && event.payload.mode === 'append'
    && typeof event.payload.content === 'string'
    && typeof event.payload.sessionId === 'string'
}

function runtimeEventMessageId(event: CloudRuntimeEvent) {
  return typeof event.payload.messageId === 'string' ? event.payload.messageId : ''
}

export function createRuntimeDeltaCoalescer(options: {
  route: (event: CloudRuntimeEvent) => Promise<void>
  flushDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}): RuntimeDeltaCoalescer {
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_RUNTIME_DELTA_FLUSH_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const pendingBySession = new Map<string, RuntimeDeltaPending>()
  const tailBySession = new Map<string, Promise<void>>()

  const enqueueSession = (sessionId: string, operation: () => Promise<void>) => {
    const previous = tailBySession.get(sessionId) ?? Promise.resolve()
    const next = previous.then(operation)
    // A rejected operation must remain visible to its caller without poisoning later
    // events on the same session. Keep a non-rejecting tail solely for serialization.
    const guarded = next.then(() => {}, () => {})
    tailBySession.set(sessionId, guarded)
    void guarded.then(() => {
      if (tailBySession.get(sessionId) === guarded) tailBySession.delete(sessionId)
    })
    return next
  }

  // Called only from that session's ordered operation queue.
  const flushSession = async (sessionId: string): Promise<void> => {
    const pending = pendingBySession.get(sessionId)
    if (!pending) return
    pendingBySession.delete(sessionId)
    if (pending.timer) clearTimer(pending.timer)
    await options.route(pending.event)
  }

  const processEvent = async (event: CloudRuntimeEvent) => {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null

    if (sessionId && isAppendDeltaEvent(event)) {
      const messageId = runtimeEventMessageId(event)
      const pending = pendingBySession.get(sessionId)
      if (pending && pending.messageId === messageId) {
        // Same streaming message: concatenate the delta onto the buffered append. The
        // timer keeps running (window, not debounce) so the stream still flushes on cadence.
        pending.event = {
          ...pending.event,
          payload: {
            ...pending.event.payload,
            content: String(pending.event.payload.content ?? '') + String(event.payload.content ?? ''),
          },
        }
        return
      }
      // A delta for a different message (or none buffered): flush the old one first to keep
      // order, then start a fresh window for this message.
      if (pending) await flushSession(sessionId)
      const timer = setTimer(() => {
        // Timer flushes enter the same session queue as source events. A boundary already
        // received can therefore never be overtaken by a later timer continuation.
        void enqueueSession(sessionId, () => flushSession(sessionId))
      }, flushDelayMs)
      pendingBySession.set(sessionId, {
        event: { ...event, payload: { ...event.payload } },
        messageId,
        timer,
      })
      return
    }

    // Boundary event: flush this session's pending deltas before routing it so the
    // transcript order (deltas → snapshot/tool/idle) is preserved. Both route() calls are
    // processed on one session queue; the durable route is additionally serialized as a
    // defence in depth against callers that use it outside this coalescer (issue #855).
    // Returning the durable route promise supplies natural backpressure to the
    // SDK subscription. At most one routed event plus one coalesced pending
    // delta exists per session, rather than an unbounded promise tail.
    if (sessionId) await flushSession(sessionId)
    await options.route(event)
  }

  const handle = (event: CloudRuntimeEvent) => {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
    return sessionId
      ? enqueueSession(sessionId, () => processEvent(event))
      : processEvent(event)
  }

  const flushAll = async () => {
    // First let already-enqueued source events populate/flush their buffers. A caller may
    // invoke flushAll immediately after handle() without awaiting the individual handles.
    await Promise.all([...tailBySession.values()])
    await Promise.all([...pendingBySession.keys()].map((sessionId) => (
      enqueueSession(sessionId, () => flushSession(sessionId))
    )))
  }

  return { handle, flushAll }
}
