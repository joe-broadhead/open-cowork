import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionSyncCoordinator } from '../apps/desktop/src/main/session-sync-coordinator.ts'

test('session sync coordinator dedupes concurrent sync requests for the same session', async () => {
  const calls: Array<{ sessionId: string; force: boolean }> = []
  let resolveSync: ((value: string) => void) | null = null

  const run = createSessionSyncCoordinator<string>((sessionId, options) => {
    calls.push({ sessionId, force: options.force })
    return new Promise((resolve) => {
      resolveSync = resolve
    })
  })

  const first = run('session-1')
  const second = run('session-1')

  assert.equal(first, second)
  assert.deepEqual(calls, [{ sessionId: 'session-1', force: false }])

  resolveSync?.('synced')
  assert.equal(await first, 'synced')
})

test('session sync coordinator queues a forced rerun behind an inflight warm sync', async () => {
  const calls: Array<{ sessionId: string; force: boolean }> = []
  const resolvers: Array<(value: string) => void> = []

  const run = createSessionSyncCoordinator<string>((sessionId, options) => {
    calls.push({ sessionId, force: options.force })
    return new Promise((resolve) => {
      resolvers.push(resolve)
    })
  })

  const initial = run('session-2')
  const forced = run('session-2', { force: true })

  assert.equal(initial, forced)
  assert.deepEqual(calls, [{ sessionId: 'session-2', force: false }])

  resolvers.shift()?.('warm')
  await Promise.resolve()

  assert.deepEqual(calls, [
    { sessionId: 'session-2', force: false },
    { sessionId: 'session-2', force: true },
  ])

  resolvers.shift()?.('forced')
  assert.equal(await forced, 'forced')
})

test('session sync coordinator isolates inflight work by session id', async () => {
  const calls: Array<{ sessionId: string; force: boolean }> = []
  const resolvers = new Map<string, (value: string) => void>()

  const run = createSessionSyncCoordinator<string>((sessionId, options) => {
    calls.push({ sessionId, force: options.force })
    return new Promise((resolve) => {
      resolvers.set(sessionId, resolve)
    })
  })

  const first = run('session-a')
  const second = run('session-b', { force: true })

  assert.deepEqual(calls, [
    { sessionId: 'session-a', force: false },
    { sessionId: 'session-b', force: true },
  ])

  resolvers.get('session-a')?.('a')
  resolvers.get('session-b')?.('b')

  assert.equal(await first, 'a')
  assert.equal(await second, 'b')
})
