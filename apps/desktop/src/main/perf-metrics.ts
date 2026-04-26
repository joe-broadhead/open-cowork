import { performance } from 'node:perf_hooks'
import type { PerfCounterSnapshot, PerfDistributionSnapshot, PerfSnapshot } from '@open-cowork/shared'
import { telemetry } from './telemetry.ts'

const SAMPLE_WINDOW = 128

type PerfUnit = PerfDistributionSnapshot['unit']

type DistributionMetric = {
  kind: 'distribution'
  name: string
  unit: PerfUnit
  count: number
  total: number
  min: number
  max: number
  last: number | null
  slowCount: number
  samples: number[]
  sampleCursor: number
  updatedAt: string
}

type CounterMetric = {
  kind: 'counter'
  name: string
  value: number
  updatedAt: string
}

const distributions = new Map<string, DistributionMetric>()
const counters = new Map<string, CounterMetric>()

function nowIso() {
  return new Date().toISOString()
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

function ensureDistribution(name: string, unit: PerfUnit) {
  const existing = distributions.get(name)
  if (existing) return existing

  const created: DistributionMetric = {
    kind: 'distribution',
    name,
    unit,
    count: 0,
    total: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    last: null,
    slowCount: 0,
    samples: [],
    sampleCursor: 0,
    updatedAt: nowIso(),
  }
  distributions.set(name, created)
  return created
}

export function incrementPerfCounter(name: string, by = 1) {
  const existing = counters.get(name)
  if (existing) {
    existing.value += by
    existing.updatedAt = nowIso()
    return
  }

  counters.set(name, {
    kind: 'counter',
    name,
    value: by,
    updatedAt: nowIso(),
  })
}

export function observePerf(
  name: string,
  value: number,
  options?: {
    unit?: PerfUnit
    slowThresholdMs?: number
    slowData?: Record<string, unknown>
  },
) {
  const unit = options?.unit || 'ms'
  const metric = ensureDistribution(name, unit)
  metric.count += 1
  metric.total += value
  metric.min = Math.min(metric.min, value)
  metric.max = Math.max(metric.max, value)
  metric.last = value
  metric.updatedAt = nowIso()

  if (metric.samples.length < SAMPLE_WINDOW) {
    metric.samples.push(value)
  } else {
    metric.samples[metric.sampleCursor] = value
    metric.sampleCursor = (metric.sampleCursor + 1) % SAMPLE_WINDOW
  }

  if (unit === 'ms' && options?.slowThresholdMs !== undefined && value >= options.slowThresholdMs) {
    metric.slowCount += 1
    telemetry.perfSlow(name, value, options.slowData)
  }
}

export async function measureAsyncPerf<T>(
  name: string,
  work: () => Promise<T>,
  options?: {
    unit?: PerfUnit
    slowThresholdMs?: number
    slowData?: Record<string, unknown>
  },
) {
  const start = performance.now()
  try {
    return await work()
  } finally {
    observePerf(name, performance.now() - start, options)
  }
}

export function measurePerf<T>(
  name: string,
  work: () => T,
  options?: {
    unit?: PerfUnit
    slowThresholdMs?: number
    slowData?: Record<string, unknown>
  },
) {
  const start = performance.now()
  try {
    return work()
  } finally {
    observePerf(name, performance.now() - start, options)
  }
}

function snapshotDistribution(metric: DistributionMetric): PerfDistributionSnapshot {
  const samples = [...metric.samples].sort((a, b) => a - b)
  return {
    kind: 'distribution',
    name: metric.name,
    unit: metric.unit,
    count: metric.count,
    samplesTracked: metric.samples.length,
    total: round(metric.total),
    avg: round(metric.total / metric.count),
    min: round(metric.min === Number.POSITIVE_INFINITY ? 0 : metric.min),
    max: round(metric.max),
    p50: round(percentile(samples, 0.5)),
    p95: round(percentile(samples, 0.95)),
    last: round(metric.last ?? 0),
    slowCount: metric.slowCount,
    updatedAt: metric.updatedAt,
  }
}

function snapshotCounter(metric: CounterMetric): PerfCounterSnapshot {
  return {
    kind: 'counter',
    name: metric.name,
    value: metric.value,
    updatedAt: metric.updatedAt,
  }
}

export function getPerfSnapshot(): PerfSnapshot {
  return {
    capturedAt: nowIso(),
    counters: [...counters.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(snapshotCounter),
    distributions: [...distributions.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(snapshotDistribution),
  }
}

export function resetPerfMetrics() {
  counters.clear()
  distributions.clear()
}
