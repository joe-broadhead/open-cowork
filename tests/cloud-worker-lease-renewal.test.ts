import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import type { CloudMetricRecord, CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker, CloudWorkerLeaseLostError, CloudWorkerShutdownAbortError } from '@open-cowork/cloud-server/worker'
import type {
  CloudRuntimeAdapter,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'

class AbortAwareRuntime implements CloudRuntimeAdapter {
  readonly promptSignals: AbortSignal[] = []
  readonly abortReasons: unknown[] = []
  readonly messageIds: Array<string | undefined> = []
  readonly abortedSessions: string[] = []

  async createSession() {
    return {
      id: 'oc-session-created',
      title: 'Created session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: {
    sessionId: string
    parts: CloudRuntimePromptPart[]
    agent: string
    messageId?: string
    signal?: AbortSignal
  }) {
    assert.equal(input.sessionId, 'oc-session-1')
    assert.equal(input.parts.find((part) => part.type === 'text')?.text, 'long running prompt')
    assert.ok(input.signal)
    this.promptSignals.push(input.signal)
    this.messageIds.push(input.messageId)
    await new Promise<void>((_resolve, reject) => {
      const signal = input.signal
      if (!signal) {
        reject(new Error('Expected a worker abort signal.'))
        return
      }
      if (signal.aborted) {
        this.abortReasons.push(signal.reason)
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => {
        this.abortReasons.push(signal.reason)
        reject(signal.reason instanceof Error ? signal.reason : new Error('Worker command aborted.'))
      }, { once: true })
    })
  }

  async abortSession(input: { sessionId: string }) {
    this.abortedSessions.push(input.sessionId)
  }
}

class SlowSuccessfulRuntime implements CloudRuntimeAdapter {
  readonly messageIds: Array<string | undefined> = []
  private readonly delayMs: number

  constructor(delayMs = 1_100) {
    this.delayMs = delayMs
  }

  async createSession() {
    return {
      id: 'oc-session-created',
      title: 'Created session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(input: {
    sessionId: string
    parts: CloudRuntimePromptPart[]
    agent: string
    messageId?: string
    signal?: AbortSignal
  }) {
    this.messageIds.push(input.messageId)
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    return {
      events: [{
        type: 'assistant.message',
        payload: {
          messageId: `${input.sessionId}:assistant`,
          content: 'done',
        },
      }, {
        type: 'session.idle',
        payload: {
          sessionId: input.sessionId,
        },
      }],
    }
  }

  async abortSession() {}
}

class FailingRenewalMetricObservability implements CloudObservabilityAdapter {
  metricNames: string[] = []

  async log() {}

  async metric(record: { name: string }) {
    this.metricNames.push(record.name)
    if (record.name === 'open_cowork_cloud_worker_lease_renewals_total') {
      throw new Error('simulated renewal metric failure')
    }
  }

  async span() {}
}

class RecordingObservability implements CloudObservabilityAdapter {
  readonly metrics: CloudMetricRecord[] = []

  async log() {}

  async metric(record: CloudMetricRecord) {
    this.metrics.push(record)
  }

  async span() {}
}

function seedStore() {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.com',
    role: 'owner',
  })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    opencodeSessionId: 'oc-session-1',
    profileName: 'default',
  })
  store.enqueueSessionCommand({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    commandId: 'cmd-1',
    kind: 'prompt',
    payload: { text: 'long running prompt', agent: 'build' },
  })
  return store
}

test('cloud worker aborts active command when session lease renewal is lost', async () => {
  const store = seedStore()
  const runtime = new AbortAwareRuntime()
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const worker = new CloudWorker(store, service, 'worker-1', 3_000)

  const originalRenewSessionLease = store.renewSessionLease.bind(store)
  const originalCheckpointSession = store.checkpointSession.bind(store)
  let renewAttempts = 0
  let checkpointAttempts = 0
  store.renewSessionLease = (lease, now, ttlMs) => {
    renewAttempts += 1
    throw new Error(`simulated renewal loss for ${lease.leaseToken}:${now?.toISOString()}:${ttlMs}`)
  }
  store.checkpointSession = (lease) => {
    checkpointAttempts += 1
    return originalCheckpointSession(lease)
  }

  await assert.rejects(
    () => worker.processSessionCommands('tenant-1', 'session-1'),
    CloudWorkerLeaseLostError,
  )

  assert.equal(renewAttempts, 1)
  assert.equal(checkpointAttempts, 0)
  assert.equal(runtime.promptSignals.length, 1)
  assert.deepEqual(runtime.messageIds, ['cmd-1'])
  assert.equal(runtime.promptSignals[0]?.aborted, true)
  assert.equal(runtime.abortReasons[0] instanceof CloudWorkerLeaseLostError, true)
  assert.deepEqual(runtime.abortedSessions, ['oc-session-1'])

  store.renewSessionLease = originalRenewSessionLease
  const recoveryNow = new Date(Date.now() + 60_000)
  const reaped = store.reapExpiredSessionLeases({ now: recoveryNow })
  assert.deepEqual(reaped.map((entry) => entry.retriedCommandIds), [['cmd-1']])

  const nextLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-2', recoveryNow)
  assert.ok(nextLease)
  const reclaimed = store.claimNextSessionCommand(nextLease, recoveryNow)
  assert.equal(reclaimed?.commandId, 'cmd-1')
  assert.equal(reclaimed?.status, 'running')
  assert.equal(reclaimed?.attemptCount, 2)
})

