import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import type { CloudMetricRecord, CloudObservabilityAdapter } from '../apps/desktop/src/main/cloud/observability.ts'
import { CloudScheduler } from '../apps/desktop/src/main/cloud/scheduler.ts'
import type { CloudSessionService } from '../apps/desktop/src/main/cloud/session-service.ts'

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
