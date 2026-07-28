import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { createByokSecretStore } from '@open-cowork/cloud-server/byok-secret-store'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import {
  CloudExecutionCleanupDebtError,
  CloudExecutionIsolationError,
  developmentProcessIsolationCapability,
} from '@open-cowork/cloud-server/execution-isolation'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import {
  createPrometheusCloudObservability,
  type CloudMetricRecord,
  type CloudObservabilityAdapter,
} from '@open-cowork/cloud-server/observability'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'
import type { CloudRuntimeAdapter } from '@open-cowork/cloud-server/runtime-adapter'
import { createEnvelopeSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import {
  CloudRuntimeCapacityError,
  createWorkerScopedRuntimeAdapter,
  type WorkerScopedRuntimeAdapterOptions,
} from '@open-cowork/cloud-server/worker-scoped-runtime-adapter'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function runtimeContext(sessionId: string) {
  return { tenantId: 'tenant-a', sessionId }
}

function prompt(runtime: CloudRuntimeAdapter, sessionId: string, signal?: AbortSignal) {
  return runtime.promptSession({
    sessionId: `native-${sessionId}`,
    parts: [],
    agent: 'build',
    context: runtimeContext(sessionId),
    signal,
  })
}

function runtimeFixture(
  root: string,
  options: Pick<
    WorkerScopedRuntimeAdapterOptions,
    | 'runtimeFactory'
    | 'observability'
    | 'maxRuntimeEntries'
    | 'maxAdmissionQueueEntries'
    | 'admissionQueueTimeoutMs'
    | 'runtimeProvisionTimeoutMs'
    | 'runtimeTeardownTimeoutMs'
    | 'isolationProvider'
  >,
) {
  const store = new InMemoryControlPlaneStore()
  store.ensureOrgForTenant({ tenantId: 'tenant-a', name: 'Tenant A' })
  return createWorkerScopedRuntimeAdapter({
    paths: createCloudPathProvider(root),
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
      OPEN_COWORK_CLOUD_ROLE: 'worker',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
    }),
    env: {},
    config: DEFAULT_CONFIG,
    byokSecrets: createByokSecretStore(
      store,
      createEnvelopeSecretAdapter('runtime-admission-test-key'),
    ),
    runtimeIdleTtlMs: 60_000,
    ...options,
  })
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, message)
}