test('cloud worker shutdown aborts active prompt work and recovers the command lease', async () => {
  const store = seedStore()
  const runtime = new AbortAwareRuntime()
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const observability = new RecordingObservability()
  const worker = new CloudWorker(store, service, 'worker-1', 3_000, {}, null, observability)
  const run = worker.processSessionCommands('tenant-1', 'session-1')

  while (runtime.promptSignals.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const shutdown = await worker.completeShutdown({
    drained: false,
    now: new Date('2030-01-01T00:00:10.000Z'),
  })

  await assert.rejects(() => run, CloudWorkerShutdownAbortError)
  assert.equal(shutdown.drainStatus, 'forced')
  assert.equal(shutdown.activeAbortCount, 1)
  assert.equal(shutdown.recoveredLeaseCount, 1)
  assert.equal(shutdown.retriedCommandCount, 1)
  assert.equal(runtime.promptSignals[0]?.aborted, true)
  assert.equal(runtime.abortReasons[0] instanceof CloudWorkerShutdownAbortError, true)
  assert.deepEqual(runtime.abortedSessions, ['oc-session-1'])
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_shutdown_drains_total' && metric.attributes?.status === 'forced'),
    true,
  )
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_shutdown_forced_aborts_total' && metric.value === 1),
    true,
  )
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_shutdown_leases_recovered_total' && metric.attributes?.status === 'retried'),
    true,
  )

  const nextLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-2', new Date('2030-01-01T00:00:11.000Z'))
  assert.ok(nextLease)
  const reclaimed = store.claimNextSessionCommand(nextLease, new Date('2030-01-01T00:00:11.000Z'))
  assert.equal(reclaimed?.commandId, 'cmd-1')
  assert.equal(reclaimed?.attemptCount, 2)
})

test('cloud worker shutdown recovers a command stuck during checkpoint save', async () => {
  const store = seedStore()
  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const observability = new RecordingObservability()
  let saveStarted!: () => void
  let releaseSave!: () => void
  const saveStartedPromise = new Promise<void>((resolve) => {
    saveStarted = resolve
  })
  const releaseSavePromise = new Promise<void>((resolve) => {
    releaseSave = resolve
  })
  const worker = new CloudWorker(
    store,
    service,
    'worker-1',
    3_000,
    {
      saveAfterCommand: async () => {
        saveStarted()
        await releaseSavePromise
      },
    },
    null,
    observability,
  )
  const run = worker.processSessionCommands('tenant-1', 'session-1')
  await saveStartedPromise

  const shutdown = await worker.completeShutdown({
    drained: false,
    now: new Date('2030-01-01T00:00:10.000Z'),
  })
  releaseSave()

  await assert.rejects(() => run, /Worker lease is stale/)
  assert.equal(shutdown.drainStatus, 'forced')
  assert.equal(shutdown.activeAbortCount, 1)
  assert.equal(shutdown.recoveredLeaseCount, 1)
  assert.equal(shutdown.retriedCommandCount, 1)
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_shutdown_leases_recovered_total' && metric.attributes?.status === 'retried'),
    true,
  )

  const nextLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-2', new Date('2030-01-01T00:00:11.000Z'))
  assert.ok(nextLease)
  const reclaimed = store.claimNextSessionCommand(nextLease, new Date('2030-01-01T00:00:11.000Z'))
  assert.equal(reclaimed?.commandId, 'cmd-1')
  assert.equal(reclaimed?.attemptCount, 2)
})

test('cloud worker does not treat renewal metric failures as lease loss', async () => {
  const store = seedStore()
  const runtime = new SlowSuccessfulRuntime()
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const observability = new FailingRenewalMetricObservability()
  const worker = new CloudWorker(store, service, 'worker-1', 3_000, {}, null, observability)

  await assert.doesNotReject(() => worker.processSessionCommands('tenant-1', 'session-1'))
  assert.deepEqual(runtime.messageIds, ['cmd-1'])
  assert.equal(observability.metricNames.includes('open_cowork_cloud_worker_lease_renewals_total'), true)

  const lease = store.claimSessionLease('tenant-1', 'session-1', 'worker-2', new Date(Date.now() + 60_000))
  assert.ok(lease)
  assert.equal(store.claimNextSessionCommand(lease, new Date(Date.now() + 60_000)), null)
})

