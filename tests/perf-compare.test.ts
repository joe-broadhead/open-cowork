import test from 'node:test'
import assert from 'node:assert/strict'
import { compareReports } from '../scripts/perf/compare.ts'
import type { BenchmarkReport } from '../scripts/perf/types.ts'

function makeReport(avgMs: number, p95Ms: number): BenchmarkReport {
  return {
    generatedAt: '2026-05-29T00:00:00.000Z',
    environment: {
      platform: 'linux',
      arch: 'x64',
      node: 'v22.12.0',
    },
    suiteRuns: 5,
    regressionThresholds: {
      avgMultiplier: 1.2,
      p95Multiplier: 1.25,
      avgAbsoluteFloorMs: 0.5,
      p95AbsoluteFloorMs: 0.8,
      jitterAllowanceMs: 0.05,
    },
    benchmarks: [
      {
        name: 'engine.stream.mixed',
        iterations: 20,
        minMs: avgMs,
        maxMs: p95Ms,
        avgMs,
        p50Ms: avgMs,
        p95Ms,
      },
    ],
  }
}

test('compareReports tolerates tiny hosted-runner timer jitter', () => {
  const baseline = makeReport(1.5, 0.94)
  const current = makeReport(2.04, 1.79)

  assert.deepEqual(compareReports(current, baseline), [])
})

test('compareReports still fails material regressions beyond jitter allowance', () => {
  const baseline = makeReport(1.5, 0.94)
  const current = makeReport(2.06, 1.81)

  assert.deepEqual(compareReports(current, baseline), [
    'engine.stream.mixed avg 2.06 ms exceeds baseline limit 2.05 ms',
    'engine.stream.mixed p95 1.81 ms exceeds baseline limit 1.79 ms',
  ])
})

test('compareReports fails when a baseline benchmark disappears from the current report', () => {
  const baseline = makeReport(1.5, 0.94)
  const current = {
    ...makeReport(1.5, 0.94),
    benchmarks: [],
  }

  assert.deepEqual(compareReports(current, baseline), [
    'engine.stream.mixed is present in the baseline but missing from the current report',
  ])
})

test('compareReports fails when a current benchmark is missing from the baseline', () => {
  const baseline = {
    ...makeReport(1.5, 0.94),
    benchmarks: [],
  }
  const current = makeReport(1.5, 0.94)

  assert.deepEqual(compareReports(current, baseline), [
    'engine.stream.mixed is present in the current report but missing from the baseline',
  ])
})
