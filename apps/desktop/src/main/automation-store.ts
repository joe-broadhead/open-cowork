import { DatabaseSync } from 'node:sqlite'
import type {
  AutomationDeliveryRecord,
  AutomationFailureCode,
  AutomationRun,
  AutomationRunKind,
  AutomationSchedule,
  AutomationStatus,
  SopTriggerType,
} from '@open-cowork/shared'
import { computeNextAutomationRunAt } from './automation-schedule.ts'
import { getDb, withTransaction } from './automation-store-db.ts'
import {
  computeNextRetryAt,
  formatDayKey,
  nextHeartbeatAt,
  parseJson,
  rowToAutomationSummary,
  rowToDelivery,
  rowToRun,
  sanitizeRetryPolicy,
  type AutomationRecord,
  type DbRow,
} from './automation-store-model.ts'
import { getAutomationDetail, getAutomationRow } from './automation-store-automations.ts'
import { linkSopRunToAutomationRunInTransaction } from './sop-store.ts'

type AutomationRunCreateOptions = {
  attempt?: number
  retryOfRunId?: string | null
  sopRunLink?: { sopVersionId: string, triggerType: SopTriggerType, inputs?: Record<string, unknown> } | null
}

export { clearAutomationStoreCache } from './automation-store-db.ts'
export {
  AUTOMATION_LIST_INBOX_PER_AUTOMATION_LIMIT,
  AUTOMATION_LIST_WORK_ITEM_PER_AUTOMATION_LIMIT,
  createAutomation,
  getAutomationDetail,
  listAutomationState,
  resumeAutomationStatus,
  saveAutomationBrief,
  updateAutomation,
  updateAutomationStatus,
} from './automation-store-automations.ts'
export {
  createInboxItem,
  getInboxItem,
  listInboxForSession,
  listOpenInboxForAutomation,
  openInboxItemsForQuestion,
  resolveInboxItem,
} from './automation-store-inbox.ts'

export function createAutomationRun(
  automationId: string,
  kind: AutomationRunKind,
  title: string,
  options: AutomationRunCreateOptions = {},
) {
  const id = crypto.randomUUID()
  withTransaction((db) => {
    insertAutomationRun(db, id, automationId, kind, title, options)
  })
  return getRun(id)
}

function getActiveRunRowForAutomation(db: DatabaseSync, automationId: string) {
  return db.prepare(`
    select *
    from automation_runs
    where automation_id = ?
      and status in ('queued', 'running', 'needs_user')
    order by created_at desc
    limit 1
  `).get(automationId) as DbRow | undefined
}

function insertAutomationRun(
  db: DatabaseSync,
  id: string,
  automationId: string,
  kind: AutomationRunKind,
  title: string,
  options: AutomationRunCreateOptions = {},
) {
  const now = new Date().toISOString()
  const automation = getAutomationRow(automationId)
  const schedule = automation ? parseJson<AutomationSchedule>(automation.schedule_json, { type: 'weekly', timezone: 'UTC' }) : null
  const nextStatus = kind === 'heartbeat'
    ? (automation?.status as AutomationStatus | undefined) || 'draft'
    : 'running'
  const nextRunAt = automation && kind !== 'heartbeat' && automation.next_run_at && automation.next_run_at <= now && schedule
    ? computeNextAutomationRunAt(schedule, new Date(now))
    : automation?.next_run_at || null
  db.prepare(`
    insert into automation_runs (
      id, automation_id, session_id, kind, status, title, summary, error, failure_code, attempt, retry_of_run_id, next_retry_at, created_at, started_at, finished_at
    ) values (?, ?, null, ?, ?, ?, null, null, null, ?, ?, null, ?, null, null)
  `).run(id, automationId, kind, 'queued', title, options.attempt || 1, options.retryOfRunId || null, now)
  db.prepare('update automations set latest_run_id = ?, latest_run_status = ?, updated_at = ?, status = ?, next_run_at = ? where id = ?')
    .run(id, 'queued', now, nextStatus, nextRunAt, automationId)
  if (options.sopRunLink) {
    linkSopRunToAutomationRunInTransaction(db, {
      sopVersionId: options.sopRunLink.sopVersionId,
      automationRunId: id,
      triggerType: options.sopRunLink.triggerType,
      inputs: options.sopRunLink.inputs,
    })
  }
}

