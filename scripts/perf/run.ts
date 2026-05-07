import { performance } from 'node:perf_hooks'
import type { BenchmarkResult } from './types.ts'

export function round(value: number) {
  return Math.round(value * 100) / 100
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

export async function runBenchmark(
  name: string,
  iterations: number,
  work: () => void | Promise<void>,
  options?: { batchSize?: number; warmupIterations?: number },
): Promise<BenchmarkResult> {
  const batchSize = Math.max(1, options?.batchSize || 1)
  const warmupIterations = Math.max(1, options?.warmupIterations || 2)

  for (let index = 0; index < warmupIterations; index += 1) {
    for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
      await work()
    }
  }
  const samples: number[] = []

  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    for (let batchIndex = 0; batchIndex < batchSize; batchIndex += 1) {
      await work()
    }
    samples.push((performance.now() - start) / batchSize)
  }

  const sorted = [...samples].sort((a, b) => a - b)
  const total = samples.reduce((sum, value) => sum + value, 0)

  return {
    name,
    iterations,
    minMs: round(sorted[0] ?? 0),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    avgMs: round(total / Math.max(1, samples.length)),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
  }
}
