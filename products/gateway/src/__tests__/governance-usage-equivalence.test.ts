import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, getConfig } from '../config.js'
import {
  clearWorkStateForTest,
  completeWorkTaskRun,
  createRoadmap,
  createWorkTask,
  loadWorkState,
  startWorkTaskRun,
  type RunRecord,
} from '../work-store.js'
import { runReferencesArtifact } from '../work-store/queries.js'
import { getRunCostTokenTotals, getRunUsageTotalsBatch } from '../work-store/analytics-queries.js'
import { buildGovernanceReport, evaluateGovernanceForTask } from '../governance.js'

// The SQL run-usage aggregates must be numerically identical to the previous
// "JS-reduce over every run" logic they replaced on the governance read path.
// These tests seed a realistic run history and prove the substitution.

function eventTime(run: RunRecord): number {
  const value = Date.parse(run.completedAt || run.startedAt || '')
  return Number.isFinite(value) ? value : 0
}

function runTokens(run: RunRecord): number {
  return Number(run.inputTokens || 0) + Number(run.outputTokens || 0) + Number(run.reasoningTokens || 0) + Number(run.cacheReadTokens || 0) + Number(run.cacheWriteTokens || 0)
}

function jsCost(runs: RunRecord[]): number {
  return runs.reduce((sum, run) => sum + Number(run.costUsd || 0), 0)
}

function jsTokens(runs: RunRecord[]): number {
  return runs.reduce((sum, run) => sum + runTokens(run), 0)
}