export function createAutomationRunWhenNoActive(
  automationId: string,
  kind: AutomationRunKind,
  title: string,
  options: AutomationRunCreateOptions = {},
) {
  const id = crypto.randomUUID()
  let created = false
  withTransaction((db) => {
    if (kind !== 'heartbeat' && getActiveRunRowForAutomation(db, automationId)) return
    insertAutomationRun(db, id, automationId, kind, title, options)
    created = true
  })
  return created ? getRun(id) : null
}

export function getActiveRunForAutomation(automationId: string) {
  const row = getActiveRunRowForAutomation(getDb(), automationId)
  return row ? rowToRun(row) : null
}

export function listActiveAutomationRuns() {
  const rows = getDb().prepare(`
    select *
    from automation_runs
    where status in ('queued', 'running')
    order by created_at asc
  `).all() as DbRow[]
  return rows.map(rowToRun)
}

export function getRun(runId: string) {
  const row = getDb().prepare('select * from automation_runs where id = ?').get(runId) as DbRow | undefined
  return row ? rowToRun(row) : null
}

export function listDueAutomations(now = new Date()) {
  const rows = getDb().prepare(`
    select * from automations
    where status in ('draft', 'ready', 'completed', 'failed')
      and next_run_at is not null
      and next_run_at <= ?
    order by next_run_at asc
  `).all(now.toISOString()) as AutomationRecord[]
  return rows.map(rowToAutomationSummary)
}

export function listDueRetryRuns(now = new Date()) {
  const rows = getDb().prepare(`
    select *
    from automation_runs
    where status = 'failed'
      and next_retry_at is not null
      and next_retry_at <= ?
    order by next_retry_at asc
  `).all(now.toISOString()) as DbRow[]
  return rows.map(rowToRun)
}

export function countConsecutiveFailedWorkRuns(automationId: string) {
  const rows = getDb().prepare(`
    select status
    from automation_runs
    where automation_id = ?
      and kind != 'heartbeat'
    order by created_at desc
  `).all(automationId) as Array<{ status?: string }>
  let count = 0
  for (const row of rows) {
    if (row.status !== 'failed') break
    count += 1
  }
  return count
}

export function countAutomationWorkRunAttemptsForDay(automationId: string, timezone: string, now = new Date()) {
  const targetDayKey = formatDayKey(now, timezone)
  const rows = getDb().prepare(`
    select created_at
    from automation_runs
    where automation_id = ?
      and kind != 'heartbeat'
  `).all(automationId) as Array<{ created_at?: string }>
  return rows.reduce((count, row) => {
    if (!row.created_at) return count
    return formatDayKey(row.created_at, timezone) === targetDayKey ? count + 1 : count
  }, 0)
}

export function clearPendingRetriesForChain(rootRunId: string, exceptRunId?: string | null) {
  if (exceptRunId) {
    getDb().prepare(`
      update automation_runs
      set next_retry_at = null
      where (id = ? or retry_of_run_id = ?)
        and id != ?
    `).run(rootRunId, rootRunId, exceptRunId)
    return
  }
  getDb().prepare(`
    update automation_runs
    set next_retry_at = null
    where id = ?
      or retry_of_run_id = ?
  `).run(rootRunId, rootRunId)
}

export function getNextRetryAttemptForChain(rootRunId: string) {
  const row = getDb().prepare(`
    select max(attempt) as max_attempt
    from automation_runs
    where id = ?
      or retry_of_run_id = ?
  `).get(rootRunId, rootRunId) as { max_attempt?: number | null } | undefined
  return Math.max(1, Number(row?.max_attempt) || 1) + 1
}

export function listDueHeartbeats(now = new Date()) {
  const rows = getDb().prepare(`
    select * from automations
    where status not in ('paused', 'archived', 'running')
      and next_heartbeat_at is not null
      and next_heartbeat_at <= ?
      and not exists (
        select 1
        from automation_runs
        where automation_runs.automation_id = automations.id
          and automation_runs.status = 'failed'
          and automation_runs.next_retry_at is not null
      )
    order by next_heartbeat_at asc
  `).all(now.toISOString()) as AutomationRecord[]
  return rows.map(rowToAutomationSummary)
}

export function markRunStarted(runId: string, sessionId: string | null) {
  const run = getRun(runId)
  if (!run) return null
  withTransaction((db) => {
    const now = new Date().toISOString()
    db.prepare('update automation_runs set status = ?, session_id = ?, started_at = coalesce(started_at, ?), finished_at = null where id = ?')
      .run('running', sessionId, now, runId)
    db.prepare('update automations set latest_run_status = ?, latest_run_id = ?, latest_session_id = ?, updated_at = ?, status = ? where id = ?')
      .run('running', runId, sessionId, now, 'running', run.automationId)
    if (run.kind === 'execution') {
      db.prepare('update automation_work_items set status = ?, run_id = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status = ?')
        .run('running', runId, now, run.automationId, 'ready')
    }
  })
  return getRun(runId)
}

