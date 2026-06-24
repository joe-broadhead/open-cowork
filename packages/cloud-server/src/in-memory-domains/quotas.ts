import { quotaExceeded, type QuotaPolicyCode } from '../control-plane-errors.ts'

type CommandQueueQuota = {
  orgId?: string | null
  maxQueuedCommandsPerOrg?: number | null
  maxQueueAgeMs?: number | null
  policyCode?: QuotaPolicyCode | string
  queueAgePolicyCode?: QuotaPolicyCode | string
}

type WorkflowRunQuota = {
  orgId?: string | null
  maxConcurrentWorkflowRunsPerOrg?: number | null
  maxWorkflowRunsPerHour?: number | null
  policyCode?: QuotaPolicyCode | string
  workflowRunsPolicyCode?: QuotaPolicyCode | string
}

type QueueCommandSnapshot = {
  status: string
  createdAt: string
}

type SessionQueueSnapshot = {
  record: { tenantId: string }
  commands: Iterable<QueueCommandSnapshot>
}

type WorkflowRunSnapshot = {
  tenantId: string
  status: string
}

type UsageQuotaInput = {
  orgId: string
  quotaKey: string
  limit: number
  quantity: number
  windowMs: number
  now?: Date
  policyCode?: QuotaPolicyCode | string
}

type UsageQuotaResult = {
  allowed: boolean
  policyCode?: QuotaPolicyCode | string
  retryAfterMs: number
  limit: number
  used: number
  resetAt: string
}

export class InMemoryQuotaDomain {
  private readonly deps: {
    resolveOrgId: (tenantId: string) => string
    sessions: () => Iterable<SessionQueueSnapshot>
    workflowRuns: () => Iterable<WorkflowRunSnapshot>
    consumeUsageQuota: (input: UsageQuotaInput) => UsageQuotaResult
  }

  constructor(deps: {
    resolveOrgId: (tenantId: string) => string
    sessions: () => Iterable<SessionQueueSnapshot>
    workflowRuns: () => Iterable<WorkflowRunSnapshot>
    consumeUsageQuota: (input: UsageQuotaInput) => UsageQuotaResult
  }) {
    this.deps = deps
  }

  assertCommandQueueQuota(input: {
    tenantId: string
    quota?: CommandQueueQuota | null
    now?: Date
  }) {
    const quota = input.quota
    if (!quota) return
    const orgId = quota.orgId || this.deps.resolveOrgId(input.tenantId)
    const now = input.now || new Date()
    const stats = this.commandQueueStats(orgId)
    const maxQueuedCommands = quota.maxQueuedCommandsPerOrg
    if (maxQueuedCommands && maxQueuedCommands > 0 && stats.queuedCommands >= maxQueuedCommands) {
      quotaExceeded({
        message: 'Cloud command queue is full.',
        policyCode: quota.policyCode || 'quota.queued_commands_exceeded',
        retryAfterMs: 60_000,
        limit: maxQueuedCommands,
        used: stats.queuedCommands,
        resetAt: new Date(now.getTime() + 60_000).toISOString(),
      })
    }
    const maxQueueAgeMs = quota.maxQueueAgeMs
    if (maxQueueAgeMs && maxQueueAgeMs > 0 && stats.oldestCreatedAt) {
      const oldestAgeMs = Math.max(0, now.getTime() - Date.parse(stats.oldestCreatedAt))
      if (oldestAgeMs >= maxQueueAgeMs) {
        const queueRetryAfterMs = Math.max(1_000, Math.min(60_000, maxQueueAgeMs))
        quotaExceeded({
          message: 'Cloud command queue is too old to accept more work.',
          policyCode: quota.queueAgePolicyCode || 'quota.queue_age_exceeded',
          retryAfterMs: queueRetryAfterMs,
          limit: maxQueueAgeMs,
          used: oldestAgeMs,
          resetAt: new Date(now.getTime() + queueRetryAfterMs).toISOString(),
        })
      }
    }
  }

  assertWorkflowRunQuota(input: {
    tenantId: string
    quota?: WorkflowRunQuota | null
    now?: Date
  }) {
    const quota = input.quota
    const orgId = quota?.orgId || this.deps.resolveOrgId(input.tenantId)
    const now = input.now || new Date()
    const maxConcurrentRuns = quota?.maxConcurrentWorkflowRunsPerOrg
    if (maxConcurrentRuns && maxConcurrentRuns > 0) {
      const activeRuns = Array.from(this.deps.workflowRuns())
        .filter((run) => this.tenantBelongsToOrg(run.tenantId, orgId))
        .filter((run) => run.status === 'queued' || run.status === 'running')
        .length
      if (activeRuns >= maxConcurrentRuns) {
        quotaExceeded({
          message: 'Concurrent cloud workflow run quota exceeded.',
          policyCode: quota?.policyCode || 'quota.concurrent_workflow_runs_exceeded',
          retryAfterMs: 60_000,
          limit: maxConcurrentRuns,
          used: activeRuns,
          resetAt: new Date(now.getTime() + 60_000).toISOString(),
        })
      }
    }
    const maxWorkflowRunsPerHour = quota?.maxWorkflowRunsPerHour
    if (maxWorkflowRunsPerHour && maxWorkflowRunsPerHour > 0) {
      const result = this.deps.consumeUsageQuota({
        orgId,
        quotaKey: 'workflow_runs:hour',
        limit: maxWorkflowRunsPerHour,
        quantity: 1,
        windowMs: 60 * 60 * 1000,
        now,
        policyCode: quota?.workflowRunsPolicyCode || 'quota.workflow_runs_per_hour_exceeded',
      })
      if (!result.allowed) {
        quotaExceeded({
          message: 'Cloud workflow run quota exceeded.',
          policyCode: result.policyCode || 'quota.workflow_runs_per_hour_exceeded',
          retryAfterMs: result.retryAfterMs,
          limit: result.limit,
          used: result.used,
          resetAt: result.resetAt,
        })
      }
    }
  }

  private tenantBelongsToOrg(tenantId: string, orgId: string) {
    return this.deps.resolveOrgId(tenantId) === orgId
  }

  private commandQueueStats(orgId: string) {
    let queuedCommands = 0
    let oldestCreatedAt: string | null = null
    for (const session of this.deps.sessions()) {
      if (!this.tenantBelongsToOrg(session.record.tenantId, orgId)) continue
      for (const command of session.commands) {
        if (command.status !== 'pending' && command.status !== 'running') continue
        queuedCommands += 1
        if (!oldestCreatedAt || command.createdAt < oldestCreatedAt) oldestCreatedAt = command.createdAt
      }
    }
    return { queuedCommands, oldestCreatedAt }
  }
}
