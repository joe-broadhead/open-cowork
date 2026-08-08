import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { startCloudApp } from '@open-cowork/cloud-server/app'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import type { CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import type { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'
import { createCloudProgressWatchdogComposition } from '../packages/cloud-server/src/progress-watchdog-composition.ts'
import type {
  CloudRuntimeEventListener,
  CloudRuntimeProgressEvent,
  CloudRuntimeSubscribeOptions,
} from '../packages/cloud-server/src/runtime-adapter.ts'
import type { CloudProgressWatchdogRecoveryOutcome } from '../packages/cloud-server/src/progress-watchdog.ts'
import { FakeRuntime } from './helpers/cloud-app-runtime.ts'

function progressEvent(overrides: Partial<CloudRuntimeProgressEvent> = {}): CloudRuntimeProgressEvent {
  return {
    source: 'durable_sequence',
    disposition: 'running',
    sequence: 1,
    observedAtMs: performance.now(),
    provenance: {
      scopeId: 'tenant-secret',
      sessionId: 'session-secret',
      runId: 'run-secret',
      runtimeGeneration: 3,
      executionGeneration: 2,
      leaseOwner: 'worker-secret',
      leaseEpoch: 'epoch-secret',
    },
    ...overrides,
  }
}

function captureObservability() {
  const metrics: Parameters<CloudObservabilityAdapter['metric']>[0][] = []
  const logs: Parameters<CloudObservabilityAdapter['log']>[0][] = []
  const observability: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric(record) { metrics.push(record) },
    span() {},
  }
  return { observability, metrics, logs }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for watchdog recovery.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('cloud watchdog composition maps runtime progress and keeps snapshots privacy-safe', async () => {
  const composition = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' },
    observability: null,
    worker: {
      async recoverStalledSession() {
        throw new Error('observe mode must not recover')
      },
    },
  })
  try {
    assert.equal(composition.observe({ ...progressEvent(), provenance: null }), false)
    assert.equal(composition.observe(progressEvent()), true)
    const snapshot = composition.snapshot()
    assert.equal(snapshot.mode, 'observe')
    assert.equal(snapshot.counts.healthy, 1)
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /tenant-secret|session-secret|run-secret|worker-secret|epoch-secret/,
    )
  } finally {
    await composition.close()
  }
})

test('cloud watchdog telemetry separates bounded suspect state from outcome without identifiers', async () => {
  const capture = captureObservability()
  const composition = createCloudProgressWatchdogComposition({
    env: {
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS: '1000',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '5000',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS: '250',
    },
    observability: capture.observability,
    worker: {
      async recoverStalledSession() {
        throw new Error('observe mode must not recover')
      },
    },
  })
  try {
    assert.equal(composition.observe(progressEvent({ observedAtMs: performance.now() - 1_500 })), true)
    await waitFor(() => capture.metrics.length === 1, 1_000)
    assert.deepEqual(capture.metrics[0]?.attributes, {
      watchdog_state: 'suspect',
      watchdog_outcome: 'observed',
    })
    assert.deepEqual(capture.logs[0]?.attributes, capture.metrics[0]?.attributes)
    assert.doesNotMatch(
      JSON.stringify({ metrics: capture.metrics, logs: capture.logs }),
      /tenant-secret|session-secret|run-secret|worker-secret|epoch-secret/,
    )
  } finally {
    await composition.close()
  }
})

test('cloud watchdog composition remains off without a worker runtime owner', async () => {
  const composition = createCloudProgressWatchdogComposition({
    env: { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe' },
    observability: null,
    worker: null,
  })
  try {
    assert.equal(composition.snapshot().mode, 'off')
    assert.equal(composition.observe(progressEvent()), false)
  } finally {
    await composition.close()
  }
})

test('cloud watchdog composition recovers through the worker and emits bounded decision telemetry', async () => {
  const capture = captureObservability()
  let recoveries = 0
  const composition = createCloudProgressWatchdogComposition({
    env: {
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'enforce',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF: 'canary-2026-08',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OPERATOR_OWNER: 'runtime-oncall',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_ROLLBACK_MODE: 'observe',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS: '1000',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '2000',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS: '250',
    },
    observability: capture.observability,
    worker: {
      async recoverStalledSession(_decision, isCurrent): Promise<CloudProgressWatchdogRecoveryOutcome> {
        recoveries += 1
        assert.equal(isCurrent(), true)
        return 'recovered'
      },
    },
  })
  try {
    assert.equal(composition.observe(progressEvent({ observedAtMs: performance.now() - 2_500 })), true)
    await waitFor(() => recoveries === 1 && capture.metrics.some(
      (metric) => metric.attributes?.watchdog_outcome === 'recovered',
    ), 1_000)
    const outcomes = capture.metrics.map((metric) => metric.attributes?.watchdog_outcome)
    assert.deepEqual(outcomes.slice(-2), ['enforced', 'recovered'])
    assert.ok(outcomes.every((outcome) => ['observed', 'enforced', 'recovered'].includes(String(outcome))))
    assert.ok(capture.metrics.every((metric) => metric.attributes?.watchdog_state === 'stalled'))
    assert.deepEqual(composition.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    assert.equal(capture.logs.length, capture.metrics.length)
    assert.doesNotMatch(
      JSON.stringify({ metrics: capture.metrics, logs: capture.logs }),
      /tenant-secret|session-secret|run-secret|worker-secret|epoch-secret/,
    )
  } finally {
    await composition.close()
  }
})

test('cloud worker writes one redacted durable watchdog audit event to the resolved org', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-secret', name: 'Tenant', orgId: 'org-resolved' })
  store.ensureUser({ tenantId: 'tenant-secret', userId: 'user-secret', email: 'watchdog@example.test' })
  store.createSession({
    tenantId: 'tenant-secret',
    userId: 'user-secret',
    sessionId: 'session-secret',
    opencodeSessionId: 'opencode-secret',
    profileName: 'full',
  })
  const worker = new CloudWorker(store, {} as CloudSessionService, 'worker-secret')
  const event = {
    mode: 'enforce',
    outcome: 'recovered',
    decision: {
      scopeId: 'tenant-secret',
      sessionId: 'session-secret',
      runId: 'run-secret',
      runtimeGeneration: 3,
      executionGeneration: 2,
      leaseOwner: 'worker-secret',
      leaseEpoch: 'epoch-secret',
      state: 'stalled',
      source: 'durable_sequence',
      ageMs: 5_000,
      revision: 7,
    },
  } as const

  await worker.recordProgressWatchdogAudit(event)
  await worker.recordProgressWatchdogAudit(event)

  const events = store.listAuditEvents('org-resolved')
    .filter((entry) => entry.eventType === 'runtime.progress_watchdog.decision')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.orgId, 'org-resolved')
  assert.equal(events[0]?.actorType, 'system')
  assert.equal(events[0]?.actorId, 'progress-watchdog')
  assert.equal(events[0]?.targetType, null)
  assert.equal(events[0]?.targetId, null)
  assert.deepEqual(events[0]?.metadata, {
    mode: 'enforce',
    state: 'stalled',
    outcome: 'recovered',
    source: 'durable_sequence',
  })
  assert.doesNotMatch(
    JSON.stringify(events),
    /tenant-secret|session-secret|opencode-secret|run-secret|worker-secret|epoch-secret/,
  )
})

