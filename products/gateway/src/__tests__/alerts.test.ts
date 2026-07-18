import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { detectAlerts, detectProfileHealthAlerts, detectStuckTaskAlerts, generateIncidentReport, runAlertEngine } from '../alerts.js'
import { applyWorkTaskAction, clearWorkStateForTest, createRoadmap, createRun, createWorkTask, listAlerts, loadWorkState, resolveAlertsNotInKeys, saveWorkState, updateAlertStatus, upsertAlert } from '../work-store.js'
import { clearConfigCacheForTest, getConfig, updateConfig, type AlertsConfig } from '../config.js'
import type { EnvironmentRunRecord } from '../environments.js'

describe('alerts', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-alerts-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
  })

  it('detects stale heartbeat, stale runs, and repeated failures', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const task = createWorkTask({ title: 'Alert target' }, store)
    const run = createRun(task, 'implement', 'ses_stale', 'implementer', new Date(now - 2 * 60 * 60 * 1000))
    const failed = [1, 2, 3].map(i => ({ ...createRun(task, 'verify', `ses_fail_${i}`, 'verifier', new Date(now - i * 1000)), status: 'failed' as const, completedAt: new Date(now - i * 1000).toISOString() }))
    const state = loadWorkState(store)
    state.runs.push(run, ...failed)

    const alerts = detectAlerts({ state, now, heartbeat: { enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: new Date(now - 20 * 60 * 1000).toISOString() } as any })

    expect(alerts.map(alert => alert.key)).toEqual(expect.arrayContaining(['heartbeat:stale', `run:stale:${run.id}`, 'runs:repeated-failures', 'backup:missing']))
  })

  it('groups repeated provider failures with redacted evidence', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const task = createWorkTask({ title: 'Alert target' }, store)
    const failed = [1, 2].map(i => ({
      ...createRun(task, 'implement', `ses_provider_${i}`, 'implementer', new Date(now - i * 1000)),
      status: 'errored' as const,
      completedAt: new Date(now - i * 1000).toISOString(),
      result: { status: 'blocked' as const, summary: 'Provider authentication failure: api_key=sk-secret123456 invalid API key', feedback: 'invalid API key', artifacts: [], raw: '' },
    }))
    const state = loadWorkState(store)
    state.runs.push(...failed)

    const alerts = detectAlerts({ state, now, heartbeat: { enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: new Date(now).toISOString() } as any })
    const grouped = alerts.find(alert => alert.key === 'runs:repeated-failures:implement:provider_auth')

    expect(grouped).toMatchObject({ severity: 'critical', summary: expect.stringContaining('provider auth') })
    expect(grouped!.evidence?.join('\n')).not.toContain('sk-secret123456')
  })

  it('detects environment cleanup failures and includes them in incident reports', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const task = createWorkTask({ title: 'Environment alert target' }, store)
    const run = createRun(task, 'implement', 'ses_env_alert', 'implementer', new Date(now - 1000))
    run.environment = envRun({ status: 'cleanup_failed', cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'failed' }, metadata: { cleanupError: 'failed with api_key=fake-provider-token' } })
    const state = loadWorkState(store)
    state.runs.push(run)
    saveWorkState(state, store)

    const alerts = detectAlerts({ state, now, heartbeat: { enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: new Date(now).toISOString() } as any })
    const cleanup = alerts.find(alert => alert.key === 'environments:cleanup-failed')
    const report = generateIncidentReport()

    expect(cleanup).toMatchObject({ severity: 'warning', summary: expect.stringContaining('cleanup failure') })
    expect((cleanup?.evidence || []).join('\n')).not.toContain('fake-provider-token')
    expect(report).toContain('## Environments')
    expect(report).toContain('1 cleanup failed environment')
  })

  it('dedupes and rate-limits repeated alerts', () => {
    const input = { key: 'test:alert', severity: 'warning' as const, source: 'gateway.alerts', summary: 'Alert once', evidence: ['e1'], nextAction: 'Fix it' }

    const first = upsertAlert(input, { now: 1000, dedupeMs: 60_000 }, store)
    const second = upsertAlert(input, { now: 2000, dedupeMs: 60_000 }, store)

    expect(first).toMatchObject({ created: true, notify: true })
    expect(second).toMatchObject({ created: false, notify: false })
    expect(second.alert.dedupeCount).toBe(2)
  })

  it('suppresses and resolves alert lifecycle records', async () => {
    const first = upsertAlert({ key: 'heartbeat:stale', severity: 'warning', source: 'gateway.alerts', summary: 'stale', nextAction: 'check' }, { now: 1000 }, store)

    expect(updateAlertStatus(first.alert.id, 'suppress', { suppressMs: 60_000 }, store)).toMatchObject({ status: 'suppressed' })
    const suppressed = upsertAlert({ key: 'heartbeat:stale', severity: 'warning', source: 'gateway.alerts', summary: 'stale', nextAction: 'check' }, { now: 2000 }, store)
    expect(suppressed.notify).toBe(false)

    updateAlertStatus(first.alert.id, 'acknowledge', {}, store)
    expect(resolveAlertsNotInKeys('gateway.alerts', new Set(), store, 3000)).toBe(1)
    expect(listAlerts({}, store)[0]).toMatchObject({ status: 'resolved' })
  })

  it('resolves stale rule alerts when a later engine run no longer detects them', async () => {
    upsertAlert({ key: 'heartbeat:stale', severity: 'warning', source: 'gateway.alerts', summary: 'stale', nextAction: 'check' }, { now: 1000 }, store)
    const state = loadWorkState(store)
    saveWorkState(state, store)

    await runAlertEngine({ state, now: Date.parse('2026-06-13T12:00:00.000Z'), heartbeat: { enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: '2026-06-13T11:59:59.000Z' } as any })

    expect(listAlerts({}, store).find(alert => alert.key === 'heartbeat:stale')).toMatchObject({ status: 'resolved' })
  })

  const okHeartbeat = (now: number) => ({ enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: new Date(now).toISOString() } as any)

  it('fires a leadership-lease-stuck alert for a wedged standby daemon', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const state = loadWorkState(store)
    const wedged = { enabled: true, scope: 'gateway-local-writer', mode: 'standby' as const, canWrite: false, daemonId: 'd', instanceId: 'i', stale: true, takeoverCount: 0, leaseExpiresAt: new Date(now - 60_000).toISOString(), remediation: 'Recover the writer lease.' }

    const alerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), leadership: wedged, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    const lease = alerts.find(alert => alert.key === 'leadership:lease-stuck')

    expect(lease).toMatchObject({ severity: 'critical', source: 'gateway.alerts', target: 'leadership' })
    expect(lease!.nextAction).toContain('leadership recover')
  })

  it('does not fire lease-stuck for a healthy standby with a live writer', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const state = loadWorkState(store)
    const healthyStandby = { enabled: true, scope: 'gateway-local-writer', mode: 'standby' as const, canWrite: false, daemonId: 'd', instanceId: 'i', stale: false, takeoverCount: 0, leaseExpiresAt: new Date(now + 60_000).toISOString(), remediation: 'A writer is active.' }

    const alerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), leadership: healthyStandby, freeDiskBytes: 50 * 1024 * 1024 * 1024 })

    expect(alerts.find(alert => alert.key === 'leadership:lease-stuck')).toBeUndefined()
  })

  it('fires a disk low-space alert below the injected threshold', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const state = loadWorkState(store)

    const critical = detectAlerts({ state, now, heartbeat: okHeartbeat(now), freeDiskBytes: 50 * 1024 * 1024 })
    const criticalAlert = critical.find(alert => alert.key === 'disk:low-space')
    expect(criticalAlert).toMatchObject({ severity: 'critical', source: 'gateway.alerts' })

    const warn = detectAlerts({ state, now, heartbeat: okHeartbeat(now), freeDiskBytes: 700 * 1024 * 1024 })
    expect(warn.find(alert => alert.key === 'disk:low-space')).toMatchObject({ severity: 'warning' })

    const healthy = detectAlerts({ state, now, heartbeat: okHeartbeat(now), freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(healthy.find(alert => alert.key === 'disk:low-space')).toBeUndefined()
  })

  it('fires a memory-growth alert on a sustained rising series but not on a flat one', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const state = loadWorkState(store)
    const rising = Array.from({ length: 10 }, (_, i) => ({ at: now + i * 30_000, rssBytes: (100 + i * 40) * 1024 * 1024, heapUsedBytes: 50 * 1024 * 1024, eventLoopLagMs: 5 }))
    const flat = Array.from({ length: 10 }, (_, i) => ({ at: now + i * 30_000, rssBytes: 200 * 1024 * 1024, heapUsedBytes: 50 * 1024 * 1024, eventLoopLagMs: 5 }))

    const risingAlerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), runtimeSamples: rising, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(risingAlerts.find(alert => alert.key === 'runtime:memory-growth')).toMatchObject({ severity: 'warning', source: 'gateway.alerts' })

    const flatAlerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), runtimeSamples: flat, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(flatAlerts.find(alert => alert.key === 'runtime:memory-growth')).toBeUndefined()
  })

  it('fires an event-loop-lag alert on sustained high lag', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const state = loadWorkState(store)
    const laggy = Array.from({ length: 8 }, (_, i) => ({ at: now + i * 30_000, rssBytes: 200 * 1024 * 1024, heapUsedBytes: 50 * 1024 * 1024, eventLoopLagMs: 400 }))

    const alerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), runtimeSamples: laggy, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(alerts.find(alert => alert.key === 'runtime:event-loop-lag')).toMatchObject({ severity: 'warning' })
  })

  it('fires event-loop-lag on a bursty-but-degraded loop but not on a single transient spike', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const state = loadWorkState(store)
    const sample = (i: number, lag: number) => ({ at: now + i * 30_000, rssBytes: 200 * 1024 * 1024, heapUsedBytes: 50 * 1024 * 1024, eventLoopLagMs: lag })

    // Bursty oscillation: the recent window is a sustained majority above threshold.
    const bursty = [100, 400, 100, 400, 400, 400, 100, 400].map((lag, i) => sample(i, lag))
    const burstyAlerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), runtimeSamples: bursty, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(burstyAlerts.find(alert => alert.key === 'runtime:event-loop-lag')).toMatchObject({ severity: 'warning' })

    // A single spike then calm must not trip the alert.
    const singleSpike = [400, 100, 100, 100, 100, 100, 100, 100].map((lag, i) => sample(i, lag))
    const spikeAlerts = detectAlerts({ state, now, heartbeat: okHeartbeat(now), runtimeSamples: singleSpike, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(spikeAlerts.find(alert => alert.key === 'runtime:event-loop-lag')).toBeUndefined()
  })
})

