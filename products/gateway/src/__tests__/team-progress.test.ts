import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildTeamProgressRoutes, deliverTeamProgressBriefings, teamProgressMessage } from '../team-progress.js'
import { renderStructuredMessage } from '../channels/renderer.js'
import { clearConfigCacheForTest } from '../config.js'
import { appendWorkEvent, clearWorkStateForTest, createRoadmap, createWorkTask, listWorkEvents, loadWorkState, updateProjectBinding, upsertProjectBinding } from '../work-store.js'
import type { TeamTaskAssignment, TeamAssignmentReceipt } from '../team-assignment.js'

describe('team progress briefings', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-team-progress-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')
  const now = Date.parse('2026-06-15T12:00:00.000Z')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('routes assignment started briefings to channel and bound session with team context', async () => {
    const { assignment } = seedAssignment('started-key')
    const sent: string[] = []
    const prompts: string[] = []

    const delivered = await deliverTeamProgressBriefings(channels(sent), { state: loadWorkState(store) }, { now, filePath: store, sessionClient: sessionClient(prompts) })

    expect(delivered.failed).toHaveLength(0)
    expect(delivered.sent.map(route => route.delivery).sort()).toEqual(['immediate', 'session'])
    expect(sent[0]).toContain('Team Assignment Started')
    expect(sent[0]).toContain(`Team: delivery (${assignment.teamId})`)
    expect(sent[0]).toContain(`Member: ${assignment.memberId}`)
    expect(sent[0]).toContain('Assigned work: Ship team progress')
    expect(sent[0]).toContain('Evidence: 0/1 required evidence ref(s)')
    expect(sent[0]).toContain('Attention: monitor')
    expect(prompts[0]).toContain('Gateway team progress briefing.')
    expect(listWorkEvents(100, store).filter(event => event.type === 'team_assignment.briefing.notified')).toHaveLength(2)
  })

  it('classifies gate waiting, blocked, resumed, completed, and failed receipts deterministically', () => {
    const { assignment, binding } = seedAssignment('events-key', 'digest')
    updateProjectBinding(binding.id, { lastDigestAt: '2026-06-15T11:45:00.000Z' }, store)
    appendReceipt(assignment, 'gate_result', 'pending', 'review', 'review-pass', 'Waiting for review.')
    appendReceipt(assignment, 'gate_result', 'blocked', 'review', 'review-pass', 'Reviewer found a blocker.')
    appendReceipt(assignment, 'gate_result', 'passed', 'review', 'review-pass', 'Review passed.')
    appendReceipt(assignment, 'completion', 'passed', 'completion_quality', 'quality', 'Assignment complete.')
    appendReceipt(assignment, 'completion', 'failed', 'completion_quality', 'quality', 'Completion failed.')

    const routes = buildTeamProgressRoutes(loadWorkState(store), { now, filePath: store })
    const channelProgress = routes.filter(route => route.target.provider === 'telegram').map(route => route.progress)

    expect(channelProgress).toEqual(expect.arrayContaining(['started', 'gate_waiting', 'blocked', 'resumed', 'completed', 'failed']))
    expect(routes.find(route => route.progress === 'gate_waiting' && route.target.provider === 'telegram')).toMatchObject({ delivery: 'immediate', reason: 'critical bypasses digest', attention: 'needs_attention' })
    expect(routes.find(route => route.progress === 'blocked' && route.target.provider === 'telegram')).toMatchObject({ attention: 'needs_attention' })
    expect(routes.find(route => route.progress === 'failed' && route.target.provider === 'telegram')).toMatchObject({ attention: 'critical' })

    const failed = routes.find(route => route.progress === 'failed')!
    const plain = renderStructuredMessage(teamProgressMessage(failed), { plainText: true }).plainText
    expect(plain).toContain('Team Assignment Failed')
    expect(plain).toContain('Current gate: quality')
    expect(plain).toContain('Next action: Inspect')
  })

  it('emits scheduled digest routes when digest bindings are due', async () => {
    const { assignment, binding } = seedAssignment('digest-key', 'digest')
    updateProjectBinding(binding.id, { lastDigestAt: '2026-06-14T11:00:00.000Z' }, store)
    appendReceipt(assignment, 'gate_result', 'passed', 'review', 'review-pass', 'Review passed.')
    const sent: string[] = []

    const delivered = await deliverTeamProgressBriefings(channels(sent), { state: loadWorkState(store) }, { now, filePath: store, digestIntervalMs: 60 * 60 * 1000 })

    expect(delivered.sent.find(route => route.progress === 'scheduled_digest' && route.delivery === 'digest')).toBeTruthy()
    expect(sent.some(text => text.includes('Team Progress Digest'))).toBe(true)
    expect(listWorkEvents(100, store).find(event => event.type === 'team_assignment.briefing.notified' && event.payload['progress'] === 'scheduled_digest')?.payload).toMatchObject({
      delivery: 'digest',
      teamName: 'delivery',
      gateId: 'review-pass',
      evidenceStatus: '1/1 required evidence ref(s)',
    })
  })

  it('does not schedule digest routes after terminal completion receipts', () => {
    const { assignment, binding } = seedAssignment('terminal-digest-key', 'digest')
    updateProjectBinding(binding.id, { lastDigestAt: '2026-06-14T11:00:00.000Z' }, store)
    appendReceipt(assignment, 'completion', 'passed', 'completion_quality', 'quality', 'Assignment complete.')

    const routes = buildTeamProgressRoutes(loadWorkState(store), { now, filePath: store, digestIntervalMs: 60 * 60 * 1000 })

    expect(routes.find(route => route.progress === 'completed')).toBeTruthy()
    expect(routes.find(route => route.progress === 'scheduled_digest' && route.assignment.id === assignment.id)).toBeUndefined()
  })

  it('dedupes replayed event delivery without duplicate channel sends', async () => {
    seedAssignment('dedupe-key')
    const sent: string[] = []

    const first = await deliverTeamProgressBriefings(channels(sent), { state: loadWorkState(store) }, { now, filePath: store })
    const second = await deliverTeamProgressBriefings(channels(sent), { state: loadWorkState(store) }, { now: now + 1000, filePath: store })
    const afterWindow = await deliverTeamProgressBriefings(channels(sent), { state: loadWorkState(store) }, { now: now + 31 * 24 * 60 * 60 * 1000, filePath: store })

    expect(first.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(second.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(0)
    expect(second.suppressed).toContainEqual(expect.objectContaining({ delivery: 'deduped' }))
    expect(afterWindow.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(0)
    expect(afterWindow.suppressed).toContainEqual(expect.objectContaining({ delivery: 'deduped' }))
  })

  it('backs off recently failed delivery attempts for stale channel targets', async () => {
    const { assignment } = seedAssignment('failed-channel-key')
    appendReceipt(assignment, 'gate_result', 'pending', 'review', 'review-pass', 'Waiting for review.')
    appendReceipt(assignment, 'gate_result', 'blocked', 'review', 'review-pass', 'Reviewer found a blocker.')
    const failureNow = Date.now()
    const failingChannels = new Map([['telegram', {
      sendMessage: async () => {
        throw new Error('HTTP 400: Bad Request: chat not found')
      },
    }]])

    const first = await deliverTeamProgressBriefings(failingChannels, { state: loadWorkState(store) }, { now: failureNow, filePath: store, failureRetryMs: 60_000 })
    const second = await deliverTeamProgressBriefings(failingChannels, { state: loadWorkState(store) }, { now: failureNow + 1_000, filePath: store, failureRetryMs: 60_000 })
    const afterCooldown = await deliverTeamProgressBriefings(failingChannels, { state: loadWorkState(store) }, { now: failureNow + 61_000, filePath: store, failureRetryMs: 60_000 })

    expect(first.routes.filter(route => route.target.provider === 'telegram' && ['immediate', 'digest'].includes(route.delivery))).toHaveLength(3)
    expect(first.failed.filter(item => item.route.target.provider === 'telegram')).toHaveLength(1)
    expect(first.suppressed.filter(route => route.target.provider === 'telegram')).toEqual(expect.arrayContaining([
      expect.objectContaining({ delivery: 'deduped', reason: 'recent failed target cooldown' }),
    ]))
    expect(second.failed.filter(item => item.route.target.provider === 'telegram')).toHaveLength(0)
    expect(second.suppressed).toContainEqual(expect.objectContaining({ delivery: 'deduped', reason: 'recent failed delivery cooldown' }))
    expect(afterCooldown.failed.filter(item => item.route.target.provider === 'telegram')).toHaveLength(1)
    expect(listWorkEvents(100, store).filter(event => event.type === 'team_assignment.briefing.failed')).toHaveLength(2)
  })

  it('routes channel briefings through a task-linked roadmap when assignment roadmapId is absent', () => {
    const roadmap = createRoadmap({ title: 'Task linked routing' }, store)
    const task = createWorkTask({ title: 'Task-only assignment', roadmapId: roadmap.id }, store)
    upsertProjectBinding({ alias: 'task-linked-binding', roadmapId: roadmap.id, sessionId: 'ses_parent', scope: 'telegram', provider: 'telegram', chatId: 'chat-1' }, store)
    const assignment = assignmentFixture('task-only-key', { taskId: task.id, roadmapId: undefined })
    appendAssignmentReceipt('task-only-key', assignment)

    const routes = buildTeamProgressRoutes(loadWorkState(store), { now, filePath: store })

    expect(routes.find(route => route.assignment.id === assignment.id && route.target.provider === 'telegram')).toMatchObject({ progress: 'started', delivery: 'immediate' })
  })

  it('replays durable team events after they fall outside the recent event window', () => {
    const { assignment } = seedAssignment('old-event-key')
    for (let index = 0; index < 520; index += 1) appendWorkEvent('test.noise', `noise_${index}`, { index }, store)

    const routes = buildTeamProgressRoutes(loadWorkState(store), { now, filePath: store })

    expect(routes.find(route => route.assignment.id === assignment.id && route.progress === 'started' && route.target.provider === 'telegram')).toBeTruthy()
  })

  function seedAssignment(key: string, mode: 'immediate' | 'digest' = 'immediate') {
    const roadmap = createRoadmap({ title: `Team progress ${key}` }, store)
    const binding = upsertProjectBinding({ alias: `${key}-binding`, roadmapId: roadmap.id, sessionId: 'ses_parent', scope: 'telegram', provider: 'telegram', chatId: 'chat-1', notificationMode: mode }, store)
    const assignment = assignmentFixture(key, { roadmapId: roadmap.id })
    appendAssignmentReceipt(key, assignment)
    return { roadmap, binding, assignment }
  }

  function assignmentFixture(key: string, overrides: Partial<TeamTaskAssignment> = {}): TeamTaskAssignment {
    return {
      id: `assignment_${key}`,
      idempotencyKey: key,
      status: 'assigned',
      objective: 'Ship team progress',
      taskId: `task_${key}`,
      roadmapId: `roadmap_${key}`,
      runId: `run_${key}`,
      sessionId: 'ses_parent',
      teamRequestId: `team_req_${key}`,
      teamId: `team_${key}`,
      teamName: 'delivery',
      memberId: `team_${key}:member:implement`,
      role: 'implement',
      profile: 'implementer',
      agent: 'gateway-implementer',
      model: 'openai/gpt-5',
      profileVersion: '1',
      profileRevision: 'rev1',
      budget: {},
      scope: { skills: [], mcpServers: [], tools: [], permissions: [] },
      requiredEvidence: [{ id: 'validation', type: 'command', summary: 'Validation command output', required: true, metadata: {} }],
      gates: [
        { id: 'review-pass', type: 'review', requiredBefore: 'complete', metadata: {} },
        { id: 'quality', type: 'completion_quality', requiredBefore: 'complete', metadata: {} },
      ],
      createdAt: '2026-06-15T11:00:00.000Z',
      updatedAt: '2026-06-15T11:00:00.000Z',
      ...overrides,
    }
  }

  function appendAssignmentReceipt(key: string, assignment: TeamTaskAssignment) {
    const receipt: TeamAssignmentReceipt = {
      receiptKind: 'team_assignment',
      version: 1,
      id: `receipt_${key}`,
      idempotencyKey: key,
      idempotencyStatus: 'created',
      status: 'accepted',
      objective: assignment.objective,
      createdAt: assignment.createdAt,
      assignments: [assignment],
      rejectionReasons: [],
      links: { assignments: `/team-assignments?receiptId=receipt_${key}` },
      audit: { resolverVersion: 'team-assignment-v1', assignmentInputs: [key], createdAt: assignment.createdAt },
    }
    appendWorkEvent('team_assignment.created', receipt.id, { receipt }, store)
  }

  function appendReceipt(assignment: TeamTaskAssignment, receiptKind: 'gate_result' | 'review_outcome' | 'completion', status: any, gateType: any, gateId: string, summary: string) {
    const receipt = {
      receiptKind,
      id: `${assignment.id}_${receiptKind}_${status}_${gateId}`,
      assignmentId: assignment.id,
      gateId,
      gateType,
      status,
      summary,
      evidence: status === 'passed' ? ['validation: command passed'] : [],
      runId: assignment.runId,
      sessionId: assignment.sessionId,
      metadata: {},
      createdAt: new Date(now).toISOString(),
    }
    appendWorkEvent(`team_assignment.${receiptKind}`, assignment.id, { receipt }, store)
  }

  function channels(sent: string[]) {
    return new Map([['telegram', { sendMessage: async (_chatId: string, text: string) => { sent.push(text) } }]])
  }

  function sessionClient(prompts: string[]) {
    return { session: { prompt: async (args: any) => { prompts.push(args.body.parts[0].text) } } }
  }
})
