/**
 * Process runtime self-metrics + a small in-process metrics registry.
 *
 * The observability analysis layer is rich, but the telemetry substrate had no
 * Prometheus surface, no retained latency timeseries, and no process
 * self-metrics (RSS/heap/event-loop lag). This module adds all three, kept cheap
 * and bounded:
 *
 *   - Counters/gauges/histograms with a Prometheus text-exposition renderer.
 *   - SLO-latency histograms fed from the observability contract's observations.
 *   - A bounded ring of process samples (rss/heapUsed/event-loop lag) driven by
 *     an unref'd sampler that is cleared on shutdown, powering the growth alert.
 *
 * Everything is bounded in memory (fixed label sets, a fixed-size sample ring)
 * so an always-on daemon cannot grow it unbounded.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { ObservabilitySloResult } from './observability-contract.js'

export interface RuntimeSample {
  at: number
  rssBytes: number
  heapUsedBytes: number
  eventLoopLagMs: number
}

export interface RuntimeMetricsSnapshot {
  rssBytes: number
  heapUsedBytes: number
  heapTotalBytes: number
  externalBytes: number
  eventLoopLagMs: number
  sampleCount: number
  samples: RuntimeSample[]
}

const SAMPLE_RING_MAX = 240 // ~2h at a 30s cadence; bounded memory.
const DEFAULT_SAMPLE_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Metric primitives (minimal, label-keyed, bounded by fixed call sites).
// ---------------------------------------------------------------------------

type Labels = Record<string, string>

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  return keys.map(k => `${k}=${labels[k]}`).join(',')
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort()
  if (!keys.length) return ''
  return `{${keys.map(k => `${k}="${escapeLabelValue(labels[k]!)}"`).join(',')}}`
}

function escapeLabelValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

class Counter {
  private values = new Map<string, { labels: Labels; value: number }>()
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels)
    const existing = this.values.get(key)
    if (existing) existing.value += amount
    else this.values.set(key, { labels, value: amount })
  }
  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), { labels, value })
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value || 0
  }
  reset(): void { this.values.clear() }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    if (!this.values.size) lines.push(`${this.name} 0`)
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${renderLabels(labels)} ${value}`)
    return lines
  }
}

class Gauge {
  private values = new Map<string, { labels: Labels; value: number }>()
  constructor(readonly name: string, readonly help: string) {}
  set(value: number, labels: Labels = {}): void {
    this.values.set(labelKey(labels), { labels, value })
  }
  reset(): void { this.values.clear() }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`]
    if (!this.values.size) lines.push(`${this.name} 0`)
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${renderLabels(labels)} ${value}`)
    return lines
  }
}

class Histogram {
  private buckets: number[]
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>()
  constructor(readonly name: string, readonly help: string, buckets: number[]) {
    this.buckets = [...buckets].sort((a, b) => a - b)
  }
  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value) || value < 0) return
    const key = labelKey(labels)
    let entry = this.series.get(key)
    if (!entry) {
      entry = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }
      this.series.set(key, entry)
    }
    entry.sum += value
    entry.count += 1
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.counts[i] = (entry.counts[i] ?? 0) + 1
    }
  }
  reset(): void { this.series.clear() }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const entry of this.series.values()) {
      let cumulative = 0
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = entry.counts[i]!
        const le = this.buckets[i]!
        lines.push(`${this.name}_bucket${renderLabels({ ...entry.labels, le: formatBucket(le) })} ${cumulative}`)
      }
      lines.push(`${this.name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`)
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`)
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`)
    }
    return lines
  }
}

function formatBucket(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value)
}

// Latency buckets in milliseconds spanning fast local renders to multi-minute SLOs.
const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000]

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const counters = {
  runsDispatched: new Counter('gateway_runs_dispatched_total', 'Total scheduler runs observed as dispatched.'),
  runsCompleted: new Counter('gateway_runs_completed_total', 'Total scheduler runs observed as completed.'),
  runsFailed: new Counter('gateway_runs_failed_total', 'Total scheduler runs observed as failed/blocked/errored.'),
  channelMessagesIn: new Counter('gateway_channel_messages_in_total', 'Total inbound channel messages accepted.'),
  channelMessagesOut: new Counter('gateway_channel_messages_out_total', 'Total outbound channel messages sent.'),
  schedulerCycles: new Counter('gateway_scheduler_cycles_total', 'Total scheduler cycles executed by this daemon.'),
  authFailures: new Counter('gateway_auth_failures_total', 'Total denied HTTP requests (auth/capability failures).'),
}

const gauges = {
  queueDepth: new Gauge('gateway_queue_depth', 'Pending + running + blocked tasks in the durable work queue.'),
  activeRuns: new Gauge('gateway_active_runs', 'Runs currently in the running state.'),
  leadershipWriter: new Gauge('gateway_leadership_writer', 'Whether this daemon holds the writer lease (1) or is standby (0).'),
  rssBytes: new Gauge('gateway_process_resident_memory_bytes', 'Resident set size of the daemon process.'),
  heapUsedBytes: new Gauge('gateway_process_heap_used_bytes', 'V8 heap used by the daemon process.'),
  heapTotalBytes: new Gauge('gateway_process_heap_total_bytes', 'V8 heap total for the daemon process.'),
  eventLoopLagMs: new Gauge('gateway_event_loop_lag_ms', 'Recent event-loop delay (mean) in milliseconds.'),
  uptimeSeconds: new Gauge('gateway_process_uptime_seconds', 'Daemon process uptime in seconds.'),
  alertsActive: new Gauge('gateway_alerts_active', 'Open alerts by severity.'),
}

const sloLatency = new Histogram('gateway_slo_latency_ms', 'Observed SLO latency observations in milliseconds, labeled by budget id.', LATENCY_BUCKETS_MS)
const seenSloObservations = new Set<string>()
const MAX_SEEN_SLO_OBSERVATIONS = 50_000

// ---------------------------------------------------------------------------
// Public counter/gauge instrumentation
// ---------------------------------------------------------------------------

export function recordSchedulerCycle(): void { counters.schedulerCycles.inc() }
export function recordChannelMessageIn(provider?: string): void { counters.channelMessagesIn.inc(provider ? { provider } : {}) }
export function recordChannelMessageOut(provider?: string): void { counters.channelMessagesOut.inc(provider ? { provider } : {}) }
export function recordAuthFailure(): void { counters.authFailures.inc() }

/** Record SLO latency observations into histograms for retained trend answers. */
export function observeSloResults(results: ObservabilitySloResult[] = []): void {
  for (const row of results) {
    if (typeof row.observedMs === 'number' && Number.isFinite(row.observedMs)) {
      const key = sloObservationKey(row)
      if (seenSloObservations.has(key)) continue
      seenSloObservations.add(key)
      sloLatency.observe(row.observedMs, { budget: row.id })
    }
  }
  boundSet(seenSloObservations, MAX_SEEN_SLO_OBSERVATIONS)
}

