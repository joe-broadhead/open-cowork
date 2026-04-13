import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPerfSnapshot,
  incrementPerfCounter,
  measureAsyncPerf,
  observePerf,
  resetPerfMetrics,
} from '../apps/desktop/src/main/perf-metrics.ts'

test('perf metrics snapshot tracks counters and rolling distribution summaries', async () => {
  resetPerfMetrics()

  incrementPerfCounter('session.patch.published')
  incrementPerfCounter('session.patch.published', 2)

  observePerf('session.activate.warm', 4, { unit: 'ms', slowThresholdMs: 50 })
  observePerf('session.activate.warm', 6, { unit: 'ms', slowThresholdMs: 50 })
  observePerf('session.activate.warm', 8, { unit: 'ms', slowThresholdMs: 50 })

  await measureAsyncPerf('session.view.flush.duration', async () => {
    await Promise.resolve()
  }, { slowThresholdMs: 0 })

  const snapshot = getPerfSnapshot()
  const patchCounter = snapshot.counters.find((entry) => entry.name === 'session.patch.published')
  const activateMetric = snapshot.distributions.find((entry) => entry.name === 'session.activate.warm')
  const flushMetric = snapshot.distributions.find((entry) => entry.name === 'session.view.flush.duration')

  assert.ok(patchCounter)
  assert.equal(patchCounter.value, 3)

  assert.ok(activateMetric)
  assert.equal(activateMetric.unit, 'ms')
  assert.equal(activateMetric.count, 3)
  assert.equal(activateMetric.samplesTracked, 3)
  assert.equal(activateMetric.min, 4)
  assert.equal(activateMetric.max, 8)
  assert.equal(activateMetric.p50, 6)
  assert.equal(activateMetric.p95, 8)
  assert.equal(activateMetric.slowCount, 0)

  assert.ok(flushMetric)
  assert.equal(flushMetric.count, 1)
  assert.equal(flushMetric.slowCount, 1)
})

test('perf metrics snapshot keeps only a bounded rolling sample window', () => {
  resetPerfMetrics()

  for (let i = 1; i <= 140; i += 1) {
    observePerf('session.view.flush.batch_size', i, { unit: 'count' })
  }

  const snapshot = getPerfSnapshot()
  const metric = snapshot.distributions.find((entry) => entry.name === 'session.view.flush.batch_size')

  assert.ok(metric)
  assert.equal(metric.count, 140)
  assert.equal(metric.samplesTracked, 128)
  assert.equal(metric.min, 1)
  assert.equal(metric.max, 140)
})
