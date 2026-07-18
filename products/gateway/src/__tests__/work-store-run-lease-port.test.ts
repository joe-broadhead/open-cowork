import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import type { EnvironmentRunRecord } from '../environments.js'
import {
  completeWorkTaskRun,
  createRoadmap,
  createWorkTask,
  listWorkEvents,
  loadWorkState,
} from '../work-store.js'
import {
  createSqliteWorkStoreRunLeasePort,
} from '../work-store/run-lease-port.js'

describe('work-store run/lease mutation port', () => {
  let testDir = ''
  let store = ''

  beforeEach(() => {
    // Fresh mkdtemp directory per test: never delete the directory of a store
    // that was just initialized, and never share a fixed path across parallel
    // vitest workers.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-run-lease-port-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('owns scheduler dispatch receipts behind a local SQLite port', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Dispatch port roadmap' }, store)
    const task = createWorkTask({ title: 'Dispatch through port', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const now = Date.parse('2026-06-21T20:00:00.000Z')

    const reserved = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-port',
      leaseMs: 60_000,
      now,
    })
    const duplicate = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-port-duplicate',
      leaseMs: 60_000,
      now: now + 1_000,
    })

    expect(reserved).toMatchObject({ taskId: task.id, stage: 'implement', status: 'starting', leaseOwner: 'scheduler-port' })
    expect(duplicate).toBeUndefined()
    expect(port.countActiveDispatchStarts({}, now + 10_000)).toBe(1)
    expect(port.attachDispatchEnvironment(reserved!.id, envRun({ id: 'env_dispatch' }))).toMatchObject({ environment: expect.objectContaining({ id: 'env_dispatch' }) })
    expect(port.markDispatchFailed(reserved!.id, 'session create failed')).toMatchObject({ status: 'failed', failureReason: 'session create failed' })
    expect(port.listDispatchReceipts({ taskId: task.id })).toEqual([
      expect.objectContaining({ id: reserved!.id, status: 'failed', environment: expect.objectContaining({ id: 'env_dispatch' }) }),
    ])
  })

  it('replays dispatch reservations with the same idempotency key', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Dispatch idempotency roadmap' }, store)
    const task = createWorkTask({ title: 'Replay dispatch reservation', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const first = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-original',
      leaseMs: 60_000,
      idempotencyKey: 'dispatch:idem:1',
    })!

    const replay = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-retry',
      leaseMs: 60_000,
      idempotencyKey: 'dispatch:idem:1',
    })

    expect(replay).toEqual(first)
    expect(port.listDispatchReceipts({ taskId: task.id })).toHaveLength(1)
  })

  it('recovers expired dispatch start leases with durable receipts', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Expired dispatch start roadmap' }, store)
    const task = createWorkTask({ title: 'Recover expired dispatch start', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const reservedAt = Date.parse('2026-06-21T20:00:00.000Z')
    const recoveredAt = reservedAt + 60_001

    const reserved = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-port-expired',
      leaseMs: 60_000,
      now: reservedAt,
    })

    expect(reserved).toMatchObject({ status: 'starting' })
    expect(port.countActiveDispatchStarts({}, reservedAt + 1_000)).toBe(1)
    const recovered = port.recoverExpiredDispatchStarts(recoveredAt)

    expect(recovered).toEqual({ recovered: 1, dispatchIds: [reserved!.id] })
    expect(port.countActiveDispatchStarts({}, recoveredAt)).toBe(0)
    expect(port.listDispatchReceipts({ taskId: task.id })).toEqual([
      expect.objectContaining({
        id: reserved!.id,
        status: 'failed',
        failureReason: 'Dispatch start lease expired before run start.',
      }),
    ])
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.dispatch.start_expired',
        subjectId: task.id,
        payload: expect.objectContaining({ dispatchId: reserved!.id, recovered: true }),
      }),
    ]))
  })

  it('records prompt submission on the durable dispatch receipt', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Prompt receipt roadmap' }, store)
    const task = createWorkTask({ title: 'Record prompt receipt', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const reserved = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-port-prompt',
      leaseMs: 60_000,
    })!

    expect(port.markDispatchStarted(reserved.id, { runId: 'run_prompt_receipt', sessionId: 'ses_prompt_receipt' })).toMatchObject({ status: 'started' })
    const submitted = port.markDispatchPromptSubmitted(reserved.id)

    expect(submitted).toMatchObject({ id: reserved.id, status: 'started', promptSubmittedAt: expect.any(String) })
    expect(port.listDispatchReceipts({ taskId: task.id })).toEqual([
      expect.objectContaining({ id: reserved.id, promptSubmittedAt: submitted!.promptSubmittedAt }),
    ])
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.dispatch.prompt_submitted',
        subjectId: 'run_prompt_receipt',
        payload: expect.objectContaining({ dispatchId: reserved.id, taskId: task.id, runId: 'run_prompt_receipt' }),
      }),
    ]))
  })

  it('requires a live matching dispatch receipt owner before starting a run', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Dispatch ownership roadmap' }, store)
    const task = createWorkTask({ title: 'Fence stale dispatch owner', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const reserved = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'owner-current',
      leaseMs: 60_000,
    })!

    const missingOwner = port.startRunFromDispatch(reserved.id, task.id, 'implement', 'ses_missing_owner', 'implementer', { leaseMs: 60_000, generation: 'gen-missing' })
    const stale = port.startRunFromDispatch(reserved.id, task.id, 'implement', 'ses_stale_owner', 'implementer', { owner: 'owner-stale', leaseMs: 60_000, generation: 'gen-stale' })

    expect(missingOwner).toBeUndefined()
    expect(stale).toBeUndefined()
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)).toMatchObject({ status: 'pending', currentRunId: undefined })
    expect(port.listDispatchReceipts({ taskId: task.id })).toEqual([
      expect.objectContaining({ id: reserved.id, status: 'starting', runId: undefined, sessionId: undefined }),
    ])

    const started = port.startRunFromDispatch(reserved.id, task.id, 'implement', 'ses_current_owner', 'implementer', { owner: 'owner-current', leaseMs: 60_000, generation: 'gen-current' })
    const duplicate = port.startRunFromDispatch(reserved.id, task.id, 'implement', 'ses_duplicate_owner', 'implementer', { owner: 'owner-current', leaseMs: 60_000, generation: 'gen-current' })

    expect(started).toBeDefined()
    expect(duplicate).toBeUndefined()
    expect(port.listDispatchReceipts({ taskId: task.id })).toEqual([
      expect.objectContaining({ id: reserved.id, status: 'started', runId: started!.run.id, sessionId: 'ses_current_owner' }),
    ])
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.dispatch.started',
        subjectId: task.id,
        payload: expect.objectContaining({ dispatchId: reserved.id, runId: started!.run.id, sessionId: 'ses_current_owner' }),
      }),
    ]))
  })

  it('releases environments attached to expired dispatch start receipts', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Expired dispatch environment roadmap' }, store)
    const task = createWorkTask({ title: 'Recover expired dispatch environment', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const reservedAt = Date.parse('2026-06-21T20:00:00.000Z')
    const recoveredAt = reservedAt + 60_001
    const reserved = port.reserveDispatchStart({
      taskId: task.id,
      stage: 'implement',
      profile: 'implementer',
      leaseOwner: 'scheduler-port-env-expired',
      leaseMs: 60_000,
      now: reservedAt,
    })!

    expect(port.attachDispatchEnvironment(reserved.id, envRun({ id: 'env_dispatch_expired', status: 'prepared' }))).toMatchObject({
      environment: expect.objectContaining({ id: 'env_dispatch_expired', status: 'prepared' }),
    })

    const recovered = port.recoverExpiredDispatchStarts(recoveredAt)

    expect(recovered).toEqual({ recovered: 1, dispatchIds: [reserved.id] })
    expect(port.listDispatchReceipts({ taskId: task.id })).toEqual([
      expect.objectContaining({
        id: reserved.id,
        status: 'failed',
        environment: expect.objectContaining({
          id: 'env_dispatch_expired',
          status: 'released',
          cleanup: expect.objectContaining({ state: 'released' }),
        }),
      }),
    ])
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'environment.released',
        subjectId: task.id,
        payload: expect.objectContaining({ dispatchId: reserved.id, environmentId: 'env_dispatch_expired' }),
      }),
      expect.objectContaining({
        type: 'task.dispatch.start_expired',
        subjectId: task.id,
        payload: expect.objectContaining({
          dispatchId: reserved.id,
          environmentRecovery: expect.objectContaining({ eventType: 'environment.released', environmentId: 'env_dispatch_expired' }),
        }),
      }),
    ]))
  })

  it('owns run start, lease renewal, and recovery through the same port', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Lease port roadmap' }, store)
    const task = createWorkTask({ title: 'Run through port', roadmapId: roadmap.id, pipeline: ['implement'] }, store)

    const started = port.startRun(task.id, 'implement', 'ses_port_run', 'implementer', { owner: 'owner-one', leaseMs: 1_000, generation: 'gen-one' })
    const duplicate = port.startRun(task.id, 'implement', 'ses_port_duplicate', 'implementer', { owner: 'owner-two', leaseMs: 1_000, generation: 'gen-two' })

    expect(started).toBeDefined()
    expect(duplicate).toBeUndefined()
    expect(port.summarizeLeases(loadWorkState(store), Date.parse(started!.run.leaseExpiresAt!) + 1)).toMatchObject({ running: 1, expired: 1 })
    expect(port.renewRunLease(started!.run.id, { owner: 'owner-renewed', leaseMs: 60_000, generation: 'gen-renewed' })).toBe(false)
    expect(port.renewRunLease(started!.run.id, { owner: 'owner-one', leaseMs: 60_000, generation: 'gen-one' })).toBe(true)
    const renewed = loadWorkState(store).runs.find(run => run.id === started!.run.id)!
    expect(renewed).toMatchObject({ leaseOwner: 'owner-one', schedulerGeneration: 'gen-one' })

    const recovered = port.recoverExpiredLeases(2, Date.parse(renewed.leaseExpiresAt!) + 1)
    const state = loadWorkState(store)
    expect(recovered).toMatchObject({ recovered: 0, blocked: 1, runIds: [started!.run.id] })
    expect(state.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'blocked', currentStage: undefined, currentRunId: undefined, note: expect.stringContaining('old OpenCode session may still be running') })
    expect(state.runs.find(row => row.id === started!.run.id)).toMatchObject({ status: 'errored', result: expect.objectContaining({ summary: 'Recovered expired scheduler lease' }) })
  })

  it('adopts predecessor run leases so completions are accepted while stale owners stay fenced', () => {
    const port = createSqliteWorkStoreRunLeasePort({ filePath: store })
    const roadmap = createRoadmap({ title: 'Adoption roadmap' }, store)
    const task = createWorkTask({ title: 'Survive a daemon restart', roadmapId: roadmap.id, pipeline: ['implement'] }, store)
    const started = port.startRun(task.id, 'implement', 'ses_adopted', 'implementer', { owner: 'daemon-previous', leaseMs: 60_000, generation: 'gen-previous' })!

    const adopted = port.adoptActiveRunLeases({ owner: 'daemon-restarted', generation: 'gen-restarted', leaseMs: 60_000 })

    expect(adopted).toEqual({ adopted: 1, runIds: [started.run.id] })
    expect(loadWorkState(store).runs[0]).toMatchObject({ leaseOwner: 'daemon-restarted', schedulerGeneration: 'gen-restarted' })
    expect(listWorkEvents(20, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'task.run.lease_adopted',
        subjectId: task.id,
        payload: expect.objectContaining({ runId: started.run.id, previousLeaseOwner: 'daemon-previous', leaseOwner: 'daemon-restarted' }),
      }),
    ]))

    // A genuinely concurrent competitor still presenting the pre-adoption identity stays fenced.
    const fenced = completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'stale pass', artifacts: [], raw: 'stale pass' }, 2, store, {}, { owner: 'daemon-previous', generation: 'gen-previous' })
    expect(fenced).toMatchObject({ applied: false, reason: 'lease_owner_mismatch' })

    // The adopting daemon can accept the predecessor's completed work.
    const completion = completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'predecessor result harvested', artifacts: [], raw: 'pass' }, 2, store, {}, { owner: 'daemon-restarted', generation: 'gen-restarted' })
    expect(completion).toMatchObject({ applied: true })
    expect(loadWorkState(store).runs[0]).toMatchObject({ status: 'passed' })

    // Adoption is idempotent for leases already owned by the current daemon.
    expect(port.adoptActiveRunLeases({ owner: 'daemon-restarted', generation: 'gen-restarted', leaseMs: 60_000 })).toEqual({ adopted: 0, runIds: [] })
  })

})



function envRun(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  return {
    id: 'env_port',
    name: 'local-node',
    backend: 'local-process',
    status: 'prepared',
    specHash: 'run-lease-port',
    workdir: '/tmp/project',
    runtime: process.execPath,
    startedAt: '2026-06-21T20:00:00.000Z',
    updatedAt: '2026-06-21T20:00:00.000Z',
    ttlMs: 3600000,
    cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'pending' },
    resources: { timeoutMs: 3600000 },
    network: { mode: 'restricted' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: ['node'], missing: [], warnings: [], commandRefs: ['command -v node'] },
    artifacts: [],
    metadata: {},
    ...overrides,
  }
}
