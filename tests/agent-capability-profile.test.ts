import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeAgentCapabilityProfile,
  scoreModelContextWindow,
} from '../packages/shared/dist/index.js'

const fixture = {
  scope: 'machine' as const,
  directory: null,
  name: 'market-analyst',
  description: 'Analyzes markets.',
  instructions: 'Use evidence.',
  skillNames: ['research', 'charts'],
  toolIds: ['web', 'warehouse', 'sheets'],
  enabled: true,
  color: 'accent' as const,
  model: 'acme/frontier',
  variant: null,
  temperature: 0.2,
  steps: 30,
}

test('agent capability profile is deterministic for the same config and model metadata', () => {
  const model = { limit: { context: 200_000 } }
  const first = computeAgentCapabilityProfile(fixture, model)
  const second = computeAgentCapabilityProfile({ ...fixture }, { ...model })

  assert.deepEqual(second, first)
  assert.equal(first.score, 56)
  assert.deepEqual(
    first.axes.map((axis) => [axis.id, axis.value, axis.raw]),
    [
      ['reach', 3, '3 tools'],
      ['skills', 2, '2 skills'],
      ['context', 3, '200K ctx'],
      ['autonomy', 2.2727, '30 steps'],
      ['precision', 4, 'temp 0.20'],
    ],
  )
})

test('context scoring uses only provider-reported context limits', () => {
  assert.equal(scoreModelContextWindow(undefined), 3)
  assert.equal(scoreModelContextWindow(16_000), 1)
  assert.equal(scoreModelContextWindow(64_000), 2)
  assert.equal(scoreModelContextWindow(200_000), 3)
  assert.equal(scoreModelContextWindow(500_000), 4)
  assert.equal(scoreModelContextWindow(1_000_000), 5)
})

test('agent capability profile clamps inherited or out-of-range controls', () => {
  const profile = computeAgentCapabilityProfile({
    ...fixture,
    toolIds: Array.from({ length: 9 }, (_, index) => `tool-${index}`),
    skillNames: Array.from({ length: 7 }, (_, index) => `skill-${index}`),
    temperature: 2,
    steps: 120,
  }, { contextLength: 1_000_000 })

  assert.equal(profile.score, 84)
  assert.equal(profile.axes.find((axis) => axis.id === 'reach')?.value, 5)
  assert.equal(profile.axes.find((axis) => axis.id === 'skills')?.value, 5)
  assert.equal(profile.axes.find((axis) => axis.id === 'context')?.value, 5)
  assert.equal(profile.axes.find((axis) => axis.id === 'autonomy')?.value, 5)
  assert.equal(profile.axes.find((axis) => axis.id === 'precision')?.value, 0)
})