export function markHeartbeatCompleted(runId: string, summary: string | null) {
  const run = getRun(runId)
  if (!run) return null
  withTransaction((db) => {
    const now = new Date().toISOString()
    const automation = getAutomationDetail(run.automationId)
    db.prepare('update automation_runs set status = ?, summary = ?, finished_at = ? where id = ?')
      .run('completed', summary, now, runId)
    if (automation) {
      db.prepare('update automations set latest_run_status = ?, updated_at = ?, next_heartbeat_at = ?, last_heartbeat_at = ? where id = ?')
        .run('completed', now, nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)), now, run.automationId)
    }
  })
  return getRun(runId)
}

export function markRunNeedsUser(runId: string, summary: string | null = null) {
  const run = getRun(runId)
  if (!run) return null
  withTransaction((db) => {
    const now = new Date().toISOString()
    const automation = getAutomationDetail(run.automationId)
    db.prepare('update automation_runs set status = ?, summary = ?, finished_at = null where id = ?')
      .run('needs_user', summary, runId)
    db.prepare('update automations set latest_run_status = ?, updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
      .run('needs_user', now, 'needs_user', automation ? nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)) : null, run.automationId)
  })
  return getRun(runId)
}

export function resumeRunFromNeedsUser(runId: string) {
  const run = getRun(runId)
  if (!run) return null
  if (run.status !== 'needs_user') return run
  withTransaction((db) => {
    const now = new Date().toISOString()
    const automation = getAutomationRow(run.automationId)
    db.prepare('update automation_runs set status = ?, finished_at = null where id = ?')
      .run('running', runId)
    db.prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
      .run('running', run.sessionId || null, now, 'running', automation ? nextHeartbeatAt(automation.heartbeat_minutes, new Date(now)) : null, run.automationId)
  })
  return getRun(runId)
}

export function markRunCompleted(runId: string, summary: string | null, sessionId?: string | null) {
  const run = getRun(runId)
  if (!run) return null
  withTransaction((db) => {
    markRunCompletedInTransaction(db, run, summary, sessionId)
  })
  return getRun(runId)
}

function markRunCompletedInTransaction(db: DatabaseSync, run: AutomationRun, summary: string | null, sessionId?: string | null) {
  const now = new Date().toISOString()
  const retryRootRunId = run.retryOfRunId || run.id
  db.prepare('update automation_runs set status = ?, summary = ?, error = null, failure_code = null, session_id = coalesce(?, session_id), finished_at = ? where id = ?')
    .run('completed', summary, sessionId || null, now, run.id)
  clearPendingRetriesForChain(retryRootRunId)
  const row = getAutomationRow(run.automationId)
  if (row) {
    const schedule = parseJson<AutomationSchedule>(row.schedule_json, { type: 'weekly', timezone: 'UTC' })
    if (run.kind === 'execution') {
      db.prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, last_run_at = ?, next_run_at = ?, next_heartbeat_at = ? where id = ?')
        .run('completed', sessionId || null, now, 'completed', now, computeNextAutomationRunAt(schedule, new Date(now)), nextHeartbeatAt(row.heartbeat_minutes, new Date(now)), run.automationId)
    } else {
      db.prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
        .run('completed', sessionId || null, now, 'ready', nextHeartbeatAt(row.heartbeat_minutes, new Date(now)), run.automationId)
    }
  }
  if (run.kind === 'execution') {
    db.prepare('update automation_work_items set status = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status in (\'ready\', \'running\')')
      .run('completed', now, run.automationId)
  }
}

