import { ControlPlaneQuotaExceededError, publicQuotaMessage, type QuotaPolicyCode } from '../control-plane-errors.ts'
import { numberValue, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type CommandQueueQuota = {
  orgId?: string | null
  maxQueuedCommandsPerOrg?: number | null
  maxQueueAgeMs?: number | null
  policyCode?: QuotaPolicyCode | string
  queueAgePolicyCode?: QuotaPolicyCode | string
}

type ConcurrentSessionQuota = {
  orgId?: string | null
  maxConcurrentSessionsPerOrg?: number | null
  policyCode?: QuotaPolicyCode | string
}

type ActiveWorkerQuota = {
  orgId?: string | null
  maxActiveWorkersPerOrg?: number | null
  policyCode?: QuotaPolicyCode | string
}

type WorkflowRunQuota = {
  orgId?: string | null
  maxConcurrentWorkflowRunsPerOrg?: number | null
  maxWorkflowRunsPerHour?: number | null
  policyCode?: QuotaPolicyCode | string
  workflowRunsPolicyCode?: QuotaPolicyCode | string
}

type UsageQuotaInput = {
  orgId: string
  quotaKey: string
  limit: number
  quantity?: number
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

export type PostgresQuotaDomainDeps = {
  lockQuota: (executor: PgExecutor, orgId: string, quotaKey: string, now?: Date) => Promise<void>
  consumeUsageQuota: (executor: PgExecutor, input: UsageQuotaInput) => Promise<UsageQuotaResult>
}

async function resolveOrgId(executor: PgExecutor, tenantId: string, explicitOrgId?: string | null) {
  if (explicitOrgId) return explicitOrgId
  const result = await executor.query(
    `SELECT org_id FROM cloud_orgs WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  )
  return result.rows[0]?.org_id ? String(result.rows[0].org_id) : tenantId
}

export async function assertPostgresConcurrentSessionQuota(
  executor: PgExecutor,
  input: { tenantId: string, quota?: ConcurrentSessionQuota | null, now?: Date },
  deps: PostgresQuotaDomainDeps,
) {
  const maxConcurrentSessions = input.quota?.maxConcurrentSessionsPerOrg
  if (!maxConcurrentSessions || maxConcurrentSessions <= 0) return
  const orgId = await resolveOrgId(executor, input.tenantId, input.quota?.orgId)
  const now = input.now || new Date()
  await deps.lockQuota(executor, orgId, 'concurrent_sessions', now)
  const countRow = await executor.query(
    `SELECT count(*)::int AS count
     FROM cloud_sessions sessions
     LEFT JOIN cloud_orgs orgs ON orgs.tenant_id = sessions.tenant_id
     WHERE coalesce(orgs.org_id, sessions.tenant_id) = $1
       AND sessions.status <> 'closed'`,
    [orgId],
  )
  const activeSessions = numberValue(countRow.rows[0]?.count)
  if (activeSessions >= maxConcurrentSessions) {
    throw new ControlPlaneQuotaExceededError({
      message: 'Concurrent cloud session quota exceeded.',
      policyCode: input.quota?.policyCode || 'quota.concurrent_sessions_exceeded',
      retryAfterMs: 60_000,
      limit: maxConcurrentSessions,
      used: activeSessions,
      resetAt: new Date(now.getTime() + 60_000).toISOString(),
    })
  }
}

export async function checkPostgresActiveWorkerQuota(
  executor: PgExecutor,
  input: { tenantId: string, quota?: ActiveWorkerQuota | null, nowMs: number },
  deps: PostgresQuotaDomainDeps,
) {
  const maxActiveWorkers = input.quota?.maxActiveWorkersPerOrg
  if (!maxActiveWorkers || maxActiveWorkers <= 0) return true
  const orgId = await resolveOrgId(executor, input.tenantId, input.quota?.orgId)
  await deps.lockQuota(executor, orgId, 'active_workers')
  const countRow = await executor.query(
    `SELECT count(*)::int AS count
     FROM cloud_worker_leases leases
     JOIN cloud_sessions sessions ON sessions.tenant_id = leases.tenant_id AND sessions.session_id = leases.session_id
     LEFT JOIN cloud_orgs orgs ON orgs.tenant_id = sessions.tenant_id
     WHERE coalesce(orgs.org_id, sessions.tenant_id) = $1
       AND leases.lease_expires_at_ms > $2`,
    [orgId, input.nowMs],
  )
  const activeWorkers = numberValue(countRow.rows[0]?.count)
  return activeWorkers < maxActiveWorkers
}

export async function assertPostgresCommandQueueQuota(
  executor: PgExecutor,
  input: {
    tenantId: string
    quota?: CommandQueueQuota | null
    now?: Date
  },
  deps: PostgresQuotaDomainDeps,
) {
  const quota = input.quota
  if (!quota) return
  const orgId = await resolveOrgId(executor, input.tenantId, quota.orgId)
  const now = input.now || new Date()
  if (
    (quota.maxQueuedCommandsPerOrg && quota.maxQueuedCommandsPerOrg > 0)
    || (quota.maxQueueAgeMs && quota.maxQueueAgeMs > 0)
  ) {
    await deps.lockQuota(executor, orgId, 'queued_commands', now)
  }
  const result = await executor.query(
    `SELECT count(*)::int AS queued_commands,
            min(commands.created_at) AS oldest_created_at
     FROM cloud_session_commands commands
     JOIN cloud_sessions sessions
       ON sessions.tenant_id = commands.tenant_id
      AND sessions.session_id = commands.session_id
     LEFT JOIN cloud_orgs orgs
       ON orgs.tenant_id = commands.tenant_id
     WHERE coalesce(orgs.org_id, commands.tenant_id) = $1
       AND commands.status IN ('pending', 'running')`,
    [orgId],
  )
  const statsRow = result.rows[0] || {}
  const queuedCommands = numberValue(statsRow.queued_commands)
  const maxQueuedCommands = quota.maxQueuedCommandsPerOrg
  if (maxQueuedCommands && maxQueuedCommands > 0 && queuedCommands >= maxQueuedCommands) {
    throw new ControlPlaneQuotaExceededError({
      message: 'Cloud command queue is full.',
      policyCode: quota.policyCode || 'quota.queued_commands_exceeded',
      retryAfterMs: 60_000,
      limit: maxQueuedCommands,
      used: queuedCommands,
      resetAt: new Date(now.getTime() + 60_000).toISOString(),
    })
  }
  const maxQueueAgeMs = quota.maxQueueAgeMs
  const oldestCreatedAt = statsRow.oldest_created_at ? new Date(String(statsRow.oldest_created_at)) : null
  if (maxQueueAgeMs && maxQueueAgeMs > 0 && oldestCreatedAt) {
    const oldestAgeMs = Math.max(0, now.getTime() - oldestCreatedAt.getTime())
    if (oldestAgeMs >= maxQueueAgeMs) {
      const queueRetryAfterMs = Math.max(1_000, Math.min(60_000, maxQueueAgeMs))
      throw new ControlPlaneQuotaExceededError({
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

export async function assertPostgresCommandEnqueueQuotas(
  executor: PgExecutor,
  input: {
    tenantId: string
    queueQuota?: CommandQueueQuota | null
    usageQuotas?: UsageQuotaInput[]
    now?: Date
  },
  deps: PostgresQuotaDomainDeps,
) {
  await assertPostgresCommandQueueQuota(executor, { tenantId: input.tenantId, quota: input.queueQuota, now: input.now }, deps)
  for (const quota of input.usageQuotas || []) {
    const usage = await deps.consumeUsageQuota(executor, quota)
    if (!usage.allowed) {
      throw new ControlPlaneQuotaExceededError({
        message: publicQuotaMessage(usage.policyCode),
        policyCode: usage.policyCode || 'quota.prompts_per_hour_exceeded',
        retryAfterMs: usage.retryAfterMs,
        limit: usage.limit,
        used: usage.used,
        resetAt: usage.resetAt,
      })
    }
  }
}

export async function assertPostgresWorkflowRunQuota(
  executor: PgExecutor,
  input: {
    tenantId: string
    quota?: WorkflowRunQuota | null
    now?: Date
  },
  deps: PostgresQuotaDomainDeps,
) {
  if (!input.quota) return
  const orgId = await resolveOrgId(executor, input.tenantId, input.quota.orgId)
  const now = input.now || new Date()
  const maxConcurrentRuns = input.quota.maxConcurrentWorkflowRunsPerOrg
  if (maxConcurrentRuns && maxConcurrentRuns > 0) {
    await deps.lockQuota(executor, orgId, 'concurrent_workflow_runs', now)
    const result = await executor.query(
      `SELECT count(*)::int AS count
       FROM cloud_workflow_runs runs
       LEFT JOIN cloud_orgs orgs
         ON orgs.tenant_id = runs.tenant_id
       WHERE coalesce(orgs.org_id, runs.tenant_id) = $1
         AND runs.status IN ('queued', 'running')`,
      [orgId],
    )
    const activeRuns = numberValue(result.rows[0]?.count)
    if (activeRuns >= maxConcurrentRuns) {
      throw new ControlPlaneQuotaExceededError({
        message: 'Concurrent cloud workflow run quota exceeded.',
        policyCode: input.quota.policyCode || 'quota.concurrent_workflow_runs_exceeded',
        retryAfterMs: 60_000,
        limit: maxConcurrentRuns,
        used: activeRuns,
        resetAt: new Date(now.getTime() + 60_000).toISOString(),
      })
    }
  }
  const maxWorkflowRunsPerHour = input.quota.maxWorkflowRunsPerHour
  if (maxWorkflowRunsPerHour && maxWorkflowRunsPerHour > 0) {
    const quota = await deps.consumeUsageQuota(executor, {
      orgId,
      quotaKey: 'workflow_runs:hour',
      limit: maxWorkflowRunsPerHour,
      quantity: 1,
      windowMs: 60 * 60 * 1000,
      now,
      policyCode: input.quota.workflowRunsPolicyCode || 'quota.workflow_runs_per_hour_exceeded',
    })
    if (!quota.allowed) {
      throw new ControlPlaneQuotaExceededError({
        message: 'Cloud workflow run quota exceeded.',
        policyCode: quota.policyCode || 'quota.workflow_runs_per_hour_exceeded',
        retryAfterMs: quota.retryAfterMs,
        limit: quota.limit,
        used: quota.used,
        resetAt: quota.resetAt,
      })
    }
  }
}

export async function listPostgresRunnableSessions(
  executor: PgExecutor,
  input: { limit?: number | null, now?: Date } = {},
) {
  const now = input.now || new Date()
  const nowMs = now.getTime()
  const limit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)))
  const countRow = await executor.query(
    `SELECT count(*)::int AS count
     FROM (
       SELECT commands.tenant_id, commands.session_id
       FROM cloud_session_commands commands
       LEFT JOIN cloud_worker_leases leases
         ON leases.tenant_id = commands.tenant_id
        AND leases.session_id = commands.session_id
       WHERE commands.target_lease_token IS NULL
         AND commands.status IN ('pending', 'running')
         AND (commands.status <> 'pending' OR commands.available_at IS NULL OR commands.available_at <= $2)
         AND (leases.lease_expires_at_ms IS NULL OR leases.lease_expires_at_ms <= $1)
       GROUP BY commands.tenant_id, commands.session_id
     ) runnable`,
    [nowMs, now.toISOString()],
  )
  const selected = await executor.query(
    `SELECT commands.tenant_id, commands.session_id, min(commands.created_sequence) AS first_sequence
     FROM cloud_session_commands commands
     LEFT JOIN cloud_worker_leases leases
       ON leases.tenant_id = commands.tenant_id
      AND leases.session_id = commands.session_id
     WHERE commands.target_lease_token IS NULL
       AND commands.status IN ('pending', 'running')
       AND (commands.status <> 'pending' OR commands.available_at IS NULL OR commands.available_at <= $2)
       AND (leases.lease_expires_at_ms IS NULL OR leases.lease_expires_at_ms <= $1)
     GROUP BY commands.tenant_id, commands.session_id
     ORDER BY first_sequence, commands.tenant_id, commands.session_id
     LIMIT $3`,
    [nowMs, now.toISOString(), limit],
  )
  return {
    sessions: selected.rows.map((row) => ({
      tenantId: String(row.tenant_id),
      sessionId: String(row.session_id),
    })),
    pendingSessionCount: numberValue(countRow.rows[0]?.count),
  }
}
