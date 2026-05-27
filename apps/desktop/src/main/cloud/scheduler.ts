import type { ControlPlaneStore } from './control-plane-store.ts'
import type { CloudSessionService } from './session-service.ts'

export class CloudScheduler {
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly schedulerId: string

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    schedulerId: string,
  ) {
    this.store = store
    this.service = service
    this.schedulerId = schedulerId
  }

  async processDueWorkflows(now = new Date()): Promise<number> {
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
    return claimed
  }
}
