import { redactOperationalText } from '../operational-text-redaction.ts'
import {
  commandFromRow,
  leaseFromRow,
} from '../postgres-domains/sessions.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  AuditEventRecord,
  DeferSessionCommandInput,
  RecordAuditEventInput,
  ReapedSessionLeaseRecord,
  SessionCommandRecord,
  WorkerLeaseRecord,
} from '../control-plane-store.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type AdjustUsageQuota = (executor: PgExecutor, input: {
  orgId: string
  quotaKey: string
  windowStartedAtMs: number
  quantityDelta: number
}) => Promise<void>

export function deferredCommandSchedule(input: DeferSessionCommandInput): {
  now: Date
  availableAt: Date
} {
  if (!Number.isFinite(input.retryAfterMs) || input.retryAfterMs <= 0) {
    throw new Error('Deferred command retryAfterMs must be a positive finite number.')
  }
  const now = input.now || new Date()
  return {
    now,
    availableAt: new Date(now.getTime() + Math.floor(input.retryAfterMs)),
  }
}

export async function deferPostgresSessionCommand(
  executor: PgExecutor,
  lease: WorkerLeaseRecord,
  commandId: string,
  input: DeferSessionCommandInput,
  schedule: { now: Date, availableAt: Date },
  adjustUsageQuota: AdjustUsageQuota,
): Promise<SessionCommandRecord> {
  const leaseResult = await executor.query(
    `SELECT * FROM cloud_worker_leases
     WHERE tenant_id = $1 AND session_id = $2
     FOR UPDATE`,
    [lease.tenantId, lease.sessionId],
  )
  const currentLease = leaseResult.rows[0] ? leaseFromRow(leaseResult.rows[0]) : null
  if (!currentLease || currentLease.leaseToken !== lease.leaseToken || currentLease.leaseExpiresAt <= schedule.now.getTime()) {
    throw new Error('Worker lease is stale.')
  }

  const commandResult = await executor.query(
    `SELECT * FROM cloud_session_commands
     WHERE command_id = $1
     FOR UPDATE`,
    [commandId],
  )
  if (!commandResult.rows[0]) throw new Error(`Unknown command ${commandId}.`)
  const command = commandFromRow(commandResult.rows[0])
  if (command.status !== 'running' || command.claimedLeaseToken !== lease.leaseToken) {
    throw new Error(`Command ${commandId} is not owned by this worker.`)
  }

  if (input.quotaReservation) {
    const orgResult = await executor.query(
      `SELECT org_id FROM cloud_orgs WHERE tenant_id = $1 LIMIT 1`,
      [lease.tenantId],
    )
    if (!orgResult.rows[0]) throw new Error(`Unknown org for tenant ${lease.tenantId}.`)
    await adjustUsageQuota(executor, {
      orgId: String(orgResult.rows[0].org_id),
      quotaKey: input.quotaReservation.quotaKey,
      windowStartedAtMs: input.quotaReservation.windowStartedAtMs,
      quantityDelta: -input.quotaReservation.quantity,
    })
  }

  const deferred = await executor.query(
    `UPDATE cloud_session_commands
     SET status = 'pending',
         claimed_by = NULL,
         claimed_lease_token = NULL,
         available_at = $2,
         acked_at = NULL,
         error = NULL,
         last_error_code = $3,
         last_error_summary = $4
     WHERE command_id = $1
     RETURNING *`,
    [
      commandId,
      schedule.availableAt.toISOString(),
      input.errorCode,
      redactOperationalText(input.errorSummary, 512, 'Command deferred'),
    ],
  )
  await executor.query(
    `DELETE FROM cloud_worker_leases
     WHERE tenant_id = $1 AND session_id = $2 AND lease_token = $3`,
    [lease.tenantId, lease.sessionId, lease.leaseToken],
  )
  await executor.query(
    `UPDATE cloud_sessions
     SET status = 'idle', updated_at = $3
     WHERE tenant_id = $1 AND session_id = $2`,
    [lease.tenantId, lease.sessionId, schedule.now.toISOString()],
  )
  return commandFromRow(deferred.rows[0]!)
}

export async function recoverPostgresSessionLease(
  executor: PgExecutor,
  lease: WorkerLeaseRecord,
  now: Date,
  maxAttempts: number,
  recordAuditEvent: (
    executor: PgExecutor,
    input: RecordAuditEventInput,
  ) => Promise<AuditEventRecord>,
): Promise<ReapedSessionLeaseRecord> {
  const nowIso = now.toISOString()
  const commands = await executor.query(
    `SELECT *
     FROM cloud_session_commands
     WHERE tenant_id = $1
       AND session_id = $2
       AND status = 'running'
       AND claimed_lease_token = $3
     ORDER BY created_sequence
     FOR UPDATE`,
    [lease.tenantId, lease.sessionId, lease.leaseToken],
  )
  const retriedCommandIds: string[] = []
  const failedCommandIds: string[] = []
  for (const commandRow of commands.rows) {
    const command = commandFromRow(commandRow)
    if (command.attemptCount >= maxAttempts) {
      const summary = 'Worker lease expired after the maximum retry attempts.'
      await executor.query(
        `UPDATE cloud_session_commands
         SET status = 'failed',
             error = $2,
             last_error_code = 'lease_expired_max_attempts',
             last_error_summary = $2
         WHERE command_id = $1`,
        [command.commandId, summary],
      )
      failedCommandIds.push(command.commandId)
    } else {
      await executor.query(
        `UPDATE cloud_session_commands
         SET status = 'pending',
             claimed_by = NULL,
             claimed_lease_token = NULL,
             available_at = $2,
             error = NULL,
             last_error_code = 'lease_expired',
             last_error_summary = 'Worker lease expired before command completion.'
         WHERE command_id = $1`,
        [command.commandId, nowIso],
      )
      retriedCommandIds.push(command.commandId)
    }
  }
  await executor.query(
    `DELETE FROM cloud_worker_leases
     WHERE tenant_id = $1 AND session_id = $2 AND lease_token = $3`,
    [lease.tenantId, lease.sessionId, lease.leaseToken],
  )
  const action: ReapedSessionLeaseRecord['action'] = failedCommandIds.length > 0 && retriedCommandIds.length === 0
    ? 'failed'
    : retriedCommandIds.length > 0
      ? 'retried'
      : 'released'
  await executor.query(
    `UPDATE cloud_sessions
     SET status = $3, updated_at = $4
     WHERE tenant_id = $1 AND session_id = $2`,
    [
      lease.tenantId,
      lease.sessionId,
      action === 'failed' ? 'errored' : 'idle',
      nowIso,
    ],
  )
  const orgResult = await executor.query(
    `SELECT org_id FROM cloud_orgs WHERE tenant_id = $1 LIMIT 1`,
    [lease.tenantId],
  )
  if (orgResult.rows[0]) {
    await recordAuditEvent(executor, {
      orgId: String(orgResult.rows[0].org_id),
      actorType: 'system',
      actorId: 'managed-work-reaper',
      eventType: 'managed_work.session_lease_reaped',
      targetType: 'session',
      targetId: lease.sessionId,
      metadata: {
        action,
        leasedBy: lease.leasedBy,
        retriedCommandIds,
        failedCommandIds,
      },
      createdAt: now,
    })
  }
  return {
    tenantId: lease.tenantId,
    sessionId: lease.sessionId,
    leaseToken: lease.leaseToken,
    leasedBy: lease.leasedBy,
    action,
    retriedCommandIds,
    failedCommandIds,
    reapedAt: nowIso,
  }
}
