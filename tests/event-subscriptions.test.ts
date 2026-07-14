import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('event subscription manager maintains one native stream for repeated ensures of the same directory', async () => {
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

test('event subscription manager maintains independent native streams per OpenCode directory', async () => {
  const attempts: string[] = []
  const aborted: string[] = []
  const manager = createRuntimeEventSubscriptionManager({
    getMainWindow: () => null,
    subscribe: async (_client, _getMainWindow, signal, directory) => {
      const key = directory || '__runtime_home__'
      attempts.push(key)
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted.push(key)
          resolve()
        }, { once: true })
      })
    },
    onError: () => 'restart-runtime',
  })

  manager.ensure('/runtime/home', { id: 'home' } as any)
  manager.ensure('/workspace/project-a', { id: 'project-a' } as any)
  await waitForCondition(() => attempts.length === 2)

  assert.deepEqual(attempts.sort(), ['/runtime/home', '/workspace/project-a'])
  assert.equal(manager.count(), 2)
  assert.equal(manager.has('/runtime/home'), true)
  assert.equal(manager.has('/workspace/project-a'), true)

  manager.stop('/workspace/project-a')
  await waitForCondition(() => aborted.includes('/workspace/project-a'))
  assert.equal(manager.has('/workspace/project-a'), false)
  assert.equal(manager.has('/runtime/home'), true)
  assert.equal(manager.count(), 1)

  manager.reset()
  await waitForCondition(() => aborted.includes('/runtime/home'))
})

test('desktop main wires scoped client creation and eviction to event subscriptions', () => {
  const source = readFileSync('apps/desktop/src/main/index.ts', 'utf8')

  assert.match(source, /setDirectoryClientLifecycleHandlers\(\{[\s\S]*onCreate:[\s\S]*eventSubscriptions\.ensure\(directory, client\)[\s\S]*onEvict:[\s\S]*eventSubscriptions\.stop\(directory\)[\s\S]*\}\)/)
  assert.doesNotMatch(source, /`\/api\/event` is server-wide/)
})
