import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import {
  createRetryingRuntimeEventRouter,
  createRuntimeDeltaCoalescer,
  createSessionSerializedRuntimeEventRouter,
} from '@open-cowork/cloud-server/app'

// Issue #855: the coalescer's boundary path fires `void flushSession()` and
// `void route(boundary)` without awaiting either. route() (routeRuntimeEvent →
// worker.appendRuntimeEvent) spans multiple awaits with no per-session serialization, and
// the store assigns the durable sequence at append time — so the boundary event could be
// durably appended BEFORE the delta flushed ahead of it, inverting transcript order.
//
// The pre-existing coalescer tests use a synchronously-resolving fake route, which can
// never interleave and therefore cannot expose this race. These tests mirror the
// production wiring — the coalescer's route wrapped in
// createSessionSerializedRuntimeEventRouter — with an ASYNC route whose latency differs
// per event type (yielding to the event loop between awaits, like the real multi-await
// append path), and assert the core invariant:
//
//   for a given session, the durable append order matches arrival order.

function appendDelta(sessionId: string, messageId: string, content: string): CloudRuntimeEvent {
  return { type: 'assistant.message', payload: { sessionId, messageId, content, mode: 'append' } }
}

// Yield to the macrotask queue `count` times so slower routes let faster ones overtake
// them unless the router serializes.
async function yieldTicks(count: number) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function waitFor(predicate: () => boolean, maxTicks = 500) {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// Coalescer wired exactly like production: route calls issued by the coalescer are
// serialized per session before hitting the (slow, multi-await) append path.
function serializedCoalescer(route: (event: CloudRuntimeEvent) => Promise<void>) {
  return createRuntimeDeltaCoalescer({
    route: createSessionSerializedRuntimeEventRouter(route),
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  })
}

test('boundary event cannot durably overtake the delta flushed ahead of it, even when the delta append is slower', async () => {
  const appended: string[] = []
  // Deltas take several event-loop turns to "append" (projection materialization is the
  // expensive path); boundaries append instantly. Without per-session serialization the
  // tool.call lands first — the durably misordered transcript from #855.
  const coalescer = serializedCoalescer(async (event) => {
    await yieldTicks(event.type === 'assistant.message' ? 3 : 0)
    appended.push(event.type === 'assistant.message'
      ? `assistant.message:${String(event.payload.content)}`
      : event.type)
  })

  coalescer.handle(appendDelta('s1', 'm1', 'Hel'))
  coalescer.handle(appendDelta('s1', 'm1', 'lo'))
  // Boundary: must flush the buffered delta and durably append it FIRST.
  coalescer.handle({ type: 'tool.call', payload: { sessionId: 's1', id: 't1', name: 'read' } })

  await coalescer.flushAll()
  await waitFor(() => appended.length >= 2)

  assert.deepEqual(appended, ['assistant.message:Hello', 'tool.call'])
})

test('durable append order matches arrival order across an interleaved stream of deltas and boundaries', async () => {
  const appended: string[] = []
  const coalescer = serializedCoalescer(async (event) => {
    // Vary latency by type so any missing serialization scrambles the durable order.
    const ticks = event.type === 'assistant.message' ? 4 : event.type === 'tool.call' ? 2 : 0
    await yieldTicks(ticks)
    appended.push(event.type === 'assistant.message'
      ? `assistant.message:${String(event.payload.messageId)}:${String(event.payload.content)}`
      : event.type)
  })

  coalescer.handle(appendDelta('s1', 'm1', 'first '))
  coalescer.handle(appendDelta('s1', 'm1', 'message'))
  coalescer.handle({ type: 'tool.call', payload: { sessionId: 's1', id: 't1', name: 'read' } })
  coalescer.handle(appendDelta('s1', 'm2', 'second'))
  coalescer.handle({ type: 'session.idle', payload: { sessionId: 's1' } })

  await coalescer.flushAll()
  await waitFor(() => appended.length >= 4)

  assert.deepEqual(appended, [
    'assistant.message:m1:first message',
    'tool.call',
    'assistant.message:m2:second',
    'session.idle',
  ])
})

test('serialization is per-session: a slow session does not block other sessions', async () => {
  const appended: string[] = []
  const coalescer = serializedCoalescer(async (event) => {
    await yieldTicks(event.payload.sessionId === 'slow' ? 5 : 0)
    appended.push(`${event.type}:${String(event.payload.sessionId)}`)
  })

  coalescer.handle(appendDelta('slow', 'm1', 'a'))
  coalescer.handle({ type: 'session.idle', payload: { sessionId: 'slow' } })
  coalescer.handle({ type: 'session.idle', payload: { sessionId: 'fast' } })

  await coalescer.flushAll()
  await waitFor(() => appended.length >= 3)

  // The fast session's boundary finished while the slow session's chain was still
  // draining — sessions stay concurrent — while the slow session stays internally ordered.
  assert.deepEqual(appended, [
    'session.idle:fast',
    'assistant.message:slow',
    'session.idle:slow',
  ])
})

test('a failed route does not wedge the session chain', async () => {
  const appended: string[] = []
  const serialized = createSessionSerializedRuntimeEventRouter(async (event) => {
    await yieldTicks(1)
    if (event.payload.id === 'boom') throw new Error('append failed')
    appended.push(event.type)
  })

  // The failing call still rejects for its awaiting caller...
  await assert.rejects(
    serialized({ type: 'tool.call', payload: { sessionId: 's1', id: 'boom', name: 'read' } }),
    /append failed/,
  )
  // ...but later events on the same session still route (the chain is not poisoned).
  await serialized({ type: 'session.idle', payload: { sessionId: 's1' } })
  assert.deepEqual(appended, ['session.idle'])
})

test('runtime event retries reuse one idempotency key with bounded exponential delays', async () => {
  const attemptedIds: Array<string | undefined> = []
  const delays: number[] = []
  const route = createRetryingRuntimeEventRouter({
    route: async (event) => {
      attemptedIds.push(event.eventId)
      if (attemptedIds.length < 3) throw new Error('transient append failure')
    },
    maxAttempts: 4,
    baseDelayMs: 10,
    sleep: async (delayMs) => { delays.push(delayMs) },
  })

  await route({ type: 'session.idle', payload: { sessionId: 's1' } })

  assert.equal(attemptedIds.length, 3)
  assert.ok(attemptedIds[0]?.startsWith('runtime:s1:'))
  assert.deepEqual(new Set(attemptedIds).size, 1)
  assert.deepEqual(delays, [10, 20])
})

test('runtime event retries reject after the configured attempt budget', async () => {
  let attempts = 0
  const route = createRetryingRuntimeEventRouter({
    route: async () => {
      attempts += 1
      throw new Error('durable store unavailable')
    },
    maxAttempts: 3,
    baseDelayMs: 0,
    sleep: async () => {},
  })

  await assert.rejects(
    route({ type: 'session.idle', payload: { sessionId: 's1' } }),
    /durable store unavailable/,
  )
  assert.equal(attempts, 3)
})

test('coalescer handle applies backpressure until the durable boundary finishes', async () => {
  const started: string[] = []
  let releaseDelta!: () => void
  const deltaGate = new Promise<void>((resolve) => { releaseDelta = resolve })
  const coalescer = createRuntimeDeltaCoalescer({
    route: async (event) => {
      started.push(event.type)
      if (event.type === 'assistant.message') await deltaGate
    },
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  })

  await coalescer.handle(appendDelta('s1', 'm1', 'pending'))
  let boundaryFinished = false
  const boundary = coalescer
    .handle({ type: 'session.idle', payload: { sessionId: 's1' } })
    .then(() => { boundaryFinished = true })
  await yieldTicks(1)

  assert.deepEqual(started, ['assistant.message'])
  assert.equal(boundaryFinished, false)

  releaseDelta()
  await boundary
  assert.deepEqual(started, ['assistant.message', 'session.idle'])
  assert.equal(boundaryFinished, true)
})

// End-to-end invariant against the REAL store/service append path (multiple awaits per
// append, sequence assigned durably at store.appendSessionEvent): the persisted event log
// for the session lists the flushed delta before the boundary, with monotonic sequences.

class FakeRuntime implements CloudRuntimeAdapter {
  async createSession() {
    return {
      id: 'session-1',
      title: 'Ordering session',
      createdAt: '2026-07-05T10:00:00.000Z',
      updatedAt: '2026-07-05T10:00:00.000Z',
    }
  }

  async promptSession(_input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    return { events: [] }
  }

  async abortSession(_input: { sessionId: string }) {}
}

test('flushed deltas are durably persisted before the boundary event with monotonic sequences', async () => {
  const store = new InMemoryControlPlaneStore()
  const service = new CloudSessionService(store, new FakeRuntime(), resolveCloudRuntimePolicy(DEFAULT_CONFIG))
  const principal = { tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test' }
  const created = await service.createSession(principal)
  const sessionId = created.session.sessionId

  const coalescer = serializedCoalescer(async (event) => {
    await service.appendRuntimeEvent({
      tenantId: principal.tenantId,
      sessionId: String(event.payload.sessionId),
      event,
    })
  })

  coalescer.handle(appendDelta(sessionId, 'm1', 'Hello '))
  coalescer.handle(appendDelta(sessionId, 'm1', 'world'))
  coalescer.handle({ type: 'tool.call', payload: { sessionId, id: 't1', name: 'read' } })
  coalescer.handle(appendDelta(sessionId, 'm2', 'again'))
  coalescer.handle({ type: 'session.idle', payload: { sessionId } })
  await coalescer.flushAll()

  const relevant = (records: Array<{ type: string }>) => records.filter((event) =>
    event.type === 'assistant.message' || event.type === 'tool.call' || event.type === 'session.idle')
  let persisted = await store.listSessionEvents(principal.tenantId, sessionId, 0)
  for (let i = 0; i < 500 && relevant(persisted).length < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    persisted = await store.listSessionEvents(principal.tenantId, sessionId, 0)
  }
  const events = relevant(persisted)

  // Durable order matches arrival order.
  assert.deepEqual(events.map((event) => event.type), [
    'assistant.message',
    'tool.call',
    'assistant.message',
    'session.idle',
  ])
  assert.equal(events[0]!.payload.content, 'Hello world')
  assert.equal(events[2]!.payload.content, 'again')
  // Sequences stay strictly monotonic (no projection read-modify-write race).
  for (let i = 1; i < persisted.length; i += 1) {
    assert.ok(persisted[i]!.sequence > persisted[i - 1]!.sequence)
  }
})
