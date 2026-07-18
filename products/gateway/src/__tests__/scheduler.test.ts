import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { adoptOrphanedRunLeases, clearInFlightSupervisorPromptsForTest, dispatchStartLeaseMs, getWorkQueueSnapshot, recoverMissingOpenCodeRuns, schedulerCycle, startSchedulerAdmission, stopSchedulerAdmission, waitForSchedulerIdle } from '../scheduler.js'
import { addWorkDependency, applyWorkTaskAction, clearWorkStateForTest, completeWorkTaskRun, createRoadmap, createRoadmapSupervisor, createWorkTask, decideHumanGate, journalTaskDispatchAcquisitionIntent, listAlerts, listHumanGates, listRoadmapCompletionProposals, listTaskDispatchAcquisitions, listTaskDispatchReceipts, listWorkEvents, loadWorkState, reserveTaskDispatchStart, runWorkStoreRetentionMaintenance, saveWorkState, startWorkTaskRun, updateWorkTask, upsertProjectBinding, type WorkState } from '../work-store.js'
import { countRunsForTask, listTaskRunCountsAtOrAbove } from '../work-store/queries.js'
import { clearWorkersForTest } from '../workers.js'
import { clearEventsForTest } from '../wakeup.js'
import { clearConfigCacheForTest, getConfig, updateConfig, updateSchedulerConfig } from '../config.js'
import { environmentControllerForSpec, localProcessEnvironmentController, prepareEnvironment, registerEnvironmentControllerForTest, resolveEnvironmentSpec, type EnvironmentController, type EnvironmentRunRecord, type EnvironmentSpec } from '../environments.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'
import { getRunArtifactManifestView } from '../artifacts.js'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { buildAssistantMessage, buildFakeSession, fields, type UsedSessionApi } from './helpers/typed-opencode-client.js'