test('cloud worker saves checkpoint before atomically acking and completing a command', async () => {
  const store = seedStore()
  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const order: string[] = []
  const originalRecordExecution = service.recordManagedExecutionEvent.bind(service)
  service.recordManagedExecutionEvent = (async (input) => {
    order.push(input.eventType)
    return originalRecordExecution(input)
  }) as typeof service.recordManagedExecutionEvent
  const originalCheckpointAndAck = store.checkpointAndAckSessionCommand.bind(store)
  store.checkpointAndAckSessionCommand = ((lease, commandId, now) => {
    order.push('checkpointAndAck')
    return originalCheckpointAndAck(lease, commandId, now)
  }) as typeof store.checkpointAndAckSessionCommand
  const worker = new CloudWorker(
    store,
    service,
    'worker-1',
    3_000,
    {
      saveAfterCommand: async (lease) => {
        order.push(`save:${lease.checkpointVersion}`)
      },
    },
  )

  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 1)
  assert.deepEqual(order, [
    'worker.execution_started',
    'save:1',
    'checkpointAndAck',
    'worker.execution_completed',
  ])
  assert.deepEqual(runtime.messageIds, ['cmd-1'])

  const nextLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-2', new Date(Date.now() + 60_000))
  assert.ok(nextLease)
  assert.equal(store.claimNextSessionCommand(nextLease, new Date(Date.now() + 60_000)), null)
})

test('cloud worker leaves a command retryable when checkpoint save fails before ack', async () => {
  const store = seedStore()
  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const order: string[] = []
  const originalRecordExecution = service.recordManagedExecutionEvent.bind(service)
  service.recordManagedExecutionEvent = (async (input) => {
    order.push(input.eventType)
    return originalRecordExecution(input)
  }) as typeof service.recordManagedExecutionEvent
  const observability = new RecordingObservability()
  const originalCheckpointAndAck = store.checkpointAndAckSessionCommand.bind(store)
  let checkpointAndAckCalls = 0
  store.checkpointAndAckSessionCommand = ((lease, commandId, now) => {
    checkpointAndAckCalls += 1
    return originalCheckpointAndAck(lease, commandId, now)
  }) as typeof store.checkpointAndAckSessionCommand
  const worker = new CloudWorker(
    store,
    service,
    'worker-1',
    3_000,
    {
      saveAfterCommand: async () => {
        throw new Error('checkpoint save failed')
      },
    },
    null,
    observability,
  )

  await assert.rejects(
    () => worker.processSessionCommands('tenant-1', 'session-1'),
    /checkpoint save failed/,
  )
  assert.equal(checkpointAndAckCalls, 0)
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_checkpoint_pending_command_failures_total'),
    true,
  )
  assert.deepEqual(order, ['worker.execution_started', 'worker.execution_failed'])

  const recoveryNow = new Date(Date.now() + 60_000)
  const reaped = store.reapExpiredSessionLeases({ now: recoveryNow })
  assert.deepEqual(reaped.map((entry) => entry.retriedCommandIds), [['cmd-1']])
  const nextLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-2', recoveryNow)
  assert.ok(nextLease)
  const reclaimed = store.claimNextSessionCommand(nextLease, recoveryNow)
  assert.equal(reclaimed?.commandId, 'cmd-1')
  assert.equal(reclaimed?.attemptCount, 2)
})

test('cloud worker keeps a valid cached lease when cached renewal metrics fail', async () => {
  const store = seedStore()
  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const observability = new FailingRenewalMetricObservability()
  const worker = new CloudWorker(store, service, 'worker-1', 3_000, {}, null, observability)

  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 1)
  store.enqueueSessionCommand({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    commandId: 'cmd-2',
    kind: 'prompt',
    payload: { text: 'second prompt', agent: 'build' },
  })

  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 1)
  assert.deepEqual(runtime.messageIds, ['cmd-1', 'cmd-2'])
  assert.equal(observability.metricNames.includes('open_cowork_cloud_worker_lease_renewals_total'), true)
})

