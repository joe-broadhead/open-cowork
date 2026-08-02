import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import type { SessionCommandRecord } from '@open-cowork/cloud-server/control-plane-store'
import type {
  CloudMetricRecord,
  CloudObservabilityAdapter,
} from '@open-cowork/cloud-server/observability'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeExecutionContext,
  CloudRuntimePromptPart,
} from '@open-cowork/cloud-server/runtime-adapter'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import { CloudWorker } from '@open-cowork/cloud-server/worker'
import {
  CloudRuntimeCapacityError,
  type CloudRuntimeCapacityReason,
} from '@open-cowork/cloud-server/worker-scoped-runtime-adapter'

class RecoveringCapacityRuntime implements CloudRuntimeAdapter {
  createAttempts = 0
  promptAttempts = 0
  scopeAttempts = 0
  scopeCallbackAttempts = 0
  private readonly capacityReason: CloudRuntimeCapacityReason
  private readonly failureSurface: 'create' | 'prompt' | 'scope'

  constructor(
    capacityReason: CloudRuntimeCapacityReason,
    failureSurface: 'create' | 'prompt' | 'scope' = 'create',
  ) {
    this.capacityReason = capacityReason
    this.failureSurface = failureSurface
  }

  async withExecutionScope<T>(
    _context: CloudRuntimeExecutionContext,
    callback: () => Promise<T>,
  ): Promise<T> {
    this.scopeAttempts += 1
    if (this.failureSurface === 'scope' && this.scopeAttempts === 1) {
      throw new CloudRuntimeCapacityError(this.capacityReason, 40)
    }
    this.scopeCallbackAttempts += 1
    return callback()
  }

