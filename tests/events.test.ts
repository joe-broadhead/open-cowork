import test from 'node:test'
import assert from 'node:assert/strict'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { subscribeToEvents } from '../apps/desktop/src/main/events.ts'

type IntervalId = ReturnType<typeof setInterval>

function createFakeClient(stream: AsyncIterable<unknown>): OpencodeClient {
  return {
    event: {
      subscribe: async () => ({ stream }),
    },
  } as unknown as OpencodeClient
}

async function* emptyStream() {
  for (const value of [] as unknown[]) yield value
  // Completes immediately.
}

async function* throwingStream() {
  for (const value of [] as unknown[]) yield value
  throw new Error('stream failed')
}

async function withTrackedIntervals(fn: (state: {
  created: IntervalId[]
  cleared: IntervalId[]
}) => Promise<void>) {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const created: IntervalId[] = []
  const cleared: IntervalId[] = []

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = { handler, timeout, args, index: created.length + 1 } as unknown as IntervalId
    created.push(id)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id?: IntervalId) => {
    if (id) cleared.push(id)
  }) as typeof clearInterval

  try {
    await fn({ created, cleared })
  } finally {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
  }
}

test('subscribeToEvents clears its sweep interval when the stream ends unexpectedly', async () => {
  await withTrackedIntervals(async ({ created, cleared }) => {
    await assert.rejects(
      subscribeToEvents(createFakeClient(emptyStream()), () => null),
      /SSE stream ended unexpectedly/,
    )

    assert.equal(created.length, 1)
    assert.deepEqual(cleared, created)
  })
})

test('subscribeToEvents clears its sweep interval when an aborted stream ends', async () => {
  const controller = new AbortController()
  controller.abort()

  await withTrackedIntervals(async ({ created, cleared }) => {
    await subscribeToEvents(createFakeClient(emptyStream()), () => null, controller.signal)

    assert.equal(created.length, 1)
    assert.deepEqual(cleared, created)
  })
})

test('subscribeToEvents clears its sweep interval when stream iteration throws', async () => {
  await withTrackedIntervals(async ({ created, cleared }) => {
    await assert.rejects(
      subscribeToEvents(createFakeClient(throwingStream()), () => null),
      /stream failed/,
    )

    assert.equal(created.length, 1)
    assert.deepEqual(cleared, created)
  })
})
