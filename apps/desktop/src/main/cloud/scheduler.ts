import type { ControlPlaneStore } from './control-plane-store.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import { recordCloudSchedulerMetric } from './observability.ts'
import type { CloudSessionService } from './session-service.ts'

export class CloudScheduler {
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
    while (true) {
      const started = await this.service.claimAndStartDueWorkflow(now)
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
}
