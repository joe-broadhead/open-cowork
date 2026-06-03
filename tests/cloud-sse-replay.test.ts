import test from 'node:test'
import assert from 'node:assert/strict'

import { CloudSseReplayHub } from '../apps/desktop/src/main/cloud/sse-replay.ts'

function waitFor(predicate: () => boolean, label: string) {
  const started = Date.now()
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - started > 500) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}.`))
      }
    }, 5)
  })
}

test('SSE replay hub replays from each subscriber cursor on an existing topic', async () => {
  const hub = new CloudSseReplayHub()
  const events = [
    { sequence: 1 },
    { sequence: 2 },
    { sequence: 3 },
  ]
  const first: number[] = []
  const second: number[] = []

  const unsubscribeFirst = hub.subscribe({
    key: 'workspace:tenant:user',
    afterSequence: 2,
    pollMs: 5,
    loadEvents: async (afterSequence) => events.filter((event) => event.sequence > afterSequence),
    listener: (event) => first.push(event.sequence),
  })
  try {
    await waitFor(() => first.includes(3), 'first subscriber replay')

    const unsubscribeSecond = hub.subscribe({
      key: 'workspace:tenant:user',
      afterSequence: 1,
      pollMs: 5,
      loadEvents: async (afterSequence) => events.filter((event) => event.sequence > afterSequence),
      listener: (event) => second.push(event.sequence),
    })
    try {
      await waitFor(() => second.includes(2) && second.includes(3), 'late subscriber replay')
      assert.deepEqual(second, [2, 3])
    } finally {
      unsubscribeSecond()
    }
  } finally {
    unsubscribeFirst()
    hub.close()
  }
})