function spawnMeasuredRuntimeProcess(): Promise<{ child: ChildProcess; rssBytes: number }> {
  const child = spawn(process.execPath, [
    '--max-old-space-size=32',
    '-e',
    [
      'const held = Buffer.alloc(2 * 1024 * 1024, 1)',
      'process.send?.({ rssBytes: process.memoryUsage().rss })',
      'setInterval(() => void held, 1000)',
    ].join(';'),
  ], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      child.kill()
      reject(new Error('measured runtime process did not report readiness'))
    }, 5_000)
    timeout.unref?.()
    const onMessage = (message: unknown) => {
      const rssBytes = Number((message as { rssBytes?: unknown })?.rssBytes)
      if (!Number.isFinite(rssBytes) || rssBytes <= 0) return
      cleanup()
      resolve({ child, rssBytes })
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(`measured runtime process exited before readiness (${code ?? signal})`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function stopMeasuredRuntimeProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  child.kill()
  await exited
}

test('runtime admission coalesces one session and never exceeds the hard cap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-cap-'))
  const provisionA = deferred()
  const promptsA = deferred()
  const factorySessions: string[] = []
  let liveRuntimes = 0
  let maxLiveRuntimes = 0
  let promptACount = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 2,
    admissionQueueTimeoutMs: 1_000,
    async runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      if (input.execution.sessionId === 'session-a') await provisionA.promise
      liveRuntimes += 1
      maxLiveRuntimes = Math.max(maxLiveRuntimes, liveRuntimes)
      return {
        async promptSession() {
          if (input.execution.sessionId === 'session-a') {
            promptACount += 1
            await promptsA.promise
          }
        },
        async abortSession() {},
        async close() {
          liveRuntimes -= 1
        },
      }
    },
  })

  try {
    const firstA = prompt(runtime, 'session-a')
    const secondA = prompt(runtime, 'session-a')
    await waitFor(() => factorySessions.length === 1, 'session-a provisioning did not start')
    const queuedB = prompt(runtime, 'session-b')

    assert.deepEqual(factorySessions, ['session-a'])
    provisionA.resolve()
    await waitFor(() => promptACount === 2, 'coalesced session-a calls did not share the runtime')
    assert.deepEqual(factorySessions, ['session-a'])

    promptsA.resolve()
    await Promise.all([firstA, secondA, queuedB])
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])
    assert.equal(maxLiveRuntimes, 1)
  } finally {
    provisionA.resolve()
    promptsA.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('cache-hit acquisition keeps the runtime claimed across awaited telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-cache-hit-claim-'))
  const cacheHitMetricStarted = deferred()
  const releaseCacheHitMetric = deferred()
  const cacheHitPromptStarted = deferred()
  const releaseCacheHitPrompt = deferred()
  const sessionAClosed = deferred()
  const factorySessions: string[] = []
  const closedSessions: string[] = []
  let blockCacheHitMetric = false
  let sessionAPromptCount = 0
  let cacheHit: Promise<unknown> | null = null
  let queued: Promise<unknown> | null = null
  const observability: CloudObservabilityAdapter = {
    log() {},
    async metric(record) {
      if (
        blockCacheHitMetric
        && record.name === 'open_cowork_cloud_runtime_cache_hits_total'
      ) {
        blockCacheHitMetric = false
        cacheHitMetricStarted.resolve()
        await releaseCacheHitMetric.promise
      }
    },
    span() {},
  }
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    observability,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      return {
        async promptSession() {
          if (input.execution.sessionId !== 'session-a') return
          sessionAPromptCount += 1
          if (sessionAPromptCount === 2) {
            cacheHitPromptStarted.resolve()
            await releaseCacheHitPrompt.promise
          }
        },
        async abortSession() {},
        async close() {
          closedSessions.push(input.execution.sessionId)
          if (input.execution.sessionId === 'session-a') sessionAClosed.resolve()
        },
      }
    },
  })

  try {
    await prompt(runtime, 'session-a')
    blockCacheHitMetric = true
    cacheHit = prompt(runtime, 'session-a')
    await cacheHitMetricStarted.promise

    queued = prompt(runtime, 'session-b')
    const acquisitionOutcome = await Promise.race([
      sessionAClosed.promise.then(() => 'closed' as const),
      new Promise<'claimed'>((resolve) => setImmediate(() => resolve('claimed'))),
    ])
    assert.equal(acquisitionOutcome, 'claimed')
    assert.deepEqual(factorySessions, ['session-a'])

    releaseCacheHitMetric.resolve()
    await cacheHitPromptStarted.promise
    assert.deepEqual(factorySessions, ['session-a'])

    releaseCacheHitPrompt.resolve()
    await Promise.all([cacheHit, queued])
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])
    assert.equal(closedSessions.filter((sessionId) => sessionId === 'session-a').length, 1)
  } finally {
    releaseCacheHitMetric.resolve()
    releaseCacheHitPrompt.resolve()
    await Promise.allSettled([cacheHit, queued].filter(Boolean) as Promise<unknown>[])
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('new runtime acquisition stays claimed across awaited creation telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-new-entry-claim-'))
  const creationMetricStarted = deferred()
  const releaseCreationMetric = deferred()
  const factorySessions: string[] = []
  const closedSessions: string[] = []
  let blockCreationMetric = true
  let first: Promise<unknown> | null = null
  let contender: Promise<unknown> | null = null
  const observability: CloudObservabilityAdapter = {
    log() {},
    async metric(record) {
      if (
        blockCreationMetric
        && record.name === 'open_cowork_cloud_runtime_creation_duration_ms'
        && record.attributes?.status === 'ok'
      ) {
        blockCreationMetric = false
        creationMetricStarted.resolve()
        await releaseCreationMetric.promise
      }
    },
    span() {},
  }
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    observability,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closedSessions.push(input.execution.sessionId)
        },
      }
    },
  })

  try {
    first = prompt(runtime, 'session-a')
    await creationMetricStarted.promise

    contender = prompt(runtime, 'session-b')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(factorySessions, ['session-a'])
    assert.deepEqual(closedSessions, [])

    releaseCreationMetric.resolve()
    await Promise.all([first, contender])
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])
    assert.equal(closedSessions.filter((sessionId) => sessionId === 'session-a').length, 1)
  } finally {
    releaseCreationMetric.resolve()
    await Promise.allSettled([first, contender].filter(Boolean) as Promise<unknown>[])
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('last waiter cancellation after publication relinquishes its runtime claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-publication-cancel-'))
  const controller = new AbortController()
  const factorySessions: string[] = []
  const closedSessions: string[] = []
  let abortOnPublishedState = false
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric(record) {
      if (
        record.name === 'open_cowork_cloud_runtime_creation_duration_ms'
        && record.attributes?.status === 'ok'
      ) {
        abortOnPublishedState = true
        return
      }
      if (
        abortOnPublishedState
        && record.name === 'open_cowork_cloud_runtime_capacity_in_use'
      ) {
        abortOnPublishedState = false
        controller.abort()
      }
    },
    span() {},
  }
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 50,
    runtimeTeardownTimeoutMs: 50,
    observability,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closedSessions.push(input.execution.sessionId)
        },
      }
    },
  })

  try {
    await assert.rejects(
      () => prompt(runtime, 'session-a', controller.signal),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )
    await assert.doesNotReject(() => prompt(runtime, 'session-b'))
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])
    assert.equal(closedSessions.filter((sessionId) => sessionId === 'session-a').length, 1)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('coalesced runtime provisioning gives each waiter independent cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-coalesced-abort-'))
  const factoryGate = deferred()
  const firstController = new AbortController()
  let factoryCalls = 0
  let closed = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    async runtimeFactory() {
      factoryCalls += 1
      await factoryGate.promise
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })

  try {
    const cancelled = prompt(runtime, 'session-a', firstController.signal)
    await waitFor(() => factoryCalls === 1, 'shared runtime creation did not start')
    const survivor = prompt(runtime, 'session-a')
    await new Promise((resolve) => setImmediate(resolve))

    firstController.abort()
    const cancellationOutcome = await Promise.race([
      cancelled.then(
        () => 'fulfilled',
        (error: unknown) => (
          error instanceof DOMException && error.name === 'AbortError'
            ? 'aborted'
            : 'unexpected-error'
        ),
      ),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ])
    assert.equal(cancellationOutcome, 'aborted')
    assert.equal(factoryCalls, 1)
    assert.equal(closed, 0)

    factoryGate.resolve()
    await assert.doesNotReject(() => survivor)
    assert.equal(factoryCalls, 1)
  } finally {
    factoryGate.resolve()
    await runtime.close?.()
    assert.equal(closed, 1)
    rmSync(root, { recursive: true, force: true })
  }
})

