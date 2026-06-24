import test from 'node:test'
import assert from 'node:assert/strict'

import { CloudSseReplayHub } from '@open-cowork/cloud-server/sse-replay'

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

test('SSE replay hub catches up a late subscriber that joins during an in-flight poll', async () => {
  const hub = new CloudSseReplayHub()
  const events = [
    { sequence: 1 },
    { sequence: 2 },
    { sequence: 3 },
  ]
  const loadCalls: number[] = []
  let releaseFirstLoad: (() => void) | null = null
  const firstLoad = new Promise<void>((resolve) => {
    releaseFirstLoad = resolve
  })
  const first: number[] = []
  const second: number[] = []
  const loadEvents = async (afterSequence: number) => {
    loadCalls.push(afterSequence)
    if (loadCalls.length === 1) await firstLoad
    return events.filter((event) => event.sequence > afterSequence)
  }

  const unsubscribeFirst = hub.subscribe({
    key: 'workspace:tenant:user:race',
    afterSequence: 2,
    pollMs: 50,
    loadEvents,
    listener: (event) => first.push(event.sequence),
  })
  try {
    await waitFor(() => loadCalls.length === 1, 'first in-flight replay poll')
    const unsubscribeSecond = hub.subscribe({
      key: 'workspace:tenant:user:race',
      afterSequence: 0,
      pollMs: 50,
      loadEvents,
      listener: (event) => second.push(event.sequence),
    })
    try {
      releaseFirstLoad?.()
      await waitFor(() => second.length === 3, 'late subscriber race replay')
      assert.deepEqual(loadCalls, [2, 0])
      assert.deepEqual(first, [3])
      assert.deepEqual(second, [1, 2, 3])
    } finally {
      unsubscribeSecond()
    }
  } finally {
    unsubscribeFirst()
    hub.close()
  }
})
