import type { ControlPlaneStore, WorkerLeaseRecord } from './control-plane-store.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import { recordCloudWorkerMetric } from './observability.ts'
import type { CloudRuntimeEvent } from './runtime-adapter.ts'
import type { CloudSessionService } from './session-service.ts'
import type { CloudAbuseConfig } from '@open-cowork/shared'

export type CloudWorkerCheckpointHooks = {
  restoreBeforeCommands?: (lease: WorkerLeaseRecord) => Promise<void>
  saveAfterCommand?: (lease: WorkerLeaseRecord) => Promise<void>
}

const MAX_STALE_CHECKPOINT_RETRIES = 3

function isStaleCheckpointError(error: unknown) {
  return error instanceof Error && /checkpoint version is stale/i.test(error.message)
}

export class CloudWorkerLeaseLostError extends Error {
  constructor() {
    super('Cloud worker lost its session lease during command execution.')
    this.name = 'CloudWorkerLeaseLostError'
  }
}

export type CloudWorkerOptions = {
  // How many distinct sessions one worker tick processes concurrently. Sessions are
  // independent (per-session lease, per-session workspace), so a slow command on one
  // session no longer head-of-line-blocks every other tenant on the worker. Clamped
  // to [1, 32]; 1 preserves the previous strictly-serial behaviour.
  sessionConcurrency?: number
  // How many commands a single session drains per tick before yielding its lane back
  // to the pool. Bounds a session with a large backlog from monopolising a lane; the
  // session is re-surveyed on the next pass while it still has pending commands.
  maxCommandsPerSessionPerTick?: number
  // Upper bound on cached lease records held in memory (LRU-evicted). Clamped to
  // [1, 1_000_000]; defaults to 4096. Bounds worker memory for long-lived workers
  // that serve a large stream of distinct sessions.
  maxLeases?: number
}