test('coalesced waiter registers before awaited cache-hit telemetry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-coalesced-metric-abort-'))
  const factoryGate = deferred()
  const provisioningMetricStarted = deferred()
  const releaseProvisioningMetric = deferred()
  const firstController = new AbortController()
  let factoryCalls = 0
  let blockProvisioningMetric = true
  const observability: CloudObservabilityAdapter = {
    log() {},
    async metric(record) {
      if (
        blockProvisioningMetric
        && record.name === 'open_cowork_cloud_runtime_cache_hits_total'
        && record.attributes?.state === 'provisioning'
      ) {
        blockProvisioningMetric = false
        provisioningMetricStarted.resolve()
        await releaseProvisioningMetric.promise
      }
    },
    span() {},
  }
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    observability,
    async runtimeFactory() {
      factoryCalls += 1
      await factoryGate.promise
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {},
      }
    },
  })

  try {
    const cancelled = prompt(runtime, 'session-a', firstController.signal)
    await waitFor(() => factoryCalls === 1, 'shared runtime creation did not start')
    const survivor = prompt(runtime, 'session-a')
    await provisioningMetricStarted.promise

    firstController.abort()
    await assert.rejects(
      () => cancelled,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )

    releaseProvisioningMetric.resolve()
    factoryGate.resolve()
    await assert.doesNotReject(() => survivor)
    assert.equal(factoryCalls, 1)
  } finally {
    releaseProvisioningMetric.resolve()
    factoryGate.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime admission queue is bounded, retryable, and releases cancelled waiters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-queue-'))
  const activePrompt = deferred()
  const factorySessions: string[] = []
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      return {
        async promptSession() {
          if (input.execution.sessionId === 'session-a') await activePrompt.promise
        },
        async abortSession() {},
        async close() {},
      }
    },
  })

  try {
    const active = prompt(runtime, 'session-a')
    await waitFor(() => factorySessions.length === 1, 'session-a did not become active')

    const controller = new AbortController()
    const cancelled = prompt(runtime, 'session-b', controller.signal)
    await assert.rejects(
      () => prompt(runtime, 'session-c'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.code === 'cloud_runtime_capacity_exhausted'
        && error.retryable
        && error.retryAfterMs > 0
        && error.reason === 'queue_full'
      ),
    )

    controller.abort()
    await assert.rejects(cancelled, (error: unknown) => (
      error instanceof DOMException && error.name === 'AbortError'
    ))

    const recovered = prompt(runtime, 'session-c')
    activePrompt.resolve()
    await Promise.all([active, recovered])
    assert.deepEqual(factorySessions, ['session-a', 'session-c'])
  } finally {
    activePrompt.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancellation during idle eviction does not leave an admission waiter behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-eviction-abort-'))
  const closeStarted = deferred()
  const closeGate = deferred()
  const cancelledController = new AbortController()
  const contenderController = new AbortController()
  let cancelled: Promise<unknown> | null = null
  let contender: Promise<unknown> | null = null
  let closeAttempts = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory(input) {
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          if (input.execution.sessionId !== 'session-a') return
          closeAttempts += 1
          closeStarted.resolve()
          await closeGate.promise
          throw new Error('synthetic idle eviction cleanup failure')
        },
      }
    },
  })

  try {
    await prompt(runtime, 'session-a')
    cancelled = prompt(runtime, 'session-b', cancelledController.signal)
    await closeStarted.promise

    cancelledController.abort()
    await assert.rejects(cancelled, (error: unknown) => (
      error instanceof DOMException && error.name === 'AbortError'
    ))
    closeGate.resolve()
    await new Promise((resolve) => setImmediate(resolve))

    contender = prompt(runtime, 'session-c', contenderController.signal)
    const contenderOutcome = await Promise.race([
      contender.then(
        () => 'fulfilled',
        (error: unknown) => (
          error instanceof CloudRuntimeCapacityError
            ? error.reason
            : 'rejected'
        ),
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ])
    assert.equal(contenderOutcome, 'cleanup_pending')

    contenderController.abort()
    await assert.rejects(contender, CloudRuntimeCapacityError)
    assert.equal(closeAttempts, 1)
  } finally {
    cancelledController.abort()
    contenderController.abort()
    closeGate.resolve()
    await Promise.allSettled([cancelled, contender].filter(Boolean) as Promise<unknown>[])
    await assert.rejects(() => runtime.close!(), (error: unknown) => (
      error instanceof CloudExecutionIsolationError
      && error.reasonCode === 'sandbox_runtime_teardown_failed'
    ))
    rmSync(root, { recursive: true, force: true })
  }
})

