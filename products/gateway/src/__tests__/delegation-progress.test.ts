import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { buildDelegationProgressRoutes, delegationProgressMessage, deliverDelegationProgress } from '../delegation-progress.js'
import { submitDelegation } from '../delegation.js'
import { renderStructuredMessage } from '../channels/renderer.js'
import { telegramChannel } from '../channels/telegram.js'
import { clearConfigCacheForTest } from '../config.js'
import { appendWorkEvents, applyWorkTaskAction, clearWorkStateForTest, completeWorkTaskRun, createRoadmap, listAlerts, listDelegationProgressRouteReceipts, listWorkEvents, loadWorkState, proposeRoadmapCompletion, startWorkTaskRun, updateProjectBinding } from '../work-store.js'
import type { WorkEventRecord } from '../work-store.js'

describe('delegation progress routing', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-delegation-progress-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')
  const now = Date.parse('2026-06-14T12:00:00.000Z')

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

  it('persists parent session and channel context on delegated progress events', () => {
    const roadmap = createRoadmap({ title: 'Progress context' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'ctx-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Progress task' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' } },
    }), store)

    expect(result).toMatchObject({ ok: true, receipt: { parentSessionId: 'ses_parent' } })
    const progress = listWorkEvents(50, store).find(event => event.type === 'delegation.progress' && event.payload['progress'] === 'created')
    expect(progress?.payload).toMatchObject({
      idempotencyKey: 'ctx-key',
      parentSessionId: 'ses_parent',
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1', notificationMode: 'immediate' },
      links: { roadmap: `/roadmaps/${roadmap.id}`, task: expect.any(String) },
    })
  })

  it('routes progress to parent session and originating channel in event order', async () => {
    const roadmap = createRoadmap({ title: 'Progress order' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'order-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Ordered progress' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
      evidence: [],
    }), store)
    const taskId = result.receipt!.taskIds[0]
    const run1 = startWorkTaskRun(taskId!, 'implement', 'ses_run_1', 'implementer', store)!.run
    completeWorkTaskRun(run1.id, pass('Implemented'), 2, store)
    const run2 = startWorkTaskRun(taskId!, 'review', 'ses_run_2', 'reviewer', store)!.run
    completeWorkTaskRun(run2.id, pass('Reviewed'), 2, store)
    const run3 = startWorkTaskRun(taskId!, 'verify', 'ses_run_3', 'verifier', store)!.run
    completeWorkTaskRun(run3.id, pass('Verified'), 2, store)

    const sent: string[] = []
    const parentPrompts: string[] = []
    const delivered = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now, filePath: store, sessionClient: sessionClient(parentPrompts) })

    expect(delivered.sent.filter(route => route.delivery === 'session').map(route => route.event.payload['progress'])).toEqual(['created', 'dispatched', 'stage_advanced', 'dispatched', 'stage_advanced', 'dispatched', 'completed'])
    expect(parentPrompts.map(text => text.split('\n').find(line => line.startsWith('Delegated Work')))).toEqual([
      'Delegated Work Created',
      'Delegated Work Dispatched',
      'Delegated Work Advanced',
      'Delegated Work Dispatched',
      'Delegated Work Advanced',
      'Delegated Work Dispatched',
      'Delegated Work Completed',
    ])
    expect(parentPrompts.every(text => text.includes('Parent receipt: record this update concisely in the existing parent OpenCode Session.'))).toBe(true)
    expect(parentPrompts.every(text => text.includes('receipt-only'))).toBe(true)
    expect(sent.map(text => text.split('\n')[0])).toEqual([
      'Delegated Work Created',
      'Delegated Work Dispatched',
      'Delegated Work Advanced',
      'Delegated Work Dispatched',
      'Delegated Work Advanced',
      'Delegated Work Dispatched',
      'Delegated Work Completed',
    ])
  })

  it('retries parent session delivery for delegated progress outside the recent event window', async () => {
    const roadmap = createRoadmap({ title: 'Noisy progress retry' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'noisy-retry-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Noisy progress task' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const taskId = result.receipt!.taskIds[0]
    const run = startWorkTaskRun(taskId!, 'implement', 'ses_run', 'implementer', store)!.run
    const dispatched = listWorkEvents(50, store).find(event => event.type === 'delegation.progress' && event.payload['runId'] === run.id)!
    appendWorkEvents(Array.from({ length: 700 }, (_, index) => ({
      type: 'noise.event',
      subjectId: `noise-${index}`,
      payload: { index },
    })), store)

    const parentPrompts: string[] = []
    const delivered = await deliverDelegationProgress(new Map(), { state: loadWorkState(store) }, { now, filePath: store, sessionClient: sessionClient(parentPrompts) })

    expect(delivered.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ delivery: 'session', event: expect.objectContaining({ id: dispatched.id }) }),
    ]))
    expect(parentPrompts.join('\n')).toContain('Delegated Work Dispatched')
  })

  it('renders dogfood progress messages with concise IDs, next actions, outcomes, and stable actions', () => {
    const fixtures: WorkEventRecord[] = [
      progressEvent('created', {
        idempotencyKey: 'delegate-key',
        roadmapId: 'roadmap_1',
        taskId: 'task_1',
        projectBindingId: 'binding_1',
        nextSchedulerAction: 'wait_for_scheduler_dispatch',
        summary: 'Delegated work accepted: Polish Telegram dogfood flow.',
      }),
      progressEvent('dispatched', {
        idempotencyKey: 'delegate-key',
        roadmapId: 'roadmap_1',
        taskId: 'task_1',
        runId: 'run_1',
        stage: 'review',
        sessionId: 'ses_run_1',
        summary: 'Delegated task dispatched to review: Telegram dogfood flow.',
      }),
      progressEvent('gate_opened', {
        idempotencyKey: 'delegate-key',
        roadmapId: 'roadmap_1',
        taskId: 'task_1',
        gateId: 'gate_1',
        stage: 'deploy',
        summary: 'Production deploy requires operator approval.',
      }),
      progressEvent('completion_proposed', {
        idempotencyKey: 'delegate-key',
        roadmapId: 'roadmap_1',
        proposalId: 'completion_1',
        sessionId: 'ses_parent',
        summary: 'Completion proposed for Telegram dogfood flow.',
      }),
      progressEvent('completed', {
        idempotencyKey: 'delegate-key',
        roadmapId: 'roadmap_1',
        taskId: 'task_1',
        runId: 'run_2',
        stage: 'verify',
        sessionId: 'ses_run_2',
        runStatus: 'passed',
        taskStatus: 'done',
        summary: 'Delegated task completed: Telegram dogfood flow.',
      }),
      progressEvent('blocked', {
        idempotencyKey: 'delegate-key',
        roadmapId: 'roadmap_1',
        taskId: 'task_1',
        runId: 'run_3',
        stage: 'verify',
        runStatus: 'blocked',
        taskStatus: 'blocked',
        summary: 'Delegated task blocked: missing evidence.',
      }),
    ]

    const rendered = fixtures.map(event => {
      const message = delegationProgressMessage(event)
      return { message, plain: renderStructuredMessage(message, { plainText: true }).plainText, rich: renderStructuredMessage(message, telegramChannel.capabilities) }
    })

    expect(rendered.every(row => row.rich.mode === 'rich')).toBe(true)
    expect(rendered[0]!.plain).toContain('Delegation: delegate-key')
    expect(rendered[0]!.plain).toContain('Roadmap: roadmap_1')
    expect(rendered[0]!.plain).toContain('Task: task_1')
    expect(rendered[0]!.plain).toContain('Next action: Wait for scheduler dispatch, or use /status to inspect the queue.')
    expect(rendered[0]!.plain).toContain('- Open work: /open task_1')
    expect(rendered[1]!.plain).toContain('Run: run_1')
    expect(rendered[1]!.plain).toContain('Current step: review started')
    expect(rendered[2]!.plain).toContain('- Approve once: /gate approve gate_1 once')
    expect(rendered[2]!.plain).toContain('- Reject: /gate reject gate_1')
    expect(rendered[3]!.plain).toContain('Proposal: completion_1')
    expect(rendered[3]!.plain).toContain('- Approve completion: /completion approve completion_1')
    expect(rendered[4]!.plain).toContain('Outcome: done')
    expect(rendered[4]!.plain).toContain('Next action: Review outcome with /open task_1.')
    expect(rendered[5]!.plain).toContain('Outcome: blocked')
    expect(rendered[5]!.plain).toContain('- Retry task: /task retry task_1')
    for (const row of rendered) expect(JSON.stringify(row.message.metadata || {})).not.toContain('secret')
  })

  it('delivers delegated progress through structured Telegram cards when supported', async () => {
    const roadmap = createRoadmap({ title: 'Structured progress' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'structured-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Structured Telegram progress' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const taskId = result.receipt!.taskIds[0]
    const run = startWorkTaskRun(taskId!, 'implement', 'ses_run_1', 'implementer', store)!.run
    completeWorkTaskRun(run.id, pass('Implemented'), 2, store)

    const structured: any[] = []
    const delivered = await deliverDelegationProgress(new Map([['telegram', {
      sendMessage: async () => {},
      sendStructuredMessage: async (_chatId: string, message: any) => { structured.push(message) },
    }]]), { state: loadWorkState(store) }, { now, filePath: store })

    expect(delivered.failed).toHaveLength(0)
    expect(structured.map(message => message.title)).toEqual([
      'Delegated Work Created',
      'Delegated Work Dispatched',
      'Delegated Work Advanced',
    ])
    expect(structured[0].fallback.plainText).toContain('Delegation: structured-key')
    expect(structured[0].fallback.plainText).toContain('- Open work: /open ')
    expect(structured[1].fallback.plainText).toContain('Run:')
    expect(structured[2].fallback.plainText).toContain('Next stage: review')
    expect(structured[2].actions.map((action: any) => action.command)).toContain('/status')
  })

  it('renders completion proposal progress with approval and rejection actions from durable state', () => {
    const result = submitDelegation(request({
      idempotencyKey: 'completion-key',
      target: { type: 'project', projectAlias: 'completion-cards', title: 'Completion Cards', tasks: [], createSupervisor: true },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const proposal = proposeRoadmapCompletion({ roadmapId: result.receipt!.roadmapId!, evidence: ['npm test'], recommendation: 'ready' }, store).proposal
    const event = listWorkEvents(100, store).find(row => row.type === 'delegation.progress' && row.payload['progress'] === 'completion_proposed' && row.payload['proposalId'] === proposal.id)!

    const plain = formatPlain(event)

    expect(plain).toContain(`Proposal: ${proposal.id}`)
    expect(plain).toContain(`- Approve completion: /completion approve ${proposal.id}`)
    expect(plain).toContain(`- Reject completion: /completion reject ${proposal.id}`)
  })

  it('dedupes retried progress delivery without duplicate user-visible sends', async () => {
    const roadmap = createRoadmap({ title: 'Progress dedupe' }, store)
    submitDelegation(request({
      idempotencyKey: 'dedupe-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Dedupe progress' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const sent: string[] = []

    const first = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now, filePath: store })
    const second = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now: now + 1000, filePath: store })

    expect(first.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(second.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(0)
    expect(second.suppressed.some(route => route.delivery === 'deduped')).toBe(true)
  })

  it('dedupes delegated progress from durable route receipts after notification events are unavailable', async () => {
    const roadmap = createRoadmap({ title: 'Progress route receipt dedupe' }, store)
    submitDelegation(request({
      idempotencyKey: 'route-receipt-dedupe-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Route receipt dedupe progress' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const sent: string[] = []

    const first = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now, filePath: store })
    const channelRoute = first.sent.find(route => route.target.provider === 'telegram')!
    const db = new DatabaseSync(store)
    try {
      db.prepare("DELETE FROM events WHERE type = 'delegation.progress.notified' AND subject_id = ?").run(channelRoute.dedupeKey)
    } finally {
      db.close()
    }
    const second = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now: now + 1000, filePath: store })
    const receipts = listDelegationProgressRouteReceipts({ dedupeKey: channelRoute.dedupeKey }, store)

    expect(first.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(1)
    expect(second.sent.filter(route => route.target.provider === 'telegram')).toHaveLength(0)
    expect(second.suppressed).toContainEqual(expect.objectContaining({ dedupeKey: channelRoute.dedupeKey, delivery: 'deduped' }))
    expect(receipts).toEqual([
      expect.objectContaining({ state: 'delivered', provider: 'telegram', targetKey: expect.any(String), nextAction: 'No action; delivery receipt is present.' }),
    ])
  })

  it('defers retries while a durable progress delivery attempt is still pending', () => {
    const roadmap = createRoadmap({ title: 'Pending progress receipt' }, store)
    submitDelegation(request({
      idempotencyKey: 'pending-route-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Pending route progress' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const route = buildDelegationProgressRoutes(loadWorkState(store), { now, filePath: store })
      .find(row => row.target.provider === 'telegram')!
    const retryAt = new Date(now + 15_000).toISOString()

    appendWorkEvents([{
      type: 'delegation.progress.attempting',
      subjectId: route.dedupeKey,
      payload: {
        dedupeKey: route.dedupeKey,
        progressEventId: route.event.id,
        progressKey: route.event.payload['progressKey'],
        idempotencyKey: route.event.payload['idempotencyKey'],
        progress: route.event.payload['progress'],
        targetKey: 'pending-target',
        provider: 'telegram',
        delivery: 'immediate',
        reason: 'delivery attempt in progress',
        deferredUntil: retryAt,
      },
    }], store)

    expect(buildDelegationProgressRoutes(loadWorkState(store), { now: now + 1_000, filePath: store })).toContainEqual(expect.objectContaining({
      dedupeKey: route.dedupeKey,
      delivery: 'deferred',
      reason: 'delivery attempt already in progress',
      deferredUntil: retryAt,
    }))
    expect(buildDelegationProgressRoutes(loadWorkState(store), { now: now + 16_000, filePath: store })).toContainEqual(expect.objectContaining({
      dedupeKey: route.dedupeKey,
      delivery: 'immediate',
    }))
  })

  it('dedupes delegated progress with a durable receipt after the original event leaves the recent scan window', () => {
    const roadmap = createRoadmap({ title: 'Durable progress dedupe' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'durable-progress-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Durable progress task' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const taskId = result.receipt!.taskIds[0]

    applyWorkTaskAction(taskId!, 'done', { note: 'first completion' }, store)
    appendWorkEvents(Array.from({ length: 1200 }, (_, index) => ({
      type: 'delegation.progress',
      subjectId: `noise-${index}`,
      payload: { idempotencyKey: 'noise', progress: 'created', progressKey: `noise-${index}` },
    })), store)
    applyWorkTaskAction(taskId!, 'done', { note: 'retried completion' }, store)

    const db = new DatabaseSync(store)
    try {
      const rows = db.prepare("SELECT payload_json FROM events WHERE type = 'delegation.progress'").all() as any[]
      const completed = rows
        .map(row => JSON.parse(String(row.payload_json)))
        .filter(payload => payload.idempotencyKey === 'durable-progress-key' && payload.progress === 'completed')
      const receipts = db.prepare("SELECT * FROM delegation_progress_receipts WHERE idempotency_key = ? AND progress = 'completed'").all('durable-progress-key') as any[]

      expect(completed).toHaveLength(1)
      expect(receipts).toHaveLength(1)
      expect(receipts[0].progress_key).toBe(completed[0].progressKey)
    } finally {
      db.close()
    }
  })

  it('delivers completed progress after an earlier parent-session delivery failure', async () => {
    const roadmap = createRoadmap({ title: 'Progress parent outage' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'parent-outage-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Complete despite parent outage' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    const taskId = result.receipt!.taskIds[0]
    const sent: string[] = []
    const parentPrompts: string[] = []
    const flakySession = {
      session: {
        prompt: async (args: any) => {
          const text = args.body.parts[0].text
          parentPrompts.push(text)
          if (text.includes('Delegated Work Created')) throw new Error('fetch failed')
        },
      },
    }

    const first = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now, filePath: store, sessionClient: flakySession })
    applyWorkTaskAction(taskId!, 'done', { note: 'Verified AC1 DOD1' }, store)

    const firstRetryPrompt = parentPrompts.length
    const second = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now: now + 1000, filePath: store, sessionClient: flakySession })
    const secondPromptTitles = parentPrompts.slice(firstRetryPrompt).map(text => text.split('\n').find(line => line.startsWith('Delegated Work')))
    const events = listWorkEvents(200, store)
    const failedCreated = events.filter(event => event.type === 'delegation.progress.failed' && event.payload['progress'] === 'created' && event.payload['delivery'] === 'session')
    const completedReceipts = events.filter(event => event.type === 'delegation.progress.notified' && event.payload['progress'] === 'completed')

    expect(first.failed).toContainEqual(expect.objectContaining({ route: expect.objectContaining({ delivery: 'session', event: expect.objectContaining({ payload: expect.objectContaining({ progress: 'created' }) }) }), error: 'fetch failed' }))
    expect(sent[0]!.split('\n')[0]).toBe('Delegated Work Created')
    expect(second.sent).toContainEqual(expect.objectContaining({ delivery: 'session', event: expect.objectContaining({ payload: expect.objectContaining({ progress: 'completed' }) }) }))
    expect(sent.map(text => text.split('\n')[0])).toContain('Delegated Work Completed')
    expect(secondPromptTitles.indexOf('Delegated Work Created')).toBeGreaterThan(secondPromptTitles.indexOf('Delegated Work Completed'))
    expect(failedCreated.length).toBeGreaterThanOrEqual(1)
    expect(completedReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ delivery: 'session', sessionId: 'ses_parent' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ provider: 'telegram' }) }),
    ]))
    expect(new Set(completedReceipts.map(event => event.payload['dedupeKey'])).size).toBe(2)
  })

  it('bounds hung parent-session delivery and still records completed route outcomes', async () => {
    const roadmap = createRoadmap({ title: 'Progress parent hang' }, store)
    const result = submitDelegation(request({
      idempotencyKey: 'parent-hang-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Complete despite parent hang' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)
    applyWorkTaskAction(result.receipt!.taskIds[0]!, 'done', { note: 'Verified AC1 DOD1' }, store)

    const sent: string[] = []
    const prompted: string[] = []
    const hangingSession = {
      session: {
        prompt: async (args: any) => {
          prompted.push(args.body.parts[0].text)
          if (args.body.parts[0].text.includes('Delegated Work Created')) return new Promise(() => {})
        },
      },
    }

    const delivered = await deliverDelegationProgress(channels(sent), { state: loadWorkState(store) }, { now, filePath: store, sessionClient: hangingSession, sessionPromptTimeoutMs: 5 })
    const events = listWorkEvents(200, store)
    const failedCreated = events.find(event => event.type === 'delegation.progress.failed' && event.payload['progress'] === 'created' && event.payload['delivery'] === 'session')
    const completedReceipts = events.filter(event => event.type === 'delegation.progress.notified' && event.payload['progress'] === 'completed')

    expect(delivered.failed).toContainEqual(expect.objectContaining({ error: 'parent session prompt timed out after 5ms' }))
    expect(failedCreated?.payload['error']).toBe('parent session prompt timed out after 5ms')
    expect(prompted.map(text => text.split('\n').find(line => line.startsWith('Delegated Work')))).toContain('Delegated Work Completed')
    expect(sent.map(text => text.split('\n')[0])).toContain('Delegated Work Completed')
    expect(completedReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ delivery: 'session', sessionId: 'ses_parent' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ provider: 'telegram' }) }),
    ]))
  })

  it('defers parent session progress until a session client can notify it', async () => {
    const roadmap = createRoadmap({ title: 'Progress session defer' }, store)
    submitDelegation(request({
      idempotencyKey: 'session-defer-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Deferred session progress' },
      notificationTarget: { mode: 'parent_session' },
      parentSession: { sessionId: 'ses_parent' },
    }), store)

    const first = await deliverDelegationProgress(channels([]), { state: loadWorkState(store) }, { now, filePath: store })
    const firstReceipts = listDelegationProgressRouteReceipts({ idempotencyKey: 'session-defer-key' }, store)
    expect(listWorkEvents(50, store).filter(event => event.type === 'delegation.progress.notified')).toHaveLength(0)

    const parentPrompts: string[] = []
    const second = await deliverDelegationProgress(channels([]), { state: loadWorkState(store) }, { now: now + 1000, filePath: store, sessionClient: sessionClient(parentPrompts) })

    expect(first.sent).toHaveLength(0)
    expect(first.suppressed).toContainEqual(expect.objectContaining({ delivery: 'deferred', reason: 'session client unavailable' }))
    expect(firstReceipts).toContainEqual(expect.objectContaining({
      state: 'stale_parent',
      delivery: 'deferred',
      sessionId: 'ses_parent',
      nextAction: 'Reconnect the parent OpenCode session client, then rerun delegated progress delivery.',
    }))
    expect(listWorkEvents(50, store).filter(event => event.type === 'delegation.progress.notified')).toHaveLength(1)
    expect(second.sent).toContainEqual(expect.objectContaining({ delivery: 'session' }))
    expect(parentPrompts).toHaveLength(1)
  })

  it('honors digest suppression while allowing critical delegated progress through', async () => {
    const result = submitDelegation(request({
      idempotencyKey: 'digest-key',
      target: { type: 'project', projectAlias: 'digest-progress', title: 'Digest Progress', tasks: [{ title: 'Approval task', acceptanceCriteria: [], definitionOfDone: [] }], createSupervisor: true },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'digest' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
      budget: { requiresApprovalAbove: 10 },
    }), store)
    const bindingId = result.receipt!.projectBindingId!
    updateProjectBinding(bindingId, { lastDigestAt: '2026-06-14T11:45:00.000Z' }, store)

    const routes = buildDelegationProgressRoutes(loadWorkState(store), { now, filePath: store })
    expect(routes.find(route => route.target.provider === 'telegram' && route.event.payload['progress'] === 'created')).toMatchObject({ delivery: 'deferred', reason: 'digest interval not due' })
    expect(routes.find(route => route.target.provider === 'telegram' && route.event.payload['progress'] === 'gate_opened')).toMatchObject({ delivery: 'immediate', reason: 'critical bypasses digest' })
  })

  it('defers normal progress during quiet hours while critical progress bypasses quiet hours', async () => {
    const result = submitDelegation(request({
      idempotencyKey: 'quiet-key',
      target: { type: 'project', projectAlias: 'quiet-progress', title: 'Quiet Progress', tasks: [{ title: 'Approval task', acceptanceCriteria: [], definitionOfDone: [] }], createSupervisor: true },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
      budget: { requiresApprovalAbove: 10 },
    }), store)
    updateProjectBinding(result.receipt!.projectBindingId!, { quietHours: { start: '11:00', end: '13:00', timezone: 'UTC' } }, store)

    const routes = buildDelegationProgressRoutes(loadWorkState(store), { now, filePath: store })
    const created = routes.find(route => route.target.provider === 'telegram' && route.event.payload['progress'] === 'created')
    const gate = routes.find(route => route.target.provider === 'telegram' && route.event.payload['progress'] === 'gate_opened')

    expect(created).toMatchObject({ delivery: 'deferred', reason: 'quiet hours active', deferredUntil: '2026-06-14T13:00:00.000Z' })
    expect(gate).toMatchObject({ delivery: 'immediate', reason: 'critical bypasses quiet hours', escalationBypass: 'quiet_hours' })

    const delivered = await deliverDelegationProgress(channels([]), { state: loadWorkState(store) }, { now, filePath: store })
    expect(delivered.suppressed).toContainEqual(expect.objectContaining({ delivery: 'deferred', deferredUntil: '2026-06-14T13:00:00.000Z' }))
    expect(listWorkEvents(100, store).find(event => event.type === 'delegation.progress.suppressed' && event.payload['progress'] === 'created' && event.payload['provider'] === 'telegram')?.payload).toMatchObject({
      reason: 'quiet hours active',
      deferredUntil: '2026-06-14T13:00:00.000Z',
      quietHours: { start: '11:00', end: '13:00', timezone: 'UTC' },
    })
  })

  it('suppresses muted delegated progress without losing the policy reason', () => {
    const result = submitDelegation(request({
      idempotencyKey: 'muted-key',
      target: { type: 'project', projectAlias: 'muted-progress', title: 'Muted Progress', tasks: [{ title: 'Muted task', acceptanceCriteria: [], definitionOfDone: [] }], createSupervisor: true },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'muted' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)

    const routes = buildDelegationProgressRoutes(loadWorkState(store), { now, filePath: store })

    expect(result.receipt?.projectBindingId).toBeTruthy()
    expect(routes.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'muted', reason: 'target muted' })
    expect(routes.find(route => route.target.key === 'session:ses_parent')).toMatchObject({ delivery: 'session', reason: 'session target only' })
  })

  it('records channel send failures for delegated progress', async () => {
    const roadmap = createRoadmap({ title: 'Progress failure' }, store)
    submitDelegation(request({
      idempotencyKey: 'failure-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Failure progress' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)

    const result = await deliverDelegationProgress(new Map([['telegram', { sendMessage: async () => { throw new Error('HTTP 400 token=secret-token') } }]]), { state: loadWorkState(store) }, { now, filePath: store })

    expect(result.failed).toHaveLength(1)
    expect(listWorkEvents(50, store).find(event => event.type === 'delegation.progress.failed')?.payload['error']).toContain('token=<redacted>')
    expect(listDelegationProgressRouteReceipts({ idempotencyKey: 'failure-key' }, store)).toContainEqual(expect.objectContaining({
      state: 'failed',
      provider: 'telegram',
      error: 'HTTP 400 token=<redacted>',
      nextAction: 'Repair the delivery target and rerun delegated progress delivery.',
    }))
    expect(listAlerts({ status: 'open' }, store)).toContainEqual(expect.objectContaining({ source: 'delegation.progress', severity: 'warning' }))
  })

  it('records Telegram chat target failures without notified receipts for that route', async () => {
    const roadmap = createRoadmap({ title: 'Progress chat missing' }, store)
    submitDelegation(request({
      idempotencyKey: 'chat-missing-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Missing Telegram target' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-missing', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-missing' } },
    }), store)

    const result = await deliverDelegationProgress(new Map([['telegram', {
      sendMessage: async () => {},
      sendStructuredMessage: async () => { throw new Error('HTTP 400 Bad Request: chat not found') },
    }]]), { state: loadWorkState(store) }, { now, filePath: store })
    const events = listWorkEvents(100, store)
    const failed = events.filter(event => event.type === 'delegation.progress.failed' && event.payload['provider'] === 'telegram')
    const notified = events.filter(event => event.type === 'delegation.progress.notified' && event.payload['provider'] === 'telegram')

    expect(result.failed).toContainEqual(expect.objectContaining({ error: 'HTTP 400 Bad Request: chat not found' }))
    expect(failed).toHaveLength(1)
    expect(failed[0]!.payload).toMatchObject({ progress: 'created', provider: 'telegram', delivery: 'immediate' })
    expect(notified).toHaveLength(0)
  })

  it('records channel delivery timeouts without immediate retry or late notified receipts', async () => {
    const roadmap = createRoadmap({ title: 'Progress channel timeout' }, store)
    submitDelegation(request({
      idempotencyKey: 'channel-timeout-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Timeout Telegram target' },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-slow', notificationMode: 'immediate' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-slow' } },
    }), store)
    const cycleNow = Date.now()
    const sent: string[] = []
    let resolveSend: (() => void) | undefined

    const result = await deliverDelegationProgress(new Map([['telegram', {
      sendMessage: async (_chatId: string, text: string) => new Promise<void>(resolve => {
        resolveSend = () => {
          sent.push(text)
          resolve()
        }
      }),
    }]]), { state: loadWorkState(store) }, { now: cycleNow, filePath: store, channelDeliveryTimeoutMs: 5, timeoutRetryDelayMs: 1000 })
    resolveSend?.()
    await new Promise(resolve => setTimeout(resolve, 0))

    const events = listWorkEvents(100, store)
    const failed = events.find(event => event.type === 'delegation.progress.failed' && event.payload['provider'] === 'telegram')
    const notified = events.filter(event => event.type === 'delegation.progress.notified' && event.payload['provider'] === 'telegram')
    const cooldownRoute = buildDelegationProgressRoutes(loadWorkState(store), { now: cycleNow + 10, filePath: store, timeoutRetryDelayMs: 1000 }).find(route => route.target.provider === 'telegram')

    expect(result.failed).toContainEqual(expect.objectContaining({ error: 'telegram progress notification timed out after 5ms' }))
    expect(failed?.payload).toMatchObject({ progress: 'created', provider: 'telegram', delivery: 'immediate' })
    expect(notified).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(cooldownRoute).toMatchObject({ delivery: 'deferred', reason: 'recent timeout retry cooldown' })
  })

  function channels(sent: string[]) {
    return new Map([['telegram', { sendMessage: async (_chatId: string, text: string) => { sent.push(text) } }]])
  }

  function sessionClient(prompts: string[]) {
    return { session: { prompt: async (args: any) => { prompts.push(args.body.parts[0].text) } } }
  }
})

