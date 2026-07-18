import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest } from '../config.js'
import {
  closeWorkDb,
  completeWorkTaskRun,
  createRoadmapWithTasks,
  createWorkTask,
  deleteWorkTask,
  disposeWorkStore,
  getRun,
  loadWorkState,
  renewWorkTaskRunLease,
  saveWorkState,
  startWorkTaskRun,
  applyWorkEnvironmentAction,
  applyActiveRunControl,
  withWorkDbTransactionForTest,
} from '../work-store.js'
import { getRunBySessionId, getRunsForRoadmap, getRunsForTask, taskHasAnyRun } from '../work-store/queries.js'
import { getRunCostTokenTotals } from '../work-store/analytics-queries.js'

// The live mutation window materializes only active + currentRunId + the most
// recent LIVE_RECENT_TERMINAL_RUNS terminal runs. Seed comfortably past it so
// the "outside the window" paths are actually exercised.
const HISTORY = 900

describe('work-store run windowing', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-run-window-'))
  const store = path.join(testDir, 'gateway.db')

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    disposeWorkStore()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    disposeWorkStore()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  /** Bulk-insert terminal runs directly (fast) with known cost/token attribution. */
  function seedTerminalRuns(taskId: string, count: number, opts: { costUsd?: number; inputTokens?: number; environmentJson?: string; firstRunId?: string } = {}): void {
    closeWorkDb(store)
    const db = new DatabaseSync(store)
    db.exec('BEGIN')
    const insert = db.prepare(`INSERT INTO runs (
      id, task_id, stage, session_id, profile, status, attempt, started_at, completed_at,
      cost_usd, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, runtime_ms, result_json, environment_json
    ) VALUES (?, ?, 'implement', ?, 'build', 'passed', 1, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?)`)
    const base = Date.parse('2023-01-01T00:00:00.000Z')
    for (let i = 0; i < count; i++) {
      const started = new Date(base + i * 1000).toISOString()
      insert.run(
        i === 0 && opts.firstRunId ? opts.firstRunId : `run_hist_${taskId}_${i}`,
        taskId,
        `ses_hist_${taskId}_${i}`,
        started,
        new Date(base + i * 1000 + 250).toISOString(),
        opts.costUsd ?? 0.01,
        opts.inputTokens ?? 100,
        50,
        JSON.stringify({ status: 'pass', summary: `hist ${i}`, feedback: '', artifacts: [], raw: '' }),
        i === 0 ? (opts.environmentJson ?? null) : null,
      )
    }
    db.exec('COMMIT')
    db.close()
    disposeWorkStore()
  }

  it('keeps the full run history durable and queryable after windowed mutations', () => {
    const task = createWorkTask({ title: 'history task', pipeline: ['implement'] }, store)
    seedTerminalRuns(task.id, HISTORY)

    // A windowed mutation runs against a bounded slice, but must not touch or
    // drop the historical runs it never materialized.
    createWorkTask({ title: 'unrelated hot mutation', pipeline: ['implement'] }, store)

    // Full history is still materialized by the (all-scope) public read path.
    expect(loadWorkState(store).runs.filter(run => run.taskId === task.id)).toHaveLength(HISTORY)
    // Targeted reads see every run, including the oldest one outside the window.
    expect(getRunsForTask(task.id, { limit: HISTORY + 10 }, store)).toHaveLength(HISTORY)
    expect(getRun(`run_hist_${task.id}_0`, store)?.id).toBe(`run_hist_${task.id}_0`)
    expect(getRunBySessionId(`ses_hist_${task.id}_0`, store)?.id).toBe(`run_hist_${task.id}_0`)
    expect(taskHasAnyRun(task.id, store)).toBe(true)
  })

  it('refuses to replace durable state from a partial live-window snapshot', () => {
    const task = createWorkTask({ title: 'partial save guard', pipeline: ['implement'] }, store)
    seedTerminalRuns(task.id, HISTORY)

    const liveOnly = loadWorkState(store, { runsScope: 'live' })
    expect(() => saveWorkState(liveOnly, store)).toThrow(/partial live-window WorkState/)

    expect(loadWorkState(store).runs.filter(run => run.taskId === task.id)).toHaveLength(HISTORY)
  })

  it('completes, retries, and renews leases correctly with thousands of historical runs present', () => {
    const task = createWorkTask({ title: 'scheduler task', pipeline: ['implement', 'verify'] }, store)
    seedTerminalRuns(task.id, HISTORY)

    // Start + renew lease + complete a fresh run: all operate on the active run,
    // which the window always materializes regardless of history depth.
    const started = startWorkTaskRun(task.id, 'implement', 'ses_live_1', 'build', store, { owner: 'w1', generation: 'g1' })!.run
    expect(renewWorkTaskRunLease(started.id, { owner: 'w1' }, store)).toBe(true)
    const completed = completeWorkTaskRun(started.id, { status: 'pass', summary: 'ok', feedback: '', artifacts: [], evidence: [], raw: '' }, 2, store)
    expect(completed?.applied).toBe(true)
    expect(completed?.task?.currentStage).toBe('verify') // advanced past implement

    // Retry path: a failing run keeps the task active for another attempt.
    const retryRun = startWorkTaskRun(task.id, 'verify', 'ses_live_2', 'build', store)!.run
    const failed = completeWorkTaskRun(retryRun.id, { status: 'fail', summary: 'nope', feedback: 'retry', artifacts: [], evidence: [], raw: '' }, 2, store)
    expect(failed?.applied).toBe(true)
    const durable = loadWorkState(store).tasks.find(t => t.id === task.id)!
    expect(['running', 'pending', 'blocked']).toContain(durable.status)

    // Nothing was lost: the historical runs plus the new live runs are all durable.
    expect(loadWorkState(store).runs.filter(run => run.taskId === task.id).length).toBe(HISTORY + 2)
  })

  it('computes all-time cost/token totals in SQL that match a full JS reduction', () => {
    const task = createWorkTask({ title: 'totals task', pipeline: ['implement'] }, store)
    seedTerminalRuns(task.id, HISTORY, { costUsd: 0.02, inputTokens: 200 })

    const totals = getRunCostTokenTotals({}, store)
    const runs = loadWorkState(store).runs
    const expectedCost = runs.reduce((sum, run) => sum + Number(run.costUsd || 0), 0)
    const expectedTokens = runs.reduce((sum, run) => sum + Number(run.inputTokens || 0) + Number(run.outputTokens || 0) + Number(run.reasoningTokens || 0) + Number(run.cacheReadTokens || 0) + Number(run.cacheWriteTokens || 0), 0)

    expect(totals.runs).toBe(HISTORY)
    expect(totals.costUsd).toBeCloseTo(expectedCost, 6)
    expect(totals.tokens).toBe(expectedTokens)
    // Scoped aggregate matches too.
    expect(getRunCostTokenTotals({ taskId: task.id }, store).tokens).toBe(expectedTokens)
  })

  it('serves getRunsForRoadmap across a roadmap regardless of history depth', () => {
    const { roadmap, tasks } = createRoadmapWithTasks({ title: 'roadmap window', tasks: [{ title: 'a', pipeline: ['implement'] }, { title: 'b', pipeline: ['implement'] }] }, store)
    seedTerminalRuns(tasks[0]!.id, 40)
    seedTerminalRuns(tasks[1]!.id, 40)

    const recent = getRunsForRoadmap(roadmap.id, { limit: 25 }, store)
    expect(recent.length).toBe(25) // bounded
    expect(recent.every(run => tasks.some(t => t.id === run.taskId))).toBe(true)
    // newest-first ordering
    for (let i = 1; i < recent.length; i++) {
      expect(Date.parse(recent[i - 1]!.startedAt)).toBeGreaterThanOrEqual(Date.parse(recent[i]!.startedAt))
    }
  })

  it('cleans up an environment on a terminal run that fell outside the live window', () => {
    const task = createWorkTask({ title: 'env task', pipeline: ['implement'] }, store)
    const environment = {
      id: 'env_old_1',
      name: 'old-workspace',
      backend: 'local-process' as const,
      status: 'retained' as const,
      specHash: 'hash',
      startedAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
      ttlMs: 0,
      cleanup: { retainOnFailure: false, retainOnSuccess: true, state: 'retained' as const },
      resources: {},
      network: { mode: 'inherit' as const },
      secrets: { allowedNames: [] },
      preflight: { ok: true, evidence: [] },
      artifacts: [],
      metadata: {},
    }
    // The env-bearing run is the OLDEST; HISTORY newer terminal runs push it out
    // of the recent-terminal window entirely.
    seedTerminalRuns(task.id, HISTORY, { environmentJson: JSON.stringify(environment), firstRunId: 'run_env_old' })

    const result = applyWorkEnvironmentAction('env_old_1', 'release', {}, store)
    expect(result).toBeDefined()
    expect(result!.run.id).toBe('run_env_old')
    expect(result!.eventType).toBe('environment.released')

    // The transition persisted to the durable store (proving the hydrated run was
    // written back), and no history was lost.
    const durableRun = getRun('run_env_old', store)!
    expect(durableRun.environment?.status).toBe('released')
    expect(loadWorkState(store).runs.filter(run => run.taskId === task.id)).toHaveLength(HISTORY)
  })

  function buildEnv(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      name: `ws-${id}`,
      backend: 'local-process' as const,
      status: 'retained' as const,
      specHash: 'hash',
      startedAt: '2022-01-01T00:00:00.000Z',
      updatedAt: '2022-01-01T00:00:00.000Z',
      ttlMs: 0,
      cleanup: { retainOnFailure: false, retainOnSuccess: true, state: 'retained' as const },
      resources: {},
      network: { mode: 'inherit' as const },
      secrets: { allowedNames: [] },
      preflight: { ok: true, evidence: [] },
      artifacts: [],
      metadata: {},
      ...extra,
    }
  }

  function insertRunRow(taskId: string, opts: { id: string; startedAt: string; environmentJson?: string }): void {
    closeWorkDb(store)
    const db = new DatabaseSync(store)
    db.prepare(`INSERT INTO runs (
      id, task_id, stage, session_id, profile, status, attempt, started_at, completed_at,
      cost_usd, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, runtime_ms, result_json, environment_json
    ) VALUES (?, ?, 'implement', ?, 'build', 'passed', 1, ?, ?, 0.01, 100, 50, 0, 0, 0, 250, ?, ?)`).run(
      opts.id,
      taskId,
      `ses_${opts.id}`,
      opts.startedAt,
      opts.startedAt,
      JSON.stringify({ status: 'pass', summary: '', feedback: '', artifacts: [], raw: '' }),
      opts.environmentJson ?? null,
    )
    db.close()
    disposeWorkStore()
  }

  it('hydrates the exact run for an env-cleanup id and never matches a nested-substring collision (FIX 2)', () => {
    const task = createWorkTask({ title: 'env id collision', pipeline: ['implement'] }, store)

    // The correct run carries the target environment id. A decoy run (started
    // LATER, so a LIMIT 1 ORDER BY started_at DESC fallback would pick it first)
    // has a DIFFERENT env id but embeds the target id as a nested object field,
    // so its environment_json contains the literal `"id":"env_target"` substring.
    insertRunRow(task.id, { id: 'run_correct', startedAt: '2022-01-01T00:00:00.000Z', environmentJson: JSON.stringify(buildEnv('env_target')) })
    insertRunRow(task.id, { id: 'run_decoy', startedAt: '2022-01-02T00:00:00.000Z', environmentJson: JSON.stringify(buildEnv('env_decoy', { metadata: { linkedEnv: { id: 'env_target' } } })) })
    // Push both out of the live recency window so the SQL hydration fallback runs.
    seedTerminalRuns(task.id, HISTORY)

    const decoyJson = JSON.stringify(buildEnv('env_decoy', { metadata: { linkedEnv: { id: 'env_target' } } }))
    expect(decoyJson).toContain('"id":"env_target"') // the collision really exists

    const result = applyWorkEnvironmentAction('env_target', 'release', {}, store)
    expect(result).toBeDefined()
    expect(result!.run.id).toBe('run_correct') // NOT run_decoy
    expect(result!.eventType).toBe('environment.released')

    // The correct run transitioned; the decoy was never touched.
    expect(getRun('run_correct', store)!.environment?.status).toBe('released')
    expect(getRun('run_decoy', store)!.environment?.status).toBe('retained')
    expect(getRun('run_decoy', store)!.environment?.id).toBe('env_decoy')
  })

  it('classifies an operator control on an aged-out terminal run as run_not_active, not run_not_found (FIX 5)', () => {
    const task = createWorkTask({ title: 'old terminal control', pipeline: ['implement'] }, store)
    // The env-less terminal run is the OLDEST; HISTORY newer terminal runs push
    // it out of the live window entirely so it is absent from state.runs.
    seedTerminalRuns(task.id, HISTORY, { firstRunId: 'run_terminal_old' })

    const control = applyActiveRunControl({ runId: 'run_terminal_old', action: 'stop' }, store)
    expect(control.reason).toBe('run_not_active')
    expect(control.outcome).toBe('no_op')
    expect(control.applied).toBe(false)

    // A genuinely absent id still classifies as run_not_found.
    const missing = applyActiveRunControl({ runId: 'run_does_not_exist', action: 'stop' }, store)
    expect(missing.reason).toBe('run_not_found')
    expect(missing.applied).toBe(false)
  })

  it('never evicts a work-db connection whose write transaction is still open (FIX 3)', () => {
    const primary = path.join(testDir, 'primary.db')
    createWorkTask({ title: 'primary seed', pipeline: ['implement'] }, primary)

    let ranInside = false
    withWorkDbTransactionForTest(primary, db => {
      // Write inside the open BEGIN IMMEDIATE transaction on `primary`.
      db.prepare("INSERT INTO meta (key, value) VALUES ('fix3_probe', 'committed') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
      // Force cross-path opens past the 16-connection cache cap. `primary` is the
      // LRU front (opened first, untouched since), so the pre-fix LRU would evict
      // and realClose() it out from under this live transaction; the active-handle
      // guard must keep it alive so the COMMIT below succeeds.
      for (let i = 0; i < 20; i++) loadWorkState(path.join(testDir, `evict_probe_${i}.db`))
      ranInside = true
    })
    expect(ranInside).toBe(true)

    // The write committed durably: the pinned handle survived and COMMIT landed.
    closeWorkDb(primary)
    const db = new DatabaseSync(primary)
    const value = (db.prepare("SELECT value FROM meta WHERE key = 'fix3_probe'").get() as any)?.value
    db.close()
    expect(value).toBe('committed')
  })

  it('deletes the entire run history of a task, including runs outside the window', () => {
    const keep = createWorkTask({ title: 'keep task', pipeline: ['implement'] }, store)
    const drop = createWorkTask({ title: 'drop task', pipeline: ['implement'] }, store)
    seedTerminalRuns(keep.id, 30)
    seedTerminalRuns(drop.id, HISTORY)

    deleteWorkTask(drop.id, store)

    // Every run for the deleted task is gone from the durable store, even the
    // ones the live window never materialized; the other task is untouched.
    expect(getRunsForTask(drop.id, { limit: HISTORY + 10 }, store)).toHaveLength(0)
    expect(taskHasAnyRun(drop.id, store)).toBe(false)
    expect(loadWorkState(store).runs.filter(run => run.taskId === drop.id)).toHaveLength(0)
    expect(loadWorkState(store).runs.filter(run => run.taskId === keep.id)).toHaveLength(30)

    // No orphaned rows remain at the SQL boundary.
    closeWorkDb(store)
    const db = new DatabaseSync(store)
    const orphans = Number((db.prepare('SELECT COUNT(*) AS c FROM runs WHERE task_id = ?').get(drop.id) as any).c)
    db.close()
    expect(orphans).toBe(0)
  })
})
