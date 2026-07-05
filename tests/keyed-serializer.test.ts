import test from 'node:test'
import assert from 'node:assert/strict'

import { createKeyedSerializer } from '../apps/desktop/src/main/keyed-serializer.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => { resolve = res })
  return { promise, resolve }
}

test('keyed serializer runs same-key tasks sequentially in submission order', async () => {
  const serializer = createKeyedSerializer()
  const order: string[] = []
  const gateA = deferred()
  const gateB = deferred()
  const t1 = serializer.run('k', async () => { order.push('start1'); await gateA.promise; order.push('end1') })
  const t2 = serializer.run('k', async () => { order.push('start2'); await gateB.promise; order.push('end2') })

  await tick()
  assert.deepEqual(order, ['start1']) // t2 is serialized behind t1, not started yet
  gateA.resolve()
  await tick()
  assert.deepEqual(order, ['start1', 'end1', 'start2'])
  gateB.resolve()
  await Promise.all([t1, t2])
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2'])
})

test('keyed serializer runs different keys concurrently', async () => {
  const serializer = createKeyedSerializer()
  const started: string[] = []
  const gate = deferred()
  const a = serializer.run('a', async () => { started.push('a'); await gate.promise })
  const b = serializer.run('b', async () => { started.push('b'); await gate.promise })
  await tick()
  assert.deepEqual([...started].sort(), ['a', 'b'])
  gate.resolve()
  await Promise.all([a, b])
})

test('keyed serializer keeps the lane alive after a task throws and self-cleans', async () => {
  const serializer = createKeyedSerializer()
  await assert.rejects(serializer.run('k', async () => { throw new Error('boom') }), /boom/)
  assert.equal(await serializer.run('k', async () => 'ok'), 'ok')
  await tick()
  assert.equal(serializer.size(), 0)
})

test('keyed serializer prevents lost updates across an async read-modify-write', async () => {
  const serializer = createKeyedSerializer()
  let store: string[] = []
  const rmw = (item: string) => serializer.run('items', async () => {
    const current = [...store] // read
    await tick() // async gap where a naive unserialized RMW would interleave and last-write-win
    store = [...current, item] // write
  })
  await Promise.all([rmw('a'), rmw('b')])
  assert.deepEqual([...store].sort(), ['a', 'b']) // both survived — neither was lost-updated
})
