import type { BenchmarkReport } from './types.ts'
import { round } from './run.ts'
import { CROSS_ENVIRONMENT_FLOORS, DEFAULT_THRESHOLDS } from './thresholds.ts'

function nodeMajor(version: string) {
  const match = /^v?(\d+)/.exec(version)
  return match ? Number(match[1]) : null
}

export function hasComparableEnvironment(current: BenchmarkReport, baseline: BenchmarkReport) {
  return current.environment.platform === baseline.environment.platform
    && current.environment.arch === baseline.environment.arch
    && nodeMajor(current.environment.node) === nodeMajor(baseline.environment.node)
}

export function compareReports(current: BenchmarkReport, baseline: BenchmarkReport) {
  const failures: string[] = []
  const baselineByName = new Map(baseline.benchmarks.map((entry) => [entry.name, entry]))
  const avgMultiplier = baseline.regressionThresholds?.avgMultiplier || DEFAULT_THRESHOLDS.avgMultiplier
  const p95Multiplier = baseline.regressionThresholds?.p95Multiplier || DEFAULT_THRESHOLDS.p95Multiplier
  const comparableEnvironment = hasComparableEnvironment(current, baseline)
  const avgAbsoluteFloorMs = comparableEnvironment
    ? baseline.regressionThresholds?.avgAbsoluteFloorMs || DEFAULT_THRESHOLDS.avgAbsoluteFloorMs
    : Math.max(
      baseline.regressionThresholds?.avgAbsoluteFloorMs || DEFAULT_THRESHOLDS.avgAbsoluteFloorMs,
      CROSS_ENVIRONMENT_FLOORS.avgAbsoluteFloorMs,
    )
  const p95AbsoluteFloorMs = comparableEnvironment
    ? baseline.regressionThresholds?.p95AbsoluteFloorMs || DEFAULT_THRESHOLDS.p95AbsoluteFloorMs
    : Math.max(
      baseline.regressionThresholds?.p95AbsoluteFloorMs || DEFAULT_THRESHOLDS.p95AbsoluteFloorMs,
      CROSS_ENVIRONMENT_FLOORS.p95AbsoluteFloorMs,
    )

  for (const currentEntry of current.benchmarks) {
    const baselineEntry = baselineByName.get(currentEntry.name)
    if (!baselineEntry) continue

    const avgLimit = round(Math.max(
      baselineEntry.avgMs * avgMultiplier,
      baselineEntry.avgMs + avgAbsoluteFloorMs,
    ))
    const p95Limit = round(Math.max(
      baselineEntry.p95Ms * p95Multiplier,
      baselineEntry.p95Ms + p95AbsoluteFloorMs,
    ))

    if (currentEntry.avgMs > avgLimit) {
      failures.push(`${currentEntry.name} avg ${currentEntry.avgMs} ms exceeds baseline limit ${avgLimit} ms`)
    }
    if (currentEntry.p95Ms > p95Limit) {
      failures.push(`${currentEntry.name} p95 ${currentEntry.p95Ms} ms exceeds baseline limit ${p95Limit} ms`)
    }
  }

  return failures
}
