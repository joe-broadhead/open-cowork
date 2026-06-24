import test from 'node:test'
import assert from 'node:assert/strict'

import { createDeliveryDispatcher, type DeliveryDispatcher } from '../dist/index.js'

type Delivery = Parameters<DeliveryDispatcher['enqueue']>[0]

const makeDelivery = (channelBindingId: string, target: Record<string, unknown>, deliveryId: string): Delivery =>
  ({ deliveryId, channelBindingId, target } as unknown as Delivery)

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('delivery dispatcher serializes the same binding+target in arrival order', async () => {
  const order: string[] = []
  const gates = new Map<string, () => void>()
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 4,
    handle: async (delivery) => {
      const id = (delivery as { deliveryId: string }).deliveryId
      order.push(`start:${id}`)
      await new Promise<void>((resolve) => gates.set(id, resolve))
      order.push(`end:${id}`)
    },
  })

  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'a1'))
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'a2'))
  await tick()
  // Only the first delivery in the lane has started; the second waits its turn.
  assert.deepEqual(order, ['start:a1'])

  gates.get('a1')!()
  await tick()
  assert.deepEqual(order, ['start:a1', 'end:a1', 'start:a2'])

  gates.get('a2')!()
  await tick()
  assert.deepEqual(order, ['start:a1', 'end:a1', 'start:a2', 'end:a2'])
})

test('delivery dispatcher runs different binding+targets concurrently', async () => {
  const started = new Set<string>()
  const gates = new Map<string, () => void>()
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 4,
    handle: async (delivery) => {
      const id = (delivery as { deliveryId: string }).deliveryId
      started.add(id)
      await new Promise<void>((resolve) => gates.set(id, resolve))
    },
  })

  // Same binding, different targets → independent lanes that may run in parallel.
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'x'))
  dispatcher.enqueue(makeDelivery('A', { chat: 2 }, 'y'))
  await tick()
  assert.deepEqual([...started].sort(), ['x', 'y'])
  gates.get('x')!()
  gates.get('y')!()
  await dispatcher.drain(1_000)
})

test('delivery dispatcher caps global concurrency and drain waits for completion', async () => {
  let active = 0
  let maxActive = 0
  let release: () => void = () => {}
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 2,
    handle: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await barrier
      active -= 1
    },
  })

  // Four independent lanes would all run at once without the cap.
  for (let index = 0; index < 4; index += 1) {
    dispatcher.enqueue(makeDelivery(`B${index}`, {}, `b${index}`))
  }
  await tick()
  assert.equal(maxActive, 2)

  release()
  await dispatcher.drain(1_000)
  assert.equal(maxActive, 2)
  assert.equal(active, 0)
})
