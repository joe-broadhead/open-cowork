import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeEventSubscriptionManager } from '../apps/desktop/src/main/event-subscriptions.ts'

async function waitForCondition(condition: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('event subscription manager retries scoped subscription failures without restarting the whole runtime', async () => {
  let attempts = 0
  const manager = createRuntimeEventSubscriptionManager({
    getMainWindow: () => null,
    retryDelayMs: 0,
    subscribe: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('temporary scoped stream failure')
      }
    },
    onError: () => 'retry-subscription',
  })

  manager.ensure('/tmp/project-a', {} as any)
  await waitForCondition(() => attempts >= 2)

  assert.equal(attempts, 2)
  assert.equal(manager.has('/tmp/project-a'), true)
  manager.reset()
  assert.equal(manager.count(), 0)
})

test('event subscription manager leaves runtime-level failures to the caller instead of retrying forever', async () => {
  let attempts = 0
  const manager = createRuntimeEventSubscriptionManager({
    getMainWindow: () => null,
    retryDelayMs: 0,
    subscribe: async () => {
      attempts += 1
      throw new Error('runtime stream failure')
    },
    onError: () => 'restart-runtime',
  })

  manager.ensure(null, {} as any)
  await waitForCondition(() => attempts >= 1)

  assert.equal(attempts, 1)
  assert.equal(manager.has(null), false)
  assert.equal(manager.count(), 0)
})

test('event subscription manager maintains one global native stream for repeated ensures', async () => {
  let attempts = 0
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => { release = resolve })
  const manager = createRuntimeEventSubscriptionManager({
    getMainWindow: () => null,
    subscribe: async () => {
      attempts += 1
      await pending
    },
    onError: () => 'restart-runtime',
  })
  const client = {} as any

  manager.ensure('/runtime/home', client)
  manager.ensure('/runtime/home', client)
  manager.ensure('/runtime/home', client)
  await waitForCondition(() => attempts === 1)

  assert.equal(attempts, 1)
  assert.equal(manager.count(), 1)
  release?.()
  manager.reset()
})
