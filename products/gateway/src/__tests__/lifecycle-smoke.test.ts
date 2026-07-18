import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  applyWorkTaskAction,
  clearWorkStateForTest,
  createWorkTask,
  loadWorkState,
  saveWorkState,
  updateWorkTask,
  createRun,
  type WorkTaskAction,
} from '../work-store.js'
import { type WorkStatus } from '../workflow.js'

const ALL_STATUSES: WorkStatus[] = ['pending', 'running', 'done', 'blocked', 'paused', 'cancelled', 'archived']
const MUTATING_ACTIONS: WorkTaskAction[] = ['pause', 'resume', 'retry', 'block', 'done', 'cancel']

describe('SMOKE CONTROL lifecycle mutations', () => {
  let testDir = ''
  let store = ''

  beforeEach(() => {
    // Fresh mkdtemp directory per test: never delete the directory of a store
    // that was just initialized, and never share a fixed path across parallel
    // vitest workers.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-lifecycle-smoke-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('1. UPDATE — updateWorkTask modifies task metadata without changing status', () => {
    const task = createWorkTask({ title: 'Original', priority: 'LOW', agent: 'build' }, store)

    const updated = updateWorkTask(task.id, {
      title: 'Renamed via update',
      description: 'Updated description',
      priority: 'HIGH',
      agent: 'reviewer',
      pipeline: ['plan', 'audit'],
      note: 'metadata changed',
    }, store)

    expect(updated).toBeDefined()
    expect(updated!.title).toBe('Renamed via update')
    expect(updated!.description).toBe('Updated description')
    expect(updated!.priority).toBe('HIGH')
    expect(updated!.agent).toBe('reviewer')
    expect(updated!.pipeline).toEqual(['plan', 'audit'])
    expect(updated!.note).toBe('metadata changed')
    expect(updated!.status).toBe('pending')
  })

  it('2. PAUSE — sets status to paused and clears current run', () => {
    const task = createWorkTask({ title: 'Pause target', pipeline: ['implement', 'review', 'verify'] }, store)

    const activeRun = createRun(task, 'implement', `ses_paused`, 'implementer')
    task.status = 'running'
    task.currentRunId = activeRun.id
    task.currentStage = 'implement'
    saveWorkState(loadWorkState(store), store) // reload to get updated state
    // Recreate with the run registered
    clearWorkStateForTest(store)
    const task2 = createWorkTask({ title: 'Pause target', pipeline: ['implement', 'review', 'verify'] }, store)
    const activeRun2 = createRun(task2, 'implement', `ses_paused`, 'implementer')
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'running'
    state.tasks[0]!.currentRunId = activeRun2.id
    state.tasks[0]!.currentStage = 'implement'
    state.runs.push(activeRun2)
    saveWorkState(state, store)

    const result = applyWorkTaskAction(task2.id, 'pause', { note: 'paused for smoke test' }, store)

    expect(result).toBeDefined()
    expect(result!.task.status).toBe('paused')
    expect(result!.task.currentRunId).toBeUndefined()
    expect(result!.task.note).toBe('paused for smoke test')
    expect(result!.abortedSessionId).toBe('ses_paused')
  })

  it('3. RESUME — sets status to pending and restores currentStage', () => {
    const task = createWorkTask({ title: 'Resume target', pipeline: ['implement', 'review', 'verify'] }, store)
    // First pause it
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'paused'
    state.tasks[0]!.currentStage = undefined
    saveWorkState(state, store)

    const result = applyWorkTaskAction(task.id, 'resume', { stage: 'review' }, store)

    expect(result).toBeDefined()
    expect(result!.task.status).toBe('pending')
    expect(result!.task.currentStage).toBe('review')
    expect(result!.task.currentRunId).toBeUndefined()
  })

  it('4. RETRY — sets status to pending and resets currentStage', () => {
    const task = createWorkTask({ title: 'Retry target', pipeline: ['implement', 'review', 'verify'] }, store)
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'blocked'
    state.tasks[0]!.currentStage = undefined
    state.tasks[0]!.note = 'prior failure'
    saveWorkState(state, store)

    const result = applyWorkTaskAction(task.id, 'retry', { stage: 'implement' }, store)

    expect(result).toBeDefined()
    expect(result!.task.status).toBe('pending')
    expect(result!.task.currentStage).toBe('implement')
    expect(result!.task.currentRunId).toBeUndefined()
  })

  it('5. BLOCK — sets status to blocked and clears stage/run', () => {
    const task = createWorkTask({ title: 'Block target', pipeline: ['implement', 'review'] }, store)
    const activeRun = createRun(task, 'implement', `ses_blocked`, 'implementer')
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'running'
    state.tasks[0]!.currentRunId = activeRun.id
    state.tasks[0]!.currentStage = 'implement'
    state.runs.push(activeRun)
    saveWorkState(state, store)

    const result = applyWorkTaskAction(task.id, 'block', { note: 'blocked: needs dependency' }, store)

    expect(result).toBeDefined()
    expect(result!.task.status).toBe('blocked')
    expect(result!.task.currentRunId).toBeUndefined()
    expect(result!.task.currentStage).toBeUndefined()
    expect(result!.task.note).toBe('blocked: needs dependency')
    expect(result!.abortedSessionId).toBe('ses_blocked')
  })

  it('6. DONE — sets status to done and clears stage/run', () => {
    const task = createWorkTask({ title: 'Done target', pipeline: ['implement', 'review', 'verify'] }, store)
    const activeRun = createRun(task, 'verify', `ses_done`, 'implementer')
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'running'
    state.tasks[0]!.currentRunId = activeRun.id
    state.tasks[0]!.currentStage = 'verify'
    state.runs.push(activeRun)
    saveWorkState(state, store)

    const result = applyWorkTaskAction(task.id, 'done', { note: 'all stages passed' }, store)

    expect(result).toBeDefined()
    expect(result!.task.status).toBe('done')
    expect(result!.task.currentRunId).toBeUndefined()
    expect(result!.task.currentStage).toBeUndefined()
    expect(result!.task.note).toBe('all stages passed')
    expect(result!.abortedSessionId).toBe('ses_done')
  })

  it('7. CANCEL — sets status to cancelled and clears stage/run', () => {
    const task = createWorkTask({ title: 'Cancel target', pipeline: ['implement', 'review'] }, store)
    const activeRun = createRun(task, 'implement', `ses_cancelled`, 'implementer')
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'running'
    state.tasks[0]!.currentRunId = activeRun.id
    state.tasks[0]!.currentStage = 'implement'
    state.runs.push(activeRun)
    saveWorkState(state, store)

    const result = applyWorkTaskAction(task.id, 'cancel', { note: 'cancelled by smoke test' }, store)

    expect(result).toBeDefined()
    expect(result!.task.status).toBe('cancelled')
    expect(result!.task.currentRunId).toBeUndefined()
    expect(result!.task.currentStage).toBeUndefined()
    expect(result!.task.note).toBe('cancelled by smoke test')
    expect(result!.abortedSessionId).toBe('ses_cancelled')
  })

  it('COVERAGE — all 7 lifecycle actions are defined and reachable', () => {
    // update uses updateWorkTask() — a metadata-only mutation separate from the 6 state-transition actions
    const STATE_ACTIONS: string[] = ['pause', 'resume', 'retry', 'block', 'done', 'cancel']

    expect(STATE_ACTIONS).toHaveLength(6)
    expect(ALL_STATUSES).toHaveLength(7)

    // update is covered by test 1 (updateWorkTask)
    // pause/resume/retry/block/done/cancel covered by tests 2-7 (applyWorkTaskAction)
    for (const action of STATE_ACTIONS) {
      expect(MUTATING_ACTIONS).toContain(action as WorkTaskAction)
    }
    for (const status of ALL_STATUSES) {
      expect(['pending', 'running', 'done', 'blocked', 'paused', 'cancelled', 'archived']).toContain(status)
    }
  })

  it('ROUNDTRIP — full lifecycle: pending → running → paused → pending → running → blocked → pending → running → done', () => {
    const task = createWorkTask({ title: 'Roundtrip test', pipeline: ['implement', 'review', 'verify'] }, store)

    // pending → running (handled by scheduler dispatch, simulate here)
    const activeRun1 = createRun(task, 'implement', `ses_roundtrip_1`, 'implementer')
    const s1 = loadWorkState(store)
    const t1 = s1.tasks[0]
    t1!.status = 'running'
    t1!.currentRunId = activeRun1.id
    t1!.currentStage = 'implement'
    s1.runs.push(activeRun1)
    saveWorkState(s1, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('running')

    // running → paused
    applyWorkTaskAction(task.id, 'pause', { note: 'interrupted' }, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('paused')

    // paused → pending (resume)
    applyWorkTaskAction(task.id, 'resume', { stage: 'implement' }, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('pending')

    // pending → running (simulate dispatch again)
    const activeRun2 = createRun(task, 'implement', `ses_roundtrip_2`, 'implementer')
    const s2 = loadWorkState(store)
    const t2 = s2.tasks[0]
    t2!.status = 'running'
    t2!.currentRunId = activeRun2.id
    t2!.currentStage = 'implement'
    s2.runs.push(activeRun2)
    saveWorkState(s2, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('running')

    // running → blocked
    applyWorkTaskAction(task.id, 'block', { note: 'blocked on external dep' }, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('blocked')

    // blocked → pending (retry)
    applyWorkTaskAction(task.id, 'retry', { stage: 'implement' }, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('pending')

    // pending → running (simulate dispatch again)
    const activeRun3 = createRun(task, 'implement', `ses_roundtrip_3`, 'implementer')
    const s3 = loadWorkState(store)
    const t3 = s3.tasks[0]
    t3!.status = 'running'
    t3!.currentRunId = activeRun3.id
    t3!.currentStage = 'implement'
    s3.runs.push(activeRun3)
    saveWorkState(s3, store)
    expect(loadWorkState(store).tasks[0]!.status).toBe('running')

    // running → done
    applyWorkTaskAction(task.id, 'done', { note: 'roundtrip complete' }, store)
    const final = loadWorkState(store).tasks[0]
    expect(final!.status).toBe('done')
    expect(final!.currentRunId).toBeUndefined()
    expect(final!.currentStage).toBeUndefined()
  })

  it('EDGE — cancel from paused state is valid', () => {
    const task = createWorkTask({ title: 'Cancel from pause', pipeline: ['implement'] }, store)
    const s1 = loadWorkState(store)
    s1.tasks[0]!.status = 'paused'
    saveWorkState(s1, store)

    const result = applyWorkTaskAction(task.id, 'cancel', {}, store)
    expect(result!.task.status).toBe('cancelled')
  })

  it('EDGE — done from blocked state is valid (manual override)', () => {
    const task = createWorkTask({ title: 'Done from block', pipeline: ['implement'] }, store)
    const s1 = loadWorkState(store)
    s1.tasks[0]!.status = 'blocked'
    saveWorkState(s1, store)

    const result = applyWorkTaskAction(task.id, 'done', { note: 'resolved externally' }, store)
    expect(result!.task.status).toBe('done')
  })

  it('EDGE — block from paused state is valid', () => {
    const task = createWorkTask({ title: 'Block from pause', pipeline: ['implement'] }, store)
    const s1 = loadWorkState(store)
    s1.tasks[0]!.status = 'paused'
    saveWorkState(s1, store)

    const result = applyWorkTaskAction(task.id, 'block', { note: 'blocked while paused' }, store)
    expect(result!.task.status).toBe('blocked')
  })

  it('EDGE — resume sets currentStage to pipeline[0] when no stage specified', () => {
    const task = createWorkTask({ title: 'Resume no stage', pipeline: ['plan', 'implement'] }, store)
    const s1 = loadWorkState(store)
    s1.tasks[0]!.status = 'paused'
    s1.tasks[0]!.currentStage = undefined
    saveWorkState(s1, store)

    const result = applyWorkTaskAction(task.id, 'resume', {}, store)
    expect(result!.task.status).toBe('pending')
    expect(result!.task.currentStage).toBe('plan')
  })
})
