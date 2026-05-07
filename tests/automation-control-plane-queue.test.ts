import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoalescedControlPlaneTask } from '../apps/desktop/src/main/automation-control-plane-queue.ts'
import { createPromiseChain } from '../apps/desktop/src/main/promise-chain.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => { resolve = next })
  return { promise, resolve }
}

test('coalesced control-plane task drops duplicate ticks while one is pending', async () => {
  const release = deferred()
  const task = createCoalescedControlPlaneTask(createPromiseChain())
  const events: string[] = []

  const first = task.run(async () => {
    events.push('first:start')
    await release.promise
    events.push('first:end')
  })
  await Promise.resolve()

  const duplicate = await task.run(async () => {
    events.push('duplicate')
  })
  assert.equal(duplicate, false)
  assert.equal(task.isPending(), true)

  release.resolve()
  assert.equal(await first, true)
  assert.equal(task.isPending(), false)
  assert.deepEqual(events, ['first:start', 'first:end'])
})

test('coalesced control-plane tasks share the serial runner across task kinds', async () => {
  const release = deferred()
  const runSerially = createPromiseChain()
  const scheduler = createCoalescedControlPlaneTask(runSerially)
  const heartbeat = createCoalescedControlPlaneTask(runSerially)
  const events: string[] = []

  const first = scheduler.run(async () => {
    events.push('scheduler:start')
    await release.promise
    events.push('scheduler:end')
  })
  await Promise.resolve()

  const second = heartbeat.run(async () => {
    events.push('heartbeat')
  })
  await Promise.resolve()
  assert.deepEqual(events, ['scheduler:start'])

  release.resolve()
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.deepEqual(events, ['scheduler:start', 'scheduler:end', 'heartbeat'])
})

test('coalesced control-plane task clears pending state after failures', async () => {
  const task = createCoalescedControlPlaneTask(createPromiseChain())

  await assert.rejects(
    task.run(async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(task.isPending(), false)

  const ran = await task.run(async () => {})
  assert.equal(ran, true)
})