describe('scheduler', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-scheduler-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  let sessionCounter = 0
  let messagesBySession: Record<string, any[]> = {}
  let prompts: any[] = []
  let creates: any[] = []
  let sessions: any[] = []
  let originalPath = ''

  beforeEach(() => {
    originalPath = process.env['PATH'] || ''
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    createWorkTask({ title: 'Ship reviewed work', priority: 'HIGH' }, path.join(testDir, 'gateway.db'))
    clearWorkersForTest()
    clearEventsForTest()
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    clearInFlightSupervisorPromptsForTest()
    startSchedulerAdmission()
    sessionCounter = 0
    messagesBySession = {}
    prompts = []
    creates = []
    sessions = []
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    process.env['PATH'] = originalPath
    delete process.env['FAKE_CONTAINER_MISSING_TOOLS']
    delete process.env['FAKE_CONTAINER_IMAGE_MISSING']
    delete process.env['FAKE_CONTAINER_LOG']
    delete process.env['FAKE_CONTAINER_FAIL_COMMAND']
    delete process.env['FAKE_CRABBOX_LOG']
    clearCurrentDaemonLeadershipForTest()
    clearConfigCacheForTest()
  })

  it('dispatches implement, review, and verify before marking done', async () => {
    let state = await schedulerCycle(client())
    let task = state.tasks[0]
    expect(task!.status).toBe('running')
    expect(task!.currentStage).toBe('implement')
    expect(state.runs).toHaveLength(1)
    expect(prompts[0].body.parts[0].text).toContain('Stage: implement')

    messagesBySession[state.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"implemented","artifacts":["src/example.ts"]}\n```')]
    state = await schedulerCycle(client())
    task = state.tasks[0]
    expect(task!.status).toBe('running')
    expect(task!.currentStage).toBe('review')
    expect(state.runs.map(run => run.stage)).toEqual(['implement', 'review'])

    messagesBySession[state.runs[1]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"review passed","artifacts":[]}\n```')]
    state = await schedulerCycle(client())
    task = state.tasks[0]
    expect(task!.status).toBe('running')
    expect(task!.currentStage).toBe('verify')

    messagesBySession[state.runs[2]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"verified","artifacts":["npm test"]}\n```')]
    state = await schedulerCycle(client())
    task = state.tasks[0]
    expect(task!.status).toBe('done')
    expect(task!.currentStage).toBeUndefined()
  })

  it('does not dispatch scheduler work when this daemon is standby', async () => {
    const dbPath = path.join(testDir, 'gateway.db')
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'writer-daemon', instanceId: 'writer-instance', leaseMs: 60_000 })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'standby-daemon', instanceId: 'standby-instance', leaseMs: 60_000 })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    const state = await schedulerCycle(client())

    expect(state.tasks[0]).toMatchObject({ status: 'pending', currentRunId: undefined })
    expect(state.runs).toHaveLength(0)
    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(listTaskDispatchReceipts({ status: 'starting' }, dbPath)).toEqual([])
  })

  it('sizes dispatch start leases above long environment prepare windows', () => {
    const config = getConfig()
    const resolved = resolveEnvironmentSpec({
      config: {
        ...config.environments,
        defaultEnvironment: 'slow',
        environments: {
          ...config.environments.environments,
          slow: {
            backend: 'local-process',
            resources: { timeoutMs: config.scheduler.leaseMs + 120_000 },
          },
        },
      },
      stage: 'implement',
    })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    expect(dispatchStartLeaseMs(config, resolved.spec)).toBe(resolved.spec.resources.timeoutMs + Math.max(config.scheduler.intervalMs * 3, 30_000))
  })

  it('does not lease supervisor wakeups when this daemon is standby', async () => {
    const dbPath = path.join(testDir, 'gateway.db')
    const task = loadWorkState(dbPath).tasks[0]
    createRoadmapSupervisor({ roadmapId: task!.roadmapId, sessionId: 'ses_standby_supervisor', nextReviewAt: '2000-01-01T00:00:00.000Z' }, dbPath)
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'writer-daemon', instanceId: 'writer-instance', leaseMs: 60_000 })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'standby-daemon', instanceId: 'standby-instance', leaseMs: 60_000 })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    const state = await schedulerCycle(client())

    expect(state.supervisors[0]).toMatchObject({ sessionId: 'ses_standby_supervisor' })
    expect(state.supervisors[0]!.wakeLeaseOwner).toBeUndefined()
    expect(prompts).toHaveLength(0)
  })

  it('mechanically isolates review gate stage permissions before dispatch', async () => {
    updateConfig({
      profiles: {
        reviewer: {
          ...getConfig().profiles['reviewer'],
          permission: {
            ...getConfig().profiles['reviewer']!.permission,
            edit: 'allow',
            webfetch: 'allow',
            websearch: 'allow',
            task: 'allow',
            bash: 'allow',
          },
        },
      },
    } as any)

    let state = await schedulerCycle(client())
    messagesBySession[state.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"implemented","artifacts":["src/example.ts"]}\n```')]
    state = await schedulerCycle(client())

    expect(state.tasks[0]).toMatchObject({ status: 'running', currentStage: 'review' })
    const reviewPrompt = prompts[1]
    expect(reviewPrompt.body.agent).toBe('gateway-reviewer')
    expect(reviewPrompt.body.permission).toMatchObject({
      edit: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      todowrite: 'deny',
    })
    expect(reviewPrompt.body.permission.bash).toMatchObject({ '': 'deny', 'git diff': 'allow', 'npm run verify': 'allow' })
    expect(reviewPrompt.body.parts[0].text).toContain('Mechanical review-gate isolation policy is active')
    expect(reviewPrompt.body.parts[0].text).toContain('Forbidden context:')

    const event = listWorkEvents(20, path.join(testDir, 'gateway.db')).find(row => row.type === 'review_gate.isolation.enforced')
    expect(event?.payload).toMatchObject({
      stage: 'review',
      profile: 'reviewer',
      deniedTools: expect.arrayContaining(['edit', 'webfetch', 'websearch', 'task', 'todowrite']),
      allowedBashCommandCount: expect.any(Number),
      changedPermissions: expect.arrayContaining(['bash', 'edit', 'task', 'webfetch', 'websearch']),
    })
  })

  it('keeps verifier evidence commands available through the isolated bash allowlist', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const task = createWorkTask({ title: 'Verify evidence', pipeline: ['verify'], qualitySpec: { verificationCommands: ['npm test'], evidenceRequirements: ['test output'] } as any }, store)

    let state = await schedulerCycle(client())

    expect(state.runs[0]).toMatchObject({ taskId: task.id, stage: 'verify', resolvedProfile: 'verifier' })
    expect(prompts[0].body.permission.bash).toMatchObject({ '': 'deny', 'npm test': 'allow', 'npm run verify': 'allow' })
    messagesBySession[state.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"verified CMD1 and EVIDENCE1","artifacts":["CMD1 npm test"],"evidence":[{"type":"command","ref":"npm test","summary":"CMD1 EVIDENCE1 test output passed"}]}\n```')]

    state = await schedulerCycle(client())

    expect(state.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'done' })
  })

  it('does not let a completed run overwrite a manual task action', async () => {
    let state = await schedulerCycle(client())
    const taskId = state.tasks[0]!.id
    messagesBySession[state.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"implemented","artifacts":[]}\n```')]

    state = await schedulerCycle(client({ beforeMessages: () => applyWorkTaskAction(taskId, 'cancel', { note: 'user cancelled' }, path.join(testDir, 'gateway.db')) }))

    expect(state.tasks[0]).toMatchObject({ status: 'cancelled', currentRunId: undefined, currentStage: undefined, note: 'user cancelled' })
    expect(state.runs[0]!.status).toBe('errored')
  })

  it('does not mutate durable state from read-only queue snapshots', async () => {
    const snapshot = getWorkQueueSnapshot()

    expect(snapshot.tasks).toHaveLength(1)
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks[0]!.status).toBe('pending')

    const state = await schedulerCycle(client())
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ title: 'Ship reviewed work', status: 'running' })
  })

  it('retries transient prompt dispatch failures with backoff', async () => {
    const aborted: string[] = []

    await schedulerCycle(client({ promptError: new Error('fetch failed'), onAbort: id => aborted.push(id) }))
    await flushAsync()

    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.tasks[0]).toMatchObject({ status: 'pending', currentRunId: undefined, currentStage: 'implement', earliestStartAt: expect.any(String) })
    expect(Date.parse(state.tasks[0]!.earliestStartAt!)).toBeGreaterThan(Date.now())
    expect(state.tasks[0]!.note).toContain('Transient OpenCode transport failure')
    expect(state.runs[0]).toMatchObject({ status: 'failed', result: { failureClass: 'flaky_test' } })
    expect(aborted).toEqual(['ses_1'])
    expect(listAlerts({ status: 'open' }, path.join(testDir, 'gateway.db'))[0]).toMatchObject({ key: expect.stringContaining('run-failure:transport') })
  })

  it('blocks terminal provider prompt failures without retrying', async () => {
    const aborted: string[] = []

    await schedulerCycle(client({ promptError: new Error('HTTP 401: invalid API key'), onAbort: id => aborted.push(id) }))
    await flushAsync()

    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', currentRunId: undefined, currentStage: undefined, note: expect.stringContaining('Provider authentication failure') })
    expect(state.runs[0]).toMatchObject({ status: 'errored', result: { summary: expect.stringContaining('Provider authentication failure') } })
    expect(aborted).toEqual(['ses_1'])
  })

  it('keeps a run active when prompt transport fails after assistant activity starts', async () => {
    const aborted: string[] = []
    await schedulerCycle(client({
      afterCreate: id => { messagesBySession[id] = [assistant('working')] },
      promptError: new Error('fetch failed'),
      onAbort: id => aborted.push(id),
    }))
    await flushAsync()

    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.tasks[0]).toMatchObject({ status: 'running', currentStage: 'implement' })
    expect(state.runs[0]).toMatchObject({ status: 'running' })
    expect(aborted).toEqual([])
  })

  it('recovers a stale run that never recorded prompt dispatch acknowledgement', async () => {
    const store = path.join(testDir, 'gateway.db')
    const dispatched = await schedulerCycle(client({ beforePrompt: () => new Promise(() => {}) }))
    const task = dispatched.tasks[0]!
    const startedRun = dispatched.runs[0]!
    const state = loadWorkState(store)
    const run = state.runs.find(row => row.id === startedRun.id)!
    run.startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    state.tasks.find(row => row.id === task.id)!.currentRunId = run.id
    saveWorkState(state, store)
    const aborted: string[] = []

    const recovered = await schedulerCycle(client({
      listSessions: () => [buildFakeSession({ id: run.sessionId })],
      onAbort: id => aborted.push(id),
    }))
    const durable = loadWorkState(store)
    const oldRun = durable.runs.find(row => row.id === run.id)!

    expect(['failed', 'errored']).toContain(oldRun.status)
    expect(oldRun.result?.summary).toContain('Prompt dispatch was not acknowledged')
    expect(durable.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'pending', currentRunId: undefined, currentStage: 'implement' })
    expect(recovered.runs.find(row => row.id === run.id)?.status).not.toBe('running')
    expect(aborted).toEqual([run.sessionId])
  })

  it('does not recover a stale run when the durable prompt dispatch receipt remains after event pruning', async () => {
    const store = path.join(testDir, 'gateway.db')
    const dispatched = await schedulerCycle(client())
    await waitFor(() => Boolean(listTaskDispatchReceipts({ status: 'started' }, store).find(receipt => receipt.promptSubmittedAt)))
    const task = dispatched.tasks[0]!
    const startedRun = dispatched.runs[0]!
    const state = loadWorkState(store)
    const run = state.runs.find(row => row.id === startedRun.id)!
    run.startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    state.tasks.find(row => row.id === task.id)!.currentRunId = run.id
    saveWorkState(state, store)
    const db = new DatabaseSync(store)
    try {
      db.prepare("DELETE FROM events WHERE type = 'task.dispatch.prompt_submitted'").run()
    } finally {
      db.close()
    }
    const aborted: string[] = []

    const recovered = await schedulerCycle(client({
      listSessions: () => [buildFakeSession({ id: run.sessionId })],
      onAbort: id => aborted.push(id),
    }))

    expect(recovered.runs.find(row => row.id === run.id)).toMatchObject({ status: 'running' })
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)).toMatchObject({ status: 'running', currentRunId: run.id })
    expect(aborted).toEqual([])
  })

  it('blocks the active run when OpenCode returns a terminal assistant error', async () => {
    let state = await schedulerCycle(client())
    messagesBySession[state.runs[0]!.sessionId] = [assistantError('[DeepSeek] Insufficient Balance')]

    state = await schedulerCycle(client())

    expect(state.tasks[0]).toMatchObject({ status: 'blocked', currentRunId: undefined, currentStage: undefined, note: expect.stringContaining('Insufficient Balance') })
    expect(state.runs[0]).toMatchObject({ status: 'errored', result: { summary: expect.stringContaining('Provider balance') } })
    expect(listAlerts({ status: 'open' }, path.join(testDir, 'gateway.db'))[0]).toMatchObject({ key: expect.stringContaining('run-failure:provider_balance'), severity: 'critical' })
  })

  it('blocks provider/model configuration errors without retrying', async () => {
    let state = await schedulerCycle(client())
    messagesBySession[state.runs[0]!.sessionId] = [assistantError('Model gpt-future does not exist for provider openai')]

    state = await schedulerCycle(client())

    expect(state.tasks[0]).toMatchObject({ status: 'blocked', currentRunId: undefined, currentStage: undefined })
    expect(state.runs[0]).toMatchObject({ status: 'errored', result: { summary: expect.stringContaining('Provider/model configuration failure'), failureClass: 'needs_credentials' } })
    expect(listAlerts({ status: 'open' }, path.join(testDir, 'gateway.db'))[0]).toMatchObject({ key: expect.stringContaining('run-failure:provider_model'), severity: 'critical' })
  })

  it('aborts an unused session when a task changes before dispatch commit', async () => {
    const aborted: string[] = []
    const dispatched = client({
      afterCreate: () => {
        const task = loadWorkState(path.join(testDir, 'gateway.db')).tasks[0]
        applyWorkTaskAction(task!.id, 'pause', { note: 'paused during dispatch' }, path.join(testDir, 'gateway.db'))
      },
      onAbort: id => aborted.push(id),
    })

    const state = await schedulerCycle(dispatched)

    expect(state.tasks[0]).toMatchObject({ status: 'paused', currentRunId: undefined })
    expect(state.runs).toHaveLength(0)
    expect(aborted).toEqual(['ses_1'])
    expect(prompts).toHaveLength(0)
  })

  it('rechecks task readiness before creating a selected session', async () => {
    updateSchedulerConfig({ maxConcurrent: 2 })
    const store = path.join(testDir, 'gateway.db')
    const first = loadWorkState(store).tasks[0]
    const second = createWorkTask({ title: 'Second selected task', priority: 'HIGH' }, store)
    const aborted: string[] = []
    let dependencyAdded = false

    const state = await schedulerCycle(client({
      afterCreate: () => {
        if (dependencyAdded) return
        dependencyAdded = true
        addWorkDependency({ taskId: second.id, dependsOnTaskId: first!.id, type: 'blocked_by' }, store)
      },
      onAbort: id => aborted.push(id),
    }))

    expect(creates).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(aborted).toEqual([])
    expect(state.runs).toHaveLength(1)
    expect(state.tasks.find(task => task.id === second.id)).toMatchObject({ status: 'pending', currentRunId: undefined })
  })

  it('shares an in-flight scheduler cycle instead of dispatching duplicate work', async () => {
    const store = path.join(testDir, 'gateway.db')
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const first = schedulerCycle(client({ beforeCreate: () => createGate }))
    const second = schedulerCycle(client())

    await flushAsync()
    expect(prompts).toHaveLength(0)
    const starting = listTaskDispatchReceipts({ status: 'starting' }, store)
    expect(starting).toHaveLength(1)
    expect(starting[0]).toMatchObject({ taskId: loadWorkState(store).tasks[0]!.id, stage: 'implement', leaseOwner: expect.stringContaining('gateway-') })
    expect(loadWorkState(store).runs).toHaveLength(0)

    releaseCreate()
    const [firstState, secondState] = await Promise.all([first, second])

    expect(firstState.runs).toHaveLength(1)
    expect(secondState.runs).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(loadWorkState(path.join(testDir, 'gateway.db')).runs).toHaveLength(1)
    expect(listTaskDispatchReceipts({ status: 'started' }, store)).toEqual([
      expect.objectContaining({ id: starting[0]!.id, runId: firstState.runs[0]!.id, sessionId: firstState.runs[0]!.sessionId }),
    ])
  })

  it('waits for the coalesced cycle to settle and blocks new admission during shutdown', async () => {
    let releaseCreate!: () => void
    let enteredCreate!: () => void
    const entered = new Promise<void>(resolve => { enteredCreate = resolve })
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const cycle = schedulerCycle(client({ beforeCreate: () => { enteredCreate(); return createGate } }))
    await entered

    stopSchedulerAdmission()
    let idle = false
    const waiting = waitForSchedulerIdle().then(() => { idle = true })
    await flushAsync()
    expect(idle).toBe(false)

    releaseCreate()
    await Promise.all([cycle, waiting])
    expect(idle).toBe(true)
    expect(creates).toHaveLength(1)

    await schedulerCycle(client())
    expect(creates).toHaveLength(1)
  })

  it('fences a session-create takeover race and cleans the stale dispatch', async () => {
    const store = path.join(testDir, 'gateway.db')
    let leadershipNow = 1_000_000
    const firstWriter = createDaemonLeadership({ filePath: store, daemonId: 'daemon-a', instanceId: 'daemon-a:1', leaseMs: 10_000, now: () => leadershipNow })
    const nextWriter = createDaemonLeadership({ filePath: store, daemonId: 'daemon-b', instanceId: 'daemon-b:1', leaseMs: 10_000, now: () => leadershipNow })
    firstWriter.acquireOrRenew()
    setCurrentDaemonLeadership(firstWriter)

    let releaseCreate!: () => void
    let enteredCreate!: () => void
    const entered = new Promise<void>(resolve => { enteredCreate = resolve })
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const aborted: string[] = []
    const staleCycle = schedulerCycle(client({ beforeCreate: () => { enteredCreate(); return createGate }, onAbort: id => aborted.push(id) }))
    await entered

    leadershipNow += 10_001
    expect(nextWriter.acquireOrRenew({ takeoverStale: true })).toMatchObject({ mode: 'writer', leaderId: 'daemon-b:1' })
    setCurrentDaemonLeadership(nextWriter)
    releaseCreate()
    const staleState = await staleCycle

    expect(staleState.runs).toHaveLength(0)
    expect(aborted).toContain('ses_1')

    const currentState = await schedulerCycle(client({ onAbort: id => aborted.push(id) }))
    expect(currentState.runs).toHaveLength(1)
    expect(currentState.runs[0]!.sessionId).not.toBe('ses_1')
    expect(listTaskDispatchReceipts({ status: 'failed' }, store)).toEqual([
      expect.objectContaining({ taskId: currentState.tasks[0]!.id, failureReason: expect.stringContaining('Abandoned external acquisition') }),
    ])
  })

  it('releases a resource-less environment acquisition by idempotency key before settling the dispatch', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]!
    updateConfig({
      environments: {
        defaultEnvironment: 'keyed-env',
        environments: { 'keyed-env': { backend: 'custom' } },
      },
    } as any)
    const resolved = resolveEnvironmentSpec({ taskEnvironment: 'keyed-env', config: getConfig().environments, stage: 'implement' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', profile: 'implementer', leaseOwner: 'stale-dispatch', leaseMs: 60_000, now: Date.now() - 120_000 }, store)!
    const key = `${receipt.id}:environment`
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'environment', provider: 'custom', idempotencyKey: key, metadata: { environmentName: resolved.spec.name, specHash: resolved.spec.specHash, stage: 'implement' } }, store)
    applyWorkTaskAction(task.id, 'pause', { note: 'hold recovery fixture' }, store)
    const lookups: string[] = []
    const releases: string[] = []
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      lookupByKey: (spec, idempotencyKey) => {
        lookups.push(idempotencyKey)
        return { ok: true, found: true, backend: spec.backend, idempotencyKeyHash: 'hash', resourceId: 'env_keyed', metadata: {}, evidence: ['found keyed acquisition'] }
      },
      releaseByKey: (spec, idempotencyKey) => {
        releases.push(idempotencyKey)
        return { ok: true, found: true, released: true, backend: spec.backend, idempotencyKeyHash: 'hash', resourceId: 'env_keyed', evidence: ['released keyed acquisition'] }
      },
    }))

    try {
      await schedulerCycle(client())

      expect(lookups).toEqual([key])
      expect(releases).toEqual([key])
      expect(listTaskDispatchAcquisitions(store).find(row => row.dispatchId === receipt.id && row.kind === 'environment')).toMatchObject({ status: 'released' })
      expect(listTaskDispatchReceipts({ status: 'failed' }, store)).toEqual([
        expect.objectContaining({ id: receipt.id, failureReason: expect.stringContaining('Abandoned external acquisition') }),
      ])
    } finally {
      unregister()
    }
  })

  it('keeps a resource-less environment acquisition pending until backend absence is authoritative', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]!
    updateConfig({
      environments: {
        defaultEnvironment: 'keyed-env',
        environments: { 'keyed-env': { backend: 'custom' } },
      },
    } as any)
    const resolved = resolveEnvironmentSpec({ taskEnvironment: 'keyed-env', config: getConfig().environments, stage: 'implement' })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', profile: 'implementer', leaseOwner: 'stale-dispatch', leaseMs: 60_000, now: Date.now() - 120_000 }, store)!
    const key = `${receipt.id}:environment`
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'environment', provider: 'custom', idempotencyKey: key, metadata: { environmentName: resolved.spec.name, specHash: resolved.spec.specHash, stage: 'implement' } }, store)
    applyWorkTaskAction(task.id, 'pause', { note: 'hold recovery fixture' }, store)
    const releases: string[] = []
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      lookupByKey: (spec, idempotencyKey) => ({ ok: true, found: false, backend: spec.backend, idempotencyKeyHash: idempotencyKey, metadata: {}, evidence: ['no keyed acquisition yet'] }),
      releaseByKey: (_spec, idempotencyKey) => {
        releases.push(idempotencyKey)
        throw new Error('release should not run before lookup finds a resource')
      },
    }))

    try {
      await schedulerCycle(client())

      expect(releases).toEqual([])
      expect(listTaskDispatchAcquisitions(store).find(row => row.dispatchId === receipt.id && row.kind === 'environment')).toMatchObject({ status: 'intent' })
    } finally {
      unregister()
    }
  })

  it('releases a resource-less local-container workspace by idempotency key after prepare-only crash', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const runtime = installFakeContainerRuntime(testDir)
    const repoDir = sourceRepo(testDir, 'container-prepare-crash')
    writeSourceFile(repoDir, 'package.json', '{}')
    updateConfig({
      environments: {
        defaultEnvironment: 'container-recovery',
        environments: { 'container-recovery': { backend: 'local-container', workdir: repoDir, tools: ['node'], container: { runtime, image: 'example/test:latest' } } },
      },
    } as any)
    const task = createWorkTask({ title: 'Container prepare crash' }, store)
    const resolved = resolveEnvironmentSpec({ taskEnvironment: 'container-recovery', config: getConfig().environments, stage: 'implement', workdir: repoDir })
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', profile: 'implementer', leaseOwner: 'stale-dispatch', leaseMs: 60_000, now: Date.now() - 120_000 }, store)!
    const key = `${receipt.id}:environment`
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'environment', provider: 'local-container', idempotencyKey: key, metadata: { environmentName: resolved.spec.name, specHash: resolved.spec.specHash, stage: 'implement', workdir: repoDir } }, store)
    const prepared = environmentControllerForSpec(resolved.spec).prepare(resolved.spec, { taskId: task.id, stage: 'implement', dispatchId: receipt.id, idempotencyKey: key })
    const workspace = String(prepared.metadata['workspaceHostPath'])
    expect(fs.existsSync(workspace)).toBe(true)
    applyWorkTaskAction(task.id, 'pause', { note: 'hold recovery fixture' }, store)

    await schedulerCycle(client())

    expect(fs.existsSync(workspace)).toBe(false)
    expect(listTaskDispatchAcquisitions(store).find(row => row.dispatchId === receipt.id && row.kind === 'environment')).toMatchObject({ status: 'released' })
    expect(listTaskDispatchReceipts({ status: 'failed' }, store)).toEqual([
      expect.objectContaining({ id: receipt.id, failureReason: expect.stringContaining('Abandoned external acquisition') }),
    ])
  })

  it('dispatches only runnable tasks when dependencies block higher-priority work', async () => {
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    const dependent = state.tasks[0]
    const prerequisite = createWorkTask({ title: 'Dependency prerequisite', priority: 'LOW' }, store)
    addWorkDependency({ taskId: dependent!.id, dependsOnTaskId: prerequisite.id }, store)

    const afterDispatch = await schedulerCycle(client())

    expect(afterDispatch.tasks.find(task => task.id === dependent!.id)).toMatchObject({ status: 'pending' })
    expect(afterDispatch.tasks.find(task => task.id === prerequisite.id)).toMatchObject({ status: 'running' })
    expect(afterDispatch.runs).toHaveLength(1)
  })

  it('passes task working directory hints to OpenCode session operations', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { note: 'Workdir: /tmp/dbt-nova-live-soak' }, store)

    await schedulerCycle(client())

    const expectedWorkdir = path.join(fs.realpathSync('/tmp'), 'dbt-nova-live-soak')
    expect(creates[0].query).toMatchObject({ directory: expectedWorkdir })
    expect(prompts[0].query).toMatchObject({ directory: expectedWorkdir })
  })

  it('blocks before session creation when required preflight tools are missing', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { qualitySpec: { requiredTools: ['gateway-tool-not-installed'] } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Preflight failed') })
    expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ key: 'preflight:missing-tools:local-process:gateway-tool-not-installed' })
  })

  it('allows dispatch when required preflight tools are present', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { qualitySpec: { requiredTools: ['node'] } as any }, store)

    const state = await schedulerCycle(client())

    expect(state.tasks[0]).toMatchObject({ status: 'running', currentStage: 'implement' })
    expect(creates).toHaveLength(1)
    expect(prompts).toHaveLength(1)
  })

  it('binds an unbound local-process task to a Gateway-owned workspace, never the ambient cwd', async () => {
    // The default beforeEach task has no environment/workdir bound.
    const state = await schedulerCycle(client())
    const run = state.runs[0]!
    expect(run.environment?.backend).toBe('local-process')
    // Real, contained workspace under the state dir — not undefined and not the daemon cwd.
    expect(run.environment?.workdir).toContain(path.join(testDir, 'workspaces'))
    expect(run.environment?.workdir).not.toBe(process.cwd())
    expect(fs.existsSync(run.environment!.workdir!)).toBe(true)
    // The dispatched OpenCode session is rooted there.
    expect(prompts[0].query?.directory).toBe(run.environment?.workdir)
  })

  it('records resolved environment metadata and prompt context on dispatch', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'node-local', backend: 'local-process', tools: ['node'], network: { mode: 'disabled' } } as any }, store)

    const state = await schedulerCycle(client())

    expect(state.runs[0]!.environment).toMatchObject({ name: 'node-local', backend: 'local-process', preflight: { ok: true, checked: ['node'] }, network: { mode: 'disabled' } })
    expect(state.runs[0]!.runtimeProfile).toMatchObject({
      profile: 'implementer',
      environment: { name: 'node-local', backend: 'local-process' },
      network: { mode: 'disabled' },
      capabilityGrant: { id: expect.stringMatching(/^grant_/), status: 'granted', grants: { agent: 'gateway-implementer' } },
      validation: { ok: true },
    })
    expect(loadWorkState(store).runs[0]!.runtimeProfile).toMatchObject({ id: expect.stringMatching(/^runtime_/), filesystem: { policy: 'local-workdir' }, capabilityGrant: { id: expect.stringMatching(/^grant_/) } })
    expect(listWorkEvents(20, store).find(event => event.type === 'runtime.capability_grant.validated')?.payload).toMatchObject({
      stage: 'implement',
      capabilityGrant: { status: 'granted', grants: { agent: 'gateway-implementer' } },
    })
    expect(prompts[0].body.parts[0].text).toContain('Execution environment contract:')
    expect(prompts[0].body.parts[0].text).toContain('Runtime capability grant:')
    expect(prompts[0].body.parts[0].text).toContain('Runtime isolation contract:')
    expect(prompts[0].body.parts[0].text).toContain('node-local (local-process)')
  })

  it('blocks invalid runtime capability grants before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    updateConfig({
      profiles: {
        implementer: {
          ...getConfig().profiles['implementer'],
          tools: ['not_installed_runtime_tool'],
        },
      },
    } as any)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.runs).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Runtime capability grant rejected') })
    expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ source: 'gateway.runtime.capabilities', severity: 'critical' })
    expect(listWorkEvents(20, store).find(event => event.type === 'runtime.capability_grant.rejected')?.payload).toMatchObject({
      stage: 'implement',
      capabilityGrant: { status: 'denied', validation: { ok: false, errors: expect.arrayContaining([expect.stringContaining('LP_TOOL_UNKNOWN')]) } },
    })
  })

  it('blocks unsafe runtime profiles before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'unsafe-runtime', backend: 'local-process', network: { mode: 'restricted', allow: ['*'] } } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Runtime isolation rejected') })
    expect(listTaskDispatchReceipts({}, store)).toHaveLength(0)
    expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ source: 'gateway.runtime', severity: 'critical' })
  })

  it('blocks invalid environment specs before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { backend: 'local-container' } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Environment resolution failed') })
    expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ source: 'gateway.environment' })
  })

  it('gates remote environment leases before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'remote-test', backend: 'remote-crabbox', crabbox: { profile: 'test-profile' } } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'pending', currentStage: 'implement', currentRunId: undefined })
    expect(listHumanGates({ status: 'open' }, store)[0]).toMatchObject({
      type: 'external_side_effect',
      taskId: task!.id,
      stage: 'implement',
      requestedBy: 'gateway.environment',
      reason: expect.stringContaining('Remote environment lease requires approval'),
      details: { environment: { name: 'remote-test', backend: 'remote-crabbox', specHash: expect.any(String) } },
    })
  })

  it('dispatches named remote-crabbox environments with lease metadata', async () => {
    const cli = installFakeCrabboxCli(testDir)
    updateConfig({
      environments: {
        requireApprovalForRemote: false,
        defaultEnvironment: 'remote-test',
        environments: {
          'remote-test': { backend: 'remote-crabbox', tools: ['node'], crabbox: { cli, profile: 'ci', provider: 'aws', class: 'beast' } },
        },
      },
    } as any)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(state.runs[0]!.environment).toMatchObject({ backend: 'remote-crabbox', leaseId: 'cbx_scheduler_test', runId: 'run_scheduler', provider: 'aws', class: 'beast', preflight: { ok: true } })
    expect(prompts[0].body.parts[0].text).toContain('Crabbox command prefix:')
    expect(prompts[0].body.parts[0].text).toContain('fake-crabbox run --id cbx_scheduler_test')
  })

  it('gates privileged container environments before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'privileged-container', backend: 'local-container', container: { image: 'example/test:latest', privileged: true } } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'pending', currentStage: 'implement', currentRunId: undefined })
    expect(listHumanGates({ status: 'open' }, store)[0]).toMatchObject({
      type: 'destructive_action',
      taskId: task!.id,
      stage: 'implement',
      requestedBy: 'gateway.environment',
      reason: expect.stringContaining('Privileged local container environment requires approval'),
      details: { environment: { name: 'privileged-container', backend: 'local-container', specHash: expect.any(String) } },
    })
  })

  it('blocks mock backend hydration failures before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      hydrate: () => ({ ok: false, status: 'failed', reason: 'patch conflict', evidence: ['patch=abc123'] }),
    }))

    try {
      const state = await schedulerCycle(client())

      expect(creates).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Environment hydration failed') })
      expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ key: `environment:hydration:${task!.id}:implement`, evidence: expect.arrayContaining(['patch=abc123']) })
    } finally {
      unregister()
    }
  })

  it('blocks mock backend prepare failures before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      prepare: () => { throw new Error('lease capacity denied') },
    }))

    try {
      const state = await schedulerCycle(client())

      expect(creates).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Environment prepare/lease failed') })
      expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ key: `environment:prepare:${task!.id}:implement` })
    } finally {
      unregister()
    }
  })

  it('blocks mock backend preflight failures before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      prepare: spec => ({
        ...prepareEnvironment(spec, { taskId: task!.id, stage: 'implement' }),
        status: 'blocked',
        preflight: { ok: false, checked: ['mock-tool'], missing: ['mock-tool'], warnings: [], commandRefs: ['mock command -v mock-tool'] },
      }),
    }))

    try {
      const state = await schedulerCycle(client())

      expect(creates).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Preflight failed') })
      expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ key: 'preflight:missing-tools:custom:mock-tool' })
    } finally {
      unregister()
    }
  })

  it('blocks mock backend attach failures before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      attach: () => ({ ok: false, commandPrefix: [], evidence: ['socket unavailable'], reason: 'attach refused' }),
    }))

    try {
      const state = await schedulerCycle(client())

      expect(creates).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Environment attach failed') })
      expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ key: `environment:attach:${task!.id}:implement`, evidence: expect.arrayContaining(['socket unavailable']) })
    } finally {
      unregister()
    }
  })

  it('records cleanup_failed when a mock backend release fails after completion', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any, pipeline: ['implement'] }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      release: () => { throw new Error('release API unavailable') },
    }))

    try {
      let state = await schedulerCycle(client())
      messagesBySession[state.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"implemented","artifacts":[]}\n```')]
      state = await schedulerCycle(client())

      expect(state.tasks[0]).toMatchObject({ status: 'done' })
      expect(state.runs[0]).toMatchObject({ status: 'passed', environment: { status: 'cleanup_failed', cleanup: { state: 'failed' }, metadata: { cleanupError: 'release API unavailable' } } })
    } finally {
      unregister()
    }
  })

  it('blocks expired leases during scheduler startup instead of dispatching duplicate live work', async () => {
    updateSchedulerConfig({ retryLimit: 1 })
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const started = startWorkTaskRun(task!.id, 'implement', 'ses_expired_before_restart', 'implementer', store, {
      owner: 'before-restart',
      leaseMs: 120_000,
    })!
    const stale = loadWorkState(store)
    stale.runs.find(run => run.id === started.run.id)!.leaseExpiresAt = '2000-01-01T00:00:00.000Z'
    saveWorkState(stale, store)

    const state = await schedulerCycle(client({ listSessions: () => [{ id: 'ses_expired_before_restart' }] }))

    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'errored', result: { summary: 'Recovered expired scheduler lease' } })
    expect(state.runs.filter(run => run.taskId === task!.id)).toHaveLength(1)
    expect(state.tasks.find(row => row.id === task!.id)).toMatchObject({ status: 'blocked', currentRunId: undefined, currentStage: undefined, note: expect.stringContaining('old OpenCode session may still be running') })
    expect(prompts).toHaveLength(0)
    expect(listWorkEvents(20, store).map(event => event.type)).toEqual(expect.arrayContaining(['task.run.lease_expired']))
  })

  it('adopts predecessor run leases after restart so completed work is accepted instead of fenced', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    // A previous daemon process dispatched this run; its owner/generation no longer exist.
    const started = startWorkTaskRun(task!.id, 'implement', 'ses_predecessor', 'implementer', store, {
      owner: 'gateway-previous-instance',
      leaseMs: 3_600_000,
      generation: 'gen-previous-instance',
    })!
    // The restarted daemon holds the singleton writer lease for this state dir.
    const leadership = createDaemonLeadership({ filePath: store, daemonId: 'restarted-daemon', instanceId: 'restarted-instance', leaseMs: 60_000 })
    leadership.acquireOrRenew()
    setCurrentDaemonLeadership(leadership)
    // The agent finished while the daemon was down.
    sessions.push({ id: 'ses_predecessor', title: 'GW:predecessor', time: { created: Date.now() }, tokens: {} })
    messagesBySession['ses_predecessor'] = [assistant('```json\n{"status":"pass","summary":"finished before restart","artifacts":[]}\n```')]

    // Without adoption, the completion is fenced against the dead owner.
    let state = await schedulerCycle(client())
    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'running', leaseOwner: 'gateway-previous-instance' })
    expect(listWorkEvents(50, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.run.completion_denied', payload: expect.objectContaining({ reason: 'lease_owner_mismatch' }) }),
    ]))

    // The startup recovery pass adopts the orphaned lease as the leadership-holding writer.
    const adopted = adoptOrphanedRunLeases()
    expect(adopted).toMatchObject({ adopted: 1, runIds: [started.run.id] })

    state = await schedulerCycle(client())
    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'passed', result: expect.objectContaining({ summary: 'finished before restart' }) })
    expect(state.tasks.find(row => row.id === task!.id)).toMatchObject({ currentStage: 'review' })
  })

  it('does not adopt run leases from standby: a non-leader competitor stays fenced', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const started = startWorkTaskRun(task!.id, 'implement', 'ses_writer_owned', 'implementer', store, {
      owner: 'writer-owner',
      leaseMs: 3_600_000,
      generation: 'writer-generation',
    })!
    const writer = createDaemonLeadership({ filePath: store, daemonId: 'writer-daemon', instanceId: 'writer-instance', leaseMs: 60_000 })
    const standby = createDaemonLeadership({ filePath: store, daemonId: 'standby-daemon', instanceId: 'standby-instance', leaseMs: 60_000 })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    expect(adoptOrphanedRunLeases()).toEqual({ adopted: 0, runIds: [] })
    expect(loadWorkState(store).runs.find(run => run.id === started.run.id)).toMatchObject({ leaseOwner: 'writer-owner', schedulerGeneration: 'writer-generation' })

    const fenced = completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'competitor pass', artifacts: [], raw: 'pass' }, 2, store, {}, { owner: 'standby-owner', generation: 'standby-generation' })
    expect(fenced).toMatchObject({ applied: false, reason: 'lease_owner_mismatch' })
  })

  it('recovers running runs whose OpenCode session disappeared after restart', async () => {
    updateSchedulerConfig({ retryLimit: 0 })
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const started = startWorkTaskRun(task!.id, 'implement', 'ses_missing_after_restart', 'implementer', store)!

    const state = await schedulerCycle(client({ listSessions: () => [], getSession: goneSession('ses_missing_after_restart') }))

    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'errored' })
    expect(state.tasks.find(row => row.id === task!.id)).toMatchObject({ status: 'blocked', currentRunId: undefined, note: expect.stringContaining('Recovered missing OpenCode session') })
    expect(prompts).toHaveLength(0)
  })

  it('recovers missing OpenCode sessions at startup and dispatches one replacement when retries remain', async () => {
    updateSchedulerConfig({ retryLimit: 1 })
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const started = startWorkTaskRun(task!.id, 'implement', 'ses_missing_retry', 'implementer', store)!

    const state = await schedulerCycle(client({ listSessions: () => [], getSession: goneSession('ses_missing_retry') }))

    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'errored', result: { summary: 'Recovered missing OpenCode session' } })
    const replacement = state.runs.find(run => run.id !== started.run.id)!
    expect(replacement).toMatchObject({ status: 'running', stage: 'implement', sessionId: 'ses_1' })
    expect(state.tasks.find(row => row.id === task!.id)).toMatchObject({ status: 'running', currentRunId: replacement.id, note: expect.stringContaining('Recovered missing OpenCode session') })
    expect(prompts).toHaveLength(1)
    expect(listWorkEvents(20, store).map(event => event.type)).toEqual(expect.arrayContaining(['task.run.orphan_recovered']))
  })

  it('releases mock backend environments when stale running sessions are recovered', async () => {
    updateSchedulerConfig({ retryLimit: 0 })
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController())

    try {
      let state = await schedulerCycle(client())
      expect(state.runs[0]!.environment).toMatchObject({ backend: 'custom', status: 'prepared' })
      const goneSid = state.runs[0]!.sessionId

      state = await schedulerCycle(client({ listSessions: () => [], getSession: goneSession(goneSid) }))

      expect(state.tasks[0]).toMatchObject({ status: 'blocked', currentRunId: undefined, note: expect.stringContaining('Recovered missing OpenCode session') })
      expect(state.runs[0]).toMatchObject({ status: 'errored', environment: { status: 'released', cleanup: { state: 'released' } } })
    } finally {
      unregister()
    }
  })

  it('raises an alert when preflight failure cleanup also fails', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    updateWorkTask(task!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController({
      prepare: spec => ({
        ...prepareEnvironment(spec, { taskId: task!.id, stage: 'implement' }),
        id: 'env_preflight_cleanup_failed',
        status: 'blocked',
        preflight: { ok: false, checked: ['mock-tool'], missing: ['mock-tool'], warnings: [], commandRefs: ['mock command -v mock-tool'] },
      }),
      release: () => { throw new Error('cleanup endpoint unavailable') },
    }))

    try {
      const state = await schedulerCycle(client())

      expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Preflight failed') })
      expect(creates).toHaveLength(0)
      expect(listAlerts({ status: 'open' }, store)).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: `environment:release:${task!.id}:implement:env_preflight_cleanup_failed`, summary: expect.stringContaining('Environment cleanup failed after preflight failure') }),
        expect.objectContaining({ key: 'preflight:missing-tools:custom:mock-tool' }),
      ]))
    } finally {
      unregister()
    }
  })

  it('persists running OpenCode session usage before the stage completes', async () => {
    let state = await schedulerCycle(client())
    const sessionId = state.runs[0]!.sessionId

    state = await schedulerCycle(client({
      getSession: id => id === sessionId
        ? { id, cost: 0.25, tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 1 } } }
        : undefined,
    }))

    expect(state.runs[0]).toMatchObject({ costUsd: 0.25, inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 })
  })

  it('enforces per-stage concurrency limits during dispatch', async () => {
    updateSchedulerConfig({ maxConcurrent: 3, stageConcurrency: { implement: 1 } })
    createWorkTask({ title: 'Second implement task', priority: 'HIGH' }, path.join(testDir, 'gateway.db'))
    createWorkTask({ title: 'Third implement task', priority: 'HIGH' }, path.join(testDir, 'gateway.db'))

    const state = await schedulerCycle(client())

    expect(state.runs).toHaveLength(1)
    expect(prompts).toHaveLength(1)
  })

  it('counts starting dispatch receipts against stage and profile concurrency', async () => {
    updateSchedulerConfig({ maxConcurrent: 3, stageConcurrency: { implement: 1 }, profileConcurrency: { implementer: 1 } })
    const store = path.join(testDir, 'gateway.db')
    const [reservedTask] = loadWorkState(store).tasks
    reserveTaskDispatchStart({ taskId: reservedTask!.id, stage: 'implement', profile: 'implementer', leaseOwner: 'test', leaseMs: 60_000 }, store)
    createWorkTask({ title: 'Second implement task', priority: 'HIGH' }, store)

    const state = await schedulerCycle(client())

    expect(state.runs).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(listTaskDispatchReceipts({ status: 'starting' }, store)).toEqual([
      expect.objectContaining({ taskId: reservedTask!.id, stage: 'implement', profile: 'implementer' }),
    ])
  })

  it('recovers expired starting dispatch receipts before capacity admission', async () => {
    updateSchedulerConfig({ maxConcurrent: 3, stageConcurrency: { implement: 1 }, profileConcurrency: { implementer: 1 } })
    const store = path.join(testDir, 'gateway.db')
    const [reservedTask] = loadWorkState(store).tasks
    const reserved = reserveTaskDispatchStart({
      taskId: reservedTask!.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'stale-start',
      leaseMs: 60_000,
      now: Date.now() - 120_000,
    }, store)!
    createWorkTask({ title: 'Second implement task', priority: 'HIGH' }, store)

    const state = await schedulerCycle(client())

    expect(state.runs).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(listTaskDispatchReceipts({ status: 'failed' }, store)).toEqual([
      expect.objectContaining({
        id: reserved.id,
        taskId: reservedTask!.id,
        failureReason: 'Dispatch start lease expired before run start.',
      }),
    ])
    expect(listTaskDispatchReceipts({ status: 'started' }, store)).toHaveLength(1)
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.dispatch.start_expired',
        subjectId: reservedTask!.id,
        payload: expect.objectContaining({ dispatchId: reserved.id, recovered: true }),
      }),
    ]))
  })

  it('records durable capacity reasons for team and channel limits', async () => {
    const store = path.join(testDir, 'gateway.db')
    updateConfig({
      agentTeams: {
        delivery: { roles: { implement: 'implementer', review: 'reviewer', verify: 'verifier' } },
      },
    } as any)
    updateSchedulerConfig({
      maxConcurrent: 3,
      capacity: {
        teamConcurrency: { delivery: 1 },
        roadmapConcurrency: {},
        channelConcurrency: { telegram: 1 },
      },
    } as any)
    const [first] = loadWorkState(store).tasks
    updateWorkTask(first!.id, { agentTeam: 'delivery' }, store)
    createWorkTask({ title: 'Second delivery task', priority: 'HIGH', agentTeam: 'delivery', roadmapId: first!.roadmapId }, store)
    upsertProjectBinding({ alias: 'delivery', roadmapId: first!.roadmapId, sessionId: 'ses_delivery', provider: 'telegram', chatId: 'chat-1' }, store)

    const state = await schedulerCycle(client())

    expect(state.runs).toHaveLength(1)
    const pending = state.tasks.find(task => task.title === 'Second delivery task')
    expect(pending).toMatchObject({ status: 'pending', currentRunId: undefined, note: expect.stringContaining('Capacity wait: team:delivery') })
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'capacity.admission.delayed', subjectId: pending?.id, payload: expect.objectContaining({ dimension: 'team', key: 'delivery', reason: expect.stringContaining('capacity.team_full') }) }),
    ]))
  })

  it('records global capacity holds before silently skipping ready work', async () => {
    const store = path.join(testDir, 'gateway.db')
    updateSchedulerConfig({ maxConcurrent: 1 })
    const first = loadWorkState(store).tasks[0]
    createWorkTask({ title: 'Second queued task', priority: 'HIGH', roadmapId: first!.roadmapId }, store)

    const state = await schedulerCycle(client())

    expect(state.runs).toHaveLength(1)
    const pending = state.tasks.find(task => task.title === 'Second queued task')
    expect(pending).toMatchObject({ status: 'pending', earliestStartAt: undefined, note: expect.stringContaining('Capacity wait: global:scheduler') })
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'capacity.admission.queued', subjectId: pending?.id, payload: expect.objectContaining({ dimension: 'global', key: 'scheduler' }) }),
    ]))
  })

  it('waits when retained environment policy is exhausted', async () => {
    updateConfig({ environments: { maxRetained: 1 } } as any)
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    state.runs.push({
      id: 'run_retained',
      taskId: 'task_retained',
      stage: 'verify',
      sessionId: 'ses_retained',
      profile: 'verifier',
      status: 'passed',
      attempt: 1,
      startedAt: new Date().toISOString(),
      environment: environmentRecord({ status: 'retained', cleanup: { retainOnFailure: true, retainOnSuccess: false, state: 'retained' } }),
    })
    saveWorkState(state, store)

    const after = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(after.tasks[0]).toMatchObject({ status: 'pending', currentRunId: undefined })
  })

  it('waits when backend-specific environment concurrency is exhausted', async () => {
    updateConfig({ environments: { backendMaxConcurrent: { custom: 1 } } } as any)
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    updateWorkTask(state.tasks[0]!.id, { environment: { name: 'mock-env', backend: 'custom' } as any }, store)
    const latest = loadWorkState(store)
    latest.runs.push({
      id: 'run_custom_active',
      taskId: 'task_custom_active',
      stage: 'implement',
      sessionId: 'ses_custom_active',
      profile: 'implementer',
      status: 'running',
      attempt: 1,
      startedAt: new Date().toISOString(),
      environment: environmentRecord({ backend: 'custom', status: 'prepared' }),
    })
    saveWorkState(latest, store)
    const unregister = registerEnvironmentControllerForTest('custom', mockController())

    try {
      const after = await schedulerCycle(client())

      expect(creates).toHaveLength(0)
      expect(prompts).toHaveLength(0)
      expect(after.tasks[0]).toMatchObject({ status: 'pending', currentRunId: undefined, note: expect.stringContaining('Capacity wait: environment:custom') })
      expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'capacity.admission.delayed', subjectId: state.tasks[0]!.id, payload: expect.objectContaining({ dimension: 'environment', key: 'custom' }) }),
      ]))
    } finally {
      unregister()
    }
  })

  it('dispatches without source hydration when a task has no dependencies', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const repoDir = sourceRepo(testDir, 'no-dependency')
    writeSourceFile(repoDir, 'file.txt', 'base\n')
    createWorkTask({ title: 'Independent task', environment: { name: 'source', backend: 'local-process', workdir: repoDir } as any }, store)

    const state = await schedulerCycle(client())

    expect(state.tasks[0]).toMatchObject({ status: 'running', currentStage: 'implement' })
    expect(listWorkEvents(10, store).find(event => event.type === 'environment.hydrated')?.payload).toMatchObject({ hydration: { status: 'not_required' } })
  })

  it('hydrates one dependency patch stack before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const repoDir = sourceRepo(testDir, 'one-dependency')
    writeSourceFile(repoDir, 'file.txt', 'base\n')
    writeSourceFile(repoDir, 'dep.patch', patchFor('file.txt', 'base', 'dependency'))
    const dependency = doneDependency(store, 'Dependency patch', 'dep.patch')
    createWorkTask({ title: 'Dependent task', dependsOn: [dependency.id], environment: { name: 'source', backend: 'local-process', workdir: repoDir } as any }, store)

    const state = await schedulerCycle(client())

    expect(state.tasks.find(task => task.title === 'Dependent task')).toMatchObject({ status: 'running', currentStage: 'implement' })
    expect(fs.readFileSync(path.join(repoDir, 'file.txt'), 'utf8')).toBe('dependency\n')
    const hydration = listWorkEvents(20, store).find(event => event.type === 'environment.hydrated')?.payload['hydration'] as any
    expect(hydration).toMatchObject({ status: 'applied', source: { dependencyTaskIds: [dependency.id], changedFiles: ['file.txt'], applyResult: 'applied' } })
    expect(hydration.source.patchIds[0]).toContain(dependency.id)
  })

  it('hydrates multiple dependency patches before session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const repoDir = sourceRepo(testDir, 'multiple-dependencies')
    writeSourceFile(repoDir, 'a.txt', 'base-a\n')
    writeSourceFile(repoDir, 'b.txt', 'base-b\n')
    writeSourceFile(repoDir, 'a.patch', patchFor('a.txt', 'base-a', 'one'))
    writeSourceFile(repoDir, 'b.patch', patchFor('b.txt', 'base-b', 'two'))
    const first = doneDependency(store, 'First patch', 'a.patch')
    const second = doneDependency(store, 'Second patch', 'b.patch')
    createWorkTask({ title: 'Multi dependent task', dependsOn: [first.id, second.id], environment: { name: 'source', backend: 'local-process', workdir: repoDir } as any }, store)

    const state = await schedulerCycle(client())

    expect(state.tasks.find(task => task.title === 'Multi dependent task')).toMatchObject({ status: 'running' })
    expect(fs.readFileSync(path.join(repoDir, 'a.txt'), 'utf8')).toBe('one\n')
    expect(fs.readFileSync(path.join(repoDir, 'b.txt'), 'utf8')).toBe('two\n')
    const hydration = listWorkEvents(20, store).find(event => event.type === 'environment.hydrated')?.payload['hydration'] as any
    expect(hydration.source).toMatchObject({ changedFiles: ['a.txt', 'b.txt'], applyResult: 'applied' })
    expect(hydration.source.dependencyTaskIds).toEqual(expect.arrayContaining([first.id, second.id]))
  })

  it('blocks dependent dispatch when a dependency patch conflicts', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const repoDir = sourceRepo(testDir, 'conflicting-dependency')
    writeSourceFile(repoDir, 'file.txt', 'unexpected\n')
    writeSourceFile(repoDir, 'dep.patch', patchFor('file.txt', 'base', 'dependency'))
    const dependency = doneDependency(store, 'Conflicting patch', 'dep.patch')
    createWorkTask({ title: 'Blocked dependent task', dependsOn: [dependency.id], environment: { name: 'source', backend: 'local-process', workdir: repoDir } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks.find(task => task.title === 'Blocked dependent task')).toMatchObject({ status: 'blocked', note: expect.stringContaining('Environment hydration failed') })
    expect(listAlerts({ status: 'open' }, store)[0]).toMatchObject({ source: 'gateway.environment', evidence: expect.arrayContaining([expect.stringContaining('patch')]) })
  })

  it('blocks dependent dispatch when a dependency has no patch artifact', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const repoDir = sourceRepo(testDir, 'missing-artifact')
    writeSourceFile(repoDir, 'file.txt', 'base\n')
    const dependency = doneDependency(store, 'Missing patch')
    createWorkTask({ title: 'Missing artifact dependent task', dependsOn: [dependency.id], environment: { name: 'source', backend: 'local-process', workdir: repoDir } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks.find(task => task.title === 'Missing artifact dependent task')).toMatchObject({ status: 'blocked', note: expect.stringContaining('Missing dependency patch artifact') })
  })

  it('dispatches after restart when dependency patch is already applied', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const repoDir = sourceRepo(testDir, 'restart-recovery')
    writeSourceFile(repoDir, 'file.txt', 'dependency\n')
    writeSourceFile(repoDir, 'dep.patch', patchFor('file.txt', 'base', 'dependency'))
    const dependency = doneDependency(store, 'Already applied patch', 'dep.patch')
    createWorkTask({ title: 'Restarted dependent task', dependsOn: [dependency.id], environment: { name: 'source', backend: 'local-process', workdir: repoDir } as any }, store)
    clearConfigCacheForTest()

    const state = await schedulerCycle(client())

    expect(state.tasks.find(task => task.title === 'Restarted dependent task')).toMatchObject({ status: 'running' })
    const hydration = listWorkEvents(20, store).find(event => event.type === 'environment.hydrated')?.payload['hydration'] as any
    expect(hydration.evidence).toEqual(expect.arrayContaining([expect.stringContaining('patch already applied')]))
  })

  it('releases local-container workspace when preflight blocks dispatch', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const runtime = installFakeContainerRuntime(testDir)
    process.env['FAKE_CONTAINER_MISSING_TOOLS'] = 'missing-tool'
    const repoDir = sourceRepo(testDir, 'container-preflight')
    writeSourceFile(repoDir, 'package.json', '{}')
    createWorkTask({ title: 'Container preflight block', environment: { name: 'container', backend: 'local-container', workdir: repoDir, tools: ['missing-tool'], container: { runtime, image: 'example/test:latest' } } as any }, store)

    const state = await schedulerCycle(client())

    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('Preflight failed') })
    const prepared = listWorkEvents(20, store).find(event => event.type === 'environment.prepared')?.payload['environment'] as any
    expect(prepared).toMatchObject({ backend: 'local-container', metadata: { workspaceHostPath: expect.any(String) } })
    expect(fs.existsSync(prepared.metadata.workspaceHostPath)).toBe(false)
    expect(listWorkEvents(20, store).find(event => event.type === 'environment.released')?.payload).toMatchObject({ reason: 'preflight_failed' })
  })

  it('releases local-container workspace when stale sessions are recovered', async () => {
    updateSchedulerConfig({ retryLimit: 0 })
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const runtime = installFakeContainerRuntime(testDir)
    const repoDir = sourceRepo(testDir, 'container-stale')
    writeSourceFile(repoDir, 'package.json', '{}')
    createWorkTask({ title: 'Container stale recovery', environment: { name: 'container', backend: 'local-container', workdir: repoDir, tools: ['node'], container: { runtime, image: 'example/test:latest' } } as any }, store)

    let state = await schedulerCycle(client())
    const workspace = String(state.runs[0]!.environment?.metadata['workspaceHostPath'])
    expect(state.runs[0]).toMatchObject({ status: 'running', environment: { backend: 'local-container', status: 'prepared' } })
    expect(fs.existsSync(workspace)).toBe(true)
    const goneSid = state.runs[0]!.sessionId

    state = await schedulerCycle(client({ listSessions: () => [], getSession: goneSession(goneSid) }))

    expect(state.runs[0]).toMatchObject({ status: 'errored', environment: { status: 'released', cleanup: { state: 'released' } } })
    expect(fs.existsSync(workspace)).toBe(false)
  })

  it('releases prepared environments when run ownership is lost after session creation', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const runtime = installFakeContainerRuntime(testDir)
    const repoDir = sourceRepo(testDir, 'container-ownership-lost')
    writeSourceFile(repoDir, 'package.json', '{}')
    const task = createWorkTask({ title: 'Container ownership race', environment: { name: 'container', backend: 'local-container', workdir: repoDir, tools: ['node'], container: { runtime, image: 'example/test:latest' } } as any }, store)
    const aborted: string[] = []

    const state = await schedulerCycle(client({
      afterCreate: () => applyWorkTaskAction(task.id, 'cancel', { note: 'lost race' }, store),
      onAbort: id => aborted.push(id),
    }))

    const prepared = listWorkEvents(20, store).find(event => event.type === 'environment.prepared')?.payload['environment'] as any
    expect(prepared).toMatchObject({ backend: 'local-container', metadata: { workspaceHostPath: expect.any(String) } })
    expect(state.runs).toHaveLength(0)
    expect(aborted).toEqual(['ses_1'])
    expect(fs.existsSync(prepared.metadata.workspaceHostPath)).toBe(false)
    expect(listWorkEvents(20, store).find(event => event.type === 'environment.released')?.payload).toMatchObject({ reason: 'run_ownership_lost' })
  })

  it('keeps dispatch acquisitions pending when session abort cleanup is not verified', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const runtime = installFakeContainerRuntime(testDir)
    const repoDir = sourceRepo(testDir, 'container-unverified-session-cleanup')
    writeSourceFile(repoDir, 'package.json', '{}')
    const task = createWorkTask({ title: 'Container unverified cleanup', environment: { name: 'container', backend: 'local-container', workdir: repoDir, tools: ['node'], container: { runtime, image: 'example/test:latest' } } as any }, store)
    const aborted: string[] = []

    await schedulerCycle(client({
      afterCreate: () => applyWorkTaskAction(task.id, 'cancel', { note: 'lost race' }, store),
      onAbort: id => aborted.push(id),
      getSession: id => ({ id }),
    }))

    const prepared = listWorkEvents(20, store).find(event => event.type === 'environment.prepared')?.payload['environment'] as any
    const acquisitions = listTaskDispatchAcquisitions(store)
    expect(aborted).toEqual(['ses_1'])
    expect(fs.existsSync(prepared.metadata.workspaceHostPath)).toBe(true)
    expect(acquisitions.find(row => row.kind === 'session')).toMatchObject({ status: 'acquired', resourceId: 'ses_1' })
    expect(acquisitions.find(row => row.kind === 'environment')).toMatchObject({ status: 'acquired' })
    expect(listAlerts({ source: 'gateway.scheduler' }, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining('OpenCode session cleanup was not verified') }),
    ]))
    fs.rmSync(path.dirname(prepared.metadata.workspaceHostPath), { recursive: true, force: true })
  })

  it('merges local-container command captures into completed run artifacts', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const runtime = installFakeContainerRuntime(testDir)
    const repoDir = sourceRepo(testDir, 'container-capture')
    writeSourceFile(repoDir, 'package.json', '{}')
    createWorkTask({ title: 'Container capture', pipeline: ['implement'], environment: { name: 'container', backend: 'local-container', workdir: repoDir, tools: ['node'], container: { runtime, image: 'example/test:latest' } } as any }, store)

    let state = await schedulerCycle(client())
    const prefix = (state.runs[0]!.environment?.metadata['commandPrefix'] as string[])[0]!
    const workspace = String(state.runs[0]!.environment?.metadata['workspaceHostPath'])
    const command = spawnSync(prefix, ['capture-ok'], { encoding: 'utf8' })
    messagesBySession[state.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"implemented","artifacts":[]}\n```')]
    state = await schedulerCycle(client())

    expect(command.status).toBe(0)
    expect(command.stdout).toContain('captured ok stdout')
    expect(state.runs[0]!.result?.artifacts).toEqual(expect.arrayContaining([expect.stringMatching(/\.stdout\.log$/), expect.stringMatching(/\.stderr\.log$/), expect.stringMatching(/\.json$/)]))
    expect(state.runs[0]!.environment?.artifacts).toEqual(expect.arrayContaining([expect.stringMatching(/\.stdout\.log$/)]))
    expect(state.runs[0]!.result?.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'log', summary: expect.stringContaining('captured 1 command') })]))
    const stdoutRef = state.runs[0]!.result?.artifacts.find(ref => ref.endsWith('.stdout.log'))!
    const stdoutPath = stdoutRef.replace(/^file:/, '')
    expect(fs.existsSync(stdoutPath)).toBe(true)
    expect(stdoutPath.startsWith(path.dirname(workspace))).toBe(false)
    expect(fs.existsSync(workspace)).toBe(false)
    const manifest = getRunArtifactManifestView(state.runs[0]!.id, state, store)!
    expect(manifest).toMatchObject({
      manifestFound: true,
      counts: { available: 3, missing: 0, unsupported: 0, blocked: 0 },
      retentionPolicies: ['run_artifact'],
      redactionStatus: 'redacted',
    })
    expect(JSON.stringify(manifest)).not.toContain(workspace)
  })

  it('prompts due roadmap supervisors without creating duplicate turns', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const supervisor = createRoadmapSupervisor({ roadmapId: task!.roadmapId, sessionId: 'ses_supervisor', nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)

    const state = await schedulerCycle(client())

    expect(prompts[0].path.id).toBe('ses_supervisor')
    expect(prompts[0].body.parts[0].text).toContain('Roadmap supervisor turn')
    const leased = loadWorkState(store).supervisors.find(row => row.supervisorId === supervisor.supervisorId)!
    expect(leased).toMatchObject({ wakeLeaseOwner: expect.any(String), lastReviewAt: undefined })
    expect(state.runs).toHaveLength(1)

    const nextReviewAt = futureIso()
    messagesBySession[supervisor.sessionId] = [assistant('```json\n' + JSON.stringify({ turn: { supervisorId: supervisor.supervisorId, roadmapId: supervisor.roadmapId, leaseOwner: leased.wakeLeaseOwner, cursorEventId: leased.lastWakeEventId || leased.lastReviewedEventId || 0 }, status: 'ok', summary: 'reviewed roadmap', actions: [{ type: 'schedule_next_review', summary: 'review tomorrow' }], questions: [], proposedTasks: [], nextReviewAt }) + '\n```')]
    await schedulerCycle(client())

    const completed = loadWorkState(store).supervisors.find(row => row.supervisorId === supervisor.supervisorId)!
    expect(completed).toMatchObject({ wakeLeaseOwner: undefined, lastReviewAt: expect.any(String), nextReviewAt, lastResultStatus: 'ok', lastResultSummary: 'reviewed roadmap' })
    expect(prompts.filter(prompt => prompt.path.id === 'ses_supervisor')).toHaveLength(1)
  })

  it('does not block the scheduler cycle on a hung supervisor prompt', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    createRoadmapSupervisor({ roadmapId: task!.roadmapId, sessionId: 'ses_supervisor_hang', nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)
    const hangForever = new Promise<void>(() => {})

    const state = await schedulerCycle(client({
      beforePrompt: args => args.path.id === 'ses_supervisor_hang' ? hangForever : undefined,
    }))

    // The supervisor turn was fired but the cycle completed and still admitted task work.
    expect(prompts.some(prompt => prompt.path.id === 'ses_supervisor_hang')).toBe(true)
    expect(state.runs).toHaveLength(1)
    expect(state.supervisors[0]).toMatchObject({ wakeLeaseOwner: expect.any(String) })
  })

  it('does not fire a second prompt into a supervisor session whose prompt is still in flight after the lease re-arms', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const supervisor = createRoadmapSupervisor({ roadmapId: task!.roadmapId, sessionId: 'ses_supervisor_inflight', nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)
    const hangForever = new Promise<void>(() => {})

    await schedulerCycle(client({
      beforePrompt: args => args.path.id === 'ses_supervisor_inflight' ? hangForever : undefined,
    }))
    expect(prompts.filter(prompt => prompt.path.id === 'ses_supervisor_inflight')).toHaveLength(1)

    // Expire the wake lease, as it would after the hung prompt outlived the
    // lease window, so the next cycle re-acquires the wakeup.
    const state = loadWorkState(store)
    const leased = state.supervisors.find(row => row.supervisorId === supervisor.supervisorId)!
    leased.wakeLeaseExpiresAt = new Date(Date.now() - 1000).toISOString()
    saveWorkState(state, store)

    await schedulerCycle(client())

    // The wakeup re-armed but the in-flight guard suppressed a second
    // interleaved LLM turn into the same session.
    expect(loadWorkState(store).supervisors[0]).toMatchObject({ wakeLeaseOwner: expect.any(String) })
    expect(prompts.filter(prompt => prompt.path.id === 'ses_supervisor_inflight')).toHaveLength(1)
  })

  it('shares an in-flight supervisor wakeup cycle instead of prompting duplicate turns', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    createRoadmapSupervisor({ roadmapId: task!.roadmapId, sessionId: 'ses_supervisor_dupe', nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)
    let releasePrompt!: () => void
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve })

    const first = schedulerCycle(client({
      beforePrompt: args => args.path.id === 'ses_supervisor_dupe' ? promptGate : undefined,
    }))
    const second = schedulerCycle(client())

    let results: PromiseSettledResult<WorkState>[] = []
    try {
      await waitFor(() => prompts.some(prompt => prompt.path.id === 'ses_supervisor_dupe'))
      expect(prompts.filter(prompt => prompt.path.id === 'ses_supervisor_dupe')).toHaveLength(1)
    } finally {
      releasePrompt()
      results = await Promise.allSettled([first, second])
    }

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(prompts.filter(prompt => prompt.path.id === 'ses_supervisor_dupe')).toHaveLength(1)
    expect(loadWorkState(store).supervisors[0]).toMatchObject({ wakeLeaseOwner: expect.any(String), lastWakeReason: 'schedule' })
  })

  it('applies multi-project supervisor turns to the correct roadmap', async () => {
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    state.tasks = []
    state.runs = []
    state.roadmaps = []
    state.supervisors = []
    state.projectBindings = []
    state.completionProposals = []
    state.dependencies = []
    saveWorkState(state, store)
    const alpha = createRoadmap({ title: 'Alpha project' }, store)
    const beta = createRoadmap({ title: 'Beta project' }, store)
    const alphaSupervisor = createRoadmapSupervisor({ roadmapId: alpha.id, sessionId: 'ses_alpha_supervisor', nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)
    const betaSupervisor = createRoadmapSupervisor({ roadmapId: beta.id, sessionId: 'ses_beta_supervisor', nextReviewAt: '2000-01-01T00:00:00.000Z' }, store)
    upsertProjectBinding({ alias: 'alpha', roadmapId: alpha.id, sessionId: alphaSupervisor.sessionId }, store)
    upsertProjectBinding({ alias: 'beta', roadmapId: beta.id, sessionId: betaSupervisor.sessionId }, store)

    await schedulerCycle(client())

    expect(prompts).toHaveLength(2)
    expect(new Set(prompts.map(prompt => prompt.path.id))).toEqual(new Set(['ses_alpha_supervisor', 'ses_beta_supervisor']))
    const leased = loadWorkState(store).supervisors
    const alphaLeased = leased.find(row => row.supervisorId === alphaSupervisor.supervisorId)!
    const betaLeased = leased.find(row => row.supervisorId === betaSupervisor.supervisorId)!
    messagesBySession[alphaSupervisor.sessionId] = [assistant('```json\n' + JSON.stringify({ turn: { supervisorId: alphaSupervisor.supervisorId, roadmapId: alpha.id, leaseOwner: alphaLeased.wakeLeaseOwner, cursorEventId: alphaLeased.lastWakeEventId || alphaLeased.lastReviewedEventId || 0 }, status: 'completion_proposed', summary: 'alpha ready', actions: [{ type: 'propose_completion', summary: 'alpha complete' }], questions: [], proposedTasks: [], completion: { recommendation: 'ready_for_user_approval', evidence: ['alpha verify'], risks: [] } }) + '\n```')]
    const betaNextReviewAt = futureIso()
    messagesBySession[betaSupervisor.sessionId] = [assistant('```json\n' + JSON.stringify({ turn: { supervisorId: betaSupervisor.supervisorId, roadmapId: beta.id, leaseOwner: betaLeased.wakeLeaseOwner, cursorEventId: betaLeased.lastWakeEventId || betaLeased.lastReviewedEventId || 0 }, status: 'ok', summary: 'beta reviewed', actions: [{ type: 'schedule_next_review', summary: 'review beta tomorrow' }], questions: [], proposedTasks: [], nextReviewAt: betaNextReviewAt }) + '\n```')]

    await schedulerCycle(client())

    const completed = loadWorkState(store).supervisors
    expect(completed.find(row => row.supervisorId === alphaSupervisor.supervisorId)).toMatchObject({ lastResultStatus: 'completion_proposed', lastResultSummary: 'alpha ready' })
    expect(completed.find(row => row.supervisorId === betaSupervisor.supervisorId)).toMatchObject({ wakeLeaseOwner: undefined, lastResultStatus: 'ok', lastResultSummary: 'beta reviewed', nextReviewAt: betaNextReviewAt })
    expect(listRoadmapCompletionProposals({ roadmapId: alpha.id, status: 'open' }, store)).toHaveLength(1)
    expect(listRoadmapCompletionProposals({ roadmapId: beta.id, status: 'open' }, store)).toHaveLength(0)
    expect(prompts.filter(prompt => prompt.path.id === 'ses_beta_supervisor')).toHaveLength(1)
    expect(listWorkEvents(100, store).filter(event => event.type === 'roadmap.supervisor.result_applied')).toHaveLength(2)
  })

  it('blocks dispatch when governance budgets are exhausted', async () => {
    updateConfig({ governance: { global: { dailyCostUsd: 0 } } } as any)

    const state = await schedulerCycle(client())

    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('global daily cost exhausted') })
  })

  it('resolves agent teams, task stage overrides, and run attribution before dispatch', async () => {
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    state.tasks = []
    state.runs = []
    state.roadmaps = []
    saveWorkState(state, store)
    updateConfig({
      agentTeams: {
        analytics: {
          roles: { implement: 'reviewer', verify: 'verifier' },
          capabilityRequirements: { implement: ['gateway-stage'] },
          qualitySpecDefaults: { acceptanceCriteria: ['model tested'], verificationCommands: ['dbt test'] },
        },
      },
    } as any)
    const roadmap = createRoadmap({ title: 'Analytics project', agentTeam: 'analytics' }, store)
    const task = createWorkTask({ title: 'Build dbt model', roadmapId: roadmap.id, pipeline: ['implement'], stageProfiles: { implement: 'implementer' } }, store)

    const dispatched = await schedulerCycle(client())
    const run = dispatched.runs.find(row => row.taskId === task.id)!

    expect(run).toMatchObject({ profile: 'implementer', resolvedProfile: 'implementer', resolvedAgent: 'gateway-implementer', agentTeam: 'analytics', agentTeamVersion: getConfig().agentTeams['analytics']!.revision })
    expect(prompts[0].body.agent).toBe('gateway-implementer')
    expect(prompts[0].body.parts[0].text).toContain('dbt test')
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)?.qualitySpec).toMatchObject({ acceptanceCriteria: ['model tested'], verificationCommands: ['dbt test'] })
  })

  it('blocks invalid agent team capability requirements before creating a session', async () => {
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    state.tasks = []
    state.runs = []
    state.roadmaps = []
    saveWorkState(state, store)
    updateConfig({ agentTeams: { analytics: { roles: { implement: 'implementer' }, capabilityRequirements: { implement: ['missing-skill'] }, qualitySpecDefaults: {} } } } as any)
    const roadmap = createRoadmap({ title: 'Analytics project', agentTeam: 'analytics' }, store)
    createWorkTask({ title: 'Build dbt model', roadmapId: roadmap.id }, store)

    const blocked = await schedulerCycle(client())

    expect(prompts).toHaveLength(0)
    expect(blocked.runs).toHaveLength(0)
    expect(blocked.tasks[0]).toMatchObject({ status: 'blocked', note: expect.stringContaining('missing-skill') })
    expect(listWorkEvents(10, store).at(-1)?.type).toBe('task.block')
  })

  it('allows explicit profile capabilities, tools, and MCP references to satisfy team requirements', async () => {
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    state.tasks = []
    state.runs = []
    state.roadmaps = []
    saveWorkState(state, store)
    updateConfig({
      profiles: {
        implementer: {
          ...getConfig().profiles['implementer'],
          capabilities: ['repo-write'],
          tools: ['gateway_task_update'],
          mcpServers: ['gateway'],
        },
      },
      agentTeams: {
        bounded: {
          roles: { implement: 'implementer' },
          capabilityRequirements: { implement: ['repo-write', 'gateway_task_update', 'gateway'] },
        },
      },
    } as any)
    const roadmap = createRoadmap({ title: 'Bounded project', agentTeam: 'bounded' }, store)
    createWorkTask({ title: 'Use bounded implementer', roadmapId: roadmap.id }, store)

    const dispatched = await schedulerCycle(client())

    expect(dispatched.runs).toHaveLength(1)
    expect(dispatched.runs[0]).toMatchObject({ resolvedProfile: 'implementer', resolvedAgent: 'gateway-implementer', agentTeam: 'bounded' })
  })

  it('blocks dispatch on Gateway stage approvals until the gate is approved', async () => {
    updateConfig({ humanLoop: { stageApprovals: ['implement'] } } as any)

    let state = await schedulerCycle(client())

    expect(prompts).toHaveLength(0)
    expect(state.tasks[0]).toMatchObject({ status: 'pending', currentStage: 'implement' })
    const [gate] = listHumanGates({ status: 'open' }, path.join(testDir, 'gateway.db'))
    expect(gate).toMatchObject({ type: 'stage_transition', stage: 'implement' })

    decideHumanGate(gate!.id, { decision: 'approve', scope: 'once' }, path.join(testDir, 'gateway.db'))
    state = await schedulerCycle(client())

    expect(prompts).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ status: 'running', currentStage: 'implement' })
  })

  it('does not mark done when final stage evidence misses the task quality spec', async () => {
    const store = path.join(testDir, 'gateway.db')
    const state = loadWorkState(store)
    state.tasks = []
    state.roadmaps = []
    state.runs = []
    saveWorkState(state, store)
    const task = createWorkTask({ title: 'Evidence required', pipeline: ['verify'], qualitySpec: { verificationCommands: ['npm test'], evidenceRequirements: ['test output'] } as any }, store)

    let afterDispatch = await schedulerCycle(client())
    messagesBySession[afterDispatch.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"verified","artifacts":[]}\n```')]
    const afterMissing = await schedulerCycle(client())

    expect(afterMissing.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'running', currentStage: 'verify', note: expect.stringContaining('Quality gate missing required evidence') })
    expect(afterMissing.runs[0]).toMatchObject({ status: 'failed', result: { failureClass: 'verification_failed' } })
    expect(afterMissing.runs[1]).toMatchObject({ status: 'running', stage: 'verify' })
  })

  it('does not let empty backend artifact evidence satisfy review quality gates', async () => {
    const store = path.join(testDir, 'gateway.db')
    resetWorkState(store)
    const task = createWorkTask({ title: 'Review evidence required', pipeline: ['review'], qualitySpec: { acceptanceCriteria: ['review cites evidence'] } as any }, store)

    let afterDispatch = await schedulerCycle(client())
    messagesBySession[afterDispatch.runs[0]!.sessionId] = [assistant('```json\n{"status":"pass","summary":"reviewed","artifacts":[]}\n```')]
    const afterMissing = await schedulerCycle(client())

    expect(afterMissing.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'pending', currentStage: 'implement', note: expect.stringContaining('at least one artifact or evidence entry') })
    expect(afterMissing.runs[0]).toMatchObject({ status: 'failed', result: { failureClass: 'verification_failed' } })
    expect(afterMissing.runs[0]!.result?.evidence || []).toEqual([])
    expect(afterMissing.runs).toHaveLength(1)
  })

  // --- Windowed read-path (live scope) correctness under deep terminal-run history ---
  // The scheduler's per-tick reads use the windowed `live` run scope, which only
  // materializes running runs, currentRunId runs, and a bounded recent slice of
  // terminal runs. These tests seed thousands of OLD terminal runs (well past the
  // live window) and prove the scheduler still behaves identically.

  it('dispatches a ready task with thousands of historical terminal runs outside the live window', async () => {
    const store = path.join(testDir, 'gateway.db')
    seedTerminalRuns(store, 2000, { taskId: 'task_history' })
    const task = loadWorkState(store).tasks[0]

    const state = await schedulerCycle(client())

    const dispatched = state.tasks.find(row => row.id === task!.id)!
    expect(dispatched).toMatchObject({ status: 'running', currentStage: 'implement' })
    expect(state.runs.some(run => run.taskId === task!.id && run.status === 'running')).toBe(true)
    expect(prompts).toHaveLength(1)
  })

  it('completes and retries an active run with thousands of historical terminal runs outside the live window', async () => {
    updateSchedulerConfig({ retryLimit: 2 })
    const store = path.join(testDir, 'gateway.db')
    seedTerminalRuns(store, 2000, { taskId: 'task_history' })

    // Dispatch, then complete the active implement run despite the deep history.
    let state = await schedulerCycle(client())
    const task = state.tasks[0]
    const implementRun = state.runs.find(run => run.taskId === task!.id && run.status === 'running')!
    messagesBySession[implementRun.sessionId] = [assistant('```json\n{"status":"pass","summary":"implemented","artifacts":["src/example.ts"]}\n```')]
    state = await schedulerCycle(client())
    expect(state.tasks.find(row => row.id === task!.id)).toMatchObject({ status: 'running', currentStage: 'review' })

    // Fail the review run: it must retry (lease + completion still correct).
    const reviewRun = state.runs.find(run => run.taskId === task!.id && run.stage === 'review' && run.status === 'running')!
    messagesBySession[reviewRun.sessionId] = [assistant('```json\n{"status":"fail","summary":"needs work","feedback":"fix it","artifacts":[]}\n```')]
    state = await schedulerCycle(client())
    // The failed run is recorded terminal (completion + lease fencing correct) and
    // the task retries with a fresh active run re-dispatched in the same cycle.
    expect(state.runs.find(run => run.id === reviewRun.id)).toMatchObject({ status: 'failed' })
    const retried = state.tasks.find(row => row.id === task!.id)!
    expect(retried.status).toBe('running')
    expect(retried.currentRunId).toBeDefined()
    expect(retried.currentRunId).not.toBe(reviewRun.id)
  })

  it('still counts a RETAINED environment on an OLD terminal run outside the live window', async () => {
    updateConfig({ environments: { maxRetained: 1 } } as any)
    const store = path.join(testDir, 'gateway.db')

    // A retained environment sitting on a run that finished long ago.
    const seeded = loadWorkState(store)
    seeded.runs.push({
      id: 'run_old_retained',
      taskId: 'task_old_retained',
      stage: 'verify',
      sessionId: 'ses_old_retained',
      profile: 'verifier',
      status: 'passed',
      attempt: 1,
      startedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      environment: environmentRecord({ status: 'retained', cleanup: { retainOnFailure: true, retainOnSuccess: false, state: 'retained' } }),
    })
    saveWorkState(seeded, store)

    // Bury it under 1200 newer terminal runs so it falls outside the recent live window.
    seedTerminalRuns(store, 1200, { taskId: 'task_history', baseTimeMs: Date.now() })

    const after = await schedulerCycle(client())

    // The retained-environment limit (1) is still seen as exhausted, so no dispatch.
    expect(creates).toHaveLength(0)
    expect(prompts).toHaveLength(0)
    expect(after.tasks[0]).toMatchObject({ status: 'pending', currentRunId: undefined })
  })

  it('recovers an orphaned active run with thousands of historical terminal runs outside the live window', async () => {
    updateSchedulerConfig({ retryLimit: 0 })
    const store = path.join(testDir, 'gateway.db')
    const task = loadWorkState(store).tasks[0]
    const started = startWorkTaskRun(task!.id, 'implement', 'ses_orphan_deep', 'implementer', store)!
    seedTerminalRuns(store, 2000, { taskId: 'task_history' })

    const state = await schedulerCycle(client({ listSessions: () => [], getSession: goneSession('ses_orphan_deep') }))

    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'errored' })
    expect(state.tasks.find(row => row.id === task!.id)).toMatchObject({ status: 'blocked', currentRunId: undefined, note: expect.stringContaining('Recovered missing OpenCode session') })
  })

  // The session surface is typed against the real SDK via `UsedSessionApi` (a
  // Pick of the methods the gateway touches). An SDK upgrade that renames or
  // reshapes create/get/list/messages/prompt/abort breaks compilation here,
  // instead of silently passing an `any`. Returns/response envelopes reuse the
  // shared typed helper (`fields`, `buildFakeSession`, `buildAssistantMessage`).
  describe('per-task run cap (#203)', () => {
    const store = path.join(testDir, 'gateway.db')

    function isolatedTask(title: string) {
      // Drop the default beforeEach task so only our task competes for capacity.
      const initial = loadWorkState(store)
      if (initial.tasks[0]) applyWorkTaskAction(initial.tasks[0].id, 'cancel', {}, store)
      return createWorkTask({ title, pipeline: ['implement'] }, store)
    }

    it('blocks a task that has already reached maxRunsPerTask instead of dispatching it', async () => {
      updateSchedulerConfig({ maxRunsPerTask: 3 })
      const task = isolatedTask('Runaway issue')
      seedTerminalRuns(store, 3, { taskId: task.id })
      expect(countRunsForTask(task.id, store)).toBe(3)
      const runsBefore = loadWorkState(store).runs.length

      await schedulerCycle(client())

      const after = loadWorkState(store).tasks.find(t => t.id === task.id)!
      expect(after.status).toBe('blocked')
      expect(after.note).toContain('Exceeded maxRunsPerTask (3 runs)')
      expect(loadWorkState(store).runs.length).toBe(runsBefore) // no new run dispatched
      expect(prompts).toHaveLength(0)
      const events = listWorkEvents(200, store)
      expect(events.some(e => e.type === 'scheduler.run_cap_exceeded' && e.subjectId === task.id)).toBe(true)
      expect(events.some(e => e.type === 'task.block' && e.subjectId === task.id)).toBe(true)
    })

    it('blocks at maxRunsPerTask even after retention prunes old run rows', async () => {
      updateSchedulerConfig({ maxRunsPerTask: 3 })
      const task = isolatedTask('Pruned runaway issue')
      seedTerminalRuns(store, 3, { taskId: task.id })
      const retained = runWorkStoreRetentionMaintenance(store, {
        runsMaxAgeMs: 90 * 24 * 60 * 60 * 1000,
        receiptsMaxAgeMs: 0,
        now: new Date('2026-07-01T00:00:00.000Z'),
      })
      expect(retained.runs.pruned).toBe(2)
      expect(loadWorkState(store).runs.filter(run => run.taskId === task.id)).toHaveLength(1)
      expect(countRunsForTask(task.id, store)).toBe(3)

      await schedulerCycle(client())

      const after = loadWorkState(store).tasks.find(t => t.id === task.id)!
      expect(after.status).toBe('blocked')
      expect(prompts).toHaveLength(0)
    })

    it('dispatches a task under the cap normally', async () => {
      updateSchedulerConfig({ maxRunsPerTask: 3 })
      const task = isolatedTask('Healthy issue')
      seedTerminalRuns(store, 1, { taskId: task.id })

      await schedulerCycle(client())

      const after = loadWorkState(store).tasks.find(t => t.id === task.id)!
      expect(after.status).toBe('running')
      expect(after.currentRunId).toBeDefined()
    })

    it('is a real ceiling: a task at cap-1 dispatches, then blocks once at the cap', async () => {
      updateSchedulerConfig({ maxRunsPerTask: 3 })
      const task = isolatedTask('Churning issue')
      seedTerminalRuns(store, 2, { taskId: task.id }) // cap - 1

      // Cycle 1: under the cap -> dispatches, creating the run that reaches the cap.
      await schedulerCycle(client())
      expect(loadWorkState(store).tasks.find(t => t.id === task.id)!.status).toBe('running')
      expect(countRunsForTask(task.id, store)).toBe(3)

      // Churn re-creates a dispatchable task (return it to pending).
      applyWorkTaskAction(task.id, 'retry', { stage: 'implement' }, store)

      // Cycle 2: now at the cap -> blocked, never dispatched again.
      await schedulerCycle(client())
      const after = loadWorkState(store).tasks.find(t => t.id === task.id)!
      expect(after.status).toBe('blocked')
      expect(after.note).toContain('Exceeded maxRunsPerTask (3 runs)')
      expect(countRunsForTask(task.id, store)).toBe(3) // no further runs accumulated
    })

    it('countRunsForTask and listTaskRunCountsAtOrAbove read the indexed count', async () => {
      const task = isolatedTask('Counted issue')
      seedTerminalRuns(store, 4, { taskId: task.id })
      const other = createWorkTask({ title: 'Quiet issue', pipeline: ['implement'] }, store)
      startWorkTaskRun(other.id, 'implement', `ses_${other.id}`, 'implementer', store)

      expect(countRunsForTask(task.id, store)).toBe(4)
      expect(countRunsForTask(other.id, store)).toBe(1)
      expect(countRunsForTask('task_does_not_exist', store)).toBe(0)

      const atOrAbove3 = listTaskRunCountsAtOrAbove(3, 50, store)
      expect(atOrAbove3.find(row => row.taskId === task.id)?.runCount).toBe(4)
      expect(atOrAbove3.some(row => row.taskId === other.id)).toBe(false)
    })

    it('re-block after an operator resume (cap unchanged) does not re-emit run_cap_exceeded', async () => {
      updateSchedulerConfig({ maxRunsPerTask: 3 })
      const task = isolatedTask('Resumed runaway')
      seedTerminalRuns(store, 3, { taskId: task.id })

      // Cycle 1: first breach — fully eventful block.
      await schedulerCycle(client())
      expect(loadWorkState(store).tasks.find(t => t.id === task.id)!.status).toBe('blocked')
      const capEventsAfterFirst = listWorkEvents(500, store).filter(e => e.type === 'scheduler.run_cap_exceeded' && e.subjectId === task.id)
      expect(capEventsAfterFirst).toHaveLength(1)

      // Operator resumes WITHOUT raising the cap; count is still at the cap.
      applyWorkTaskAction(task.id, 'resume', { stage: 'implement' }, store)

      // Cycle 2: re-blocks quietly — no duplicate run_cap_exceeded / task.block.
      await schedulerCycle(client())
      const after = loadWorkState(store).tasks.find(t => t.id === task.id)!
      expect(after.status).toBe('blocked')
      expect(after.note).toContain('Exceeded maxRunsPerTask (3 runs)')
      const events = listWorkEvents(500, store)
      expect(events.filter(e => e.type === 'scheduler.run_cap_exceeded' && e.subjectId === task.id)).toHaveLength(1)
      expect(events.filter(e => e.type === 'task.block' && e.subjectId === task.id)).toHaveLength(1)
    })

    it('re-emits run_cap_exceeded when the operator raises the cap and the task breaches the new ceiling', async () => {
      updateSchedulerConfig({ maxRunsPerTask: 3 })
      const task = isolatedTask('Raised-cap runaway')
      seedTerminalRuns(store, 3, { taskId: task.id })
      await schedulerCycle(client())
      expect(listWorkEvents(500, store).filter(e => e.type === 'scheduler.run_cap_exceeded' && e.subjectId === task.id)).toHaveLength(1)

      // Operator raises the cap and resumes; the task dispatches until it hits the
      // new, higher ceiling — a genuinely new breach that SHOULD re-emit.
      updateSchedulerConfig({ maxRunsPerTask: 4 })
      applyWorkTaskAction(task.id, 'resume', { stage: 'implement' }, store)
      await schedulerCycle(client()) // dispatches run #4 -> reaches the new cap
      expect(countRunsForTask(task.id, store)).toBe(4)
      applyWorkTaskAction(task.id, 'retry', { stage: 'implement' }, store)
      await schedulerCycle(client()) // now at cap 4 -> blocks with a fresh breach

      const capEvents = listWorkEvents(500, store).filter(e => e.type === 'scheduler.run_cap_exceeded' && e.subjectId === task.id)
      expect(capEvents.length).toBeGreaterThanOrEqual(2)
      expect(capEvents.some(e => Number(e.payload?.['cap']) === 4)).toBe(true)
    })
  })

  describe('session-recovery robustness (directory-scoped list false-positive)', () => {
    const store = path.join(testDir, 'gateway.db')

    function activeRun(sessionId: string): string {
      const task = createWorkTask({ title: `Long run ${sessionId}`, pipeline: ['implement'] }, store)
      const started = startWorkTaskRun(task.id, 'implement', sessionId, 'implementer', store)
      if (!started?.run) throw new Error('failed to start run')
      return started.run.id
    }

    const runStatus = (runId: string) => loadWorkState(store).runs.find(r => r.id === runId)?.status
    const notFound = () => Object.assign(new Error('session not found'), { status: 404 })
    const transportError = () => Object.assign(new Error('fetch failed'), { status: 500 })

    it('does NOT recover a run whose session is absent from the list but present on get (false-positive killed)', async () => {
      const runId = activeRun('ses_live')
      // The directory-scoped list is incomplete (omits a live session), but the
      // authoritative per-run get returns the session -> must not recover.
      const result = await recoverMissingOpenCodeRuns(client({ listSessions: () => [], getSession: id => ({ id }) }), loadWorkState(store), 5)
      expect(result.recovered).toBe(0)
      expect(result.runIds).toEqual([])
      expect(runStatus(runId)).toBe('running')
    })

    it('recovers a run only when get confirms a genuine 404', async () => {
      const runId = activeRun('ses_gone')
      const result = await recoverMissingOpenCodeRuns(client({ listSessions: () => [], getSession: () => { throw notFound() } }), loadWorkState(store), 5)
      expect(result.recovered).toBe(1)
      expect(result.runIds).toContain(runId)
      expect(runStatus(runId)).toBe('errored')
    })

    it('stays conservative on a non-404 transport error from get (does not recover)', async () => {
      const runId = activeRun('ses_flaky')
      const result = await recoverMissingOpenCodeRuns(client({ listSessions: () => [], getSession: () => { throw transportError() } }), loadWorkState(store), 5)
      expect(result.recovered).toBe(0)
      expect(runStatus(runId)).toBe('running')
    })

    it('makes zero per-run get calls when the session is listed (pre-filter short-circuits)', async () => {
      const runId = activeRun('ses_ok')
      const getCalls: string[] = []
      const result = await recoverMissingOpenCodeRuns(
        client({ listSessions: () => [{ id: 'ses_ok' }], getSession: id => { getCalls.push(id); return undefined } }),
        loadWorkState(store),
        5,
      )
      expect(result.recovered).toBe(0)
      expect(getCalls).toEqual([])
      expect(runStatus(runId)).toBe('running')
    })

    it('recovers nothing when the session list itself fails (conservative abort)', async () => {
      const runId = activeRun('ses_listfail')
      const result = await recoverMissingOpenCodeRuns(client({ listSessions: () => { throw transportError() } }), loadWorkState(store), 5)
      expect(result.recovered).toBe(0)
      expect(runStatus(runId)).toBe('running')
    })
  })

  function client(hooks: { beforeMessages?: () => void; beforeCreate?: () => Promise<void> | void; beforePrompt?: (args: any) => Promise<void> | void; afterCreate?: (id: string) => void; onAbort?: (id: string) => void; promptError?: Error; listSessions?: (args: any) => any[]; getSession?: (id: string) => any } = {}): OpencodeClient {
    const session: UsedSessionApi = {
      create: async options => {
        await hooks.beforeCreate?.()
        const id = `ses_${++sessionCounter}`
        creates.push(options)
        const created = buildFakeSession({ id, title: options?.body?.title, directory: options?.query?.directory })
        sessions.push(created)
        hooks.afterCreate?.(id)
        return fields(created)
      },
      prompt: async options => {
        prompts.push(options)
        await hooks.beforePrompt?.(options)
        if (hooks.promptError) throw hooks.promptError
        return fields({ info: buildAssistantMessage({ id: `msg_${++sessionCounter}`, sessionID: options.path.id }), parts: [] })
      },
      // Fire-and-forget twin: resolves 204-like at enqueue and never surfaces a
      // mid-turn promptError. Task dispatch must pass async:false to stay on the
      // blocking `prompt` above; if it regresses to this path, promptError-based
      // failure tests break — the intended tripwire.
      promptAsync: (async () => fields(undefined)) as any,
      messages: async options => {
        hooks.beforeMessages?.()
        return fields(messagesBySession[options.path.id] || [])
      },
      get: async options => {
        const override = hooks.getSession?.(options.path.id)
        if (override !== undefined) return fields(buildFakeSession({ id: options.path.id, ...override }))
        const existing = sessions.find(session => session.id === options.path.id)
        if (!existing) throw Object.assign(new Error('session not found'), { status: 404 })
        return fields(existing)
      },
      list: async options => fields(hooks.listSessions ? hooks.listSessions(options) : sessions.filter(session => !options?.query?.directory || session.directory === options.query.directory)),
      abort: async options => {
        hooks.onAbort?.(options.path.id)
        sessions = sessions.filter(session => session.id !== options.path.id)
        return fields(true)
      },
      delete: async options => {
        sessions = sessions.filter(session => session.id !== options.path.id)
        return fields(true)
      },
    }
    return { session } as unknown as OpencodeClient
  }
})

function flushAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition was not met before timeout')
    await flushAsync()
  }
}

function assistant(text: string) {
  return {
    info: { role: 'assistant', time: { created: 1, completed: 2 } },
    parts: [{ type: 'text', text }, { type: 'step-finish' }],
  }
}

function assistantError(message: string) {
  return {
    info: { role: 'assistant', time: { created: 1, completed: 2 }, error: { name: 'APIError', data: { message, statusCode: 402 } } },
    parts: [],
  }
}

// Models a session that OpenCode genuinely no longer has: `session.get` 404s for
// `missingId` (and only it), which is the authoritative signal recovery now
// requires — absence from a directory-scoped `session.list` alone is not enough.
function goneSession(missingId: string) {
  return (id: string) => {
    if (id === missingId) throw Object.assign(new Error('session not found'), { status: 404 })
    return undefined
  }
}

// Seed `count` terminal (passed/failed) runs so the scheduler's live read window
// (running + currentRunId + recent 500 terminal) provably excludes older history.
function seedTerminalRuns(store: string, count: number, opts: { taskId?: string; baseTimeMs?: number } = {}): void {
  const state = loadWorkState(store)
  // Default to an old epoch so filler runs sort BEFORE the runs the scheduler
  // creates during the cycle (which happen "now"): the real active/terminal runs
  // then stay inside the recent live window and remain visible in the windowed
  // return snapshot, while the table still carries thousands of rows. Callers that
  // need filler to be NEWER than a specific old run (retained-env case) pass an
  // explicit recent baseTimeMs.
  const base = opts.baseTimeMs ?? Date.parse('2020-01-01T00:00:00.000Z')
  const taskId = opts.taskId ?? 'task_history'
  for (let i = 0; i < count; i++) {
    state.runs.push({
      id: `run_filler_${i}`,
      taskId,
      stage: 'implement',
      sessionId: `ses_filler_${i}`,
      profile: 'implementer',
      status: i % 2 === 0 ? 'passed' : 'failed',
      attempt: 1,
      startedAt: new Date(base + i * 1000).toISOString(),
      completedAt: new Date(base + i * 1000 + 500).toISOString(),
    })
  }
  saveWorkState(state, store)
}

function resetWorkState(store: string): void {
  const state = loadWorkState(store)
  state.tasks = []
  state.runs = []
  state.dependencies = []
  state.roadmaps = []
  saveWorkState(state, store)
}

function sourceRepo(rootDir: string, name: string): string {
  const repoDir = path.join(rootDir, name)
  fs.mkdirSync(repoDir, { recursive: true })
  return repoDir
}

function writeSourceFile(repoDir: string, relativePath: string, content: string): void {
  const filePath = path.join(repoDir, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function patchFor(relativePath: string, from: string, to: string): string {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    '@@ -1 +1 @@',
    `-${from}`,
    `+${to}`,
    '',
  ].join('\n')
}

function doneDependency(store: string, title: string, patchArtifact?: string) {
  const task = createWorkTask({ title, pipeline: ['implement'] }, store)
  const started = startWorkTaskRun(task.id, 'implement', `ses_${task.id}`, 'implementer', store)!
  completeWorkTaskRun(started.run.id, {
    status: 'pass',
    summary: 'dependency done',
    feedback: '',
    artifacts: patchArtifact ? [`patch:${patchArtifact}`] : [],
    evidence: patchArtifact ? [{ type: 'diff', ref: patchArtifact, summary: 'dependency patch artifact' }] : [],
    raw: '{}',
  }, 2, store)
  return loadWorkState(store).tasks.find(row => row.id === task.id)!
}

function installFakeContainerRuntime(rootDir: string): string {
  const runtime = 'fake-container'
  const scriptPath = path.join(rootDir, runtime)
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_CONTAINER_LOG) fs.appendFileSync(process.env.FAKE_CONTAINER_LOG, JSON.stringify(args) + '\\n')
if (args[0] === '--version') { console.log('fake-container 1.0.0'); process.exit(0) }
if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.FAKE_CONTAINER_IMAGE_MISSING) { console.error('image missing'); process.exit(1) }
  console.log('sha256:fake-image')
  process.exit(0)
}
if (args[0] === 'run') {
  const commandIndex = args.indexOf('command')
  const command = commandIndex >= 0 ? args.slice(commandIndex) : []
  if (command[0] === 'command' && command[1] === '-v') {
    const tool = command[2]
    const missing = (process.env.FAKE_CONTAINER_MISSING_TOOLS || '').split(',').filter(Boolean)
    if (missing.includes(tool)) { console.error('missing ' + tool); process.exit(1) }
    console.log('/usr/bin/' + tool)
    process.exit(0)
  }
  const imageIndex = args.indexOf('example/test:latest')
  const stageCommand = imageIndex >= 0 ? args.slice(imageIndex + 1) : []
  if (stageCommand[0] === 'capture-ok') { console.log('captured ok stdout'); console.error('captured ok stderr'); process.exit(0) }
  if (stageCommand[0] === 'sh' && stageCommand[1] === '-lc') { console.log('shell ran: ' + (stageCommand[2] || '')); process.exit(0) }
  if (stageCommand[0] === 'true') { console.log('warm true'); process.exit(0) }
  console.log('ran container command')
  process.exit(0)
}
console.error('unsupported fake-container args: ' + args.join(' '))
process.exit(1)
`)
  fs.chmodSync(scriptPath, 0o755)
  process.env['PATH'] = `${rootDir}${path.delimiter}${process.env['PATH'] || ''}`
  process.env['FAKE_CONTAINER_LOG'] = path.join(rootDir, 'fake-container.log')
  return runtime
}

