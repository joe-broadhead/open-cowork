import test from 'node:test'
import assert from 'node:assert/strict'

import { setRenderStateEntry } from './render/state.ts'

test('setRenderStateEntry evicts the least-recently-set entry when over the cap', () => {
  const map = new Map<string, number>()
  for (let index = 0; index < 5; index += 1) {
    setRenderStateEntry(map, `key-${index}`, index, 3)
  }
  // Only the three most-recently-set keys survive.
  assert.deepEqual([...map.keys()], ['key-2', 'key-3', 'key-4'])
})

test('setRenderStateEntry treats a re-set as a touch so active keys are not evicted', () => {
  const map = new Map<string, number>()
  setRenderStateEntry(map, 'a', 1, 3)
  setRenderStateEntry(map, 'b', 1, 3)
  setRenderStateEntry(map, 'c', 1, 3)
  // Touch 'a' — it moves to newest, so the next insert evicts 'b' (now oldest), not 'a'.
  setRenderStateEntry(map, 'a', 2, 3)
  setRenderStateEntry(map, 'd', 1, 3)
  assert.deepEqual([...map.keys()], ['c', 'a', 'd'])
  assert.equal(map.get('a'), 2)
})
