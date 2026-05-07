import type { BenchmarkReport, BenchmarkResult } from './types.ts'
import { round } from './run.ts'
import { DEFAULT_THRESHOLDS } from './thresholds.ts'

export function formatLine(result: BenchmarkResult) {
  return `${result.name.padEnd(28)} avg ${String(result.avgMs).padStart(7)} ms  p95 ${String(result.p95Ms).padStart(7)} ms  min ${String(result.minMs).padStart(7)} ms  max ${String(result.maxMs).padStart(7)} ms`
}

export function createReport(results: BenchmarkResult[]): BenchmarkReport {
  return {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    suiteRuns: 1,
    regressionThresholds: DEFAULT_THRESHOLDS,
    benchmarks: results,
  }
}

export function aggregateReports(reports: BenchmarkReport[]): BenchmarkReport {
  if (reports.length === 1) return reports[0]

  const aggregateForName = (name: string) => {
    const entries = reports
      .map((report) => report.benchmarks.find((benchmark) => benchmark.name === name))
      .filter((entry): entry is BenchmarkResult => Boolean(entry))
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
    const median = (values: number[]) => {
      const ordered = sorted(values)
      return ordered[Math.floor(ordered.length / 2)] ?? 0
    }

    return {
      name,
      iterations: entries[0]?.iterations || 0,
      minMs: round(Math.min(...entries.map((entry) => entry.minMs))),
      maxMs: round(Math.max(...entries.map((entry) => entry.maxMs))),
      avgMs: round(median(entries.map((entry) => entry.avgMs))),
      p50Ms: round(median(entries.map((entry) => entry.p50Ms))),
      p95Ms: round(median(entries.map((entry) => entry.p95Ms))),
    }
  }

  const benchmarkNames = reports[0]?.benchmarks.map((benchmark) => benchmark.name) || []
  return {
    ...reports[0],
    generatedAt: new Date().toISOString(),
    suiteRuns: reports.length,
    benchmarks: benchmarkNames.map(aggregateForName),
  }
}
