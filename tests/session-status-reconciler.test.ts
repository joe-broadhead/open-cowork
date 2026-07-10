import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createSessionStatusReconciler } from '../apps/desktop/src/main/session-status-coordinator.ts'

test('session status reconciler resolves a stuck busy session when status becomes idle', async () => {
  let lookups = 0
  let idleCalls = 0
  const statuses = ['busy', 'busy', 'idle']

  const reconciler = createSessionStatusReconciler(async () => {
    const status = statuses[Math.min(lookups, statuses.length - 1)]
    lookups += 1
    return status
  })

  reconciler.start('session-1', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    onIdle: async () => {
      idleCalls += 1
    },
  })

  const deadline = Date.now() + 1000
  while (Date.now() < deadline && idleCalls === 0) {
    await sleep(5)
  }

  assert.equal(lookups >= 3, true)
  assert.equal(idleCalls, 1)
  assert.equal(reconciler.has('session-1'), false)
})

test('session status reconciler ignores duplicate starts for the same session', async () => {
  let lookups = 0
  let idleCalls = 0

  const reconciler = createSessionStatusReconciler(async () => {
    lookups += 1
    return 'idle'
  })

  reconciler.start('session-2', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    onIdle: () => {
      idleCalls += 1
    },
  })

  reconciler.start('session-2', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    onIdle: () => {
      idleCalls += 10
    },
  })

  await sleep(10)

  assert.equal(lookups, 1)
  assert.equal(idleCalls, 1)
})

test('session status reconciler stops polling when a session is cancelled', async () => {
  let lookups = 0

  const reconciler = createSessionStatusReconciler(async () => {
    lookups += 1
    return 'busy'
  })

  reconciler.start('session-3', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    onIdle: () => {},
  })

  await sleep(5)
  reconciler.stop('session-3')
  const stoppedAt = lookups
  await sleep(10)

  assert.equal(reconciler.has('session-3'), false)
  assert.equal(lookups, stoppedAt)
})

test('session status reconciler abandons a session that keeps returning null (deleted / runtime gone)', async () => {
  let lookups = 0
  let abandoned: string | null = null

  const reconciler = createSessionStatusReconciler(async () => {
    lookups += 1
    return null
  })

  reconciler.start('session-null', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    maxConsecutiveMisses: 3,
    onIdle: () => {},
    onAbandon: (reason) => {
      abandoned = reason
    },
  })

  const deadline = Date.now() + 1000
  while (Date.now() < deadline && reconciler.has('session-null')) {
    await sleep(5)
  }

  assert.equal(abandoned, 'misses-exceeded')
  assert.equal(reconciler.has('session-null'), false)
  // Bounded: initial poll + at most maxConsecutiveMisses follow-ups, not infinite.
  assert.equal(lookups <= 5, true)

  const settledAt = lookups
  await sleep(15)
  assert.equal(lookups, settledAt)
})

test('session status reconciler keeps polling a running session and does not abandon on the miss cap', async () => {
  let lookups = 0
  let idleCalls = 0
  // A run that stays busy well past the miss cap, then goes idle — a non-null
  // status must reset the miss counter so a live session is never abandoned.
  const reconciler = createSessionStatusReconciler(async () => {
    lookups += 1
    return lookups >= 6 ? 'idle' : 'busy'
  })

  reconciler.start('session-live', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    maxConsecutiveMisses: 2,
    onIdle: () => {
      idleCalls += 1
    },
  })

  const deadline = Date.now() + 1000
  while (Date.now() < deadline && idleCalls === 0) {
    await sleep(5)
  }

  assert.equal(idleCalls, 1)
  assert.equal(lookups >= 6, true)
  assert.equal(reconciler.has('session-live'), false)
})

test('session status reconciler retries after transient lookup errors and still resolves idle', async () => {
  let lookups = 0
  let errors = 0
  let idleCalls = 0

  const reconciler = createSessionStatusReconciler(async () => {
    lookups += 1
    if (lookups === 1) {
      throw new Error('network drop')
    }
    return lookups >= 3 ? 'idle' : 'busy'
  })

  reconciler.start('session-4', {
    initialDelayMs: 1,
    maxDelayMs: 1,
    onIdle: () => {
      idleCalls += 1
    },
    onError: () => {
      errors += 1
    },
  })

  const deadline = Date.now() + 1000
  while (Date.now() < deadline && idleCalls === 0) {
    await sleep(5)
  }

  assert.equal(errors, 1)
  assert.equal(idleCalls, 1)
  assert.equal(reconciler.has('session-4'), false)
})
