import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, getConfig } from '../config.js'
import { clearWorkStateForTest, completeWorkTaskRun, createWorkTask, loadWorkState, startWorkTaskRun } from '../work-store.js'
import { buildGovernanceReport, evaluateGovernanceForTask, evaluateRunRuntime } from '../governance.js'

describe('governance policy', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-governance-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

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

  it('blocks dispatch when global cost budget is exhausted', () => {
    const task = createWorkTask({ title: 'Budget target' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_cost', 'implementer', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [], raw: '{}' }, 2, store, { costUsd: 1.2, inputTokens: 100 })
    const next = createWorkTask({ title: 'Next task' }, store)
    const config = { ...getConfig(), governance: { ...getConfig().governance, global: { dailyCostUsd: 1 } } }

    expect(evaluateGovernanceForTask(next, 'implement', loadWorkState(store), config)).toMatchObject({ allowed: false, status: 'blocked', action: 'block' })
  })

  it('warns when a configured budget is near exhaustion', () => {
    const task = createWorkTask({ title: 'Warn target' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_warn', 'implementer', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [], raw: '{}' }, 2, store, { costUsd: 0.85 })
    const config = { ...getConfig(), governance: { ...getConfig().governance, global: { dailyCostUsd: 1 } } }

    expect(evaluateGovernanceForTask(createWorkTask({ title: 'Warn next' }, store), 'implement', loadWorkState(store), config)).toMatchObject({ allowed: true, status: 'warn' })
    expect(buildGovernanceReport(loadWorkState(store), config)).toMatchObject({ status: 'warn' })
  })

  it('uses budget-specific pause action for stage token limits', () => {
    const task = createWorkTask({ title: 'Token target', pipeline: ['review'] }, store)
    const started = startWorkTaskRun(task.id, 'review', 'ses_tokens', 'reviewer', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [], raw: '{}' }, 2, store, { inputTokens: 100, outputTokens: 50 })
    const config = { ...getConfig(), governance: { ...getConfig().governance, stages: { review: { tokenLimit: 100, action: 'pause' as const } } } }

    expect(evaluateGovernanceForTask(createWorkTask({ title: 'Token next', pipeline: ['review'] }, store), 'review', loadWorkState(store), config)).toMatchObject({ allowed: false, status: 'paused', action: 'pause' })
  })

  it('continues past broad warnings to enforce narrower hard limits', () => {
    const task = createWorkTask({ title: 'Mixed target', pipeline: ['review'] }, store)
    const started = startWorkTaskRun(task.id, 'review', 'ses_mixed', 'reviewer', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: '', artifacts: [], raw: '{}' }, 2, store, { costUsd: 0.85, inputTokens: 100 })
    const config = { ...getConfig(), governance: { ...getConfig().governance, global: { dailyCostUsd: 1 }, stages: { review: { tokenLimit: 100, action: 'pause' as const } } } }

    expect(evaluateGovernanceForTask(createWorkTask({ title: 'Mixed next', pipeline: ['review'] }, store), 'review', loadWorkState(store), config)).toMatchObject({ allowed: false, status: 'paused', scope: 'stage:review' })
  })

  it('blocks runs that exceed runtime ceilings', () => {
    const task = createWorkTask({ title: 'Runtime target' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_runtime', 'implementer', store)!
    const config = { ...getConfig(), governance: { ...getConfig().governance, runtime: { maxRunMs: 1000, staleRunMs: 0 } } }

    expect(evaluateRunRuntime(started.run, config, Date.parse(started.run.startedAt) + 1001)).toMatchObject({ allowed: false, status: 'blocked' })
  })
})
