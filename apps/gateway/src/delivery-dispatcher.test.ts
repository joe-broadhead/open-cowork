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

test('delivery dispatcher rotates freed slots across lanes so a hot lane cannot starve later ones (#858)', async () => {
  const startOrder: string[] = []
  const gates = new Map<string, () => void>()
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 1,
    handle: async (delivery) => {
      const id = (delivery as { deliveryId: string }).deliveryId
      startOrder.push(id)
      await new Promise<void>((resolve) => gates.set(id, resolve))
    },
  })

  // Lane A is "hot" (a backlog of three); lanes B and C arrive after A is already busy. The old
  // pump re-scanned the lanes Map from the front on every freed slot, so A won every slot and B/C
  // starved until A drained. Fair rotation must serve B and C before A's second delivery.
  for (const id of ['a1', 'a2', 'a3']) dispatcher.enqueue(makeDelivery('A', { chat: 1 }, id))
  dispatcher.enqueue(makeDelivery('B', { chat: 1 }, 'b1'))
  dispatcher.enqueue(makeDelivery('C', { chat: 1 }, 'c1'))

  for (const expected of ['a1', 'b1', 'c1', 'a2', 'a3']) {
    await tick()
    assert.equal(startOrder.at(-1), expected)
    gates.get(expected)!()
  }
  await dispatcher.drain(1_000)
  assert.deepEqual(startOrder, ['a1', 'b1', 'c1', 'a2', 'a3'])
})

test('delivery dispatcher keeps rotating under sustained enqueues to a hot lane (#858)', async () => {
  const startOrder: string[] = []
  const gates = new Map<string, () => void>()
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 1,
    handle: async (delivery) => {
      const id = (delivery as { deliveryId: string }).deliveryId
      startOrder.push(id)
      await new Promise<void>((resolve) => gates.set(id, resolve))
    },
  })

  // Lane A stays continuously hot: every time one of its deliveries starts, another is enqueued
  // behind it. Lane B, enqueued once, must still get the very next freed slot.
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'a1'))
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'a2'))
  dispatcher.enqueue(makeDelivery('B', { chat: 1 }, 'b1'))
  await tick()
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'a3')) // arrives while a1 is in-flight
  gates.get('a1')!()
  await tick()
  assert.equal(startOrder.at(-1), 'b1') // B was not starved by the refreshed A backlog
  gates.get('b1')!()
  await tick()
  gates.get('a2')!()
  await tick()
  gates.get('a3')!()
  await dispatcher.drain(1_000)
  assert.deepEqual(startOrder, ['a1', 'b1', 'a2', 'a3'])
})

test('delivery dispatcher drops a re-served deliveryId that is still queued or in-flight (#857)', async () => {
  const handled: string[] = []
  const duplicates: string[] = []
  const gates = new Map<string, () => void>()
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 1,
    handle: async (delivery) => {
      const id = (delivery as { deliveryId: string }).deliveryId
      handled.push(id)
      await new Promise<void>((resolve) => gates.set(id, resolve))
    },
    onDuplicate: (delivery) => duplicates.push((delivery as { deliveryId: string }).deliveryId),
  })

  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'd1'))
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'd2'))
  await tick()
  // d1 is in-flight and d2 is queued; a claim-TTL lapse re-serves both — neither may double-send.
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'd1'))
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'd2'))
  await tick()
  assert.deepEqual(duplicates, ['d1', 'd2'])
  gates.get('d1')!()
  await tick()
  gates.get('d2')!()
  await dispatcher.drain(1_000)
  assert.deepEqual(handled, ['d1', 'd2'])

  // After a delivery settles it is no longer pending: a later re-serve (e.g. a cloud-side retry of
  // a failed attempt) must be processed again — the guard never weakens at-least-once delivery.
  dispatcher.enqueue(makeDelivery('A', { chat: 1 }, 'd1'))
  await tick()
  assert.deepEqual(handled, ['d1', 'd2', 'd1'])
  gates.get('d1')!()
  await dispatcher.drain(1_000)
  assert.deepEqual(duplicates, ['d1', 'd2'])
})

test('delivery dispatcher sheds deliveries past maxQueueDepth instead of growing unbounded (P1-C)', async () => {
  const handled: string[] = []
  const shed: string[] = []
  let release: () => void = () => {}
  const dispatcher = createDeliveryDispatcher({
    maxConcurrency: 1,
    maxQueueDepth: 2,
    handle: async (delivery) => {
      handled.push((delivery as { deliveryId: string }).deliveryId)
      await new Promise<void>((resolve) => { release = resolve })
    },
    onShed: (delivery) => shed.push((delivery as { deliveryId: string }).deliveryId),
  })

  // d1 starts (concurrency 1, blocks); d2 + d3 fill the queue (cap 2); d4 + d5 are shed
  // (left unacked for the cloud to re-serve) rather than growing the heap without bound.
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) dispatcher.enqueue(makeDelivery('A', { chat: 1 }, id))
  await tick()
  assert.deepEqual(shed, ['d4', 'd5'])
  assert.deepEqual(handled, ['d1'])
  release()
})
