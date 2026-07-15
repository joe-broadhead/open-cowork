import type { ControlPlaneStore } from './control-plane-store.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import { recordCloudSchedulerMetric } from './observability.ts'
import type { CloudSessionService } from './session-service.ts'

// Data-retention windows for the transient channel tables. A null window means
// that table is never pruned (the default), so retention is opt-in per the
// operator's compliance policy — the scheduler does nothing destructive until a
// window is configured.
export type CloudRetentionOptions = {
  channelDeliveryMs: number | null
  channelInteractionMs: number | null
  // Stale per-source throttle state (cloud_rate_limits + cloud_auth_failures). Pure
  // throttle bookkeeping, not compliance data, and it grows one row per client IP
  // forever — so this prune defaults ON (window via app.ts) unlike the others.
  staleThrottleMs: number | null
  // Compliance/projection-sensitive event logs (P1-C3). These grow without bound on any active
  // tenant, but they ARE compliance/replay data — so each defaults OFF (null) and is pruned only
  // when the operator opts in with an explicit window per their retention policy. Pruning session
  // events trims old SSE replay history; the durable projection still covers the gap.
  sessionEventMs: number | null
  auditEventMs: number | null
  usageEventMs: number | null
  // cloud_workspace_events is written 1:1 with cloud_session_events (P1-B); same opt-in
  // semantics — trimming it advances the workspace-event min(sequence), and the durable
  // projection covers the gap, just like the session-event log.
  workspaceEventMs: number | null
  intervalMs: number
  batchSize: number
  maxBatches: number
}

const DISABLED_CLOUD_RETENTION: CloudRetentionOptions = {
  channelDeliveryMs: null,
  channelInteractionMs: null,
  staleThrottleMs: null,
  sessionEventMs: null,
  auditEventMs: null,
  usageEventMs: null,
  workspaceEventMs: null,
  intervalMs: 60 * 60 * 1000,
  batchSize: 500,
  maxBatches: 20,
}

export class CloudScheduler {
  private readonly expiredClaimReapBatchSize = 100
  private readonly maxExpiredClaimReapBatches = 10
  // Cap claims per tick so a large backlog drains across ticks instead of monopolizing one
  // loop (which would starve the reaper/retention). The next tick continues the backlog.
  private readonly maxClaimsPerLoop = 200
  // Refresh the heartbeat every N claims during the bounded loop rather than per claim —
  // a per-claim write of the growing activeSessionIds array was O(K²) serialized bytes.
  private readonly heartbeatEveryClaims = 25
  private readonly store: ControlPlaneStore
  private readonly service: CloudSessionService
  private readonly schedulerId: string
  private readonly observability: CloudObservabilityAdapter | null
  private readonly retention: CloudRetentionOptions
  private lastRetentionRunMs = 0
  // Periodic concurrency-gauge reconcile (P2-7). null/0 = disabled; the clamp-on-read trigger is
  // already drift-free for post-migration activity, so this is an opt-in belt-and-suspenders sweep.
  private readonly concurrencyReconcileMs: number | null
  private lastConcurrencyReconcileRunMs = 0
  // Throttle for the projection-lag gauge (P1-F): the aggregate scans cloud_sessions, so emit it
  // at most once a minute rather than on every (sub-second) scheduler loop.
  private readonly projectionLagIntervalMs = 60_000
  private lastProjectionLagRunMs = 0

  constructor(
    store: ControlPlaneStore,
    service: CloudSessionService,
    schedulerId: string,
    observability: CloudObservabilityAdapter | null = null,
    retention: CloudRetentionOptions = DISABLED_CLOUD_RETENTION,
    concurrencyReconcileMs: number | null = null,
  ) {
    this.store = store
    this.service = service
    this.schedulerId = schedulerId
    this.observability = observability
    this.retention = retention
    this.concurrencyReconcileMs = concurrencyReconcileMs && concurrencyReconcileMs > 0 ? concurrencyReconcileMs : null
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
    while (claimed < this.maxClaimsPerLoop) {
      const started = await this.service.domains.workflows.claimAndStartDueWorkflow(now, this.schedulerId)
      if (!started) break
      claimed += 1
      activeSessionIds.push(started.sessionId)
      // Periodic (not per-claim) heartbeat so a busy loop stays fresh without quadratic writes.
      if (claimed % this.heartbeatEveryClaims === 0) {
        await this.store.recordWorkerHeartbeat({ workerId: this.schedulerId, role: 'scheduler', activeSessionIds, now })
      }
    }
    if (claimed > 0 && claimed % this.heartbeatEveryClaims !== 0) {
      await this.store.recordWorkerHeartbeat({ workerId: this.schedulerId, role: 'scheduler', activeSessionIds, now })
    }
    await recordCloudSchedulerMetric(this.observability, {
      name: 'open_cowork_cloud_scheduler_claims_total',
      value: claimed,
      schedulerId: this.schedulerId,
      status: 'ok',
    })
    await this.maybeProcessRetention(now)
    await this.maybeReconcileConcurrency(now)
    await this.maybeEmitProjectionLag(now)
    await this.maybeDrainScimSyncQueue()
    await recordCloudSchedulerMetric(this.observability, {
      name: 'open_cowork_cloud_scheduler_loop_duration_ms',
      value: Date.now() - startedAt,
      schedulerId: this.schedulerId,
      status: 'ok',
    })
    return claimed
  }

