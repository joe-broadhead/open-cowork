import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFeatureValueReview,
  parseFeatureValueCollectorExport,
  renderFeatureValueReview,
} from '../scripts/report-feature-value.mjs'

const featureValueEvent = (feature: string, stage: string) => JSON.stringify({
  schema: 'adoption/v2',
  ts: '2026-08-01T12:00:00.000Z',
  event: 'feature.value',
  props: { feature, stage },
})

test('feature-value report reads collector NDJSON and ignores unrelated events', () => {
  const parsed = parseFeatureValueCollectorExport([
    featureValueEvent('projects', 'discovered'),
    JSON.stringify({ schema: 'adoption/v2', event: 'app.ready', props: {} }),
    featureValueEvent('projects', 'activated'),
    featureValueEvent('projects', 'repeated'),
  ].join('\n'))
  const review = buildFeatureValueReview(parsed)
  const projects = review.rows.find((row) => row.feature === 'projects')

  assert.equal(review.sourceRecords, 4)
  assert.equal(review.featureValueEvents, 3)
  assert.equal(review.ignoredRecords, 1)
  assert.equal(review.decisionPolicy.automaticRemoval, false)
  assert.match(projects?.outcome || '', /organizes work/i)
  assert.match(projects?.denominator || '', /^Installations/)
  assert.deepEqual(projects && {
    discovered: projects.discovered,
    activated: projects.activated,
    repeated: projects.repeated,
    activationRate: projects.activationRate,
    repeatRate: projects.repeatRate,
    evidence: projects.evidence,
  }, {
    discovered: 1,
    activated: 1,
    repeated: 1,
    activationRate: 1,
    repeatRate: 1,
    evidence: 'partial',
  })
  assert.match(renderFeatureValueReview(review), /projects \| partial \| 1 \| 1 \| 100\.0% \| 1 \| 100\.0%/)
  assert.match(renderFeatureValueReview(review), /anonymous delivery is at-least-once/i)
})

test('feature-value report labels lossy or windowed funnels as partial', () => {
  const parsed = parseFeatureValueCollectorExport([
    featureValueEvent('projects', 'discovered'),
    featureValueEvent('projects', 'activated'),
    featureValueEvent('projects', 'activated'),
  ].join('\n'))
  const review = buildFeatureValueReview(parsed)
  const projects = review.rows.find((row) => row.feature === 'projects')

  assert.equal(projects?.evidence, 'partial')
  assert.equal(projects?.activationRate, null)
  assert.match(renderFeatureValueReview(review), /projects \| partial \| 1 \| 2 \| —/)
})

test('feature-value report accepts JSON arrays and rejects malformed value events without echoing them', () => {
  const array = JSON.stringify([
    JSON.parse(featureValueEvent('voice', 'discovered')),
  ])
  assert.equal(parseFeatureValueCollectorExport(array).events.length, 1)

  assert.throws(
    () => parseFeatureValueCollectorExport(JSON.stringify({
      schema: 'adoption/v2',
      event: 'feature.value',
      props: { feature: 'projects', stage: 'activated', prompt: 'secret text' },
    })),
    (error: unknown) => error instanceof Error
      && error.message === 'Invalid adoption/v2 feature.value record.'
      && !error.message.includes('secret text'),
  )
})