test('timed-out admission leaves no queue or permit residue and can retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-timeout-'))
  const activePrompt = deferred()
  const factorySessions: string[] = []
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 20,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      return {
        async promptSession() {
          if (input.execution.sessionId === 'session-a') await activePrompt.promise
        },
        async abortSession() {},
        async close() {},
      }
    },
  })

  try {
    const active = prompt(runtime, 'session-a')
    await waitFor(() => factorySessions.length === 1, 'session-a did not become active')
    const timedOut = prompt(runtime, 'session-b')
    const timedOutAssertion = assert.rejects(
      timedOut,
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'queue_timeout'
        && error.retryable
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    await timedOutAssertion

    activePrompt.resolve()
    await active
    await assert.doesNotReject(() => prompt(runtime, 'session-b'))
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])
  } finally {
    activePrompt.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('failed creation releases its permit for the next session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-failure-'))
  const factorySessions: string[] = []
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      if (input.execution.sessionId === 'session-a') {
        throw new Error('synthetic creation failure')
      }
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {},
      }
    },
  })

  try {
    await assert.rejects(() => prompt(runtime, 'session-a'), /synthetic creation failure/)
    await assert.doesNotReject(() => prompt(runtime, 'session-b'))
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('cancelling in-flight creation closes its boundary and releases the permit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-create-abort-'))
  const factoryGate = deferred()
  const controller = new AbortController()
  let factoryCalls = 0
  let closed = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    async runtimeFactory() {
      factoryCalls += 1
      if (factoryCalls === 1) await factoryGate.promise
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })

  try {
    const cancelled = prompt(runtime, 'session-a', controller.signal)
    await waitFor(() => factoryCalls === 1, 'cancelled runtime creation did not start')
    controller.abort()
    factoryGate.resolve()
    await assert.rejects(cancelled, (error: unknown) => (
      error instanceof DOMException && error.name === 'AbortError'
    ))
    assert.equal(closed, 1)

    await assert.doesNotReject(() => prompt(runtime, 'session-b'))
    assert.equal(factoryCalls, 2)
  } finally {
    factoryGate.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-key retry fast-fails while an aborted provision generation finishes cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-create-abort-retry-'))
  const firstFactoryStarted = deferred()
  const releaseFirstFactory = deferred()
  const controller = new AbortController()
  let factoryCalls = 0
  let liveAllocations = 0
  let maxLiveAllocations = 0
  let retry: Promise<unknown> | null = null
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 2,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    async runtimeFactory() {
      factoryCalls += 1
      liveAllocations += 1
      maxLiveAllocations = Math.max(maxLiveAllocations, liveAllocations)
      if (factoryCalls === 1) {
        firstFactoryStarted.resolve()
        await releaseFirstFactory.promise
      }
      let closed = false
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          if (closed) return
          closed = true
          liveAllocations -= 1
        },
      }
    },
  })

  try {
    const cancelled = prompt(runtime, 'session-a', controller.signal)
    await firstFactoryStarted.promise
    controller.abort()
    await assert.rejects(
      cancelled,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )

    await assert.rejects(
      () => prompt(runtime, 'session-a'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )
    assert.equal(factoryCalls, 1)
    assert.equal(liveAllocations, 1)

    releaseFirstFactory.resolve()
    await waitFor(
      () => liveAllocations === 0,
      'the aborted runtime generation did not finish cleanup',
    )
    retry = prompt(runtime, 'session-a')
    await retry
    assert.equal(factoryCalls, 2)
    assert.equal(maxLiveAllocations, 1)
  } finally {
    releaseFirstFactory.resolve()
    await Promise.allSettled([retry].filter(Boolean) as Promise<unknown>[])
    await runtime.close?.()
    assert.equal(liveAllocations, 0)
    rmSync(root, { recursive: true, force: true })
  }
})

