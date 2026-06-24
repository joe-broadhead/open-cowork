import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import type { CloudMetricRecord, CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import { CloudScheduler } from '@open-cowork/cloud-server/scheduler'
import type { CloudSessionService } from '@open-cowork/cloud-server/session-service'

class RecordingObservability implements CloudObservabilityAdapter {
  readonly metrics: CloudMetricRecord[] = []

  async log() {}

  async metric(record: CloudMetricRecord) {
    this.metrics.push(record)
  }

  async span() {}
}

function createManualWorkflow(store: InMemoryControlPlaneStore, workflowId: string) {
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId,
    draft: {
      title: workflowId,
      instructions: 'Run bounded scheduler recovery work.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
}

test('cloud scheduler reaps expired workflow claims in bounded batches and reports drain cap hits', async () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.com',
    role: 'owner',
  })
  for (let index = 0; index < 1_001; index += 1) {
    const workflowId = `workflow-expired-claim-${String(index).padStart(3, '0')}`
    createManualWorkflow(store, workflowId)
    const run = store.createWorkflowRun({
      tenantId: 'tenant-1',
      userId: 'user-1',
      workflowId,
      runId: `workflow-run-expired-claim-${String(index).padStart(3, '0')}`,
      triggerType: 'manual',
      claimedBy: 'stale-scheduler',
      leaseTtlMs: 1,
      createdAt: new Date('2000-01-01T00:00:00.000Z'),
    })
    assert.ok(run.claimToken)
  }

  const service = {
    async claimAndStartDueWorkflow() {
      return null
    },
  } as unknown as CloudSessionService
  const observability = new RecordingObservability()
  const scheduler = new CloudScheduler(store, service, 'scheduler-1', observability)

  assert.equal(await scheduler.processDueWorkflows(new Date('2030-01-01T00:00:00.000Z')), 0)
  const reapedMetric = observability.metrics.find((metric) => metric.name === 'open_cowork_cloud_scheduler_expired_claims_reaped_total')
  assert.equal(reapedMetric?.value, 1_000)
  const capHitMetric = observability.metrics.find((metric) => metric.name === 'open_cowork_cloud_scheduler_expired_claim_reaper_drain_cap_hits_total')
  assert.equal(capHitMetric?.value, 1)
  assert.equal(capHitMetric?.attributes?.status, 'cap_hit')
})

test('cloud scheduler runs retention in bounded batches, throttled by interval', async () => {
  const deliveryReturns = [2, 2, 1] // drains in three batches (last < batchSize)
  let deliveryCalls = 0
  let interactionCalls = 0
  const store = {
    async recordWorkerHeartbeat() {},
    async reapExpiredWorkflowClaims() { return [] },
    async pruneTerminalChannelDeliveries() {
      const value = deliveryReturns[deliveryCalls] ?? 0
      deliveryCalls += 1
      return value
    },
    async pruneExpiredChannelInteractions() {
      interactionCalls += 1
      return 0
    },
  } as unknown as InMemoryControlPlaneStore
  const service = {
    async claimAndStartDueWorkflow() { return null },
  } as unknown as CloudSessionService
  const observability = new RecordingObservability()
  const scheduler = new CloudScheduler(store, service, 'scheduler-1', observability, {
    channelDeliveryMs: 1_000,
    channelInteractionMs: 1_000,
    staleThrottleMs: null,
    intervalMs: 10_000,
    batchSize: 2,
    maxBatches: 5,
  })

  // First loop runs retention: deliveries drain across three batches, then interactions.
  await scheduler.processDueWorkflows(new Date('2030-01-01T00:00:00.000Z'))
  assert.equal(deliveryCalls, 3)
  assert.equal(interactionCalls, 1)
  const prunedMetric = observability.metrics.find((metric) => metric.name === 'open_cowork_cloud_scheduler_retention_pruned_total')
  assert.equal(prunedMetric?.value, 5)

  // Within the interval the sweep is skipped entirely.
  await scheduler.processDueWorkflows(new Date('2030-01-01T00:00:05.000Z'))
  assert.equal(deliveryCalls, 3)
  assert.equal(interactionCalls, 1)

  // Past the interval it runs again.
  await scheduler.processDueWorkflows(new Date('2030-01-01T00:00:15.000Z'))
  assert.equal(deliveryCalls, 4)
  assert.equal(interactionCalls, 2)
})

test('cloud scheduler skips retention entirely when no window is configured', async () => {
  let pruneCalls = 0
  const store = {
    async recordWorkerHeartbeat() {},
    async reapExpiredWorkflowClaims() { return [] },
    async pruneTerminalChannelDeliveries() { pruneCalls += 1; return 0 },
    async pruneExpiredChannelInteractions() { pruneCalls += 1; return 0 },
  } as unknown as InMemoryControlPlaneStore
  const service = {
    async claimAndStartDueWorkflow() { return null },
  } as unknown as CloudSessionService
  const scheduler = new CloudScheduler(store, service, 'scheduler-1', new RecordingObservability())

  await scheduler.processDueWorkflows(new Date('2030-01-01T00:00:00.000Z'))
  assert.equal(pruneCalls, 0)
})

test('cloud scheduler caps claims per loop and throttles the heartbeat', async () => {
  let heartbeats = 0
  const store = {
    async recordWorkerHeartbeat() { heartbeats += 1 },
    async reapExpiredWorkflowClaims() { return [] },
    async pruneTerminalChannelDeliveries() { return 0 },
    async pruneExpiredChannelInteractions() { return 0 },
  } as unknown as InMemoryControlPlaneStore
  let serviceCalls = 0
  const service = {
    // Always returns a workflow so the loop would run forever without the cap.
    async claimAndStartDueWorkflow() { serviceCalls += 1; return { sessionId: `s-${serviceCalls}` } },
  } as unknown as CloudSessionService
  const scheduler = new CloudScheduler(store, service, 'scheduler-1', new RecordingObservability())

  const claimed = await scheduler.processDueWorkflows(new Date('2030-01-01T00:00:00.000Z'))

  assert.equal(claimed, 200) // maxClaimsPerLoop — the backlog drains across ticks, not in one
  // Heartbeats: 1 start + every-25-claims during the loop (200/25 = 8). Far below per-claim (200).
  assert.ok(heartbeats <= 12, `expected throttled heartbeats, got ${heartbeats}`)
})
