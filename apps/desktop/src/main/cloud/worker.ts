import type { ControlPlaneStore, WorkerLeaseRecord } from './control-plane-store.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import { recordCloudWorkerMetric } from './observability.ts'
import type { CloudRuntimeEvent } from './runtime-adapter.ts'
import type { CloudSessionService } from './session-service.ts'
import type { CloudAbuseConfig } from '../config-types.ts'

export type CloudWorkerCheckpointHooks = {
  restoreBeforeCommands?: (lease: WorkerLeaseRecord) => Promise<void>
  saveAfterCommand?: (lease: WorkerLeaseRecord) => Promise<void>
}

export class CloudWorker {
  private readonly claimBatchSize = 100
  private readonly leases = new Map<string, WorkerLeaseRecord>()
  private readonly restoredLeaseTokens = new Set<string>()
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly workerId: string
  private readonly leaseTtlMs: number
  private readonly checkpointHooks: CloudWorkerCheckpointHooks
  private readonly abuse: CloudAbuseConfig | null
  private readonly observability: CloudObservabilityAdapter | null

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    workerId: string,
    leaseTtlMs = 30_000,
    checkpointHooks: CloudWorkerCheckpointHooks = {},
    abuse: CloudAbuseConfig | null = null,
    observability: CloudObservabilityAdapter | null = null,
  ) {
    this.store = store
    this.service = service
    this.workerId = workerId
    this.leaseTtlMs = leaseTtlMs
    this.checkpointHooks = checkpointHooks
    this.abuse = abuse
    this.observability = observability
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
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_commands_processed_total',
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: 'ok',
          durationMs: Date.now() - startedAt,
        })
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_command_duration_ms',
          value: Date.now() - startedAt,
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: 'ok',
        })
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
    const startedAt = Date.now()
    let processed = 0
    let pendingSessionCount = 0
    while (true) {
      const claimStartedAt = Date.now()
      const claims = await this.store.claimRunnableSessions({
        workerId: this.workerId,
        limit: this.claimBatchSize,
        now: new Date(),
        ttlMs: this.leaseTtlMs,
      })
      pendingSessionCount = Math.max(pendingSessionCount, claims.pendingSessionCount)
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_runnable_session_claim_duration_ms',
        value: Date.now() - claimStartedAt,
        workerId: this.workerId,
        status: 'ok',
      })
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_runnable_sessions_claimed_total',
        value: claims.leases.length,
        workerId: this.workerId,
        status: claims.leases.length > 0 ? 'claimed' : 'empty',
      })
      if (claims.leases.length === 0) break
      let processedThisBatch = 0
      for (const lease of claims.leases) {
        await this.store.releaseSessionLease(lease)
        processedThisBatch += await this.processSessionCommands(lease.tenantId, lease.sessionId)
      }
      processed += processedThisBatch
      if (claims.leases.length < this.claimBatchSize || processedThisBatch === 0) break
    }
    await recordCloudWorkerMetric(this.observability, {
      name: 'open_cowork_cloud_command_queue_depth',
      value: pendingSessionCount,
      workerId: this.workerId,
    })
    await recordCloudWorkerMetric(this.observability, {
      name: 'open_cowork_cloud_worker_loop_duration_ms',
      value: Date.now() - startedAt,
      workerId: this.workerId,
      status: 'ok',
    })
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
    try {
      await this.service.assertWorkerExecutionAllowed(tenantId)
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error
        ? (error as { status?: unknown }).status
        : null
      if (status === 402 || status === 429) {
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_lease_denials_total',
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: status === 402 ? 'entitlement_denied' : 'quota_denied',
        })
        return null
      }
      throw error
    }
    const existing = this.leases.get(leaseKey)
    if (existing) {
      try {
        const renewed = await this.store.renewSessionLease(existing, new Date(), this.leaseTtlMs)
        this.leases.set(leaseKey, renewed)
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_lease_renewals_total',
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: 'ok',
        })
        return renewed
      } catch {
        this.leases.delete(leaseKey)
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_stale_owner_rejections_total',
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: 'stale',
        })
      }
    }
    const activeWorkerQuota = await this.service.activeWorkerQuotaForTenant(tenantId)
    const claimed = await this.store.claimSessionLease(
      tenantId,
      sessionId,
      this.workerId,
      new Date(),
      this.leaseTtlMs,
      this.abuse?.enabled && activeWorkerQuota
        ? {
            orgId: activeWorkerQuota.orgId,
            maxActiveWorkersPerOrg: activeWorkerQuota.limit,
            policyCode: 'quota.active_workers_exceeded',
          }
        : null,
    )
    if (claimed) {
      this.leases.set(leaseKey, claimed)
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_lease_claims_total',
        workerId: this.workerId,
        tenantId,
        sessionId,
        status: 'claimed',
      })
    } else {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_lease_claims_total',
        workerId: this.workerId,
        tenantId,
        sessionId,
        status: 'denied',
      })
    }
    return claimed
  }

  private leaseKey(tenantId: string, sessionId: string) {
    return `${tenantId}\0${sessionId}`
  }
}