describe('governance run-usage SQL equivalence', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-governance-usage-'))
  const store = path.join(testDir, 'gateway.db')

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  function seed(): { roadmapA: string; roadmapB: string; taskA1: string } {
    const roadmapA = createRoadmap({ title: 'Roadmap A' }, store).id
    const roadmapB = createRoadmap({ title: 'Roadmap B' }, store).id
    const taskA1 = createWorkTask({ title: 'A1', roadmapId: roadmapA, pipeline: ['implement', 'review'] }, store).id
    const taskA2 = createWorkTask({ title: 'A2', roadmapId: roadmapA, pipeline: ['implement'] }, store).id
    const taskB1 = createWorkTask({ title: 'B1', roadmapId: roadmapB, pipeline: ['review'] }, store).id
    const taskB2 = createWorkTask({ title: 'B2', roadmapId: roadmapB, pipeline: ['review'] }, store).id

    let counter = 0
    const run = (taskId: string, stage: string, cost: number, tokens: number, status: 'pass' | 'fail' = 'pass') => {
      counter += 1
      const started = startWorkTaskRun(taskId, stage, `ses_${counter}`, 'agent', store)
      expect(started, `run ${counter} (${taskId}/${stage}) should start`).toBeDefined()
      completeWorkTaskRun(started!.run.id, { status, summary: 'done', feedback: '', artifacts: [], raw: '{}' }, 2, store, { costUsd: cost, inputTokens: tokens })
    }
    run(taskA1, 'implement', 0.11, 100) // advances taskA1 to review
    run(taskA1, 'review', 0.22, 250)
    run(taskA2, 'implement', 0.33, 400)
    run(taskB1, 'review', 0.44, 550)
    run(taskB2, 'review', 0.05, 60, 'fail')
    return { roadmapA, roadmapB, taskA1 }
  }

  it('matches JS full-reduce totals for global, task, roadmap, and stage scopes', () => {
    const { roadmapA, taskA1 } = seed()
    const runs = loadWorkState(store).runs

    const global = getRunCostTokenTotals({}, store)
    expect(global.runs).toBe(runs.length)
    expect(global.costUsd).toBeCloseTo(jsCost(runs), 10)
    expect(global.tokens).toBe(jsTokens(runs))

    const taskRuns = runs.filter(run => run.taskId === taskA1)
    const taskTotals = getRunCostTokenTotals({ taskId: taskA1 }, store)
    expect(taskTotals.costUsd).toBeCloseTo(jsCost(taskRuns), 10)
    expect(taskTotals.tokens).toBe(jsTokens(taskRuns))

    const roadmapTaskIds = new Set(loadWorkState(store).tasks.filter(task => task.roadmapId === roadmapA).map(task => task.id))
    const roadmapRuns = runs.filter(run => roadmapTaskIds.has(run.taskId))
    const roadmapTotals = getRunCostTokenTotals({ roadmapId: roadmapA }, store)
    expect(roadmapTotals.costUsd).toBeCloseTo(jsCost(roadmapRuns), 10)
    expect(roadmapTotals.tokens).toBe(jsTokens(roadmapRuns))

    const stageRuns = runs.filter(run => run.stage === 'review')
    const stageTotals = getRunCostTokenTotals({ stage: 'review' }, store)
    expect(stageTotals.costUsd).toBeCloseTo(jsCost(stageRuns), 10)
    expect(stageTotals.tokens).toBe(jsTokens(stageRuns))
  })

  it('matches JS costSince windowing for the since bound', () => {
    seed()
    const runs = loadWorkState(store).runs
    const now = Date.now()

    // A since far in the past includes everything; far in the future includes nothing.
    const past = getRunCostTokenTotals({ since: now - 365 * 24 * 3600_000 }, store)
    expect(past.costUsd).toBeCloseTo(jsCost(runs.filter(run => eventTime(run) >= now - 365 * 24 * 3600_000)), 10)
    expect(past.runs).toBe(runs.length)

    const future = getRunCostTokenTotals({ since: now + 3600_000 }, store)
    expect(future.runs).toBe(0)
    expect(future.costUsd).toBe(0)
  })

  it('batches multiple scoped windows in one connection with identical results', () => {
    const { roadmapA, taskA1 } = seed()
    const single = [
      getRunCostTokenTotals({}, store),
      getRunCostTokenTotals({ taskId: taskA1 }, store),
      getRunCostTokenTotals({ roadmapId: roadmapA }, store),
    ]
    const batched = getRunUsageTotalsBatch([{}, { taskId: taskA1 }, { roadmapId: roadmapA }], store)
    expect(batched).toEqual(single)
  })

  it('governance report totals equal the old totalUsage full-reduce', () => {
    seed()
    const state = loadWorkState(store)
    const config = { ...getConfig(), governance: { ...getConfig().governance, enabled: true } }
    const report = buildGovernanceReport(state, config, Date.now(), store)
    expect(report.totals.costUsd).toBeCloseTo(jsCost(state.runs), 10)
    expect(report.totals.tokens).toBe(jsTokens(state.runs))
    // All seeded runs are terminal, so runtimeMs equals the SQL terminal sum.
    const terminalRuntime = state.runs.reduce((sum, run) => sum + Number(run.runtimeMs || 0), 0)
    expect(report.totals.runtimeMs).toBeCloseTo(terminalRuntime, 6)
  })

  it('surfaces the same used spend in a task budget decision as a JS reduce', () => {
    const { taskA1 } = seed()
    const runs = loadWorkState(store).runs
    const expectedTaskCost = jsCost(runs.filter(run => run.taskId === taskA1)) // 0.11 + 0.22 = 0.33
    // A limit of 0.4 puts used/limit at ~0.825 → warn, which surfaces `used`.
    const config = { ...getConfig(), governance: { ...getConfig().governance, enabled: true, tasks: { [taskA1]: { totalCostUsd: 0.4 } } } }
    const evalTask = loadWorkState(store).tasks.find(task => task.id === taskA1)!
    const decision = evaluateGovernanceForTask(evalTask, 'implement', loadWorkState(store), config, Date.now(), store)
    expect(decision.status).toBe('warn')
    expect(decision.used).toBeCloseTo(expectedTaskCost, 10)
  })

  it('runReferencesArtifact matches known refs without substring collisions', () => {
    const roadmap = createRoadmap({ title: 'Artifacts' }, store).id
    const task = createWorkTask({ title: 'Produce', roadmapId: roadmap, pipeline: ['implement'] }, store).id
    const started = startWorkTaskRun(task, 'implement', 'ses_artifact', 'agent', store)!
    completeWorkTaskRun(started.run.id, {
      status: 'pass',
      summary: 'done',
      feedback: '',
      artifacts: ['file:/tmp/report.log'],
      evidence: [{ type: 'log', ref: 'file:/tmp/evidence.txt', summary: 'e' }],
      raw: '{}',
    }, 2, store)

    expect(runReferencesArtifact('file:/tmp/report.log', store)).toBe(true)
    expect(runReferencesArtifact('file:/tmp/evidence.txt', store)).toBe(true)
    // A strict substring of a real ref must not resolve as attached.
    expect(runReferencesArtifact('file:/tmp/report', store)).toBe(false)
    expect(runReferencesArtifact('file:/tmp/missing.log', store)).toBe(false)
  })
})
