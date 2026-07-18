import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ChannelSyncBridge, clearChannelSyncForTest } from '../channel-sync.js'
import { clearChannelSessionsForTest, setChannelSession } from '../channel-sessions.js'
import { clearConfigCacheForTest, updateSchedulerConfig } from '../config.js'
import { schedulerCycle } from '../scheduler.js'
import {
  applyWorkTaskAction,
  clearWorkStateForTest,
  createWorkTask,
  listWorkEvents,
  loadWorkState,
  recoverExpiredWorkLeases,
  recoverOrphanedWorkRuns,
  saveWorkState,
  startWorkTaskRun,
  type WorkState,
} from '../work-store.js'
import { clearWorkersForTest } from '../workers.js'
import { clearEventsForTest } from '../wakeup.js'

describe('deterministic stress suite', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-stress-suite-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')
  const channelStateFile = path.join(testDir, 'channel-sync.json')
  const extended = process.env['GATEWAY_STRESS_EXTENDED'] === '1'
  let sessionCounter = 0
  let prompts: any[] = []
  let sessions: any[] = []
  let messagesBySession: Record<string, any[]> = {}

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(store)
    clearChannelSessionsForTest()
    clearChannelSyncForTest(channelStateFile)
    clearWorkersForTest()
    clearEventsForTest()
    clearConfigCacheForTest()
    updateSchedulerConfig({ maxConcurrent: extended ? 12 : 6, retryLimit: 1, leaseMs: 60_000 })
    sessionCounter = 0
    prompts = []
    sessions = []
    messagesBySession = {}
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
    clearWorkersForTest()
    clearEventsForTest()
  })

  it('keeps one active run per task across repeated and overlapping scheduler ticks', async () => {
    resetWorkState()
    const taskCount = extended ? 60 : 18
    for (let i = 0; i < taskCount; i++) {
      createWorkTask({ title: `Stress dispatch ${i + 1}`, priority: i % 3 === 0 ? 'HIGH' : 'MEDIUM', pipeline: ['implement'] }, store)
    }

    let state = loadWorkState(store)
    for (let wave = 0; wave < taskCount + 5; wave++) {
      state = await overlappingSchedulerTickRequests(5)
      assertNoDuplicateActiveRuns(state, `wave ${wave}`)
      for (const run of state.runs.filter(row => row.status === 'running')) {
        messagesBySession[run.sessionId] ||= [assistantResult(`stress pass ${run.id}`)]
      }
      if (state.tasks.every(task => task.status === 'done')) break
    }
    state = await overlappingSchedulerTickRequests(5)

    assertNoDuplicateActiveRuns(state, 'final')
    expect(state.tasks.filter(task => task.status === 'done')).toHaveLength(taskCount)
    expect(new Set(state.runs.map(run => run.id)).size).toBe(state.runs.length)
    expect(prompts.length).toBe(taskCount)
  }, 60_000)

  it('does not duplicate channel sync delivery across restart and noisy replay', async () => {
    const sessionCount = extended ? 24 : 6
    const messages: Record<string, any[]> = {}
    const sent: Array<{ provider: string; chatId: string; threadId?: string; text: string }> = []
    let now = 1_000_000
    const bridge = () => new ChannelSyncBridge(
      { session: { messages: async (args: any) => ({ data: messages[args.path.id] || [] }) } },
      new Map(['telegram', 'whatsapp'].map(provider => [provider, {
        sendMessage: async (chatId: string, text: string, options?: { threadId?: string }) => {
          sent.push({ provider, chatId, ...(options?.threadId ? { threadId: options.threadId } : {}), text })
        },
      }])),
      { stateFile: channelStateFile, now: () => now },
    )
    const first = bridge()

    for (let i = 0; i < sessionCount; i++) {
      const sessionId = `ses_stress_${i + 1}`
      setChannelSession('telegram', `tg-${i + 1}`, sessionId)
      setChannelSession('whatsapp', `wa-${i + 1}`, sessionId)
      messages[sessionId] = [channelMessage(sessionId, `old-${i}`, 'assistant', `old ${i}`, now - 500)]
      await first.initialize(sessionId, 'telegram', `tg-${i + 1}`)
      await first.initialize(sessionId, 'whatsapp', `wa-${i + 1}`)
      first.recordInbound(sessionId, 'telegram', `tg-${i + 1}`, `hello ${i + 1}`)
      messages[sessionId].push(channelMessage(sessionId, `u-${i}`, 'user', `hello ${i + 1}`, now + i * 10 + 1))
      messages[sessionId].push(channelMessage(sessionId, `a-${i}`, 'assistant', `done ${i + 1}`, now + i * 10 + 2))
    }

    await Promise.all([first.syncOnce(), first.syncOnce(), first.syncOnce()])
    const afterFirstPass = sent.length
    const restarted = bridge()
    now += 60_000
    await Promise.all([restarted.syncOnce(), restarted.syncOnce()])

    expect(afterFirstPass).toBe(sessionCount * 3)
    expect(sent).toHaveLength(afterFirstPass)
    expect(uniqueDeliveryKeys(sent).size).toBe(sent.length)
  })

  it('recovers scheduler failure modes idempotently with useful diagnostics', async () => {
    const count = extended ? 18 : 6

    resetWorkState()
    const expiredRuns = startManyRuns('expired lease', count)
    markRunsExpired(expiredRuns.map(run => run.id))
    const expiredFirst = recoverExpiredWorkLeases(1, store, Date.parse('2026-06-16T09:00:00.000Z'))
    const expiredSecond = recoverExpiredWorkLeases(1, store, Date.parse('2026-06-16T09:01:00.000Z'))
    let state = loadWorkState(store)
    expect(expiredFirst).toMatchObject({ recovered: 0, blocked: count })
    expect(expiredFirst.runIds.sort()).toEqual(expiredRuns.map(run => run.id).sort())
    expect(expiredSecond).toMatchObject({ recovered: 0, blocked: 0, runIds: [] })
    expect(state.tasks.filter(task => task.status === 'blocked')).toHaveLength(count)
    expect(state.runs.filter(run => run.status === 'errored')).toHaveLength(count)
    assertNoDuplicateActiveRuns(state, 'expired lease recovery')

    resetWorkState()
    const orphanRuns = startManyRuns('orphaned session', count)
    const orphanFirst = recoverOrphanedWorkRuns(new Set(), 1, store, Date.parse('2026-06-16T09:05:00.000Z'))
    const orphanSecond = recoverOrphanedWorkRuns(new Set(), 1, store, Date.parse('2026-06-16T09:06:00.000Z'))
    state = loadWorkState(store)
    expect(orphanFirst).toMatchObject({ recovered: count, blocked: 0 })
    expect(orphanFirst.runIds.sort()).toEqual(orphanRuns.map(run => run.id).sort())
    expect(orphanSecond).toMatchObject({ recovered: 0, blocked: 0, runIds: [] })
    assertNoDuplicateActiveRuns(state, 'orphan recovery')

    resetWorkState()
    updateSchedulerConfig({ maxConcurrent: count, retryLimit: 2 })
    for (let i = 0; i < count; i++) createWorkTask({ title: `Prompt outage ${i + 1}`, pipeline: ['implement'] }, store)
    const aborted: string[] = []
    await schedulerCycle(client({ promptError: new Error('fetch failed'), onAbort: id => aborted.push(id) }))
    await waitFor(() => loadWorkState(store).runs.filter(run => run.status === 'failed').length === count)
    await waitFor(() => loadWorkState(store).tasks.filter(task => task.status === 'pending' && task.currentRunId === undefined && task.earliestStartAt).length === count)
    state = loadWorkState(store)
    expect(aborted).toHaveLength(count)
    expect(state.tasks.filter(task => task.status === 'pending' && task.currentRunId === undefined && task.earliestStartAt)).toHaveLength(count)
    assertNoDuplicateActiveRuns(state, 'prompt failure recovery')

    resetWorkState()
    const raced = createWorkTask({ title: 'Completion race', pipeline: ['implement'] }, store)
    state = await schedulerCycle(client())
    const [running] = state.runs.filter(run => run.status === 'running')
    messagesBySession[running!.sessionId] = [assistantResult('completed during race')]
    state = await schedulerCycle(client({
      beforeMessages: () => applyWorkTaskAction(raced.id, 'cancel', { note: 'operator cancelled during completion race' }, store),
    }))

    expect(state.tasks.find(task => task.id === raced.id)).toMatchObject({ status: 'cancelled', note: 'operator cancelled during completion race' })
    expect(state.runs.find(run => run.id === running!.id)).toMatchObject({ status: 'errored' })
    expect(recoveryDiagnostics()).toMatchObject({
      expiredLeaseEvents: count,
      orphanRecoveryEvents: count,
      promptRetryEvents: count,
    })
  })

  async function overlappingSchedulerTickRequests(count: number): Promise<WorkState> {
    const results = await Promise.all(Array.from({ length: count }, () => schedulerCycle(client())))
    if (new Set(results).size !== 1) throw new Error(`overlapping scheduler requests did not share one in-flight cycle: ${results.length}`)
    return results[0]!
  }

  function client(hooks: { beforeMessages?: () => void; promptError?: Error; onAbort?: (id: string) => void } = {}): any {
    return {
      session: {
        create: async (args: any) => {
          const id = `ses_${++sessionCounter}`
          sessions.push({ id, title: args?.body?.title, directory: args?.query?.directory, time: { created: Date.now() }, tokens: {} })
          return { data: { id } }
        },
        prompt: async (args: any) => {
          prompts.push(args)
          if (hooks.promptError) throw hooks.promptError
          return { data: {} }
        },
        messages: async (args: any) => {
          hooks.beforeMessages?.()
          return { data: messagesBySession[args.path.id] || [] }
        },
        get: async (args: any) => ({ data: sessions.find(session => session.id === args.path.id) || {} }),
        list: async (args: any = {}) => ({ data: sessions.filter(session => !args.query?.directory || session.directory === args.query.directory) }),
        abort: async (args: any) => {
          hooks.onAbort?.(args.path.id)
          return { data: {} }
        },
      },
    }
  }

  function startManyRuns(prefix: string, count: number) {
    return Array.from({ length: count }, (_, index) => {
      const task = createWorkTask({ title: `${prefix} ${index + 1}`, pipeline: ['implement'] }, store)
      const started = startWorkTaskRun(task.id, 'implement', `ses_${prefix.replace(/\s+/g, '_')}_${index + 1}`, 'implementer', store, {
        owner: `${prefix}-owner`,
        leaseMs: 120_000,
      })
      if (!started) throw new Error(`failed to start run for ${task.id}`)
      return started.run
    })
  }

  function markRunsExpired(runIds: string[]): void {
    const state = loadWorkState(store)
    for (const run of state.runs.filter(row => runIds.includes(row.id))) run.leaseExpiresAt = '2026-06-16T08:00:00.000Z'
    saveWorkState(state, store)
  }

  function resetWorkState(): void {
    const state = loadWorkState(store)
    state.tasks = []
    state.runs = []
    state.dependencies = []
    state.roadmaps = []
    saveWorkState(state, store)
  }

  function recoveryDiagnostics() {
    const events = listWorkEvents(500, store)
    return {
      expiredLeaseEvents: events.filter(event => event.type === 'task.run.lease_expired').length,
      orphanRecoveryEvents: events.filter(event => event.type === 'task.run.orphan_recovered').length,
      promptRetryEvents: events.filter(event => event.type === 'task.run.completed' && event.payload?.['runStatus'] === 'failed').length,
      tasks: loadWorkState(store).tasks.map(task => ({ id: task.id, title: task.title, status: task.status, currentRunId: task.currentRunId })),
    }
  }
})