function progressEvent(progress: string, payload: Record<string, unknown>): WorkEventRecord {
  return {
    id: 1,
    type: 'delegation.progress',
    subjectId: String(payload['taskId'] || payload['roadmapId'] || payload['proposalId'] || 'subject'),
    payload: { progress, progressKey: `fixture:${progress}`, ...payload },
    createdAt: '2026-06-14T12:00:00.000Z',
  }
}

function formatPlain(event: WorkEventRecord): string {
  return renderStructuredMessage(delegationProgressMessage(event), { plainText: true }).plainText
}

function pass(summary: string) {
  return { status: 'pass' as const, summary: `${summary} AC1 DOD1`, artifacts: ['artifact'], evidence: [{ type: 'test' as const, ref: 'artifact', summary: `${summary} AC1 DOD1` }], raw: summary }
}

function request(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    idempotencyKey: 'base-key',
    target: { type: 'issue', roadmapId: 'roadmap_missing', title: 'Base delegated task' },
    objective: 'Complete delegated work',
    context: {
      summary: 'Enough context to do the work.',
      references: ['docs/concepts/delegation-contract.md'],
      constraints: [],
      nonGoals: [],
    },
    acceptanceCriteria: ['AC1'],
    definitionOfDone: ['DOD1'],
    desired: { profile: 'implementer', stageProfiles: { review: 'reviewer', verify: 'verifier' } },
    environment: undefined,
    schedule: {},
    budget: {},
    evidence: [{ type: 'test', summary: 'Relevant tests pass' }],
    notificationTarget: { mode: 'parent_session' },
    parentSession: { sessionId: 'ses_parent' },
    completionPolicy: 'assistant_proposes_user_approves',
    ...overrides,
  }
}