function sloObservationKey(row: ObservabilitySloResult): string {
  return [
    row.id,
    row.status,
    Math.round(row.observedMs ?? -1),
    row.warningMs,
    row.thresholdMs,
    row.summary,
    row.evidence.join('|'),
  ].join('\u001f')
}

// Monotonic run counters reconciled from durable state so we do not need to hook
// the scheduler internals: we count each run id at most once per terminal state.
const seenDispatched = new Set<string>()
const seenTerminal = new Set<string>()

export interface RunCounterInput {
  runs: Array<{ id: string; status: string }>
}

export function reconcileRunCountersFromState(state: RunCounterInput): void {
  for (const run of state.runs || []) {
    if (!seenDispatched.has(run.id)) {
      seenDispatched.add(run.id)
      counters.runsDispatched.inc()
    }
    const terminal = run.status === 'completed' || run.status === 'done' || run.status === 'failed' || run.status === 'blocked' || run.status === 'errored'
    if (terminal && !seenTerminal.has(run.id)) {
      seenTerminal.add(run.id)
      if (run.status === 'failed' || run.status === 'blocked' || run.status === 'errored') counters.runsFailed.inc()
      else counters.runsCompleted.inc()
    }
  }
  // Bound the id sets: they can only grow with distinct run ids, so cap them.
  boundSet(seenDispatched)
  boundSet(seenTerminal)
}

function boundSet(set: Set<string>, max = 50_000): void {
  if (set.size <= max) return
  const excess = set.size - max
  let removed = 0
  for (const value of set) {
    set.delete(value)
    if (++removed >= excess) break
  }
}

export interface RuntimeGaugeInput {
  queueDepth?: number
  activeRuns?: number
  leadershipWriter?: boolean
  alertsActive?: number
}

export function setRuntimeGauges(input: RuntimeGaugeInput): void {
  if (input.queueDepth !== undefined) gauges.queueDepth.set(input.queueDepth)
  if (input.activeRuns !== undefined) gauges.activeRuns.set(input.activeRuns)
  if (input.leadershipWriter !== undefined) gauges.leadershipWriter.set(input.leadershipWriter ? 1 : 0)
  if (input.alertsActive !== undefined) gauges.alertsActive.set(input.alertsActive)
}

// ---------------------------------------------------------------------------
// Process sampler (rss/heap/event-loop lag)
// ---------------------------------------------------------------------------

const sampleRing: RuntimeSample[] = []
let sampleTimer: NodeJS.Timeout | null = null
let loopDelay: IntervalHistogram | null = null

function currentEventLoopLagMs(): number {
  if (!loopDelay) return 0
  // mean is in nanoseconds; convert to ms. Reset so each sample is a fresh window.
  const meanMs = loopDelay.mean / 1e6
  loopDelay.reset()
  return Number.isFinite(meanMs) ? Math.max(0, meanMs) : 0
}