function assertNoDuplicateActiveRuns(state: WorkState, label: string): void {
  const activeByTask = new Map<string, string[]>()
  for (const run of state.runs.filter(row => row.status === 'running')) {
    activeByTask.set(run.taskId, [...(activeByTask.get(run.taskId) || []), run.id])
  }
  const duplicates = [...activeByTask.entries()].filter(([, ids]) => ids.length > 1)
  if (duplicates.length) {
    throw new Error(`${label}: duplicate active runs ${JSON.stringify({ duplicates, summary: stressSummary(state) })}`)
  }
}

function stressSummary(state: WorkState) {
  return {
    tasks: state.tasks.length,
    runs: state.runs.length,
    taskStatuses: countBy(state.tasks.map(task => task.status)),
    runStatuses: countBy(state.runs.map(run => run.status)),
  }
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] || 0) + 1
    return acc
  }, {})
}

function uniqueDeliveryKeys(sent: Array<{ provider: string; chatId: string; threadId?: string; text: string }>): Set<string> {
  return new Set(sent.map(item => `${item.provider}:${item.chatId}:${item.threadId || ''}:${item.text}`))
}

function assistantResult(summary: string) {
  return {
    info: { role: 'assistant', time: { created: 1, completed: 2 } },
    parts: [{ type: 'text', text: '```json\n' + JSON.stringify({ status: 'pass', summary, artifacts: ['stress-evidence'] }) + '\n```' }, { type: 'step-finish' }],
  }
}

function channelMessage(sessionId: string, id: string, role: string, text: string, created: number) {
  return {
    info: { id, role, sessionID: sessionId, time: { created, completed: created + 1 } },
    parts: [{ id: `part-${id}`, type: 'text', text }],
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 10): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout')
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