// ---- #205 proactive profile-health alert ---------------------------------
describe('profile-health alert', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-profile-health-'))
  const store = path.join(testDir, 'gateway.db')
  const now = Date.parse('2026-07-01T12:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
    createRoadmap({ title: 'seed' }, store)
  })
  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
  })

  interface Seed { profile: string; status: 'errored' | 'passed'; summary?: string; ageDays?: number }
  function seedRuns(runs: Seed[]): void {
    const db = new DatabaseSync(store)
    try {
      const insert = db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, resolved_profile, status, attempt, started_at, completed_at, cost_usd, input_tokens, output_tokens, runtime_ms, result_json)
         VALUES (?, ?, 'implement', ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, 0, ?)`,
      )
      runs.forEach((r, i) => {
        const startedAt = new Date(now - (r.ageDays ?? 1) * DAY).toISOString()
        const completedAt = new Date(now - (r.ageDays ?? 1) * DAY + 1000).toISOString()
        const result = r.summary === undefined ? null : JSON.stringify({ status: 'blocked', summary: r.summary, feedback: r.summary, artifacts: [], raw: r.summary })
        insert.run(`run_${i}`, `task_${i}`, `ses_${i}`, r.profile, r.profile, r.status, startedAt, completedAt, result)
      })
    } finally { db.close() }
  }

  const cfg = (over: Partial<AlertsConfig['profileHealth']> = {}): any => ({
    alerts: { profileHealth: { enabled: true, windowDays: 7, minRuns: 10, maxGenuineFailureRate: 0.5, ...over } },
  })

  it('fires for a profile whose GENUINE failure rate exceeds the threshold', () => {
    seedRuns([
      ...Array.from({ length: 8 }, () => ({ profile: 'broken', status: 'errored' as const, summary: 'the diff did not satisfy the spec' })),
      ...Array.from({ length: 4 }, () => ({ profile: 'broken', status: 'passed' as const })),
    ])
    const alerts = detectProfileHealthAlerts(cfg(), now)
    const fired = alerts.find(a => a.key === 'profile-health:broken')
    expect(fired).toBeDefined()
    // 8 genuine / 12 terminal = 66.7% > 50% threshold.
    expect(fired!.summary).toMatch(/66\.7%/)
    expect(fired!.nextAction).toMatch(/analytics --scorecard --by profile/)
    expect(fired!.severity).toBe('warning')
  })

  it('does NOT fire for a profile whose errors are all operational session-recovery (cry-wolf guard)', () => {
    // The dogfood pattern: many session-recovery errors, few passes, zero genuine.
    seedRuns([
      ...Array.from({ length: 40 }, () => ({ profile: 'implementer', status: 'errored' as const, summary: 'Recovered missing OpenCode session' })),
      ...Array.from({ length: 5 }, () => ({ profile: 'implementer', status: 'passed' as const })),
    ])
    const alerts = detectProfileHealthAlerts(cfg(), now)
    expect(alerts.find(a => a.key === 'profile-health:implementer')).toBeUndefined()
  })

  it('does NOT fire on a provider-balance blip (external cohort excluded)', () => {
    seedRuns([
      ...Array.from({ length: 20 }, () => ({ profile: 'implementer', status: 'errored' as const, summary: 'HTTP 402: Insufficient Balance' })),
      ...Array.from({ length: 5 }, () => ({ profile: 'implementer', status: 'passed' as const })),
    ])
    expect(detectProfileHealthAlerts(cfg(), now).find(a => a.key === 'profile-health:implementer')).toBeUndefined()
  })

  it('FIRES on genuine failures whose text carries incidental bare status numbers (FIX 1 lock-in)', () => {
    // These are genuine implement failures; the "429"/"402"/"504" are incidental
    // (no HTTP context / provider words), so they must stay in the genuine cohort
    // and trip the alert rather than being masked as external.
    seedRuns([
      ...Array.from({ length: 8 }, () => ({ profile: 'sneaky', status: 'errored' as const, summary: 'expected 429 rows but the diff emitted 512' })),
      ...Array.from({ length: 4 }, () => ({ profile: 'sneaky', status: 'passed' as const })),
    ])
    const fired = detectProfileHealthAlerts(cfg(), now).find(a => a.key === 'profile-health:sneaky')
    expect(fired).toBeDefined()
    // 8 genuine / 12 terminal = 66.7%.
    expect(fired!.summary).toMatch(/66\.7%/)
  })

  it('does NOT fire on resultless errored runs (unknown cohort excluded, FIX 3)', () => {
    // Errored with no result_json (crash/abort before the result was written):
    // cause is indeterminate -> `unknown`, never counted as genuine.
    seedRuns([
      ...Array.from({ length: 30 }, () => ({ profile: 'crashy', status: 'errored' as const })), // no summary -> NULL result_json
      ...Array.from({ length: 5 }, () => ({ profile: 'crashy', status: 'passed' as const })),
    ])
    expect(detectProfileHealthAlerts(cfg(), now).find(a => a.key === 'profile-health:crashy')).toBeUndefined()
  })

  it('respects minRuns: a thin sample with high genuine failure does not fire', () => {
    seedRuns([
      ...Array.from({ length: 4 }, () => ({ profile: 'thin', status: 'errored' as const, summary: 'genuine boom' })),
    ])
    // 4 terminal < minRuns 10, even at 100% genuine failure.
    expect(detectProfileHealthAlerts(cfg({ minRuns: 10 }), now).find(a => a.key === 'profile-health:thin')).toBeUndefined()
    // Lowering minRuns below the sample makes it fire.
    expect(detectProfileHealthAlerts(cfg({ minRuns: 3 }), now).find(a => a.key === 'profile-health:thin')).toBeDefined()
  })

  it('respects the threshold and window bounds', () => {
    seedRuns([
      ...Array.from({ length: 4 }, () => ({ profile: 'mild', status: 'errored' as const, summary: 'genuine boom' })),
      ...Array.from({ length: 8 }, () => ({ profile: 'mild', status: 'passed' as const })),
      // Old genuine failures outside the 7d window must not count.
      ...Array.from({ length: 20 }, () => ({ profile: 'mild', status: 'errored' as const, summary: 'genuine boom', ageDays: 30 })),
    ])
    // In-window: 4 genuine / 12 terminal = 33% < 50% threshold -> no alert.
    expect(detectProfileHealthAlerts(cfg(), now).find(a => a.key === 'profile-health:mild')).toBeUndefined()
    // Dropping the threshold below 33% fires.
    expect(detectProfileHealthAlerts(cfg({ maxGenuineFailureRate: 0.2 }), now).find(a => a.key === 'profile-health:mild')).toBeDefined()
  })

  it('is disabled when config.alerts.profileHealth.enabled is false', () => {
    seedRuns(Array.from({ length: 20 }, () => ({ profile: 'broken', status: 'errored' as const, summary: 'genuine boom' })))
    expect(detectProfileHealthAlerts(cfg({ enabled: false }), now)).toHaveLength(0)
  })

  it('is wired into the alert engine and dedupes by profile key across cycles', async () => {
    seedRuns([
      ...Array.from({ length: 12 }, () => ({ profile: 'broken', status: 'errored' as const, summary: 'genuine boom' })),
    ])
    const first = await runAlertEngine({ now, opencodeReachable: true })
    expect(first.detected.find(a => a.key === 'profile-health:broken')).toBeDefined()
    await runAlertEngine({ now: now + 1000, opencodeReachable: true })
    const durable = listAlerts({ status: 'open' }).filter(a => a.key === 'profile-health:broken')
    expect(durable).toHaveLength(1)
    expect(durable[0]!.dedupeCount).toBeGreaterThanOrEqual(1)
  })
})

// ---- #203 stuck-task / per-task run cap alert ----------------------------
describe('stuck-task alert', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-stuck-task-'))
  const store = path.join(testDir, 'gateway.db')

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
    clearConfigCacheForTest()
    // Warn at 3 runs, hard-block at 5, so tests stay small and legible.
    updateConfig({ scheduler: { maxRunsPerTask: 5 } as any, alerts: { stuckTask: { enabled: true, runThreshold: 3 } } as any })
  })
  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
  })

  function seedTaskWithRuns(title: string, count: number) {
    const task = createWorkTask({ title, pipeline: ['implement'] }, store)
    const state = loadWorkState(store)
    for (let i = 0; i < count; i++) {
      state.runs.push({ ...createRun(task, 'implement', `ses_${task.id}_${i}`, 'implementer'), status: 'errored', completedAt: new Date().toISOString() })
    }
    saveWorkState(state, store)
    return task
  }

  it('fires a warning when a task crosses the run threshold but is under the cap', () => {
    const task = seedTaskWithRuns('Runaway issue', 3)
    const alerts = detectStuckTaskAlerts(loadWorkState(store), getConfig())
    const stuck = alerts.find(a => a.key === `stuck-task:${task.id}`)
    expect(stuck).toBeDefined()
    expect(stuck!.severity).toBe('warning')
    expect(stuck!.summary).toContain('3 runs')
    expect(stuck!.nextAction).toContain('gateway analytics --scorecard')
    expect(stuck!.evidence).toEqual(expect.arrayContaining([`task=${task.id}`, 'runCount=3']))
  })

  it('does not fire under the threshold', () => {
    seedTaskWithRuns('Healthy issue', 2)
    const alerts = detectStuckTaskAlerts(loadWorkState(store), getConfig())
    expect(alerts).toHaveLength(0)
  })

  it('respects the enabled flag', () => {
    clearConfigCacheForTest()
    updateConfig({ scheduler: { maxRunsPerTask: 5 } as any, alerts: { stuckTask: { enabled: false, runThreshold: 3 } } as any })
    seedTaskWithRuns('Runaway issue', 5)
    expect(detectStuckTaskAlerts(loadWorkState(store), getConfig())).toHaveLength(0)
  })

  it('escalates to critical for a task blocked at the run cap', () => {
    const task = seedTaskWithRuns('Capped issue', 5)
    applyWorkTaskAction(task.id, 'block', { note: 'Exceeded maxRunsPerTask (5 runs) — stuck task, needs operator attention' }, store)
    const alerts = detectStuckTaskAlerts(loadWorkState(store), getConfig())
    const stuck = alerts.find(a => a.key === `stuck-task:${task.id}`)
    expect(stuck!.severity).toBe('critical')
    expect(stuck!.summary).toContain('run cap')
  })

  it('ignores done/cancelled tasks and dedups per task', () => {
    const done = seedTaskWithRuns('Legit retried issue', 4)
    applyWorkTaskAction(done.id, 'done', {}, store)
    const runawayA = seedTaskWithRuns('Runaway A', 3)
    const runawayB = seedTaskWithRuns('Runaway B', 4)

    const alerts = detectStuckTaskAlerts(loadWorkState(store), getConfig())
    const keys = alerts.map(a => a.key)
    expect(keys).not.toContain(`stuck-task:${done.id}`)
    expect(keys).toEqual(expect.arrayContaining([`stuck-task:${runawayA.id}`, `stuck-task:${runawayB.id}`]))
    expect(new Set(keys).size).toBe(keys.length) // one dedup key per task
  })

  it('surfaces through detectAlerts end-to-end', () => {
    const task = seedTaskWithRuns('Runaway issue', 4)
    const now = Date.now()
    const okHeartbeat = { enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: new Date(now).toISOString() } as any
    const alerts = detectAlerts({ state: loadWorkState(store), now, heartbeat: okHeartbeat, freeDiskBytes: 50 * 1024 * 1024 * 1024 })
    expect(alerts.some(a => a.key === `stuck-task:${task.id}`)).toBe(true)
  })

  it('surfaces a live runaway even behind >=50 terminal tasks above the threshold', () => {
    // 51 done tasks each with a HIGHER run count than the live task. Under the old
    // "top-50 by COUNT(*) then filter terminal in JS" window these crowded the
    // live task out entirely, so it never alerted. The JOIN now excludes terminal
    // tasks in SQL *before* the limit, so the genuinely-stuck live task still fires.
    for (let i = 0; i < 51; i++) {
      const done = seedTaskWithRuns(`Done retried ${i}`, 10)
      applyWorkTaskAction(done.id, 'done', {}, store)
    }
    const live = seedTaskWithRuns('Live runaway', 4)
    const alerts = detectStuckTaskAlerts(loadWorkState(store), getConfig())
    const keys = alerts.map(a => a.key)
    expect(keys).toContain(`stuck-task:${live.id}`)
    expect(keys).toEqual([`stuck-task:${live.id}`]) // only the live task competes for the window
  })

  it('does not auto-resolve a firing live-task alert when terminal tasks flood the window', async () => {
    const now = Date.now()
    const okHeartbeat = { enabled: true, schedulerEnabled: true, intervalMs: 1000, running: false, status: 'ok', tickCount: 1, skippedTicks: 0, lastCompletedAt: new Date(now).toISOString() } as any
    const bigDisk = 50 * 1024 * 1024 * 1024
    const live = seedTaskWithRuns('Live runaway', 4)
    await runAlertEngine({ state: loadWorkState(store), now, heartbeat: okHeartbeat, freeDiskBytes: bigDisk })
    expect(listAlerts({ status: 'open' }).some(a => a.key === `stuck-task:${live.id}`)).toBe(true)
    // A burst of terminal tasks above the threshold must NOT crowd the live task
    // out of the active set and auto-resolve its still-firing alert.
    for (let i = 0; i < 51; i++) {
      const done = seedTaskWithRuns(`Done retried ${i}`, 10)
      applyWorkTaskAction(done.id, 'done', {}, store)
    }
    await runAlertEngine({ state: loadWorkState(store), now: now + 1000, heartbeat: okHeartbeat, freeDiskBytes: bigDisk })
    expect(listAlerts({ status: 'open' }).some(a => a.key === `stuck-task:${live.id}`)).toBe(true)
  })
})

function envRun(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  return {
    id: 'env_alert',
    name: 'local-node',
    backend: 'local-process',
    status: 'prepared',
    specHash: 'abc123',
    workdir: '/tmp/project',
    runtime: process.execPath,
    startedAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
    ttlMs: 3600000,
    cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'pending' },
    resources: { timeoutMs: 3600000 },
    network: { mode: 'restricted' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: ['node'], missing: [], warnings: [], commandRefs: ['command -v node'] },
    artifacts: [],
    metadata: {},
    ...overrides,
  }
}