export class CloudWorker {
  private readonly claimBatchSize = 100
  private readonly expiredLeaseReapBatchSize = 100
  private readonly maxExpiredLeaseReapBatches = 10
  private readonly sessionConcurrency: number
  private readonly maxCommandsPerSessionPerTick: number
  // Cached lease records keyed on the stable tenant\0session key, retained across ticks so a
  // revisited session renews (cheap) instead of re-claiming. Bounded with LRU eviction: without
  // it, a long-lived worker serving a stream of one-shot sessions accumulated one entry per
  // distinct session forever (#908, same leak class as restoredSessions/P3-13). Every touch moves
  // the entry to the most-recent end so the oldest (genuinely idle) lease is evicted first; its
  // server-side lease is then reclaimed by the expiry reaper.
  private readonly leases = new Map<string, WorkerLeaseRecord>()
  private readonly maxLeases: number
  // Sessions whose checkpoint has already been restored on this worker, keyed on the stable
  // tenant\0session key (not the per-claim lease token, which changed every claim → unbounded
  // growth, and re-ran the expensive restore for an already-warm session on a new token). Bounded
  // with oldest-eviction (P2, same class as the fixed P3-13 leak).
  private readonly restoredSessions = new Set<string>()
  private readonly maxRestoredSessions = 4096
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
    options: CloudWorkerOptions = {},
  ) {
    this.store = store
    this.service = service
    this.workerId = workerId
    this.leaseTtlMs = leaseTtlMs
    this.checkpointHooks = checkpointHooks
    this.abuse = abuse
    this.observability = observability
    this.sessionConcurrency = clampInteger(options.sessionConcurrency, 4, 1, 32)
    this.maxCommandsPerSessionPerTick = clampInteger(options.maxCommandsPerSessionPerTick, 50, 1, 10_000)
    this.maxLeases = clampInteger(options.maxLeases, 4096, 1, 1_000_000)
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
      try {
        await this.service.reserveWorkerExecutionCapacity(tenantId)
      } catch (error) {
        if (this.isQuotaOrEntitlementDenial(error)) {
          await this.recordLeaseDenial(tenantId, sessionId, error)
          this.leases.delete(this.leaseKey(tenantId, sessionId))
          return processed
        }
        throw error
      }
      const startedAt = Date.now()
      await this.service.recordManagedExecutionEvent({
        tenantId,
        sessionId,
        workerId: this.workerId,
        commandId: command.commandId,
        commandKind: command.kind,
        eventType: 'worker.execution_started',
      })
      try {
        const commandLease = lease
        lease = await this.executeWithLeaseRenewal(commandLease, (signal) => this.service.executeCommand(commandLease, command, { signal, deferAck: true }))
        lease = await this.checkpointAndAckCommand(lease, command.commandId)
        await this.service.recordManagedExecutionEvent({
          tenantId,
          sessionId,
          workerId: this.workerId,
          commandId: command.commandId,
          commandKind: command.kind,
          eventType: 'worker.execution_completed',
          elapsedMs: Date.now() - startedAt,
        })
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
      } catch (error) {
        await this.service.recordManagedExecutionEvent({
          tenantId,
          sessionId,
          workerId: this.workerId,
          commandId: command.commandId,
          commandKind: command.kind,
          eventType: 'worker.execution_failed',
          elapsedMs: Date.now() - startedAt,
          errorCode: error instanceof Error ? error.name || 'Error' : 'unknown',
        })
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_commands_processed_total',
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: 'error',
        })
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_command_duration_ms',
          value: Date.now() - startedAt,
          workerId: this.workerId,
          tenantId,
          sessionId,
          status: 'error',
        })
        throw error
      } finally {
        await this.service.recordWorkerMinutes({
          tenantId,
          sessionId,
          workerId: this.workerId,
          elapsedMs: Date.now() - startedAt,
          reservedMinutes: 1,
        })
      }
      this.touchLease(this.leaseKey(tenantId, sessionId), lease)
      processed += 1
      // Yield the lane after a bounded run so one session's backlog cannot monopolise
      // it; the session is re-surveyed next pass while it still has pending commands.
      if (processed >= this.maxCommandsPerSessionPerTick) break
    }
    return processed
  }

  async processAllSessionCommands(): Promise<number> {
    const startedAt = Date.now()
    let processed = 0
    let pendingSessionCountEstimate = 0
    const { reapedCount, drainCapHit } = await this.reapExpiredSessionLeases(new Date())
    if (reapedCount > 0) {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_expired_leases_reaped_total',
        value: reapedCount,
        workerId: this.workerId,
        status: 'ok',
      })
    }
    if (drainCapHit) {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_expired_lease_reaper_drain_cap_hits_total',
        workerId: this.workerId,
        status: 'cap_hit',
      })
    }
    while (true) {
      const claimStartedAt = Date.now()
      const runnable = await this.store.listRunnableSessions({
        limit: this.claimBatchSize,
        now: new Date(),
      })
      pendingSessionCountEstimate = Math.max(pendingSessionCountEstimate, runnable.pendingSessionCountEstimate)
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_runnable_session_claim_duration_ms',
        value: Date.now() - claimStartedAt,
        workerId: this.workerId,
        status: 'ok',
      })
      if (runnable.sessions.length === 0) {
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_runnable_sessions_claimed_total',
          value: 0,
          workerId: this.workerId,
          status: 'empty',
        })
        break
      }
      const processedThisBatch = await this.processSessionsConcurrently(runnable.sessions)
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_runnable_sessions_claimed_total',
        value: processedThisBatch,
        workerId: this.workerId,
        status: processedThisBatch > 0 ? 'claimed' : 'denied',
      })
      processed += processedThisBatch
      if (runnable.sessions.length < this.claimBatchSize || processedThisBatch === 0) break
    }
    await recordCloudWorkerMetric(this.observability, {
      name: 'open_cowork_cloud_command_queue_depth_estimate',
      value: pendingSessionCountEstimate,
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

  // Process a claimed batch of independent sessions across a bounded pool of lanes so a
  // slow command on one session does not head-of-line-block other tenants on this worker.
  // With sessionConcurrency = 1 this is exactly the previous strictly-serial drain. On a
  // session error, lanes stop pulling new sessions, in-flight sessions settle, and the
  // first error is surfaced to the loop-failure path (so a bad session no longer silently
  // aborts the others it had not yet reached).
  private async processSessionsConcurrently(
    inputSessions: Array<{ tenantId: string, sessionId: string }>,
  ): Promise<number> {
    if (inputSessions.length === 0) return 0
    // Round-robin the batch across tenants before assigning lanes (P2 per-org fairness): the batch
    // arrives FIFO-by-oldest-command, so one high-volume tenant would otherwise fill every lane and
    // starve other tenants within this worker. Interleaving spreads the lanes across orgs.
    const sessions = interleaveByTenant(inputSessions)
    const laneCount = Math.min(this.sessionConcurrency, sessions.length)
    // `cursor` is shared but only ever read-then-incremented synchronously (no await
    // between), so lanes never claim the same index. Each lane accumulates its own count
    // — a shared `processed += await …` would lose updates because the read happens
    // before the await resolves.
    let cursor = 0
    let firstError: unknown = null
    const runLane = async (): Promise<number> => {
      let laneProcessed = 0
      while (cursor < sessions.length && firstError === null) {
        const session = sessions[cursor]
        cursor += 1
        if (!session) break
        try {
          laneProcessed += await this.processSessionCommands(session.tenantId, session.sessionId)
        } catch (error) {
          if (firstError === null) firstError = error
          break
        }
      }
      return laneProcessed
    }
    const laneTotals = await Promise.all(Array.from({ length: laneCount }, () => runLane()))
    if (firstError !== null) throw firstError
    return laneTotals.reduce((sum, count) => sum + count, 0)
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
    lease = await this.checkpointLease(lease)
    await this.checkpointHooks.saveAfterCommand?.(lease)
    this.touchLease(this.leaseKey(tenantId, sessionId), lease)
    return true
  }

  private async reapExpiredSessionLeases(now: Date) {
    let reapedCount = 0
    let retriedCommandCount = 0
    let failedCommandCount = 0
    for (let batch = 0; batch < this.maxExpiredLeaseReapBatches; batch += 1) {
      const reaped = await this.store.reapExpiredSessionLeases({
        now,
        limit: this.expiredLeaseReapBatchSize,
      })
      reapedCount += reaped.length
      retriedCommandCount += reaped.reduce((sum, entry) => sum + entry.retriedCommandIds.length, 0)
      failedCommandCount += reaped.reduce((sum, entry) => sum + entry.failedCommandIds.length, 0)
      if (reaped.length < this.expiredLeaseReapBatchSize) {
        await this.recordCommandRecoveryMetrics(retriedCommandCount, failedCommandCount)
        return { reapedCount, drainCapHit: false }
      }
    }
    await this.recordCommandRecoveryMetrics(retriedCommandCount, failedCommandCount)
    return { reapedCount, drainCapHit: true }
  }

  private async recordCommandRecoveryMetrics(retriedCommandCount: number, failedCommandCount: number) {
    if (retriedCommandCount > 0) {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_command_recoveries_total',
        value: retriedCommandCount,
        workerId: this.workerId,
        status: 'retried',
      })
    }
    if (failedCommandCount > 0) {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_command_recoveries_total',
        value: failedCommandCount,
        workerId: this.workerId,
        status: 'failed',
      })
    }
  }

  private async restoreCheckpointOnce(lease: WorkerLeaseRecord) {
    const key = this.leaseKey(lease.tenantId, lease.sessionId)
    if (!this.checkpointHooks.restoreBeforeCommands || this.restoredSessions.has(key)) return
    await this.checkpointHooks.restoreBeforeCommands(lease)
    this.restoredSessions.add(key)
    if (this.restoredSessions.size > this.maxRestoredSessions) {
      const oldest = this.restoredSessions.values().next().value
      if (oldest !== undefined) this.restoredSessions.delete(oldest)
    }
  }

  private async checkpointLease(lease: WorkerLeaseRecord): Promise<WorkerLeaseRecord> {
    let current = lease
    for (let attempt = 0; attempt < MAX_STALE_CHECKPOINT_RETRIES; attempt += 1) {
      try {
        return await this.store.checkpointSession(current)
      } catch (error) {
        if (!isStaleCheckpointError(error) || attempt === MAX_STALE_CHECKPOINT_RETRIES - 1) {
          throw error
        }
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_checkpoint_stale_retries_total',
          workerId: this.workerId,
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          status: 'retry',
        })
        current = await this.store.renewSessionLease(current, new Date(), this.leaseTtlMs)
      }
    }
    return current
  }

  private async checkpointAndAckCommand(lease: WorkerLeaseRecord, commandId: string): Promise<WorkerLeaseRecord> {
    let current = lease
    for (let attempt = 0; attempt < MAX_STALE_CHECKPOINT_RETRIES; attempt += 1) {
      const checkpointed = {
        ...current,
        checkpointVersion: current.checkpointVersion + 1,
      }
      await this.saveCheckpointBeforeAck(checkpointed)
      try {
        const result = await this.store.checkpointAndAckSessionCommand(current, commandId)
        return result.lease
      } catch (error) {
        if (!isStaleCheckpointError(error) || attempt === MAX_STALE_CHECKPOINT_RETRIES - 1) {
          throw error
        }
        await recordCloudWorkerMetric(this.observability, {
          name: 'open_cowork_cloud_worker_checkpoint_stale_retries_total',
          workerId: this.workerId,
          tenantId: current.tenantId,
          sessionId: current.sessionId,
          status: 'retry',
        })
        current = await this.store.renewSessionLease(current, new Date(), this.leaseTtlMs)
      }
    }
    return current
  }

  private async saveCheckpointBeforeAck(lease: WorkerLeaseRecord) {
    try {
      await this.checkpointHooks.saveAfterCommand?.(lease)
    } catch (error) {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_checkpoint_pending_command_failures_total',
        workerId: this.workerId,
        tenantId: lease.tenantId,
        sessionId: lease.sessionId,
        status: 'save_failed',
      })
      throw error
    }
  }

  private async getOrClaimLease(tenantId: string, sessionId: string): Promise<WorkerLeaseRecord | null> {
    const leaseKey = this.leaseKey(tenantId, sessionId)
    try {
      await this.service.assertWorkerLeaseAllowed(tenantId)
    } catch (error) {
      if (this.isQuotaOrEntitlementDenial(error)) {
        await this.recordLeaseDenial(tenantId, sessionId, error)
        return null
      }
      throw error
    }
    const existing = this.leases.get(leaseKey)
    if (existing) {
      try {
        const renewed = await this.store.renewSessionLease(existing, new Date(), this.leaseTtlMs)
        this.touchLease(leaseKey, renewed)
        void this.recordRenewalMetric(tenantId, sessionId, 'ok')
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
      this.touchLease(leaseKey, claimed)
      await this.service.recordManagedWorkClaimed({
        tenantId,
        sessionId,
        workerId: this.workerId,
        leaseToken: claimed.leaseToken,
      })
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

  private isQuotaOrEntitlementDenial(error: unknown) {
    const status = error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : null
    return status === 402 || status === 429
  }

  private async recordLeaseDenial(tenantId: string, sessionId: string, error: unknown) {
    const status = error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : null
    await recordCloudWorkerMetric(this.observability, {
      name: 'open_cowork_cloud_worker_lease_denials_total',
      workerId: this.workerId,
      tenantId,
      sessionId,
      status: status === 402 ? 'entitlement_denied' : 'quota_denied',
    })
  }

  private async executeWithLeaseRenewal<T>(lease: WorkerLeaseRecord, work: (signal: AbortSignal) => Promise<T>): Promise<WorkerLeaseRecord> {
    let current = lease
    let renewing = false
    let leaseLostError: CloudWorkerLeaseLostError | null = null
    const controller = new AbortController()
    const intervalMs = Math.max(1_000, Math.floor(this.leaseTtlMs / 3))
    const markLeaseLost = () => {
      if (leaseLostError) return
      leaseLostError = new CloudWorkerLeaseLostError()
      this.leases.delete(this.leaseKey(lease.tenantId, lease.sessionId))
      controller.abort(leaseLostError)
    }
    const timer = setInterval(() => {
      if (controller.signal.aborted) return
      if (renewing) return
      renewing = true
      void Promise.resolve()
        .then(() => this.store.renewSessionLease(current, new Date(), this.leaseTtlMs))
        .then((renewed) => {
          if (controller.signal.aborted) return
          current = renewed
          this.touchLease(this.leaseKey(renewed.tenantId, renewed.sessionId), renewed)
          void this.recordRenewalMetric(renewed.tenantId, renewed.sessionId, 'ok')
        })
        .catch((error: unknown) => {
          void error
          markLeaseLost()
          void this.recordRenewalMetric(lease.tenantId, lease.sessionId, 'failed')
        })
        .finally(() => {
          renewing = false
        })
    }, intervalMs)
    try {
      await work(controller.signal)
      if (leaseLostError) throw leaseLostError
      return current
    } finally {
      clearInterval(timer)
    }
  }

  private leaseKey(tenantId: string, sessionId: string) {
    return `${tenantId}\0${sessionId}`
  }

  // Insert/refresh a cached lease as most-recently-used and evict the oldest idle lease(s)
  // once the map exceeds maxLeases (#908). Deleting before setting moves an existing key to
  // the end of the Map's insertion order, so a lease renewed every tick stays fresh and the
  // eviction target is always the least-recently-touched (idle) session.
  private touchLease(key: string, record: WorkerLeaseRecord) {
    this.leases.delete(key)
    this.leases.set(key, record)
    while (this.leases.size > this.maxLeases) {
      const oldest = this.leases.keys().next().value
      if (oldest === undefined) break
      this.leases.delete(oldest)
    }
  }

  private async recordRenewalMetric(tenantId: string, sessionId: string, status: 'ok' | 'failed') {
    try {
      await recordCloudWorkerMetric(this.observability, {
        name: 'open_cowork_cloud_worker_lease_renewals_total',
        workerId: this.workerId,
        tenantId,
        sessionId,
        status,
      })
    } catch {
      // Lease ownership is authoritative; telemetry failures must not change command execution.
    }
  }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// Reorder a batch so sessions round-robin across their tenants while preserving each tenant's
// original (FIFO) order, so concurrency lanes are spread across orgs rather than monopolised.
function interleaveByTenant<T extends { tenantId: string }>(sessions: T[]): T[] {
  const queues = new Map<string, T[]>()
  for (const session of sessions) {
    const queue = queues.get(session.tenantId)
    if (queue) queue.push(session)
    else queues.set(session.tenantId, [session])
  }
  const lists = Array.from(queues.values())
  const result: T[] = []
  for (let index = 0; result.length < sessions.length; index += 1) {
    for (const queue of lists) {
      const next = queue[index]
      if (next) result.push(next)
    }
  }
  return result
}