export function markRunFailed(
  runId: string,
  error: string,
  sessionId?: string | null,
  options: { retryable?: boolean, failureCode?: AutomationFailureCode | null } = {},
) {
  const run = getRun(runId)
  if (!run) return null
  withTransaction((db) => {
    const now = new Date().toISOString()
    const automation = getAutomationDetail(run.automationId)
    const retryPolicy = sanitizeRetryPolicy(automation?.retryPolicy)
    const allowRetry = options.retryable !== false
    const nextRetryAt = automation && allowRetry && run.kind !== 'heartbeat' && run.attempt <= retryPolicy.maxRetries
      ? computeNextRetryAt(retryPolicy, run.attempt, now)
      : null
    db.prepare('update automation_runs set status = ?, error = ?, failure_code = ?, session_id = coalesce(?, session_id), next_retry_at = ?, finished_at = ? where id = ?')
      .run('failed', error, options.failureCode || null, sessionId || null, nextRetryAt, now, runId)
    db.prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
      .run('failed', sessionId || null, now, 'failed', automation ? nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)) : null, run.automationId)
    if (run.kind === 'execution') {
      if (nextRetryAt) {
        db.prepare('update automation_work_items set status = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status = ?')
          .run('ready', now, run.automationId, 'running')
      } else {
        db.prepare('update automation_work_items set status = ?, blocking_reason = ?, updated_at = ? where automation_id = ? and status = ?')
          .run('failed', error, now, run.automationId, 'running')
      }
    }
  })
  return getRun(runId)
}

export function markRunCancelled(runId: string, summary: string | null = null) {
  const run = getRun(runId)
  if (!run) return null
  withTransaction((db) => {
    const now = new Date().toISOString()
    const automation = getAutomationDetail(run.automationId)
    const nextStatus: AutomationStatus = run.kind === 'execution' && automation?.brief?.approvedAt
      ? 'ready'
      : run.kind === 'enrichment'
        ? 'draft'
        : automation?.status || 'draft'
    db.prepare('update automation_runs set status = ?, summary = ?, finished_at = ? where id = ?')
      .run('cancelled', summary, now, runId)
    db.prepare('update automations set latest_run_status = ?, updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
      .run('cancelled', now, nextStatus, automation ? nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)) : null, run.automationId)
    if (run.kind === 'execution') {
      db.prepare('update automation_work_items set status = ?, blocking_reason = ?, updated_at = ? where automation_id = ? and status = ?')
        .run('ready', 'Execution was cancelled before completion.', now, run.automationId, 'running')
    }
  })
  return getRun(runId)
}

export function attachRunSession(runId: string, automationId: string, sessionId: string) {
  const run = getRun(runId)
  if (!run) return null
  if (run.automationId !== automationId) {
    throw new Error('Automation run does not belong to the requested automation.')
  }
  withTransaction((db) => {
    const now = new Date().toISOString()
    db.prepare('update automation_runs set session_id = ?, started_at = coalesce(started_at, ?) where id = ?').run(sessionId, now, runId)
    db.prepare('update automations set latest_session_id = ?, updated_at = ? where id = ?').run(sessionId, now, run.automationId)
  })
  return getRun(runId)
}

type DeliveryRecordInput = {
  automationId: string
  runId?: string | null
  provider: AutomationDeliveryRecord['provider']
  target: string
  status: AutomationDeliveryRecord['status']
  title: string
  body: string
}

function getDeliveryRecord(deliveryId: string) {
  const row = getDb().prepare('select * from automation_deliveries where id = ?').get(deliveryId) as DbRow | undefined
  return row ? rowToDelivery(row) : null
}

export function listAutomationDeliveryRecordsForAudit() {
  const rows = getDb().prepare('select * from automation_deliveries order by created_at asc, id asc').all() as DbRow[]
  return rows.map(rowToDelivery)
}

function insertDeliveryRecord(db: DatabaseSync, id: string, input: DeliveryRecordInput, createdAt: string) {
  db.prepare(`
    insert into automation_deliveries (id, automation_id, run_id, provider, target, status, title, body, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.automationId, input.runId || null, input.provider, input.target, input.status, input.title, input.body, createdAt)
}

export function createDeliveryRecord(input: DeliveryRecordInput) {
  const id = crypto.randomUUID()
  withTransaction((db) => {
    insertDeliveryRecord(db, id, input, new Date().toISOString())
  })
  return getDeliveryRecord(id)
}

export function markRunCompletedWithDeliveryRecord(
  runId: string,
  summary: string | null,
  sessionId: string | null | undefined,
  delivery: Omit<DeliveryRecordInput, 'automationId' | 'runId'>,
) {
  const run = getRun(runId)
  if (!run) return { run: null, delivery: null }
  const deliveryId = crypto.randomUUID()
  withTransaction((db) => {
    const now = new Date().toISOString()
    markRunCompletedInTransaction(db, run, summary, sessionId)
    insertDeliveryRecord(db, deliveryId, {
      automationId: run.automationId,
      runId: run.id,
      ...delivery,
    }, now)
  })
  return {
    run: getRun(runId),
    delivery: getDeliveryRecord(deliveryId),
  }
}
