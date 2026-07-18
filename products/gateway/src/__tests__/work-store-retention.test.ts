import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearWorkStateForTest, createRoadmap, createWorkTask, loadWorkState, runWorkStoreRetentionMaintenance } from '../work-store.js'
import { countRunsForTask, getRunsForTask } from '../work-store/queries.js'
import { getRunAnalyticsGroups } from '../work-store/analytics-queries.js'
import { getWorkQueueSnapshot } from '../scheduler.js'

const DAY = 24 * 60 * 60 * 1000

describe('work-store retention', () => {
  let testDir: string
  let store: string
  const now = Date.parse('2026-07-01T12:00:00.000Z')
  const day = (n: number) => now - n * DAY
  const iso = (ms: number) => new Date(ms).toISOString()

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-retention-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  interface RunSeed { id: string; taskId: string; status: 'running' | 'passed' | 'failed' | 'blocked' | 'errored'; startedAtMs: number }

  function seedRuns(seeds: RunSeed[]): void {
    const db = new DatabaseSync(store)
    try {
      const insert = db.prepare(
        `INSERT INTO runs (id, task_id, stage, session_id, profile, status, attempt, started_at, completed_at)
         VALUES (?, ?, 'implement', ?, 'p', ?, 1, ?, ?)`,
      )
      for (const seed of seeds) {
        const completedAt = seed.status === 'running' ? null : iso(seed.startedAtMs + 1000)
        insert.run(seed.id, seed.taskId, `ses_${seed.id}`, seed.status, iso(seed.startedAtMs), completedAt)
      }
    } finally {
      db.close()
    }
  }

  function setCurrentRun(taskId: string, runId: string): void {
    const db = new DatabaseSync(store)
    try {
      db.prepare('UPDATE tasks SET current_run_id = ? WHERE id = ?').run(runId, taskId)
    } finally {
      db.close()
    }
  }

  function runIds(): Set<string> {
    return new Set(loadWorkState(store).runs.map(run => run.id))
  }

  it('prunes only truly-old, non-lastRun, non-current terminal runs and preserves every consumer view', () => {
    const rm = createRoadmap({ title: 'RM' }, store).id
    const t1 = createWorkTask({ title: 'T1', roadmapId: rm, pipeline: ['implement'] }, store).id
    const t2 = createWorkTask({ title: 'T2 stale', roadmapId: rm, pipeline: ['implement'] }, store).id
    const t3 = createWorkTask({ title: 'T3 current', roadmapId: rm, pipeline: ['implement'] }, store).id
    const t4 = createWorkTask({ title: 'T4 running', roadmapId: rm, pipeline: ['implement'] }, store).id

    seedRuns([
      { id: 'r_t1_recent', taskId: t1, status: 'passed', startedAtMs: day(5) }, // recent lastRun -> keep
      { id: 'r_t1_old_a', taskId: t1, status: 'failed', startedAtMs: day(120) }, // old, non-last -> PRUNE
      { id: 'r_t1_old_b', taskId: t1, status: 'blocked', startedAtMs: day(150) }, // old, non-last -> PRUNE
      { id: 'r_t2_only', taskId: t2, status: 'passed', startedAtMs: day(200) }, // old but only run = lastRun -> keep
      { id: 'r_t3_current', taskId: t3, status: 'passed', startedAtMs: day(180) }, // old, non-last, current -> keep
      { id: 'r_t3_newer', taskId: t3, status: 'passed', startedAtMs: day(3) }, // recent lastRun -> keep
      { id: 'r_t4_running', taskId: t4, status: 'running', startedAtMs: day(300) }, // old but not terminal -> keep
    ])
    setCurrentRun(t3, 'r_t3_current')

    // Analytics aggregates over both a narrow (in-window) and wide window, captured
    // before retention to prove the narrow window is untouched and the wide window
    // loses exactly the two truly-old non-lastRun runs.
    const narrowBefore = getRunAnalyticsGroups('roadmap', { since: day(30) }, store)
    const wideBefore = getRunAnalyticsGroups('roadmap', { since: day(365) }, store)

    const result = runWorkStoreRetentionMaintenance(store, { runsMaxAgeMs: 90 * DAY, receiptsMaxAgeMs: 0, now: new Date(now) })

    expect(result.runs.pruned).toBe(2)
    const remaining = runIds()
    expect(remaining.has('r_t1_old_a')).toBe(false)
    expect(remaining.has('r_t1_old_b')).toBe(false)
    for (const kept of ['r_t1_recent', 'r_t2_only', 'r_t3_current', 'r_t3_newer', 'r_t4_running']) {
      expect(remaining.has(kept)).toBe(true)
    }

    // getWorkQueueSnapshot lastRun-per-task survives, including the stale task whose
    // only (and therefore most-recent) run is 200 days old.
    const snapshot = getWorkQueueSnapshot()
    const byId = new Map(snapshot.tasks.map(task => [task.id, task]))
    expect(byId.get(t1)?.lastRun?.id).toBe('r_t1_recent')
    expect(byId.get(t2)?.lastRun?.id).toBe('r_t2_only')
    expect(byId.get(t3)?.lastRun?.id).toBe('r_t3_newer')
    expect(byId.get(t4)?.lastRun?.id).toBe('r_t4_running')

    // Narrow (30-day) analytics window is byte-identical — retention never touches it.
    expect(getRunAnalyticsGroups('roadmap', { since: day(30) }, store)).toEqual(narrowBefore)
    // Wide (365-day) window drops exactly the two pruned runs.
    const wideAfter = getRunAnalyticsGroups('roadmap', { since: day(365) }, store)
    const totalRuns = (rows: Array<{ runCount: number }>) => rows.reduce((sum, row) => sum + row.runCount, 0)
    expect(totalRuns(wideBefore) - totalRuns(wideAfter)).toBe(2)

    // getRunsForTask still returns the preserved stale lastRun.
    expect(getRunsForTask(t2, {}, store).map(run => run.id)).toContain('r_t2_only')
  })

  it('executes the run prune in bounded chunks', () => {
    const rm = createRoadmap({ title: 'RM' }, store).id
    const task = createWorkTask({ title: 'many', roadmapId: rm, pipeline: ['implement'] }, store).id
    const seeds: RunSeed[] = [{ id: 'r_last', taskId: task, status: 'passed', startedAtMs: day(1) }]
    for (let i = 0; i < 25; i++) seeds.push({ id: `r_old_${i}`, taskId: task, status: 'passed', startedAtMs: day(100 + i) })
    seedRuns(seeds)

    // chunk size 10 < 25 prunable rows forces multiple bounded delete transactions.
    const result = runWorkStoreRetentionMaintenance(store, { runsMaxAgeMs: 90 * DAY, receiptsMaxAgeMs: 0, rowDeleteChunkRows: 10, now: new Date(now) })
    expect(result.runs.pruned).toBe(25)
    const remaining = runIds()
    expect(remaining.size).toBe(1)
    expect(remaining.has('r_last')).toBe(true)
  })

  it('preserves lifetime run counts after old runs are pruned', () => {
    const rm = createRoadmap({ title: 'RM' }, store).id
    const task = createWorkTask({ title: 'Lifetime budget', roadmapId: rm, pipeline: ['implement'] }, store).id
    seedRuns([
      { id: 'r_last', taskId: task, status: 'passed', startedAtMs: day(1) },
      { id: 'r_old_1', taskId: task, status: 'failed', startedAtMs: day(120) },
      { id: 'r_old_2', taskId: task, status: 'blocked', startedAtMs: day(121) },
    ])

    expect(countRunsForTask(task, store)).toBe(3)
    const result = runWorkStoreRetentionMaintenance(store, { runsMaxAgeMs: 90 * DAY, receiptsMaxAgeMs: 0, now: new Date(now) })

    expect(result.runs.pruned).toBe(2)
    expect(getRunsForTask(task, {}, store).map(run => run.id)).toEqual(['r_last'])
    expect(countRunsForTask(task, store)).toBe(3)
  })

  it('prunes idle receipt rows past the window but keeps recent and active rows', () => {
    createRoadmap({ title: 'RM' }, store) // initialize the full schema (all receipt tables)
    const db = new DatabaseSync(store)
    try {
      // task_dispatch_receipts: keep recent + active 'starting', prune old idle 'started'.
      const dispatch = db.prepare(
        `INSERT INTO task_dispatch_receipts (id, task_id, stage, idempotency_key, lease_owner, lease_expires_at, status, created_at, updated_at)
         VALUES (?, 't', 's', ?, 'o', ?, ?, ?, ?)`,
      )
      dispatch.run('d_old', 'k_d_old', iso(day(200)), 'started', iso(day(200)), iso(day(200)))
      dispatch.run('d_recent', 'k_d_recent', iso(day(1)), 'started', iso(day(1)), iso(day(1)))
      dispatch.run('d_old_active', 'k_d_old_active', iso(day(200)), 'starting', iso(day(200)), iso(day(200)))

      // supervisor_wakeup_receipts: keep active 'leased', prune old 'completed'.
      const wake = db.prepare(
        `INSERT INTO supervisor_wakeup_receipts (id, supervisor_id, roadmap_id, wake_reason, reason_detail, idempotency_key, window_key, cursor_event_id, trigger_event_ids_json, lease_owner, lease_expires_at, status, created_at, updated_at)
         VALUES (?, 's', 'r', 'w', 'w', ?, 'wk', 0, '[]', 'o', ?, ?, ?, ?)`,
      )
      wake.run('w_old', 'k_w_old', iso(day(200)), 'completed', iso(day(200)), iso(day(200)))
      wake.run('w_recent', 'k_w_recent', iso(day(1)), 'completed', iso(day(1)), iso(day(1)))
      wake.run('w_old_active', 'k_w_old_active', iso(day(200)), 'leased', iso(day(200)), iso(day(200)))

      // delegation_progress_receipts: pure dedup ledger, prune by age only.
      const progress = db.prepare(
        `INSERT INTO delegation_progress_receipts (progress_key, idempotency_key, progress, created_at) VALUES (?, 'k', 'done', ?)`,
      )
      progress.run('p_old', iso(day(200)))
      progress.run('p_recent', iso(day(1)))

      // delegation_progress_route_receipts: keep active 'deferred', prune old 'delivered'.
      const route = db.prepare(
        `INSERT INTO delegation_progress_route_receipts (dedupe_key, state, attempt_count, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`,
      )
      route.run('rt_old', 'delivered', iso(day(200)), iso(day(200)))
      route.run('rt_recent', 'delivered', iso(day(1)), iso(day(1)))
      route.run('rt_old_active', 'deferred', iso(day(200)), iso(day(200)))
    } finally {
      db.close()
    }

    const result = runWorkStoreRetentionMaintenance(store, { runsMaxAgeMs: 0, receiptsMaxAgeMs: 90 * DAY, now: new Date(now) })
    expect(result.receipts.pruned).toBe(4) // d_old, w_old, p_old, rt_old

    const check = new DatabaseSync(store)
    try {
      const ids = (sql: string, col: string) => new Set((check.prepare(sql).all() as Array<Record<string, unknown>>).map(row => String(row[col])))
      const dispatchIds = ids('SELECT id FROM task_dispatch_receipts', 'id')
      expect(dispatchIds).toEqual(new Set(['d_recent', 'd_old_active']))
      const wakeIds = ids('SELECT id FROM supervisor_wakeup_receipts', 'id')
      expect(wakeIds).toEqual(new Set(['w_recent', 'w_old_active']))
      const progressIds = ids('SELECT progress_key FROM delegation_progress_receipts', 'progress_key')
      expect(progressIds).toEqual(new Set(['p_recent']))
      const routeIds = ids('SELECT dedupe_key FROM delegation_progress_route_receipts', 'dedupe_key')
      expect(routeIds).toEqual(new Set(['rt_recent', 'rt_old_active']))
    } finally {
      check.close()
    }
  })

  it('honours the configured retention window default when no options are passed', () => {
    updateConfig({ storage: { retention: { runsMaxAgeDays: 60, receiptsMaxAgeDays: 60 } } } as never)
    const rm = createRoadmap({ title: 'RM' }, store).id
    const task = createWorkTask({ title: 'T', roadmapId: rm, pipeline: ['implement'] }, store).id
    seedRuns([
      { id: 'r_last', taskId: task, status: 'passed', startedAtMs: day(1) },
      { id: 'r_old_70', taskId: task, status: 'passed', startedAtMs: day(70) }, // > 60 days, non-last -> prune
      { id: 'r_in_50', taskId: task, status: 'passed', startedAtMs: day(50) }, // < 60 days -> keep
    ])
    // No options: window comes from config (60 days). now defaults to Date.now(); the
    // seeded ages are relative to a fixed `now`, so pass it to keep the boundary exact.
    const result = runWorkStoreRetentionMaintenance(store, { now: new Date(now), receiptsMaxAgeMs: 0 })
    expect(result.runs.pruned).toBe(1)
    expect(runIds().has('r_old_70')).toBe(false)
    expect(runIds().has('r_in_50')).toBe(true)
    expect(runIds().has('r_last')).toBe(true)
  })
})
