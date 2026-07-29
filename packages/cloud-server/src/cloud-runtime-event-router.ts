import { randomUUID } from 'node:crypto'
import type { ControlPlaneStore } from './control-plane-store.ts'
import type { CloudRuntimeEvent } from './runtime-adapter.ts'
import type { CloudWorker } from './worker.ts'

export async function routeRuntimeEvent(
  store: ControlPlaneStore,
  worker: CloudWorker,
  event: CloudRuntimeEvent,
) {
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
  if (!sessionId) return
  const session = await store.findSession(sessionId)
  if (!session) return
  await worker.appendRuntimeEvent(session.tenantId, session.sessionId, event)
}

// Runtime events cross multiple awaits before the store assigns their durable
// sequence. Serialize each session's events while keeping distinct sessions
// concurrent, and discard settled tails so the map cannot grow without bound.
export function createSessionSerializedRuntimeEventRouter(
  route: (event: CloudRuntimeEvent) => Promise<void>,
): (event: CloudRuntimeEvent) => Promise<void> {
  const tailBySession = new Map<string, Promise<void>>()
  return (event) => {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
    if (!sessionId) return route(event)
    const tail = tailBySession.get(sessionId) ?? Promise.resolve()
    const next = tail.then(() => route(event))
    const guarded = next.then(() => {}, () => {})
    tailBySession.set(sessionId, guarded)
    void guarded.then(() => {
      if (tailBySession.get(sessionId) === guarded) tailBySession.delete(sessionId)
    })
    return next
  }
}

export const DEFAULT_RUNTIME_EVENT_ROUTE_ATTEMPTS = 6

/**
 * Runtime stream events are not replayable after the OpenCode process exits.
 * Retry transient durable-boundary failures in place, using one generated id
 * for every attempt so a commit followed by a response failure is idempotent.
 */
export function createRetryingRuntimeEventRouter(options: {
  route: (event: CloudRuntimeEvent) => Promise<void>
  maxAttempts?: number
  baseDelayMs?: number
  sleep?: (delayMs: number) => Promise<void>
}): (event: CloudRuntimeEvent) => Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_RUNTIME_EVENT_ROUTE_ATTEMPTS))
  const baseDelayMs = Math.max(0, Math.floor(options.baseDelayMs ?? 50))
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, delayMs)
  }))
  return async (event) => {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : 'unscoped'
    const retryableEvent = event.eventId
      ? event
      : { ...event, eventId: `runtime:${sessionId}:${randomUUID()}` }
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await options.route(retryableEvent)
        return
      } catch (error) {
        lastError = error
        if (attempt === maxAttempts) break
        await sleep(Math.min(1_000, baseDelayMs * (2 ** (attempt - 1))))
      }
    }
    throw lastError
  }
}
