import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setChannelSession } from '../channel-sessions.js'
import { clearConfigCacheForTest, getConfig } from '../config.js'
import { buildNeedsAttentionReport, ensureHumanGateForTaskStage, formatNeedsAttentionReport } from '../human-loop.js'
import { clearWorkStateForTest, completeWorkTaskRun, createHumanGate, createRoadmap, createRoadmapSupervisor, createWorkTask, decideHumanGate, getWorkTaskReadiness, listHumanGates, listWorkEvents, loadWorkState, proposeRoadmapCompletion, startWorkTaskRun, timeoutHumanGate } from '../work-store.js'
import { taskHasAnyRun } from '../work-store/queries.js'

describe('human loop gates', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-human-loop-test-'))

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

  it('creates durable manual gates and approves them with audit events', () => {
    const task = createWorkTask({ title: 'Needs approval', manualGate: 'approval_required' }, store)
    const [gate] = listHumanGates({ status: 'open' }, store)

    expect(gate).toMatchObject({ taskId: task.id, status: 'pending', type: 'task_start' })
    expect(getWorkTaskReadiness(task.id, store)).toMatchObject({ status: 'waiting' })

    const result = decideHumanGate(gate!.id, { decision: 'approve', scope: 'once', actor: 'operator', source: 'test' }, store)

    expect(result?.gate).toMatchObject({ status: 'approved', scope: 'once', decidedBy: 'operator' })
    expect(getWorkTaskReadiness(task.id, store)).toMatchObject({ status: 'runnable' })
    expect(listWorkEvents(5, store).some(event => event.type === 'audit.human_decision')).toBe(true)
  })

  it('replays terminal human gate decisions without duplicating side effects', () => {
    createWorkTask({ title: 'Approve once', manualGate: 'approval_required' }, store)
    const [gate] = listHumanGates({ status: 'open' }, store)

    const first = decideHumanGate(gate!.id, { decision: 'approve', scope: 'once', actor: 'operator' }, store)
    const second = decideHumanGate(gate!.id, { decision: 'reject', note: 'late duplicate' }, store)

    expect(first?.gate).toMatchObject({ status: 'approved', scope: 'once' })
    expect(second?.gate).toMatchObject({ status: 'approved', scope: 'once' })
    expect(listWorkEvents(20, store).filter(event => event.type === 'human_gate.decided')).toHaveLength(1)
    expect(listWorkEvents(20, store).filter(event => event.type === 'audit.human_decision')).toHaveLength(1)
  })

  it('rejects gates by blocking the task', () => {
    const task = createWorkTask({ title: 'Reject me', manualGate: 'approval_required' }, store)
    const [gate] = listHumanGates({ status: 'open' }, store)

    const result = decideHumanGate(gate!.id, { decision: 'reject', note: 'unsafe' }, store)

    expect(result?.gate.status).toBe('rejected')
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)).toMatchObject({ status: 'blocked', note: 'unsafe' })
  })

  it('applies timeout policy to stale gates', () => {
    const task = createWorkTask({ title: 'Timeout target' }, store)
    const gate = createHumanGate({ type: 'task_start', taskId: task.id, reason: 'Needs approval', expiresAt: '2026-06-13T00:00:00.000Z', timeoutAction: 'block' }, store)

    const result = timeoutHumanGate(gate.id, 'block', store, Date.parse('2026-06-13T00:00:01.000Z'))

    expect(result?.gate.status).toBe('timed_out')
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)).toMatchObject({ status: 'blocked', note: 'Human gate timed out: Needs approval' })
  })

  it('bridges OpenCode-native requests without duplicating them as Gateway gates', () => {
    const report = buildNeedsAttentionReport({
      state: loadWorkState(store),
      gates: [],
      questions: [{ id: 'q1', sessionID: 'ses_q', questions: [{ header: 'Choice', question: 'Pick one?' }] }],
      permissions: [{ id: 'p1', sessionID: 'ses_p', permission: 'bash', patterns: ['npm test'] }],
    })

    expect(report.items.map(item => item.kind)).toEqual(['opencode_question', 'opencode_permission'])
    const text = formatNeedsAttentionReport(report)
    expect(text).toContain('Surfaces: Web/TUI=aligned')
    expect(text).toContain('CLI/MCP=aligned')
    expect(text).toContain('Mission Control=aligned')
    expect(report.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'q1',
        owner: 'opencode',
        decisionState: 'requires_open_code',
        action: expect.stringContaining('Gateway only forwards'),
        decision: expect.objectContaining({ source: 'opencode_question', owner: 'opencode' }),
        surfaceStates: expect.arrayContaining([
          expect.objectContaining({ surface: 'opencode_web_tui', status: 'aligned', decisionState: 'requires_open_code' }),
          expect.objectContaining({ surface: 'mission_control', status: 'aligned', decisionState: 'requires_open_code' }),
        ]),
      }),
      expect.objectContaining({
        id: 'p1',
        owner: 'opencode',
        decisionState: 'requires_open_code',
        action: expect.stringContaining('Gateway does not bypass OpenCode'),
        decision: expect.objectContaining({ source: 'opencode_permission', owner: 'opencode' }),
        decisionJourney: expect.objectContaining({ releaseClaim: 'local_operator_decision_surface_sync_only' }),
        surfaceStates: expect.arrayContaining([
          expect.objectContaining({ surface: 'trusted_channel', status: 'unavailable', decisionState: 'requires_open_code' }),
          expect.objectContaining({ surface: 'cli_mcp', status: 'aligned', decisionState: 'requires_open_code' }),
        ]),
      }),
    ]))
    expect(listHumanGates({}, store)).toHaveLength(0)
  })

  it('marks direct session-bound channels as aligned for OpenCode permission waits', () => {
    setChannelSession('telegram', 'chat-permission', 'ses_p')

    const report = buildNeedsAttentionReport({
      state: loadWorkState(store),
      gates: [],
      questions: [],
      permissions: [{ id: 'p_session', sessionID: 'ses_p', permission: 'bash', patterns: ['npm test'] }],
    })

    const permission = report.items.find(item => item.id === 'p_session')
    expect(permission).toMatchObject({
      kind: 'opencode_permission',
      owner: 'opencode',
      decisionState: 'requires_open_code',
      channels: 1,
    })
    expect(permission?.surfaceStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: 'trusted_channel', status: 'aligned', decisionState: 'requires_open_code' }),
    ]))
    expect(formatNeedsAttentionReport(report)).toContain('Trusted channel=aligned')
  })

  it('surfaces pending completion proposals as attention items', () => {
    const roadmap = createRoadmap({ title: 'Attention completion' }, store)
    const proposal = proposeRoadmapCompletion({ roadmapId: roadmap.id, evidence: ['tests'], unresolvedRisks: ['rollout'] }, store).proposal

    const report = buildNeedsAttentionReport({ state: loadWorkState(store), gates: [] })

    expect(report.items).toContainEqual(expect.objectContaining({
      id: proposal.id,
      kind: 'completion_proposal',
      roadmapId: roadmap.id,
      severity: 'high',
      owner: 'gateway',
      decisionState: 'requires_gateway',
      decision: expect.objectContaining({ source: 'gateway_completion_proposal' }),
    }))
  })

  it('groups Needs Attention by roadmap and resolves OpenCode request sessions to projects', () => {
    const roadmap = createRoadmap({ title: 'Grouped attention' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' }, store)
    const task = createWorkTask({ title: 'Blocked project task', roadmapId: roadmap.id, manualGate: 'approval_required' }, store)

    const report = buildNeedsAttentionReport({
      state: loadWorkState(store),
      questions: [{ id: 'q_project', sessionID: supervisor.sessionId, questions: [{ question: 'Proceed?', header: 'Decision' }] }],
      permissions: [],
    })

    expect(report.projects).toContainEqual(expect.objectContaining({ roadmapId: roadmap.id, roadmapTitle: 'Grouped attention', supervisorId: supervisor.supervisorId }))
    expect(report.projects.find(project => project.roadmapId === roadmap.id)?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.id, kind: 'gateway_gate' }),
      expect.objectContaining({ id: 'q_project', kind: 'opencode_question', roadmapId: roadmap.id }),
    ]))
  })

  it('creates policy stage gates and suppresses the same scope after approval', () => {
    const task = createWorkTask({ title: 'Verify gate', pipeline: ['verify'] }, store)
    const config = { ...getConfig(), humanLoop: { ...getConfig().humanLoop, stageApprovals: ['verify'] } }

    const gate = ensureHumanGateForTaskStage(task, 'verify', loadWorkState(store), config)!
    expect(gate).toMatchObject({ type: 'stage_transition', stage: 'verify' })
    decideHumanGate(gate.id, { decision: 'approve', scope: 'once' }, store)

    expect(ensureHumanGateForTaskStage(task, 'verify', loadWorkState(store), config)).toBeUndefined()
  })

  it('does not raise a spurious task_start gate when the task already ran but its runs aged out of the live window', () => {
    const task = createWorkTask({ title: 'Already ran', pipeline: ['implement'] }, store)
    const config = { ...getConfig(), humanLoop: { ...getConfig().humanLoop, enabled: true, taskStartApproval: true } }

    // The task genuinely ran before: a terminal run is durable in the store.
    const started = startWorkTaskRun(task.id, 'implement', 'ses_started', 'build', store)!.run
    completeWorkTaskRun(started.id, { status: 'pass', summary: 'ok', feedback: '', artifacts: [], evidence: [], raw: '' }, 2, store)
    expect(taskHasAnyRun(task.id, store)).toBe(true)

    // Simulate the scheduler dispatch path handing in a WINDOWED live state whose
    // runs slice no longer contains this task's aged-out terminal run. Reading
    // state.runs would wrongly conclude the task never started and raise a fresh
    // task_start gate; the durable taskHasAnyRun check must prevent that.
    const windowedState = { ...loadWorkState(store), runs: [] }
    expect(ensureHumanGateForTaskStage(task, 'implement', windowedState, config)).toBeUndefined()
    expect(listHumanGates({ status: 'open' }, store).some(gate => gate.type === 'task_start')).toBe(false)

    // Control: a task that truly never ran still raises the start gate, so the
    // fix narrows only the aged-out case.
    const fresh = createWorkTask({ title: 'Never ran', pipeline: ['implement'] }, store)
    const freshState = { ...loadWorkState(store), runs: [] }
    const gate = ensureHumanGateForTaskStage(fresh, 'implement', freshState, config)
    expect(gate).toMatchObject({ type: 'task_start', taskId: fresh.id })
  })
})