  // Drain the durable SCIM sync-event queue (#895) each loop: claim up to a bounded batch
  // of DUE events (respecting per-event backoff) across all orgs, apply idempotently, and
  // complete/retry. A no-op with no due events, so it is safe to run every tick.
  private async maybeDrainScimSyncQueue() {
    const result = await this.service.domains.scimReconciler.drain({ orgId: null, limit: this.maxClaimsPerLoop })
    if (result.processed > 0) {
      await recordCloudSchedulerMetric(this.observability, {
        name: 'open_cowork_cloud_scheduler_scim_sync_processed_total',
        value: result.processed,
        schedulerId: this.schedulerId,
        status: result.failed > 0 ? 'partial' : 'ok',
      })
    }
  }

  // Throttled data-retention sweep, run from the scheduler loop at most once per
  // retention.intervalMs. No-op unless at least one window is configured. Each
  // table drains in bounded batches so a sweep can't monopolize the loop.
  private async maybeProcessRetention(now: Date) {
    const { channelDeliveryMs, channelInteractionMs, staleThrottleMs, sessionEventMs, auditEventMs, usageEventMs, workspaceEventMs, intervalMs } = this.retention
    if (
      channelDeliveryMs === null && channelInteractionMs === null && staleThrottleMs === null
      && sessionEventMs === null && auditEventMs === null && usageEventMs === null && workspaceEventMs === null
    ) return
    const nowMs = now.getTime()
    if (this.lastRetentionRunMs !== 0 && nowMs - this.lastRetentionRunMs < intervalMs) return
    this.lastRetentionRunMs = nowMs

    let pruned = 0
    if (channelDeliveryMs !== null) {
      const olderThan = new Date(nowMs - channelDeliveryMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneTerminalChannelDeliveries({ olderThan, limit }))
    }
    if (channelInteractionMs !== null) {
      const olderThan = new Date(nowMs - channelInteractionMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneExpiredChannelInteractions({ olderThan, limit }))
    }
    if (staleThrottleMs !== null) {
      const olderThan = new Date(nowMs - staleThrottleMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneStaleThrottleState({ olderThan, limit }))
    }
    if (sessionEventMs !== null) {
      const olderThan = new Date(nowMs - sessionEventMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneExpiredSessionEvents({ olderThan, limit }))
    }
    if (auditEventMs !== null) {
      const olderThan = new Date(nowMs - auditEventMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneExpiredAuditEvents({ olderThan, limit }))
    }
    if (usageEventMs !== null) {
      const olderThan = new Date(nowMs - usageEventMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneExpiredUsageEvents({ olderThan, limit }))
    }
    if (workspaceEventMs !== null) {
      const olderThan = new Date(nowMs - workspaceEventMs)
      pruned += await this.pruneInBatches((limit) => this.store.pruneExpiredWorkspaceEvents({ olderThan, limit }))
    }
    if (pruned > 0) {
      await recordCloudSchedulerMetric(this.observability, {
        name: 'open_cowork_cloud_scheduler_retention_pruned_total',
        value: pruned,
        schedulerId: this.schedulerId,
        status: 'ok',
      })
    }
  }

  private async maybeReconcileConcurrency(now: Date) {
    if (this.concurrencyReconcileMs === null) return
    const nowMs = now.getTime()
    if (this.lastConcurrencyReconcileRunMs !== 0 && nowMs - this.lastConcurrencyReconcileRunMs < this.concurrencyReconcileMs) return
    this.lastConcurrencyReconcileRunMs = nowMs
    const touched = await this.store.reconcileConcurrencyCounters()
    await recordCloudSchedulerMetric(this.observability, {
      name: 'open_cowork_cloud_scheduler_concurrency_reconciled_total',
      value: touched,
      schedulerId: this.schedulerId,
      status: 'ok',
    })
  }

  // Emit the durable-event-to-projection lag gauge (P1-F). Previously this metric was alerted,
  // graphed, and cataloged but had zero emit sites, so the projection-lag page could never fire.
  private async maybeEmitProjectionLag(now: Date) {
    const nowMs = now.getTime()
    if (this.lastProjectionLagRunMs !== 0 && nowMs - this.lastProjectionLagRunMs < this.projectionLagIntervalMs) return
    this.lastProjectionLagRunMs = nowMs
    const lag = await this.store.getMaxProjectionLag()
    await recordCloudSchedulerMetric(this.observability, {
      name: 'open_cowork_cloud_projection_lag_events',
      value: lag,
      schedulerId: this.schedulerId,
      status: 'ok',
    })
  }

  private async pruneInBatches(prune: (limit: number) => Promise<number> | number): Promise<number> {
    let total = 0
    for (let batch = 0; batch < this.retention.maxBatches; batch += 1) {
      const removed = await prune(this.retention.batchSize)
      total += removed
      if (removed < this.retention.batchSize) break
    }
    return total
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
