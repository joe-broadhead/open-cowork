import assert from 'node:assert/strict'
import test from 'node:test'
import { findOnlyIndexedCandidate } from '../apps/desktop/src/main/task-binding-policy.ts'

test('findOnlyIndexedCandidate returns the single entry without inspecting metadata', () => {
  assert.equal(findOnlyIndexedCandidate([{ title: 'Only task', agent: null }]), 0)
})

test('findOnlyIndexedCandidate refuses multiple candidates even when metadata differs', () => {
  const entries = [
    { title: 'Prepare forecast', agent: 'analyst' },
    { title: 'Build chart pack', agent: 'charts' },
  ]

  assert.equal(findOnlyIndexedCandidate(entries), -1)
})

test('findOnlyIndexedCandidate refuses empty candidate lists', () => {
  assert.equal(findOnlyIndexedCandidate([]), -1)
})