test('cloud worker refreshes stale checkpoint leases advanced by runtime events', async () => {
  const store = seedStore()
  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const observability = new RecordingObservability()
  const worker = new CloudWorker(store, service, 'worker-1', 3_000, {}, null, observability)
  const originalCheckpointSession = store.checkpointSession.bind(store)
  const originalCheckpointAndAck = store.checkpointAndAckSessionCommand.bind(store)
  const originalRenewSessionLease = store.renewSessionLease.bind(store)
  let checkpointAndAckAttempts = 0
  let renewAttempts = 0

  store.checkpointAndAckSessionCommand = ((lease, commandId, now) => {
    checkpointAndAckAttempts += 1
    if (checkpointAndAckAttempts === 1) {
      originalCheckpointSession(lease)
      throw new Error('Checkpoint version is stale.')
    }
    return originalCheckpointAndAck(lease, commandId, now)
  }) as typeof store.checkpointAndAckSessionCommand
  store.renewSessionLease = (lease, now, ttlMs) => {
    renewAttempts += 1
    return originalRenewSessionLease(lease, now, ttlMs)
  }

  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 1)
  assert.equal(checkpointAndAckAttempts, 2)
  assert.equal(renewAttempts, 1)
  assert.deepEqual(runtime.messageIds, ['cmd-1'])
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_checkpoint_stale_retries_total'),
    true,
  )
})

test('cloud worker reaps expired leases in bounded batches and reports drain cap hits', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.com',
    role: 'owner',
  })
  for (let index = 0; index < 1_001; index += 1) {
    const sessionId = `expired-session-${String(index).padStart(3, '0')}`
    store.createSession({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId,
      opencodeSessionId: `oc-${sessionId}`,
      profileName: 'default',
    })
    assert.ok(store.claimSessionLease('tenant-1', sessionId, 'stale-worker', new Date('2000-01-01T00:00:00.000Z'), 1))
  }

  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(
    store,
    runtime,
    resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    undefined,
    { randomUUID: () => 'test-id' },
  )
  const observability = new RecordingObservability()
  const worker = new CloudWorker(store, service, 'worker-1', 3_000, {}, null, observability)

  assert.equal(await worker.processAllSessionCommands(), 0)
  const reapedMetric = observability.metrics.find((metric) => metric.name === 'open_cowork_cloud_worker_expired_leases_reaped_total')
  assert.equal(reapedMetric?.value, 1_000)
  const capHitMetric = observability.metrics.find((metric) => metric.name === 'open_cowork_cloud_worker_expired_lease_reaper_drain_cap_hits_total')
  assert.equal(capHitMetric?.value, 1)
  assert.equal(capHitMetric?.attributes?.status, 'cap_hit')
})

test('cloud worker LRU-evicts idle leases so the cache stays bounded (#908)', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.com', role: 'owner' })
  const sessions = ['session-1', 'session-2', 'session-3']
  for (const sessionId of sessions) {
    store.createSession({ tenantId: 'tenant-1', userId: 'user-1', sessionId, opencodeSessionId: `oc-${sessionId}`, profileName: 'default' })
    store.enqueueSessionCommand({ tenantId: 'tenant-1', userId: 'user-1', sessionId, commandId: `${sessionId}-cmd-1`, kind: 'prompt', payload: { text: 'p', agent: 'build' } })
  }

  const claimCounts = new Map<string, number>()
  const originalClaim = store.claimSessionLease.bind(store)
  store.claimSessionLease = ((...args: Parameters<typeof store.claimSessionLease>) => {
    claimCounts.set(args[1], (claimCounts.get(args[1]) ?? 0) + 1)
    return originalClaim(...args)
  }) as typeof store.claimSessionLease

  const runtime = new SlowSuccessfulRuntime(0)
  const service = new CloudSessionService(store, runtime, resolveCloudRuntimePolicy(DEFAULT_CONFIG), undefined, { randomUUID: () => 'test-id' })
  // maxLeases: 2 → after three distinct sessions, the least-recently-touched (session-1) is evicted.
  const worker = new CloudWorker(store, service, 'worker-1', 3_000, {}, null, null, { maxLeases: 2 })

  for (const sessionId of sessions) {
    assert.equal(await worker.processSessionCommands('tenant-1', sessionId), 1)
  }
  assert.deepEqual(sessions.map((sessionId) => claimCounts.get(sessionId)), [1, 1, 1])

  // session-1 (least-recently-touched) was evicted from the in-memory cache. It therefore has no
  // cached lease to renew, and can't re-claim while its server-side lease is still valid — so it
  // attempts a fresh claim (proving it is no longer cached) and processes nothing this tick; its
  // command is retried after the lease expires and is reaped. A cache that had NOT evicted it would
  // have renewed and returned 1.
  store.enqueueSessionCommand({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', commandId: 'session-1-cmd-2', kind: 'prompt', payload: { text: 'p', agent: 'build' } })
  assert.equal(await worker.processSessionCommands('tenant-1', 'session-1'), 0)
  assert.equal(claimCounts.get('session-1'), 2)

  // A still-cached session renews (no fresh claim) and processes normally.
  store.enqueueSessionCommand({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-3', commandId: 'session-3-cmd-2', kind: 'prompt', payload: { text: 'p', agent: 'build' } })
  assert.equal(await worker.processSessionCommands('tenant-1', 'session-3'), 1)
  assert.equal(claimCounts.get('session-3'), 1)
})