/**
 * Refresh the process gauges for a READ-ONLY /metrics scrape: reads live RSS/heap
 * (side-effect free) and the event-loop lag from the last scheduled sample, WITHOUT
 * pushing into the ring or resetting the event-loop-delay histogram. The scheduled
 * sampler remains the sole writer of the ring and the sole caller of loopDelay.reset(),
 * so scrapes cannot inject off-cadence samples or suppress the sustained-lag alert.
 */
function refreshProcessGaugesForScrape(): void {
  const mem = process.memoryUsage()
  gauges.rssBytes.set(mem.rss)
  gauges.heapUsedBytes.set(mem.heapUsed)
  gauges.heapTotalBytes.set(mem.heapTotal)
  gauges.eventLoopLagMs.set(sampleRing[sampleRing.length - 1]?.eventLoopLagMs ?? 0)
  gauges.uptimeSeconds.set(Math.round(process.uptime()))
}

/** Take one process sample, push it into the bounded ring, and update gauges. */
export function sampleRuntimeMetrics(now = Date.now()): RuntimeSample {
  const mem = process.memoryUsage()
  const sample: RuntimeSample = {
    at: now,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    eventLoopLagMs: currentEventLoopLagMs(),
  }
  sampleRing.push(sample)
  while (sampleRing.length > SAMPLE_RING_MAX) sampleRing.shift()
  gauges.rssBytes.set(mem.rss)
  gauges.heapUsedBytes.set(mem.heapUsed)
  gauges.heapTotalBytes.set(mem.heapTotal)
  gauges.eventLoopLagMs.set(sample.eventLoopLagMs)
  gauges.uptimeSeconds.set(Math.round(process.uptime()))
  return sample
}

/** Start the unref'd process sampler. Idempotent. */
export function startRuntimeMetricsSampler(options: { intervalMs?: number } = {}): void {
  if (sampleTimer) return
  try {
    loopDelay = monitorEventLoopDelay({ resolution: 20 })
    loopDelay.enable()
  } catch {
    loopDelay = null
  }
  sampleRuntimeMetrics()
  sampleTimer = setInterval(() => { try { sampleRuntimeMetrics() } catch {} }, Math.max(1_000, options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS))
  sampleTimer.unref?.()
}

/** Stop the sampler and release the event-loop monitor. Wired into shutdown. */
export function stopRuntimeMetricsSampler(): void {
  if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null }
  if (loopDelay) { try { loopDelay.disable() } catch {}; loopDelay = null }
}

export function getRuntimeMetricsSamples(): RuntimeSample[] {
  return [...sampleRing]
}

export function clearRuntimeMetricsForTest(): void {
  sampleRing.length = 0
  seenDispatched.clear()
  seenTerminal.clear()
  seenSloObservations.clear()
  for (const counter of Object.values(counters)) counter.reset()
  for (const gauge of Object.values(gauges)) gauge.reset()
  sloLatency.reset()
  stopRuntimeMetricsSampler()
}

export function getRuntimeMetricsSnapshot(): RuntimeMetricsSnapshot {
  const mem = process.memoryUsage()
  const latest = sampleRing[sampleRing.length - 1]
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    eventLoopLagMs: latest?.eventLoopLagMs ?? 0,
    sampleCount: sampleRing.length,
    samples: [...sampleRing],
  }
}

// ---------------------------------------------------------------------------
// Prometheus exposition
// ---------------------------------------------------------------------------

export interface PrometheusRenderInput {
  queueDepth?: number
  activeRuns?: number
  leadershipWriter?: boolean
  alertsActive?: number
  runs?: Array<{ id: string; status: string }>
  slo?: ObservabilitySloResult[]
}

/** Render the full registry as Prometheus text exposition (version 0.0.4). */
export function renderPrometheusMetrics(input: PrometheusRenderInput = {}): string {
  if (input.runs) reconcileRunCountersFromState({ runs: input.runs })
  if (input.slo) observeSloResults(input.slo)
  setRuntimeGauges(input)
  // Refresh process gauges from live RSS/heap + the last scheduled sample's lag so
  // /metrics is answerable even before the periodic sampler ticks — WITHOUT sampling
  // the ring or resetting the lag window (which would corrupt the alert-feeding series).
  refreshProcessGaugesForScrape()

  const blocks: string[][] = [
    counters.runsDispatched.render(),
    counters.runsCompleted.render(),
    counters.runsFailed.render(),
    counters.channelMessagesIn.render(),
    counters.channelMessagesOut.render(),
    counters.schedulerCycles.render(),
    counters.authFailures.render(),
    gauges.queueDepth.render(),
    gauges.activeRuns.render(),
    gauges.leadershipWriter.render(),
    gauges.rssBytes.render(),
    gauges.heapUsedBytes.render(),
    gauges.heapTotalBytes.render(),
    gauges.eventLoopLagMs.render(),
    gauges.uptimeSeconds.render(),
    gauges.alertsActive.render(),
    sloLatency.render(),
  ]
  return blocks.map(block => block.join('\n')).join('\n') + '\n'
}