  async createSession() {
    this.createAttempts += 1
    if (this.failureSurface === 'create' && this.createAttempts === 1) {
      throw new CloudRuntimeCapacityError(this.capacityReason, 40)
    }
    return {
      id: 'oc-session-1',
      title: 'Recovered',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async promptSession(_input: {
    sessionId: string
    parts: CloudRuntimePromptPart[]
    agent: string
    messageId?: string
  }) {
    this.promptAttempts += 1
    if (this.failureSurface === 'prompt' && this.promptAttempts === 1) {
      throw new CloudRuntimeCapacityError(this.capacityReason, 40)
    }
    return {
      events: [{
        type: 'session.idle' as const,
        payload: { sessionId: 'oc-session-1' },
      }],
    }
  }

  async abortSession() {}
}

test('worker durably defers capacity-saturated commands until retryAfter and then recovers', async (context) => {
  for (const scenario of [
    { name: 'create queue_full', reason: 'queue_full', failureSurface: 'create' },
    { name: 'create queue_timeout', reason: 'queue_timeout', failureSurface: 'create' },
    { name: 'prompt queue_full', reason: 'queue_full', failureSurface: 'prompt' },
    { name: 'prompt execution_active', reason: 'execution_active', failureSurface: 'prompt' },
    { name: 'scope adapter_closing', reason: 'adapter_closing', failureSurface: 'scope' },
  ] as const) {
    await context.test(scenario.name, async (scenarioContext) => {
      scenarioContext.mock.timers.enable({
        apis: ['Date'],
        now: new Date('2026-01-01T00:00:00.000Z'),
      })
      const store = new InMemoryControlPlaneStore()
      store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
      const org = store.ensureOrgForTenant({
        tenantId: 'tenant-1',
        name: 'Acme',
      })
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
        opencodeSessionId: '',
        profileName: 'default',
      })
      store.enqueueSessionCommand({
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'session-1',
        commandId: 'cmd-1',
        kind: 'prompt',
        payload: { text: 'retry me', agent: 'build' },
      })
      const runtime = new RecoveringCapacityRuntime(
        scenario.reason,
        scenario.failureSurface,
      )
      const service = new CloudSessionService(
        store,
        runtime,
        resolveCloudRuntimePolicy(DEFAULT_CONFIG),
        undefined,
        { randomUUID: () => 'test-id' },
        undefined,
        null,
        {},
        {
          ...DEFAULT_CONFIG.cloud.abuse,
          enabled: true,
          maxWorkerMinutesPerHour: 10,
        },
      )
      const metrics: CloudMetricRecord[] = []
      const observability: CloudObservabilityAdapter = {
        log() {},
        metric(record) { metrics.push(record) },
        span() {},
      }
      const worker = new CloudWorker(
        store,
        service,
        'worker-1',
        30_000,
        {},
        DEFAULT_CONFIG.cloud.abuse,
        observability,
      )
      let deferred: SessionCommandRecord | null = null
      let deferredAt = 0
      const originalDefer = store.deferSessionCommand.bind(store)
      store.deferSessionCommand = ((lease, commandId, input) => {
        deferredAt = Date.now()
        deferred = originalDefer(lease, commandId, input)
        return deferred
      }) as typeof store.deferSessionCommand

      assert.equal(await worker.processAllSessionCommands(), 0)
      assert.equal(deferred?.status, 'pending')
      assert.equal(deferred?.lastErrorCode, `runtime_capacity_${scenario.reason}`)
      assert.ok(Date.parse(deferred?.availableAt || '') >= deferredAt + 40)
      assert.equal(
        runtime.promptAttempts,
        scenario.failureSurface === 'prompt' ? 1 : 0,
      )
      if (scenario.failureSurface === 'scope') {
        assert.equal(runtime.scopeCallbackAttempts, 0)
        assert.equal(runtime.createAttempts, 0)
      }
      if (scenario.failureSurface === 'prompt') {
        assert.equal(
          store.listSessionEvents('tenant-1', 'session-1')
            .filter((event) => event.type === 'prompt.submitted')
            .length,
          1,
        )
        assert.equal(
          store.getSessionProjection('tenant-1', 'session-1')?.view.isGenerating,
          false,
        )
      }
      assert.equal(
        store.listUsageQuotaCounters(org.orgId)
          .find((counter) => counter.quotaKey === 'worker_minutes:hour')
          ?.quantity,
        0,
      )
      const deferredUsage = store.listUsageEvents(org.orgId, 100)
      assert.equal(
        deferredUsage.some((event) => event.eventType === 'worker.minute'),
        false,
      )
      assert.equal(
        deferredUsage.some((event) => event.eventType === 'worker.execution_deferred'),
        true,
      )
      assert.equal(
        deferredUsage.some((event) => event.eventType === 'worker.execution_failed'),
        false,
      )
      const deferredCommandMetric = metrics.find((metric) => (
        metric.name === 'open_cowork_cloud_worker_commands_processed_total'
      ))
      assert.equal(deferredCommandMetric?.attributes?.status, 'backpressure')
      const deferredDurationMetric = metrics.find((metric) => (
        metric.name === 'open_cowork_cloud_worker_command_duration_ms'
      ))
      assert.equal(deferredDurationMetric?.attributes?.status, 'backpressure')
      assert.equal(
        metrics.some((metric) => (
          metric.name === 'open_cowork_cloud_worker_loop_failures_total'
        )),
        false,
      )

      assert.equal(await worker.processAllSessionCommands(), 0)
      scenarioContext.mock.timers.tick(41)
      assert.equal(await worker.processAllSessionCommands(), 1)
      assert.equal(
        runtime.createAttempts,
        scenario.failureSurface === 'create' ? 2 : 1,
      )
      assert.equal(
        runtime.promptAttempts,
        scenario.failureSurface === 'prompt' ? 2 : 1,
      )
      if (scenario.failureSurface === 'scope') {
        assert.equal(runtime.scopeCallbackAttempts, 1)
      }
      assert.equal(
        store.listSessionEvents('tenant-1', 'session-1')
          .filter((event) => event.type === 'prompt.submitted')
          .length,
        1,
      )
      assert.equal(
        store.listUsageQuotaCounters(org.orgId)
          .find((counter) => counter.quotaKey === 'worker_minutes:hour')
          ?.quantity,
        1,
      )
      assert.equal(
        store.listUsageEvents(org.orgId, 100)
          .filter((event) => event.eventType === 'worker.minute')
          .length,
        1,
      )
    })
  }
})
