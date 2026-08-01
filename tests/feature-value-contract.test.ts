import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEATURE_VALUE_DECISION_POLICY,
  FEATURE_VALUE_DEFINITIONS,
  FEATURE_VALUE_SURFACES,
  isFeatureValueEventInput,
  summarizeFeatureValueEvents,
} from '../packages/shared/src/feature-value-contract.ts'

test('feature-value contract defines an outcome, funnel, denominator, owner, and review date for every surface', () => {
  assert.deepEqual(Object.keys(FEATURE_VALUE_DEFINITIONS), [...FEATURE_VALUE_SURFACES])
  for (const feature of FEATURE_VALUE_SURFACES) {
    const definition = FEATURE_VALUE_DEFINITIONS[feature]
    assert.ok(definition.outcome.length > 20)
    assert.ok(definition.discovery.length > 20)
    assert.ok(definition.activation.length > 20)
    assert.ok(definition.repeat.length > 20)
    assert.ok(definition.denominator.startsWith('Installations'))
    assert.match(definition.reviewDate, /^2026-\d{2}-\d{2}$/)
  }
})

test('feature-value decision policy cannot automate removal before product approval', () => {
  assert.equal(FEATURE_VALUE_DECISION_POLICY.automaticRemoval, false)
  assert.equal(FEATURE_VALUE_DECISION_POLICY.minimumDiscoveryCount, null)
  assert.equal(FEATURE_VALUE_DECISION_POLICY.minimumActivationRate, null)
  assert.equal(FEATURE_VALUE_DECISION_POLICY.minimumRepeatRate, null)
  assert.match(FEATURE_VALUE_DECISION_POLICY.reason, /product owner.*approve/i)
})

test('feature-value event input accepts only fixed enums and no extra content', () => {
  assert.equal(isFeatureValueEventInput({ feature: 'projects', stage: 'activated' }), true)
  assert.equal(isFeatureValueEventInput({ feature: 'projects', stage: 'unknown' }), false)
  assert.equal(isFeatureValueEventInput({ feature: '/Users/alice', stage: 'activated' }), false)
  assert.equal(isFeatureValueEventInput({ feature: 'projects', stage: 'activated', sessionId: 'secret' }), false)
})

test('feature-value report keeps discovery, first success, and repeat success distinct', () => {
  const report = summarizeFeatureValueEvents([
    { feature: 'projects', stage: 'discovered' },
    { feature: 'projects', stage: 'discovered' },
    { feature: 'projects', stage: 'activated' },
    { feature: 'projects', stage: 'repeated' },
    { feature: 'voice', stage: 'discovered' },
  ])
  assert.deepEqual(report.find((row) => row.feature === 'projects'), {
    feature: 'projects',
    discovered: 2,
    activated: 1,
    repeated: 1,
    activationRate: 0.5,
    repeatRate: 1,
    evidence: 'partial',
  })
  assert.deepEqual(report.find((row) => row.feature === 'voice'), {
    feature: 'voice',
    discovered: 1,
    activated: 0,
    repeated: 0,
    activationRate: 0,
    repeatRate: null,
    evidence: 'partial',
  })
})

test('feature-value report preserves partial anonymous aggregates without inventing rates', () => {
  const report = summarizeFeatureValueEvents([
    { feature: 'projects', stage: 'discovered' },
    { feature: 'projects', stage: 'activated' },
    { feature: 'projects', stage: 'activated' },
    { feature: 'voice', stage: 'discovered' },
    { feature: 'voice', stage: 'repeated' },
  ])

  assert.deepEqual(report.find((row) => row.feature === 'projects'), {
    feature: 'projects',
    discovered: 1,
    activated: 2,
    repeated: 0,
    activationRate: null,
    repeatRate: 0,
    evidence: 'partial',
  })
  assert.deepEqual(report.find((row) => row.feature === 'voice'), {
    feature: 'voice',
    discovered: 1,
    activated: 0,
    repeated: 1,
    activationRate: 0,
    repeatRate: null,
    evidence: 'partial',
  })
})

test('feature-value report never claims complete cohort evidence from anonymous events', () => {
  const empty = summarizeFeatureValueEvents([])
  assert.ok(empty.every((row) => row.evidence === 'no-data'))
  assert.ok(empty.every((row) => row.activationRate === null && row.repeatRate === null))

  const observed = summarizeFeatureValueEvents([
    { feature: 'projects', stage: 'discovered' },
    { feature: 'projects', stage: 'activated' },
  ])
  assert.equal(observed.find((row) => row.feature === 'projects')?.evidence, 'partial')
})
