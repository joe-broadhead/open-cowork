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
import { createRuntimeDeltaCoalescer } from '@open-cowork/cloud-server/app'

// Tranche H / PERF-1: token-granular `assistant.message` append deltas previously
// rewrote the whole session projection (+ ~5 DB round-trips) once PER token — O(M²) write
// amplification. The coalescer buffers consecutive append deltas per session and flushes
// them as ONE append on a streaming window / at the next boundary. These tests prove the
// streamed transcript is byte-identical to the per-token path while far fewer events are
// persisted, and that transcript ORDER is preserved across boundary events.

class FakeRuntime implements CloudRuntimeAdapter {
  async createSession() {
    return {
      id: 'session-1',
      title: 'Coalescer session',
      createdAt: '2026-06-28T10:00:00.000Z',
      updatedAt: '2026-06-28T10:00:00.000Z',
    }
  }

  async promptSession(_input: { sessionId: string, parts: CloudRuntimePromptPart[], agent: string }) {
    return { events: [] }
  }

  async abortSession(_input: { sessionId: string }) {}
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true)
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true)
  return value as unknown[]
}

function appendDelta(sessionId: string, messageId: string, content: string): CloudRuntimeEvent {
  return { type: 'assistant.message', payload: { sessionId, messageId, content, mode: 'append' } }
}

test('runtime delta coalescer folds consecutive append deltas into one routed event', async () => {
  const routed: CloudRuntimeEvent[] = []
  // Drive the flush window manually so the test is deterministic (no real timers).
  let scheduled: (() => void) | null = null
  const coalescer = createRuntimeDeltaCoalescer({
    route: async (event) => { routed.push(event) },
    setTimer: (fn) => { scheduled = fn; return 1 as unknown as ReturnType<typeof setTimeout> },
    clearTimer: () => { scheduled = null },
  })

  for (const token of ['Hel', 'lo', ' ', 'wor', 'ld']) {
    coalescer.handle(appendDelta('s1', 'm1', token))
  }
  // All five tokens are still buffered inside the open flush window — nothing materialized.
  assert.equal(routed.length, 0)
  assert.ok(scheduled)

  scheduled!()
  // One materialize covers the whole window, with the exact concatenated text.
  assert.equal(routed.length, 1)
  assert.equal(routed[0]!.payload.content, 'Hello world')
  assert.equal(routed[0]!.payload.mode, 'append')
  assert.equal(routed[0]!.payload.messageId, 'm1')
})

test('runtime delta coalescer flushes pending deltas before a boundary event, in order', async () => {
  const routed: CloudRuntimeEvent[] = []
  const coalescer = createRuntimeDeltaCoalescer({
    route: async (event) => { routed.push(event) },
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  })

  coalescer.handle(appendDelta('s1', 'm1', 'Hello'))
  coalescer.handle(appendDelta('s1', 'm1', ' world'))
  // A non-append boundary (tool call) must flush the buffered text FIRST so the transcript
  // order stays deltas → tool.
  coalescer.handle({ type: 'tool.call', payload: { sessionId: 's1', id: 't1', name: 'read' } })

  assert.deepEqual(routed.map((event) => event.type), ['assistant.message', 'tool.call'])
  assert.equal(routed[0]!.payload.content, 'Hello world')

  // A delta for a DIFFERENT message flushes the previous buffer before starting a new window.
  coalescer.handle(appendDelta('s1', 'm2', 'next'))
  // m1 had nothing pending (already flushed by the boundary); m2 is now buffered.
  assert.equal(routed.length, 2)
  await coalescer.flushAll()
  assert.equal(routed.length, 3)
  assert.equal(routed[2]!.payload.messageId, 'm2')
  assert.equal(routed[2]!.payload.content, 'next')
})

test('runtime delta coalescer keeps separate sessions independent', async () => {
  const routed: CloudRuntimeEvent[] = []
  const coalescer = createRuntimeDeltaCoalescer({
    route: async (event) => { routed.push(event) },
    setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {},
  })

  coalescer.handle(appendDelta('s1', 'm1', 'a'))
  coalescer.handle(appendDelta('s2', 'm2', 'b'))
  // A boundary for s1 must not flush s2's pending delta.
  coalescer.handle({ type: 'session.idle', payload: { sessionId: 's1' } })
  assert.deepEqual(routed.map((event) => `${event.type}:${event.payload.sessionId}`), [
    'assistant.message:s1',
    'session.idle:s1',
  ])

  await coalescer.flushAll()
  assert.equal(routed.at(-1)!.payload.sessionId, 's2')
  assert.equal(routed.at(-1)!.payload.content, 'b')
})

async function streamTokens(
  tokens: string[],
  messageId: string,
  options: { coalesce: boolean },
) {
  const store = new InMemoryControlPlaneStore()
  const service = new CloudSessionService(store, new FakeRuntime(), resolveCloudRuntimePolicy(DEFAULT_CONFIG))
  const principal = { tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test' }
  const created = await service.createSession(principal)
  const sessionId = created.session.sessionId

  const route = async (event: CloudRuntimeEvent) => {
    await service.appendRuntimeEvent({
      tenantId: principal.tenantId,
      sessionId: String(event.payload.sessionId),
      event,
    })
  }

  if (options.coalesce) {
    const coalescer = createRuntimeDeltaCoalescer({ route })
    for (const token of tokens) coalescer.handle(appendDelta(sessionId, messageId, token))
    await coalescer.flushAll()
  } else {
    for (const token of tokens) await route(appendDelta(sessionId, messageId, token))
  }

  const view = await service.getSessionView(principal, sessionId)
  const messages = asArray(asRecord(asRecord(view.projection).view).messages)
  const message = asRecord(messages.at(-1))
  const events = await store.listSessionEvents(principal.tenantId, sessionId, 0)
  const assistantEventCount = events.filter((event) => event.type === 'assistant.message').length
  return { text: String(message.content || ''), assistantEventCount }
}

test('coalesced streaming yields a byte-identical transcript with fewer projected events', async () => {
  const tokens = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog.']
  const messageId = 'assistant-msg-1'

  const baseline = await streamTokens(tokens, messageId, { coalesce: false })
  const coalesced = await streamTokens(tokens, messageId, { coalesce: true })

  // Byte-identical transcript text.
  assert.equal(baseline.text, tokens.join(''))
  assert.equal(coalesced.text, baseline.text)

  // The per-token path persisted one assistant.message event per token; the coalesced path
  // folded them into a single append — fewer projection materializations for the same text.
  assert.equal(baseline.assistantEventCount, tokens.length)
  assert.equal(coalesced.assistantEventCount, 1)
})
