import test from 'node:test'
import assert from 'node:assert/strict'
import {
  pushUniqueQueueValue,
  shiftQueueValue,
  spliceQueueValue,
} from '../apps/desktop/src/main/queue-map.ts'

test('pushUniqueQueueValue appends only new values for a key', () => {
  const map = new Map<string, string[]>()

  pushUniqueQueueValue(map, 'root', 'task-a')
  pushUniqueQueueValue(map, 'root', 'task-a')
  pushUniqueQueueValue(map, 'root', 'task-b')

  assert.deepEqual(map.get('root'), ['task-a', 'task-b'])
})

test('pushUniqueQueueValue accepts custom equality for object queues', () => {
  const map = new Map<string, Array<{ id: string; title: string }>>()

  pushUniqueQueueValue(map, 'root', { id: 'child-a', title: 'First' }, (left, right) => left.id === right.id)
  pushUniqueQueueValue(map, 'root', { id: 'child-a', title: 'Duplicate' }, (left, right) => left.id === right.id)

  assert.deepEqual(map.get('root'), [{ id: 'child-a', title: 'First' }])
})

test('shiftQueueValue returns the oldest value and deletes empty queues', () => {
  const map = new Map<string, string[]>([['root', ['task-a', 'task-b']]])

  assert.equal(shiftQueueValue(map, 'root'), 'task-a')
  assert.deepEqual(map.get('root'), ['task-b'])
  assert.equal(shiftQueueValue(map, 'root'), 'task-b')
  assert.equal(map.has('root'), false)
})

test('spliceQueueValue removes the matched value and keeps queue order', () => {
  const map = new Map<string, string[]>([['root', ['task-a', 'task-b', 'task-c']]])

  assert.equal(spliceQueueValue(map, 'root', (value) => value === 'task-b'), 'task-b')
  assert.deepEqual(map.get('root'), ['task-a', 'task-c'])
  assert.equal(spliceQueueValue(map, 'root', (value) => value === 'task-missing'), null)
  assert.deepEqual(map.get('root'), ['task-a', 'task-c'])
})
