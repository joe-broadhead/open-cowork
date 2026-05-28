import type { ControlPlaneStore, WorkerLeaseRecord } from './control-plane-store.ts'
import type { CloudRuntimeEvent } from './runtime-adapter.ts'
import type { CloudSessionService } from './session-service.ts'
import type { CloudAbuseConfig } from '../config-types.ts'

export type CloudWorkerCheckpointHooks = {
  restoreBeforeCommands?: (lease: WorkerLeaseRecord) => Promise<void>
  saveAfterCommand?: (lease: WorkerLeaseRecord) => Promise<void>
}

export class CloudWorker {
  private readonly leases = new Map<string, WorkerLeaseRecord>()
  private readonly restoredLeaseTokens = new Set<string>()
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly workerId: string
  private readonly leaseTtlMs: number
  private readonly checkpointHooks: CloudWorkerCheckpointHooks
  private readonly abuse: CloudAbuseConfig | null

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    workerId: string,
    leaseTtlMs = 30_000,
    checkpointHooks: CloudWorkerCheckpointHooks = {},
    abuse: CloudAbuseConfig | null = null,
  ) {
    this.store = store
    this.service = service
    this.workerId = workerId
    this.leaseTtlMs = leaseTtlMs
    this.checkpointHooks = checkpointHooks
    this.abuse = abuse
  }

  async processSessionCommands(tenantId: string, sessionId: string): Promise<number> {
    let lease = await this.getOrClaimLease(tenantId, sessionId)
    if (!lease) return 0
    let processed = 0
    await this.restoreCheckpointOnce(lease)
    await this.store.recordWorkerHeartbeat({
      workerId: this.workerId,
      role: 'worker',
      activeSessionIds: [sessionId],
    })
    while (true) {
      const command = await this.store.claimNextSessionCommand(lease)
      if (!command) break
      const startedAt = Date.now()
      try {
        await this.service.executeCommand(lease, command)
      } finally {
        await this.service.recordWorkerMinutes({
          tenantId,
          sessionId,
          workerId: this.workerId,
          elapsedMs: Date.now() - startedAt,
        })
      }
      lease = await this.store.checkpointSession(lease)
      await this.checkpointHooks.saveAfterCommand?.(lease)
      this.leases.set(this.leaseKey(tenantId, sessionId), lease)
      processed += 1
    }
    return processed
  }

  async processAllSessionCommands(): Promise<number> {
    let processed = 0
    for (const session of await this.store.listAllSessions()) {
      processed += await this.processSessionCommands(session.tenantId, session.sessionId)
    }
    return processed
  }

  async appendRuntimeEvent(tenantId: string, sessionId: string, event: CloudRuntimeEvent): Promise<boolean> {
    let lease = await this.getOrClaimLease(tenantId, sessionId)
    if (!lease) return false
    await this.service.appendRuntimeEvent({
      tenantId,
      sessionId,
      event,
      leaseToken: lease.leaseToken,
    })
    lease = await this.store.checkpointSession(lease)
    await this.checkpointHooks.saveAfterCommand?.(lease)
    this.leases.set(this.leaseKey(tenantId, sessionId), lease)
    return true
  }

  private async restoreCheckpointOnce(lease: WorkerLeaseRecord) {
    if (!this.checkpointHooks.restoreBeforeCommands || this.restoredLeaseTokens.has(lease.leaseToken)) return
    await this.checkpointHooks.restoreBeforeCommands(lease)
    this.restoredLeaseTokens.add(lease.leaseToken)
  }

  private async getOrClaimLease(tenantId: string, sessionId: string): Promise<WorkerLeaseRecord | null> {
    const leaseKey = this.leaseKey(tenantId, sessionId)
    const existing = this.leases.get(leaseKey)
    if (existing) {
      try {
        const renewed = await this.store.renewSessionLease(existing, new Date(), this.leaseTtlMs)
        this.leases.set(leaseKey, renewed)
        return renewed
      } catch {
        this.leases.delete(leaseKey)
      }
    }
    const claimed = await this.store.claimSessionLease(
      tenantId,
      sessionId,
      this.workerId,
      new Date(),
      this.leaseTtlMs,
      this.abuse?.enabled && this.abuse.maxActiveWorkersPerOrg
        ? {
            orgId: tenantId,
            maxActiveWorkersPerOrg: this.abuse.maxActiveWorkersPerOrg,
            policyCode: 'quota.active_workers_exceeded',
          }
        : null,
    )
    if (claimed) this.leases.set(leaseKey, claimed)
    return claimed
  }

  private leaseKey(tenantId: string, sessionId: string) {
    return `${tenantId}\0${sessionId}`
  }
}