test('adapter disposal rejects queued admission and releases every runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-dispose-'))
  const activePrompt = deferred()
  let closed = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 60_000,
    runtimeFactory(input) {
      return {
        async promptSession() {
          if (input.execution.sessionId === 'session-a') await activePrompt.promise
        },
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })

  try {
    const active = prompt(runtime, 'session-a')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const queued = prompt(runtime, 'session-b')
    const close = runtime.close!()

    await assert.rejects(queued, (error: unknown) => (
      error instanceof CloudRuntimeCapacityError
      && error.reason === 'adapter_closing'
      && error.retryable
    ))
    activePrompt.resolve()
    await active
    await close
    assert.equal(closed, 1)
  } finally {
    activePrompt.resolve()
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime admission preserves FIFO order while one dispatcher evicts an idle boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-fifo-'))
  const closeStarted = deferred()
  const closeGate = deferred()
  const promptBGate = deferred()
  const factorySessions: string[] = []
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 2,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory(input) {
      factorySessions.push(input.execution.sessionId)
      return {
        async promptSession() {
          if (input.execution.sessionId === 'session-b') await promptBGate.promise
        },
        async abortSession() {},
        async close() {
          if (input.execution.sessionId === 'session-a') {
            closeStarted.resolve()
            await closeGate.promise
          }
        },
      }
    },
  })

  try {
    await prompt(runtime, 'session-a')
    const firstWaiter = prompt(runtime, 'session-b')
    await closeStarted.promise
    const secondWaiter = prompt(runtime, 'session-c')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(factorySessions, ['session-a'])

    closeGate.resolve()
    await waitFor(
      () => factorySessions.includes('session-b'),
      'the FIFO head did not receive the evicted runtime permit',
    )
    assert.deepEqual(factorySessions, ['session-a', 'session-b'])

    promptBGate.resolve()
    await Promise.all([firstWaiter, secondWaiter])
    assert.deepEqual(factorySessions, ['session-a', 'session-b', 'session-c'])
  } finally {
    closeGate.resolve()
    promptBGate.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('provision timeout is retryable and releases the permit when the factory observes cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-provision-timeout-'))
  let factoryCalls = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeProvisionTimeoutMs: 20,
    runtimeFactory(input) {
      factoryCalls += 1
      if (factoryCalls > 1) {
        return {
          async promptSession() {},
          async abortSession() {},
          async close() {},
        }
      }
      return new Promise((_, reject) => {
        const signal = input.signal!
        const rejectAborted = () => reject(signal.reason)
        signal.addEventListener('abort', rejectAborted, { once: true })
        if (signal.aborted) rejectAborted()
      })
    },
  })

  try {
    await assert.rejects(
      () => prompt(runtime, 'session-a'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'provision_timeout'
        && error.retryable
      ),
    )
    await assert.doesNotReject(() => prompt(runtime, 'session-b'))
    assert.equal(factoryCalls, 2)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-key retry fast-fails while an aborted provision remains unresolved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-hung-provision-retry-'))
  const releaseHungFactory = deferred()
  let factoryCalls = 0
  let closed = 0
  let retry: Promise<unknown> | null = null
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 20,
    runtimeProvisionTimeoutMs: 20,
    runtimeTeardownTimeoutMs: 50,
    async runtimeFactory() {
      factoryCalls += 1
      if (factoryCalls === 1) await releaseHungFactory.promise
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })

  try {
    await assert.rejects(
      () => prompt(runtime, 'session-a'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'provision_timeout'
      ),
    )

    retry = prompt(runtime, 'session-a')
    let timeout: ReturnType<typeof setTimeout> | null = null
    const outcome = await Promise.race([
      retry.then(
        () => 'fulfilled' as const,
        (error: unknown) => (
          error instanceof CloudRuntimeCapacityError
            ? error.reason
            : 'unexpected_error'
        ),
      ),
      new Promise<'pending'>((resolve) => {
        timeout = setTimeout(() => resolve('pending'), 100)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    assert.equal(outcome, 'cleanup_pending')
    assert.equal(factoryCalls, 1)

    releaseHungFactory.resolve()
    await waitFor(() => closed === 1, 'the timed-out runtime was not closed')
    await new Promise((resolve) => setImmediate(resolve))
    await assert.doesNotReject(() => prompt(runtime, 'session-a'))
    assert.equal(factoryCalls, 2)
  } finally {
    releaseHungFactory.resolve()
    await Promise.allSettled([retry].filter(Boolean) as Promise<unknown>[])
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('adapter close aborts hidden in-flight provisioning, fails bounded, and can be retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-close-provision-'))
  const factoryGate = deferred()
  let factoryStarted = false
  let closed = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeProvisionTimeoutMs: 60_000,
    runtimeTeardownTimeoutMs: 20,
    async runtimeFactory() {
      factoryStarted = true
      await factoryGate.promise
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          closed += 1
        },
      }
    },
  })

  try {
    const provisioning = prompt(runtime, 'session-a')
    await waitFor(() => factoryStarted, 'runtime provisioning did not start')
    const firstClose = runtime.close!()
    await assert.rejects(
      provisioning,
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'adapter_closing'
      ),
    )
    await assert.rejects(
      firstClose,
      (error: unknown) => (
        error instanceof Error
        && 'reasonCode' in error
        && error.reasonCode === 'sandbox_runtime_teardown_failed'
      ),
    )

    factoryGate.resolve()
    await waitFor(() => closed === 1, 'aborted late runtime was not closed')
    await assert.doesNotReject(() => runtime.close!())
  } finally {
    factoryGate.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('adapter close bounds a hung cached runtime teardown and can be retried', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-close-cached-'))
  const closeGate = deferred()
  let closeFinished = false
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeTeardownTimeoutMs: 20,
    runtimeFactory() {
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {
          await closeGate.promise
          closeFinished = true
        },
      }
    },
  })

  try {
    await prompt(runtime, 'session-a')
    const closeOutcome = runtime.close!().then(
      () => 'resolved' as const,
      (error: unknown) => error,
    )
    const outcome = await Promise.race([
      closeOutcome,
      new Promise<'timed_out'>((resolveTimeout) => {
        setTimeout(() => resolveTimeout('timed_out'), 250)
      }),
    ])
    assert.notEqual(outcome, 'timed_out')
    assert.ok(
      outcome instanceof Error
      && 'reasonCode' in outcome
      && outcome.reasonCode === 'sandbox_runtime_teardown_failed',
    )

    closeGate.resolve()
    await waitFor(() => closeFinished, 'cached runtime teardown did not finish')
    await Promise.resolve()
    await assert.doesNotReject(() => runtime.close!())
  } finally {
    closeGate.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('provisioning cleanup debt retains hard-cap capacity until the provider proves cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-cleanup-debt-'))
  const cleanup = deferred()
  const provisionedSessions: string[] = []
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory() {
      throw new Error('the explicit isolation provider owns provisioning')
    },
    isolationProvider: {
      name: 'cleanup-debt-fixture',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision(input) {
        provisionedSessions.push(input.execution.sessionId)
        if (input.execution.sessionId === 'session-a') {
          throw new CloudExecutionCleanupDebtError(
            'synthetic_cleanup_pending',
            cleanup.promise,
          )
        }
        return {
          adapter: {
            async promptSession() {},
            async abortSession() {},
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: 'open-cowork-cloud-execution-isolation-v1',
            boundaryId: `fixture-${input.execution.sessionId}`,
            establishedAt: new Date().toISOString(),
          },
          async close() {},
        }
      },
    },
  })

  try {
    await assert.rejects(
      () => prompt(runtime, 'session-a'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )
    await assert.rejects(
      () => prompt(runtime, 'session-b'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )
    assert.deepEqual(provisionedSessions, ['session-a'])

    cleanup.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    await assert.doesNotReject(() => prompt(runtime, 'session-b'))
    assert.deepEqual(provisionedSessions, ['session-a', 'session-b'])
  } finally {
    cleanup.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent cleanup debt rejects a boundary before it can be published', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-prepublish-cleanup-debt-'))
  const cleanup = deferred()
  const contenderProvisionStarted = deferred()
  const releaseContenderProvision = deferred()
  const promptedSessions: string[] = []
  const closedSessions: string[] = []
  let contender: Promise<unknown> | null = null
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 2,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory() {
      throw new Error('the explicit isolation provider owns provisioning')
    },
    isolationProvider: {
      name: 'concurrent-prepublish-cleanup-debt-fixture',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision(input) {
        if (input.execution.sessionId === 'session-contender') {
          contenderProvisionStarted.resolve()
          await releaseContenderProvision.promise
        } else {
          await contenderProvisionStarted.promise
          throw new CloudExecutionCleanupDebtError(
            'synthetic_cleanup_pending',
            cleanup.promise,
          )
        }
        return {
          adapter: {
            async promptSession() {
              promptedSessions.push(input.execution.sessionId)
            },
            async abortSession() {},
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: 'open-cowork-cloud-execution-isolation-v1',
            boundaryId: `fixture-${input.execution.sessionId}`,
            establishedAt: new Date().toISOString(),
          },
          async close() {
            closedSessions.push(input.execution.sessionId)
          },
        }
      },
    },
  })

  try {
    contender = prompt(runtime, 'session-contender')
    await contenderProvisionStarted.promise
    await assert.rejects(
      () => prompt(runtime, 'session-debt'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )

    releaseContenderProvision.resolve()
    await assert.rejects(
      contender,
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )
    assert.deepEqual(promptedSessions, [])
    assert.deepEqual(closedSessions, ['session-contender'])
  } finally {
    cleanup.resolve()
    releaseContenderProvision.resolve()
    await Promise.allSettled([contender].filter(Boolean) as Promise<unknown>[])
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanup debt arising during publication telemetry revokes the new boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-publication-cleanup-debt-'))
  const cleanup = deferred()
  const creationMetricStarted = deferred()
  const releaseCreationMetric = deferred()
  const promptedSessions: string[] = []
  const closedSessions: string[] = []
  let blockCreationMetric = true
  let contender: Promise<unknown> | null = null
  const observability: CloudObservabilityAdapter = {
    log() {},
    async metric(record) {
      if (
        blockCreationMetric
        && record.name === 'open_cowork_cloud_runtime_creation_duration_ms'
        && record.attributes?.status === 'ok'
      ) {
        blockCreationMetric = false
        creationMetricStarted.resolve()
        await releaseCreationMetric.promise
      }
    },
    span() {},
  }
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 2,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    observability,
    runtimeFactory() {
      throw new Error('the explicit isolation provider owns provisioning')
    },
    isolationProvider: {
      name: 'concurrent-publication-cleanup-debt-fixture',
      async capability() {
        return developmentProcessIsolationCapability()
      },
      async provision(input) {
        if (input.execution.sessionId === 'session-debt') {
          throw new CloudExecutionCleanupDebtError(
            'synthetic_cleanup_pending',
            cleanup.promise,
          )
        }
        return {
          adapter: {
            async promptSession() {
              promptedSessions.push(input.execution.sessionId)
            },
            async abortSession() {},
          },
          attestation: {
            ...developmentProcessIsolationCapability(),
            format: 'open-cowork-cloud-execution-isolation-v1',
            boundaryId: `fixture-${input.execution.sessionId}`,
            establishedAt: new Date().toISOString(),
          },
          async close() {
            closedSessions.push(input.execution.sessionId)
          },
        }
      },
    },
  })

  try {
    contender = prompt(runtime, 'session-contender')
    await creationMetricStarted.promise
    await assert.rejects(
      () => prompt(runtime, 'session-debt'),
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )
    cleanup.resolve()
    await new Promise((resolve) => setImmediate(resolve))

    releaseCreationMetric.resolve()
    await assert.rejects(
      contender,
      (error: unknown) => (
        error instanceof CloudRuntimeCapacityError
        && error.reason === 'cleanup_pending'
      ),
    )
    assert.deepEqual(promptedSessions, [])
    assert.deepEqual(closedSessions, ['session-contender'])
  } finally {
    cleanup.resolve()
    releaseCreationMetric.resolve()
    await Promise.allSettled([contender].filter(Boolean) as Promise<unknown>[])
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('unexpected active runtime exit emits one stable durable root error before eviction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-unexpected-exit-'))
  const exitCallbacks: Array<() => void> = []
  const events: Array<{ eventId?: string, type: string, payload: Record<string, unknown> }> = []
  let factoryCalls = 0
  let closed = 0
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    runtimeFactory(input) {
      factoryCalls += 1
      exitCallbacks.push(input.onUnexpectedExit!)
      return {
        async promptSession() {},
        async abortSession() {},
        async subscribeEvents() {
          return () => undefined
        },
        async close() {
          closed += 1
        },
      }
    },
  })
  const unsubscribe = await runtime.subscribeEvents!(async (event) => {
    events.push(event)
  })

  try {
    await prompt(runtime, 'session-a')
    exitCallbacks[0]!()
    exitCallbacks[0]!()
    await waitFor(
      () => events.some((event) => event.type === 'runtime.error'),
      'unexpected exit did not publish a terminal root event',
    )
    const terminalEvents = events.filter((event) => event.type === 'runtime.error')
    assert.equal(terminalEvents.length, 1)
    assert.match(terminalEvents[0]!.eventId || '', /^cloud-runtime-exit:[a-f0-9]{32}$/)
    assert.deepEqual(terminalEvents[0]!.payload, {
      sessionId: 'session-a',
      opencodeSessionId: 'native-session-a',
      message: 'The Cloud runtime exited unexpectedly.',
      errorCode: 'cloud_runtime_boundary_unexpected_exit',
    })
    await waitFor(() => closed === 1, 'unexpected runtime was not evicted')

    await prompt(runtime, 'session-a')
    assert.equal(factoryCalls, 2)
  } finally {
    unsubscribe()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('saturation load keeps runtime boundaries bounded, rejects excess work, and recovers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-saturation-'))
  const activePrompts = deferred()
  const observability = createPrometheusCloudObservability()
  let liveRuntimes = 0
  let maxLiveRuntimes = 0
  let aggregateRuntimeRssBytes = 0
  let maxAggregateRuntimeRssBytes = 0
  const created: string[] = []
  const runtimeProcesses = new Map<ChildProcess, number>()
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 3,
    maxAdmissionQueueEntries: 2,
    admissionQueueTimeoutMs: 1_000,
    observability,
    async runtimeFactory(input) {
      const { child, rssBytes } = await spawnMeasuredRuntimeProcess()
      created.push(input.execution.sessionId)
      liveRuntimes += 1
      maxLiveRuntimes = Math.max(maxLiveRuntimes, liveRuntimes)
      runtimeProcesses.set(child, rssBytes)
      aggregateRuntimeRssBytes += rssBytes
      maxAggregateRuntimeRssBytes = Math.max(
        maxAggregateRuntimeRssBytes,
        aggregateRuntimeRssBytes,
      )
      return {
        async promptSession() {
          if (Number(input.execution.sessionId.slice('session-'.length)) < 3) {
            await activePrompts.promise
          }
        },
        async abortSession() {},
        async close() {
          const trackedRssBytes = runtimeProcesses.get(child)
          if (trackedRssBytes === undefined) return
          runtimeProcesses.delete(child)
          await stopMeasuredRuntimeProcess(child)
          aggregateRuntimeRssBytes -= trackedRssBytes
          liveRuntimes -= 1
        },
      }
    },
  })

  try {
    const attempts = Array.from({ length: 20 }, (_, index) => (
      prompt(runtime, `session-${index}`)
    ))
    const settledAttempts = Promise.allSettled(attempts)
    await waitFor(() => created.length === 3, 'the hard-cap runtime set did not become active')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(maxLiveRuntimes, 3)

    activePrompts.resolve()
    const results = await settledAttempts
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5)
    assert.equal(results.filter((result) => (
      result.status === 'rejected'
      && result.reason instanceof CloudRuntimeCapacityError
      && result.reason.reason === 'queue_full'
    )).length, 15)
    assert.equal(maxLiveRuntimes, 3)
    assert.equal(created.length, 5)
    assert.ok(maxAggregateRuntimeRssBytes > 0)
    assert.ok(
      maxAggregateRuntimeRssBytes <= 3 * 128 * 1024 * 1024,
      `aggregate runtime RSS exceeded the saturation budget: ${maxAggregateRuntimeRssBytes}`,
    )

    const text = observability.renderPrometheus?.() || ''
    assert.match(text, /open_cowork_cloud_runtime_admission_rejections_total\{[^}]*reason="queue_full"[^}]*\} 15/)
    assert.match(text, /open_cowork_cloud_worker_rss_bytes/)
  } finally {
    activePrompts.resolve()
    await runtime.close?.()
    await Promise.all([...runtimeProcesses.keys()].map(stopMeasuredRuntimeProcess))
    assert.equal(liveRuntimes, 0)
    assert.equal(runtimeProcesses.size, 0)
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime pressure metrics expose bounded aggregate state without session cardinality', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-metrics-'))
  const observability = createPrometheusCloudObservability()
  const activePrompt = deferred()
  const runtime = runtimeFixture(root, {
    maxRuntimeEntries: 1,
    maxAdmissionQueueEntries: 1,
    admissionQueueTimeoutMs: 1_000,
    observability,
    runtimeFactory(input) {
      return {
        async promptSession() {
          if (input.execution.sessionId === 'private-session-a') await activePrompt.promise
        },
        async abortSession() {},
        async close() {},
      }
    },
  })

  try {
    const active = prompt(runtime, 'private-session-a')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const queued = prompt(runtime, 'private-session-b')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await assert.rejects(() => prompt(runtime, 'private-session-c'), CloudRuntimeCapacityError)

    const text = observability.renderPrometheus?.() || ''
    for (const metric of [
      'open_cowork_cloud_runtime_capacity',
      'open_cowork_cloud_runtime_cached',
      'open_cowork_cloud_runtime_active',
      'open_cowork_cloud_runtime_creating',
      'open_cowork_cloud_runtime_admission_queue_depth',
      'open_cowork_cloud_runtime_admission_rejections_total',
      'open_cowork_cloud_runtime_creation_duration_ms',
      'open_cowork_cloud_worker_rss_bytes',
      'open_cowork_cloud_worker_cpu_user_seconds_total',
      'open_cowork_cloud_worker_cpu_system_seconds_total',
      'open_cowork_cloud_worker_event_loop_utilization_ratio',
    ]) {
      assert.match(text, new RegExp(metric))
    }
    assert.equal(text.includes('private-session'), false)
    assert.equal(text.includes('tenant-a'), false)

    activePrompt.resolve()
    await Promise.all([active, queued])
  } finally {
    activePrompt.resolve()
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime pressure reports process-lifetime CPU as cumulative seconds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-cpu-metrics-'))
  const metrics: CloudMetricRecord[] = []
  const observability: CloudObservabilityAdapter = {
    log() {},
    metric(record) {
      metrics.push(record)
    },
    span() {},
  }
  const before = process.cpuUsage()
  const runtime = runtimeFixture(root, {
    observability,
    runtimeFactory() {
      return {
        async promptSession() {},
        async abortSession() {},
        async close() {},
      }
    },
  })

  try {
    await waitFor(
      () => metrics.some((metric) => metric.name === 'open_cowork_cloud_runtime_capacity'),
      'configured runtime capacity was not recorded at startup',
    )
    await prompt(runtime, 'metrics-session')
    await waitFor(
      () => (
        metrics.some((metric) => metric.name === 'open_cowork_cloud_worker_cpu_user_seconds_total')
        && metrics.some((metric) => metric.name === 'open_cowork_cloud_runtime_capacity_in_use')
      ),
      'worker pressure metrics were not recorded',
    )
    const after = process.cpuUsage()
    const userCpu = metrics.find(
      (metric) => metric.name === 'open_cowork_cloud_worker_cpu_user_seconds_total',
    )
    const capacity = metrics.find(
      (metric) => metric.name === 'open_cowork_cloud_runtime_capacity_in_use',
    )
    assert.equal(userCpu?.kind, 'counter')
    assert.equal(userCpu?.aggregationTemporality, 'cumulative')
    assert.equal(userCpu?.unit, 's')
    assert.equal(capacity?.kind, 'gauge')
    assert.ok((userCpu?.value || 0) >= before.user / 1_000_000)
    assert.ok((userCpu?.value || Number.POSITIVE_INFINITY) <= after.user / 1_000_000)
  } finally {
    await runtime.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})
