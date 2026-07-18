import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearRuntimeMetricsForTest,
  getRuntimeMetricsSamples,
  getRuntimeMetricsSnapshot,
  recordAuthFailure,
  recordChannelMessageIn,
  recordSchedulerCycle,
  renderPrometheusMetrics,
  sampleRuntimeMetrics,
} from '../runtime-metrics.js'
import type { ObservabilitySloResult } from '../observability-contract.js'

function sloResult(id: ObservabilitySloResult['id'], observedMs: number): ObservabilitySloResult {
  return {
    id,
    label: id,
    thresholdMs: 300_000,
    warningMs: 60_000,
    description: 'test',
    status: 'pass',
    observedMs,
    releaseBlocking: false,
    summary: 'test',
    recommendedAction: 'none',
    evidence: [],
  }
}

describe('runtime-metrics', () => {
  beforeEach(() => clearRuntimeMetricsForTest())
  afterEach(() => clearRuntimeMetricsForTest())

  it('samples process memory and records values into the bounded ring', () => {
    sampleRuntimeMetrics()
    sampleRuntimeMetrics()
    const samples = getRuntimeMetricsSamples()
    expect(samples.length).toBe(2)
    expect(samples[0]!.rssBytes).toBeGreaterThan(0)
    expect(samples[0]!.heapUsedBytes).toBeGreaterThan(0)
    const snapshot = getRuntimeMetricsSnapshot()
    expect(snapshot.rssBytes).toBeGreaterThan(0)
    expect(snapshot.sampleCount).toBe(2)
  })

  it('renders valid Prometheus exposition with expected metric names and non-empty histograms', () => {
    recordSchedulerCycle()
    recordSchedulerCycle()
    recordChannelMessageIn('telegram')
    recordAuthFailure()

    const text = renderPrometheusMetrics({
      queueDepth: 3,
      activeRuns: 1,
      leadershipWriter: true,
      alertsActive: 2,
      runs: [
        { id: 'run_1', status: 'running' },
        { id: 'run_2', status: 'completed' },
        { id: 'run_3', status: 'failed' },
      ],
      slo: [sloResult('scheduler_latency', 1_500), sloResult('dashboard_render', 850)],
    })

    // Expected metric names present.
    for (const name of [
      'gateway_runs_dispatched_total',
      'gateway_runs_completed_total',
      'gateway_runs_failed_total',
      'gateway_channel_messages_in_total',
      'gateway_scheduler_cycles_total',
      'gateway_auth_failures_total',
      'gateway_queue_depth',
      'gateway_active_runs',
      'gateway_leadership_writer',
      'gateway_process_resident_memory_bytes',
      'gateway_process_heap_used_bytes',
      'gateway_event_loop_lag_ms',
      'gateway_slo_latency_ms',
    ]) {
      expect(text).toContain(`# TYPE ${name}`)
    }

    // Counter values reflect activity.
    expect(text).toContain('gateway_scheduler_cycles_total 2')
    expect(text).toContain('gateway_runs_dispatched_total 3')
    expect(text).toContain('gateway_runs_completed_total 1')
    expect(text).toContain('gateway_runs_failed_total 1')
    expect(text).toContain('gateway_queue_depth 3')
    expect(text).toContain('gateway_leadership_writer 1')

    // Histogram has real observations.
    expect(text).toMatch(/gateway_slo_latency_ms_bucket\{[^}]*le="\+Inf"\} \d+/)
    expect(text).toMatch(/gateway_slo_latency_ms_count\{budget="scheduler_latency"\} 1/)
    // Valid exposition ends with a newline.
    expect(text.endsWith('\n')).toBe(true)
  })

  it('rendering /metrics does not mutate the alert-feeding sample ring', () => {
    // The scheduled sampler is the sole writer of the ring; scrapes must only read.
    sampleRuntimeMetrics()
    sampleRuntimeMetrics()
    const before = getRuntimeMetricsSamples()
    expect(before.length).toBe(2)

    renderPrometheusMetrics()
    renderPrometheusMetrics()
    renderPrometheusMetrics()

    const after = getRuntimeMetricsSamples()
    // No off-cadence samples injected and the series is byte-for-byte unchanged.
    expect(after.length).toBe(2)
    expect(after).toEqual(before)
    expect(getRuntimeMetricsSnapshot().sampleCount).toBe(2)
    // The gauge still reflects the last scheduled sample's lag (read, not reset).
    const text = renderPrometheusMetrics()
    expect(text).toContain(`gateway_event_loop_lag_ms ${before[before.length - 1]!.eventLoopLagMs}`)
  })

  it('reconciles run counters monotonically without double-counting run ids', () => {
    renderPrometheusMetrics({ runs: [{ id: 'run_a', status: 'running' }] })
    const text = renderPrometheusMetrics({ runs: [{ id: 'run_a', status: 'completed' }] })
    // run_a counted once as dispatched, once as completed — not twice as dispatched.
    expect(text).toContain('gateway_runs_dispatched_total 1')
    expect(text).toContain('gateway_runs_completed_total 1')
  })

  it('does not double-count identical SLO observations across Prometheus scrapes', () => {
    const observation = sloResult('scheduler_latency', 1_500)

    renderPrometheusMetrics({ slo: [observation] })
    const text = renderPrometheusMetrics({ slo: [observation] })

    expect(text).toMatch(/gateway_slo_latency_ms_count\{budget="scheduler_latency"\} 1/)
  })
})
