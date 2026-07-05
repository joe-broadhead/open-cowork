import test from 'node:test'
import assert from 'node:assert/strict'

import { createDeliverySubscriber } from '../dist/index.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type FakeSub = {
  handlers: { onDelivery: (delivery: unknown) => void; onError: () => void; onClose: () => void }
  closed: boolean
  close(): void
}

test('delivery subscriber resubscribes on clean close and on error, then stops after close', async () => {
  const opens: FakeSub[] = []
  const healthy: boolean[] = []
  const delivered: number[] = []
  let errorMetrics = 0

  const subscriber = createDeliverySubscriber({
    subscribe: (handlers) => {
      const sub: FakeSub = { handlers, closed: false, close() { this.closed = true } }
      opens.push(sub)
      return sub
    },
    onDelivery: (delivery) => delivered.push((delivery as { id: number }).id),
    onHealthy: (value) => healthy.push(value),
    onError: () => { errorMetrics += 1 },
    retryDelayMs: 1,
    maxRetryDelayMs: 1,
    random: () => 0,
    watchdogMs: 1_000_000, // disable the watchdog for this test
  })

  subscriber.start()
  assert.equal(opens.length, 1)
  assert.equal(healthy.at(-1), true)

  // A clean server close is expected churn: resubscribe WITHOUT inflating the error metric.
  opens[0]!.handlers.onClose()
  assert.equal(healthy.at(-1), false)
  await sleep(25)
  assert.equal(opens.length, 2)
  assert.equal(errorMetrics, 0)
  assert.equal(healthy.at(-1), true)

  // An error increments the metric and resubscribes.
  opens[1]!.handlers.onError()
  assert.equal(errorMetrics, 1)
  await sleep(25)
  assert.equal(opens.length, 3)

  // A live delivery forwards through and keeps the pipe healthy.
  opens[2]!.handlers.onDelivery({ id: 7 })
  assert.deepEqual(delivered, [7])
  assert.equal(healthy.at(-1), true)

  // After close the current subscription is torn down and a late callback must NOT resubscribe.
  subscriber.close()
  assert.equal(opens[2]!.closed, true)
  opens[2]!.handlers.onClose()
  await sleep(25)
  assert.equal(opens.length, 3)
})

test('delivery subscriber rotates a connection that goes quiet past the watchdog window', async () => {
  const opens: FakeSub[] = []
  let clock = 1_000
  const subscriber = createDeliverySubscriber({
    subscribe: (handlers) => {
      const sub: FakeSub = { handlers, closed: false, close() { this.closed = true } }
      opens.push(sub)
      return sub
    },
    onDelivery: () => {},
    onHealthy: () => {},
    now: () => clock,
    watchdogMs: 5,
  })

  subscriber.start()
  assert.equal(opens.length, 1)
  // Advance the injected clock past the watchdog window; the next interval tick rotates the socket.
  clock += 10_000
  await sleep(40)
  assert.ok(opens.length >= 2, `expected a watchdog rotation, got ${opens.length}`)
  assert.equal(opens[0]!.closed, true)
  subscriber.close()
})
