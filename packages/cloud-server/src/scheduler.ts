import type { ControlPlaneStore } from './control-plane-store.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import { recordCloudSchedulerMetric } from './observability.ts'
import type { CloudSessionService } from './session-service.ts'

export class CloudScheduler {
  private readonly expiredClaimReapBatchSize = 100
  private readonly maxExpiredClaimReapBatches = 10
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly schedulerId: string
  private readonly observability: CloudObservabilityAdapter | null

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    schedulerId: string,
    observability: CloudObservabilityAdapter | null = null,
  ) {
    this.store = store
    this.service = service
    this.schedulerId = schedulerId
    this.observability = observability
  }

  async processDueWorkflows(now = new Date()): Promise<number> {
    const startedAt = Date.now()
    let claimed = 0
    const activeSessionIds: string[] = []
    await this.store.recordWorkerHeartbeat({
      workerId: this.schedulerId,
      role: 'scheduler',
      activeSessionIds,
      now,
    })
    const { reapedCount, drainCapHit } = await this.reapExpiredWorkflowClaims(now)
    if (reapedCount > 0) {
      await recordCloudSchedulerMetric(this.observability, {
        name: 'open_cowork_cloud_scheduler_expired_claims_reaped_total',
        value: reapedCount,
        schedulerId: this.schedulerId,
        status: 'ok',
      })
    }
    if (drainCapHit) {
      await recordCloudSchedulerMetric(this.observability, {
        name: 'open_cowork_cloud_scheduler_expired_claim_reaper_drain_cap_hits_total',
        schedulerId: this.schedulerId,
        status: 'cap_hit',
      })
    }
    while (true) {
      const started = await this.service.claimAndStartDueWorkflow(now, this.schedulerId)
      if (!started) break
      claimed += 1
      activeSessionIds.push(started.sessionId)
      await this.store.recordWorkerHeartbeat({
        workerId: this.schedulerId,
        role: 'scheduler',
        activeSessionIds,
        now,
      })
    }
    await recordCloudSchedulerMetric(this.observability, {
      name: 'open_cowork_cloud_scheduler_claims_total',
      value: claimed,
      schedulerId: this.schedulerId,
      status: 'ok',
    })
    await recordCloudSchedulerMetric(this.observability, {
      name: 'open_cowork_cloud_scheduler_loop_duration_ms',
      value: Date.now() - startedAt,
      schedulerId: this.schedulerId,
      status: 'ok',
    })
    return claimed
  }

  private async reapExpiredWorkflowClaims(now: Date) {
    let reapedCount = 0
    for (let batch = 0; batch < this.maxExpiredClaimReapBatches; batch += 1) {
      const reaped = await this.store.reapExpiredWorkflowClaims({
        now,
        limit: this.expiredClaimReapBatchSize,
      })
      reapedCount += reaped.length
      if (reaped.length < this.expiredClaimReapBatchSize) {
        return { reapedCount, drainCapHit: false }
      }
    }
    return { reapedCount, drainCapHit: true }
  }
}