test('cloud watchdog durable audit sink failures are best-effort', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-secret', name: 'Tenant', orgId: 'org-resolved' })
  store.ensureUser({ tenantId: 'tenant-secret', userId: 'user-secret', email: 'watchdog@example.test' })
  store.createSession({
    tenantId: 'tenant-secret',
    userId: 'user-secret',
    sessionId: 'session-secret',
    opencodeSessionId: 'opencode-secret',
    profileName: 'full',
  })
  store.recordAuditEvent = () => { throw new Error('audit sink unavailable') }
  const worker = new CloudWorker(store, {} as CloudSessionService, 'worker-secret')

  await assert.doesNotReject(worker.recordProgressWatchdogAudit({
    mode: 'observe',
    outcome: 'observed',
    decision: {
      scopeId: 'tenant-secret',
      sessionId: 'session-secret',
      runId: 'run-secret',
      runtimeGeneration: 1,
      executionGeneration: 1,
      leaseOwner: 'worker-secret',
      leaseEpoch: 'epoch-secret',
      state: 'suspect',
      source: 'durable_sequence',
      ageMs: 1_000,
      revision: 1,
    },
  }))
})

class ProgressRuntime extends FakeRuntime {
  subscriptions = 0
  private onProgress: CloudRuntimeSubscribeOptions['onProgress']

  override subscribeEvents(
    listener: CloudRuntimeEventListener,
    options?: CloudRuntimeSubscribeOptions,
  ) {
    this.subscriptions += 1
    this.onProgress = options?.onProgress
    const unsubscribe = super.subscribeEvents(listener)
    return () => {
      this.onProgress = undefined
      unsubscribe()
    }
  }

  emitProgress(event: CloudRuntimeProgressEvent) {
    this.onProgress?.(event)
  }

  hasProgressListener() {
    return Boolean(this.onProgress)
  }
}

test('cloud app uses its single runtime subscription for watchdog progress and exposes /progressz', async () => {
  const runtime = new ProgressRuntime()
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    observability: null,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.equal(runtime.subscriptions, 1)
    assert.equal(runtime.hasProgressListener(), true)
    runtime.emitProgress(progressEvent())
    const response = await fetch(`${app.url}/progressz`)
    assert.equal(response.status, 200)
    const snapshot = await response.json() as Record<string, unknown>
    assert.equal(snapshot.mode, 'observe')
    assert.deepEqual(snapshot.counts, { healthy: 1, waiting: 0, suspect: 0, stalled: 0 })
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /tenant-secret|session-secret|run-secret|worker-secret|epoch-secret/,
    )
  } finally {
    await app.close()
  }
  assert.equal(runtime.hasProgressListener(), false)
})

test('cloud app omits progress detection from its runtime subscription while watchdog mode is off', async () => {
  const runtime = new ProgressRuntime()
  const app = await startCloudApp({
    config: DEFAULT_CONFIG,
    runtime,
    observability: null,
    env: {
      OPEN_COWORK_CLOUD_ROLE: 'all-in-one',
      OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE: 'development-process',
      OPEN_COWORK_CLOUD_PROFILE: 'full',
      OPEN_COWORK_CLOUD_AUTH_MODE: 'header',
    },
    hostname: '127.0.0.1',
    port: 0,
  })

  try {
    assert.equal(runtime.subscriptions, 1, 'the durable projection subscription remains installed')
    assert.equal(runtime.hasProgressListener(), false, 'off mode installs no progress classifier hook')
    const response = await fetch(`${app.url}/progressz`)
    assert.equal(response.status, 200)
    assert.equal((await response.json() as Record<string, unknown>).mode, 'off')
  } finally {
    await app.close()
  }
})
