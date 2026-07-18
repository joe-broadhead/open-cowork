import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { applySupervisorResult, buildRoadmapSupervisorPrompt, parseSupervisorResult } from '../supervisor.js'
import { acquireDueRoadmapSupervisorWakeups, clearWorkStateForTest, createRoadmap, createRoadmapSupervisor, listRoadmapCompletionProposals, listWorkEvents, loadWorkState, updateRoadmapSupervisor } from '../work-store.js'

describe('supervisor contract', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-supervisor-test-'))

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

  it('builds prompts with durable turn identity and the safe action policy', () => {
    const { wakeup } = supervisedWakeup('Prompted roadmap')

    const prompt = buildRoadmapSupervisorPrompt(wakeup!, loadWorkState(store), {
      questions: [{ id: 'question_1', sessionID: wakeup!.supervisor.sessionId, questions: [{ question: 'Pick deployment window?', header: 'Deploy' }] }],
      permissions: [{ id: 'permission_1', sessionID: wakeup!.supervisor.sessionId, permission: 'bash', patterns: ['npm run verify'], metadata: {}, always: [] }],
    })

    expect(prompt).toContain(`"supervisorId":"${wakeup!.supervisor.supervisorId}"`)
    expect(prompt).toContain('"idempotencyKey"')
    expect(prompt).toContain('"reason":"schedule"')
    expect(prompt).toContain('Safe action policy')
    expect(prompt).toContain('OpenCode questions for this supervisor session')
    expect(prompt).toContain('OpenCode permissions for this supervisor session')
  })

  it('parses only valid fenced supervisor JSON', () => {
    const { wakeup } = supervisedWakeup('Parsed roadmap')
    const result = parseSupervisorResult([assistant(resultJson(wakeup, { status: 'needs_user', summary: 'Need a decision', actions: [{ type: 'ask_question', summary: 'Ask user' }], questions: ['Ship now?'] }))])

    expect(result).toMatchObject({ status: 'needs_user', summary: 'Need a decision', turn: { supervisorId: wakeup!.supervisor.supervisorId }, questions: ['Ship now?'] })
    expect(parseSupervisorResult([assistant('{"status":"ok"}')])).toMatchObject({ status: 'failed', summary: expect.stringContaining('fenced JSON') })
    expect(parseSupervisorResult([assistant('```json\n{"status":"ok","summary":"missing turn"}\n```')])).toMatchObject({ status: 'failed', summary: expect.stringContaining('turn is required') })
  })

  it('records proposed tasks unless direct task creation is explicitly allowed', () => {
    const { wakeup } = supervisedWakeup('Task proposal roadmap')
    const result = parseSupervisorResult([assistant(resultJson(wakeup, { actions: [{ type: 'create_task', summary: 'Add rollout task' }], proposedTasks: [{ title: 'Roll out safely', description: 'Canary rollout', priority: 'HIGH' }] }))])!

    const applied = applySupervisorResult(wakeup!.supervisor.supervisorId, result, store)

    expect(applied).toMatchObject({ applied: true, appliedActions: ['propose_task:1'] })
    expect(loadWorkState(store).tasks).toHaveLength(0)
    expect(listWorkEvents(20, store).map(event => event.type)).toContain('roadmap.supervisor.tasks_proposed')
  })

  it('allows direct task creation only by supervisor policy', () => {
    const { wakeup } = supervisedWakeup('Direct task roadmap')
    updateRoadmapSupervisor(wakeup!.supervisor.supervisorId, { completionPolicy: { allowDirectTaskCreate: true } }, store)
    const result = parseSupervisorResult([assistant(resultJson(wakeup, { actions: [{ type: 'create_task', summary: 'Create directly' }], proposedTasks: [{ title: 'Direct follow-up' }] }))])!

    const applied = applySupervisorResult(wakeup!.supervisor.supervisorId, result, store)

    expect(applied).toMatchObject({ applied: true, appliedActions: ['create_task:1'] })
    expect(loadWorkState(store).tasks).toEqual([expect.objectContaining({ title: 'Direct follow-up', roadmapId: wakeup!.supervisor.roadmapId })])
  })

  it('rejects stale results and suppresses duplicate applications', () => {
    const { wakeup } = supervisedWakeup('Idempotent roadmap')
    const result = parseSupervisorResult([assistant(resultJson(wakeup, { summary: 'No work needed', actions: [{ type: 'none', summary: 'idle' }] }))])!
    const stale = parseSupervisorResult([assistant(resultJson({ ...wakeup, leaseOwner: 'other-owner' }, { summary: 'Stale result' }))])!

    expect(applySupervisorResult(wakeup!.supervisor.supervisorId, stale, store)).toMatchObject({ applied: false, rejectedActions: ['stale_or_mismatched_turn'] })
    expect(applySupervisorResult(wakeup!.supervisor.supervisorId, result, store)).toMatchObject({ applied: true })
    expect(applySupervisorResult(wakeup!.supervisor.supervisorId, result, store)).toMatchObject({ applied: false, rejectedActions: ['duplicate_result'] })
    expect(listWorkEvents(50, store).filter(event => event.type === 'roadmap.supervisor.result_applied')).toHaveLength(1)
  })

  it('applies completion proposals and schedule actions safely', () => {
    const { wakeup } = supervisedWakeup('Completion roadmap')
    const nextReviewAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const result = parseSupervisorResult([assistant(resultJson(wakeup, {
      status: 'completion_proposed',
      summary: 'Ready for approval',
      actions: [{ type: 'propose_completion', summary: 'Evidence is complete' }, { type: 'schedule_next_review', summary: 'Review tomorrow' }],
      completion: { recommendation: 'ready_for_user_approval', evidence: ['npm run verify'], risks: [] },
      nextReviewAt,
    }))])!

    const applied = applySupervisorResult(wakeup!.supervisor.supervisorId, result, store)

    expect(applied).toMatchObject({ applied: true, appliedActions: ['propose_completion', 'schedule_next_review'] })
    expect(listRoadmapCompletionProposals({ roadmapId: wakeup!.supervisor.roadmapId, status: 'open' }, store)).toHaveLength(1)
    expect(loadWorkState(store).supervisors.find(row => row.supervisorId === wakeup!.supervisor.supervisorId)).toMatchObject({ nextReviewAt, lastResultStatus: 'completion_proposed' })
  })

  function supervisedWakeup(title: string) {
    const roadmap = createRoadmap({ title }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: `ses_${title.replace(/\W+/g, '_')}`, nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)
    const [wakeup] = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'test-owner', leaseMs: 60000 }, store)
    expect(wakeup).toBeDefined()
    return { roadmap, supervisor, wakeup }
  }

  function resultJson(wakeup: any, overrides: Record<string, unknown> = {}): string {
    return '```json\n' + JSON.stringify({
      turn: { supervisorId: wakeup.supervisor.supervisorId, roadmapId: wakeup.supervisor.roadmapId, leaseOwner: wakeup.leaseOwner, cursorEventId: wakeup.cursorEventId },
      status: 'ok',
      summary: 'Reviewed roadmap',
      actions: [{ type: 'summary', summary: 'Reviewed' }],
      questions: [],
      proposedTasks: [],
      ...overrides,
    }) + '\n```'
  }

  function assistant(text: string) {
    return {
      info: { role: 'assistant', time: { created: 1, completed: 2 } },
      parts: [{ type: 'text', text }, { type: 'step-finish' }],
    }
  }
})
