import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildMainAgentBriefing, formatMainAgentBriefing } from '../briefing.js'
import { clearConfigCacheForTest } from '../config.js'
import {
  acquireDueRoadmapSupervisorWakeups,
  applyWorkTaskAction,
  clearWorkStateForTest,
  completeRoadmapSupervisorWakeup,
  completeWorkTaskRun,
  createHumanGate,
  createRoadmap,
  createRoadmapSupervisor,
  createWorkTask,
  startWorkTaskRun,
  upsertAlert,
} from '../work-store.js'

describe('main-agent briefing', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-briefing-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('builds an empty briefing without invented work', () => {
    const briefing = buildMainAgentBriefing({ filePath: store, now: Date.parse('2026-06-15T12:00:00.000Z') })

    expect(briefing.summary).toBe('No active Gateway work or human attention is pending.')
    expect(briefing.counts).toMatchObject({ activeRuns: 0, blockedIssues: 0, gates: 0, questions: 0, permissions: 0, alerts: 0 })
    expect(briefing.recommendedNextActions[0]).toMatchObject({ id: 'briefing:monitor', action: 'No immediate action required.' })
    expect(formatMainAgentBriefing(briefing)).toContain('No active Gateway work or human attention is pending.')
  })

  it('summarizes active project work and cites durable IDs', () => {
    const roadmap = createRoadmap({ title: 'Active launch', priority: 'HIGH' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' }, store)
    const task = createWorkTask({ title: 'Implement launch flow', roadmapId: roadmap.id, priority: 'HIGH' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_run_active', 'implementer', store)!

    const briefing = buildMainAgentBriefing({ filePath: store, now: Date.parse('2026-06-15T12:00:00.000Z') })

    expect(briefing.activeRuns[0]).toMatchObject({ id: started.run.id, links: { run: `/runs/${started.run.id}`, task: `/tasks/${task.id}`, session: '/opencode/sessions/ses_run_active' } })
    expect(briefing.changedWork.some(item => item.links['roadmap'] === `/roadmaps/${roadmap.id}`)).toBe(true)
    expect(briefing.changedWork.some(item => item.summary.includes('Implement launch flow'))).toBe(true)
    expect(briefing.supervisorReceipts).toHaveLength(0)
    expect(supervisor.supervisorId).toMatch(/^supervisor_/)
  })

  it('surfaces blocked work, gates, OpenCode requests, and alerts', () => {
    const roadmap = createRoadmap({ title: 'Blocked launch', priority: 'HIGH' }, store)
    const task = createWorkTask({ title: 'Wait for API key', roadmapId: roadmap.id, priority: 'HIGH' }, store)
    applyWorkTaskAction(task.id, 'block', { note: 'API key missing' }, store)
    const gate = createHumanGate({ type: 'credential_use', taskId: task.id, roadmapId: roadmap.id, reason: 'API key approval required', requestedBy: 'test', scopeKey: `test:${task.id}` }, store)
    const alert = upsertAlert({ key: 'test:blocker', severity: 'critical', source: 'test', target: task.id, summary: 'Blocked by missing key', evidence: ['API key missing'], nextAction: 'Provide or reject the key.' }, {}, store).alert

    const briefing = buildMainAgentBriefing({
      filePath: store,
      questions: [{ id: 'q1', sessionID: 'ses_supervisor', questions: [{ header: 'Confirm', question: 'Use production key?' }] }],
      permissions: [{ id: 'p1', sessionID: 'ses_run', permission: 'bash', patterns: ['deploy'], metadata: {}, always: [] }],
      now: Date.parse('2026-06-15T12:00:00.000Z'),
    })

    expect(briefing.blockedIssues[0]).toMatchObject({ id: task.id, summary: 'API key missing' })
    expect(briefing.gates[0]).toMatchObject({ id: gate.id, links: { gate: `/human-gates/${gate.id}`, task: `/tasks/${task.id}` } })
    expect(briefing.openCodeRequests.map(item => item.id)).toEqual(['q1', 'p1'])
    expect(briefing.alerts[0]).toMatchObject({ id: alert.id, action: 'Provide or reject the key.' })
    expect(briefing.recommendedNextActions[0]!.kind).toMatch(/gateway_gate|opencode_|task|alert/)
  })

  it('recommends active alerts when alerts are the only pending issue', () => {
    const alert = upsertAlert({ key: 'test:alert-only', severity: 'critical', source: 'test', summary: 'OpenCode is unreachable', evidence: ['connection refused'], nextAction: 'Start OpenCode before dispatching more work.' }, {}, store).alert

    const briefing = buildMainAgentBriefing({ filePath: store, now: Date.parse('2026-06-15T12:00:00.000Z') })

    expect(briefing.counts.alerts).toBe(1)
    expect(briefing.recommendedNextActions[0]).toMatchObject({
      id: alert.id,
      kind: 'alert',
      action: 'Start OpenCode before dispatching more work.',
    })
    expect(briefing.recommendedNextActions[0]!.summary).toContain('connection refused')
  })

  it('includes post-completion results and enriched supervisor receipts', () => {
    const roadmap = createRoadmap({ title: 'Completion launch', priority: 'HIGH' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor', cadence: { intervalMs: 60000 } }, store)
    const task = createWorkTask({ title: 'Verify launch', roadmapId: roadmap.id, pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_verify', 'verifier', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'Verified launch', feedback: 'ok', artifacts: ['file:/tmp/report.txt'], raw: 'ok' }, 2, store)
    applyWorkTaskAction(task.id, 'done', { note: 'manually accepted' }, store)

    const wakeup = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'receipt-test', now: Date.parse('2026-06-15T12:00:00.000Z') }, store)[0]
    completeRoadmapSupervisorWakeup(supervisor.supervisorId, {
      leaseOwner: 'receipt-test',
      cursorEventId: wakeup!.cursorEventId,
      note: 'Everything is complete.',
      inspectedInputs: [`run:${started.run.id}`],
      changedObjectIds: [`task:${task.id}`, `roadmap:${roadmap.id}`],
      recommendation: 'ready_for_user_approval',
      nextAction: 'Approve completion or reopen follow-up work.',
    }, store)

    const briefing = buildMainAgentBriefing({ filePath: store, now: Date.parse('2026-06-15T12:05:00.000Z') })

    expect(briefing.recentCompletions.some(item => item.id === started.run.id)).toBe(true)
    expect(briefing.supervisorReceipts[0]).toMatchObject({
      id: wakeup!.receiptId,
      action: 'Approve completion or reopen follow-up work.',
      evidence: expect.arrayContaining([`run:${started.run.id}`, `task:${task.id}`, `roadmap:${roadmap.id}`]),
    })
    expect(formatMainAgentBriefing(briefing)).toContain('Supervisor Receipts')
  })
})
