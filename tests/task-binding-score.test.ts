import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeBindingScore,
  findBestIndexedMatch,
} from '../apps/desktop/src/main/task-binding-score.ts'

test('computeBindingScore rewards exact normalized agent and title matches', () => {
  assert.equal(
    computeBindingScore(
      { title: 'Build chart pack', agent: 'charts' },
      { title: 'Build chart pack', agent: 'Charts' },
    ),
    7,
  )
})

test('computeBindingScore does not score partial title matches', () => {
  assert.equal(
    computeBindingScore(
      { title: 'Prepare European forecast', agent: null },
      { title: 'European forecast' },
    ),
    0,
  )
})

test('findBestIndexedMatch returns the single entry even without hints', () => {
  assert.equal(findBestIndexedMatch([{ title: 'Only task', agent: null }]), 0)
})

test('findBestIndexedMatch selects the strongest non-ambiguous candidate', () => {
  const entries = [
    { title: 'Prepare forecast', agent: 'analyst' },
    { title: 'Build chart pack', agent: 'charts' },
  ]

  assert.equal(findBestIndexedMatch(entries, {
    title: 'Build chart pack',
    agent: 'charts',
  }), 1)
})

test('findBestIndexedMatch refuses ambiguous matches', () => {
  const entries = [
    { title: 'Build chart pack', agent: 'charts' },
    { title: 'Build chart pack', agent: 'charts' },
  ]

  assert.equal(findBestIndexedMatch(entries, {
    title: 'Build chart pack',
    agent: 'charts',
  }), -1)
})