function installFakeCrabboxCli(rootDir: string): string {
  const cli = 'fake-crabbox'
  const scriptPath = path.join(rootDir, cli)
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_CRABBOX_LOG) fs.appendFileSync(process.env.FAKE_CRABBOX_LOG, JSON.stringify(args) + '\\n')
function timing(extra) { console.error(JSON.stringify(Object.assign({ provider: 'aws', leaseId: 'cbx_scheduler_test', slug: 'scheduler-crab', exitCode: 0 }, extra || {}))) }
if (args[0] === '--version') { console.log('fake-crabbox 1.0.0'); process.exit(0) }
if (args[0] === 'warmup') {
  console.log('leased cbx_scheduler_test slug=scheduler-crab provider=aws server=i-test type=beast ip=203.0.113.10 idle_timeout=30m expires=soon')
  console.log('ready ssh=root@203.0.113.10 :2222 network=public workroot=/work/crabbox')
  timing({ totalMs: 42 })
  process.exit(0)
}
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ id: 'cbx_scheduler_test', slug: 'scheduler-crab', provider: 'aws', state: 'active', host: '203.0.113.10', sshKey: '/tmp/id_ed25519', workroot: '/work/crabbox' }))
  process.exit(0)
}
if (args[0] === 'run') {
  const commandIndex = args.indexOf('--')
  const command = commandIndex >= 0 ? args.slice(commandIndex + 1) : []
  if (command[0] === 'command' && command[1] === '-v') console.log('/usr/bin/' + command[2])
  else console.log('ran remote command')
  timing({ runId: 'run_scheduler', artifacts: ['crabbox://run/run_scheduler/artifact/proof.md'] })
  process.exit(0)
}
if (args[0] === 'stop' || args[0] === 'release') { console.log('released lease=cbx_scheduler_test'); process.exit(0) }
console.error('unsupported fake-crabbox args: ' + args.join(' '))
process.exit(1)
`)
  fs.chmodSync(scriptPath, 0o755)
  process.env['PATH'] = `${rootDir}${path.delimiter}${process.env['PATH'] || ''}`
  process.env['FAKE_CRABBOX_LOG'] = path.join(rootDir, 'fake-crabbox.log')
  return cli
}

function mockController(overrides: Partial<EnvironmentController> = {}): EnvironmentController {
  return {
    ...localProcessEnvironmentController,
    backend: 'custom',
    hydrate: (_spec, input) => ({ ok: true, status: 'not_required', evidence: [`mock hydrate ${input.taskId}`] }),
    prepare: (spec: EnvironmentSpec) => prepareEnvironment(spec, { taskId: 'mock-task', stage: 'implement' }),
    attach: (_spec, environment) => ({ ok: true, workdir: environment.workdir, commandPrefix: [], evidence: ['mock attach'] }),
    ...overrides,
  }
}

function environmentRecord(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  const now = new Date().toISOString()
  return {
    id: 'env_test',
    name: 'test-env',
    backend: 'local-process',
    status: 'prepared',
    specHash: 'env_hash',
    startedAt: now,
    updatedAt: now,
    ttlMs: 3600000,
    cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'pending' },
    resources: { timeoutMs: 3600000 },
    network: { mode: 'restricted' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: [], missing: [], warnings: [], commandRefs: [] },
    artifacts: [],
    metadata: {},
    ...overrides,
  }
}

function futureIso(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
}
