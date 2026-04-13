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

  await sleep(20)

  assert.equal(lookups, 3)
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
