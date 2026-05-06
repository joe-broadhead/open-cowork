import { DatabaseSync } from 'node:sqlite'
import type {
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationDraft,
  AutomationFailureCode,
  AutomationListPayload,
  AutomationRun,
  AutomationRunKind,
  AutomationSchedule,
  AutomationStatus,
  ExecutionBrief,
} from '@open-cowork/shared'
import { computeNextAutomationRunAt } from './automation-schedule.ts'
import { normalizeExecutionBriefForStorage } from './automation-brief-limits.ts'
import { getDb, withTransaction } from './automation-store-db.ts'
import {
  computeNextRetryAt,
  formatDayKey,
  nextHeartbeatAt,
  parseJson,
  rowToAutomationSummary,
  rowToDelivery,
  rowToInbox,
  rowToRun,
  rowToWorkItem,
  sanitizePreferredAgentNames,
  sanitizeRetryPolicy,
  sanitizeRunPolicy,
  type AutomationRecord,
  type DbRow,
} from './automation-store-model.ts'
export { clearAutomationStoreCache } from './automation-store-db.ts'
export {
  createInboxItem,
  getInboxItem,
  listInboxForSession,
  listOpenInboxForAutomation,
  openInboxItemsForQuestion,
  resolveInboxItem,
} from './automation-store-inbox.ts'

function getBrief(automationId: string): ExecutionBrief | null {
  const row = getDb().prepare('select brief_json from automation_briefs where automation_id = ?').get(automationId) as { brief_json?: string } | undefined
  return row ? parseJson<ExecutionBrief | null>(row.brief_json, null) : null
}

function getAutomationRow(automationId: string) {
  return getDb().prepare('select * from automations where id = ?').get(automationId) as AutomationRecord | undefined
}

function listWorkItemsForAutomation(automationId: string) {
  return (getDb().prepare('select * from automation_work_items where automation_id = ? order by created_at asc').all(automationId) as DbRow[]).map(rowToWorkItem)
}

function hasBlockingInboxItemsForAutomation(automationId: string) {
  const row = getDb().prepare(`
    select 1
    from automation_inbox
    where automation_id = ?
      and status = 'open'
      and type in ('clarification', 'approval', 'failure')
    limit 1
  `).get(automationId) as DbRow | undefined
  return Boolean(row)
}

export function listAutomationState(): AutomationListPayload {
  const db = getDb()
  const automations = (db.prepare('select * from automations order by updated_at desc').all() as AutomationRecord[]).map(rowToAutomationSummary)
  const inbox = (db.prepare('select * from automation_inbox where status = ? order by updated_at desc').all('open') as DbRow[]).map(rowToInbox)
  const workItems = (db.prepare('select * from automation_work_items order by updated_at desc').all() as DbRow[]).map(rowToWorkItem)
  const runs = (db.prepare('select * from automation_runs order by created_at desc limit 100').all() as DbRow[]).map(rowToRun)
  const deliveries = (db.prepare('select * from automation_deliveries order by created_at desc limit 100').all() as DbRow[]).map(rowToDelivery)
  return { automations, inbox, workItems, runs, deliveries }
}

export function getAutomationDetail(automationId: string): AutomationDetail | null {
  const row = getAutomationRow(automationId)
  if (!row) return null
  return {
    ...rowToAutomationSummary(row),
    brief: getBrief(automationId),
    latestSessionId: row.latest_session_id,
    deliveries: (getDb().prepare('select * from automation_deliveries where automation_id = ? order by created_at desc').all(automationId) as DbRow[]).map(rowToDelivery),
  }
}

export function createAutomation(draft: AutomationDraft): AutomationDetail {
  const db = getDb()
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const nextRunAt = computeNextAutomationRunAt(draft.schedule)
  const nextHeartbeat = nextHeartbeatAt(draft.heartbeatMinutes, new Date(now))
  const retryPolicy = sanitizeRetryPolicy(draft.retryPolicy)
  const runPolicy = sanitizeRunPolicy(draft.runPolicy)
  const preferredAgentNames = sanitizePreferredAgentNames(draft.preferredAgentNames)
  db.prepare(`
    insert into automations (
      id, title, goal, kind, status, paused_from_status, schedule_json, heartbeat_minutes, execution_mode, autonomy_policy,
      project_directory, preferred_agents_json, retry_max_attempts, retry_base_delay_minutes, retry_max_delay_minutes,
      run_daily_run_cap, run_max_duration_minutes,
      created_at, updated_at, next_run_at, last_run_at, next_heartbeat_at, last_heartbeat_at, latest_run_id, latest_run_status, latest_session_id
    ) values (?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, null, null, null)
  `).run(
    id,
    draft.title.trim(),
    draft.goal.trim(),
    draft.kind,
    'draft',
    JSON.stringify(draft.schedule),
    draft.heartbeatMinutes,
    draft.executionMode,
    draft.autonomyPolicy,
    draft.projectDirectory || null,
    JSON.stringify(preferredAgentNames),
    retryPolicy.maxRetries,
    retryPolicy.baseDelayMinutes,
    retryPolicy.maxDelayMinutes,
    runPolicy.dailyRunCap,
    runPolicy.maxRunDurationMinutes,
    now,
    now,
    nextRunAt,
    nextHeartbeat,
  )
  return getAutomationDetail(id)!
}

export function updateAutomation(automationId: string, patch: Partial<AutomationDraft>): AutomationDetail | null {
  const existing = getAutomationRow(automationId)
  if (!existing) return null
  const current = rowToAutomationSummary(existing)
  const nextSchedule = patch.schedule || current.schedule
  const nextUpdatedAt = new Date().toISOString()
  const nextRunAt = patch.schedule
    ? computeNextAutomationRunAt(nextSchedule)
    : current.nextRunAt
  const nextHeartbeat = current.status === 'paused' || current.status === 'archived'
    ? null
    : patch.heartbeatMinutes !== undefined
      ? nextHeartbeatAt(patch.heartbeatMinutes, new Date(nextUpdatedAt))
      : current.nextHeartbeatAt
  const nextRetryPolicy = sanitizeRetryPolicy(patch.retryPolicy || current.retryPolicy)
  const nextRunPolicy = sanitizeRunPolicy(patch.runPolicy || current.runPolicy)
  const nextPreferredAgentNames = sanitizePreferredAgentNames(
    patch.preferredAgentNames === undefined ? current.preferredAgentNames : patch.preferredAgentNames,
  )
  getDb().prepare(`
    update automations
    set title = ?, goal = ?, kind = ?, schedule_json = ?, heartbeat_minutes = ?, execution_mode = ?, autonomy_policy = ?,
      project_directory = ?, preferred_agents_json = ?, retry_max_attempts = ?, retry_base_delay_minutes = ?, retry_max_delay_minutes = ?,
      run_daily_run_cap = ?, run_max_duration_minutes = ?,
      updated_at = ?, next_run_at = ?, next_heartbeat_at = ?
    where id = ?
  `).run(
    patch.title?.trim() || current.title,
    patch.goal?.trim() || current.goal,
    patch.kind || current.kind,
    JSON.stringify(nextSchedule),
    patch.heartbeatMinutes ?? current.heartbeatMinutes,
    patch.executionMode || current.executionMode,
    patch.autonomyPolicy || current.autonomyPolicy,
    patch.projectDirectory === undefined ? current.projectDirectory : patch.projectDirectory,
    JSON.stringify(nextPreferredAgentNames),
    nextRetryPolicy.maxRetries,
    nextRetryPolicy.baseDelayMinutes,
    nextRetryPolicy.maxDelayMinutes,
    nextRunPolicy.dailyRunCap,
    nextRunPolicy.maxRunDurationMinutes,
    nextUpdatedAt,
    nextRunAt,
    nextHeartbeat,
    automationId,
  )
  return getAutomationDetail(automationId)
}

export function updateAutomationStatus(automationId: string, status: AutomationStatus) {
  const now = new Date().toISOString()
  const existing = getAutomationRow(automationId)
  const heartbeatAt = existing
    ? status === 'archived' || status === 'paused'
      ? null
      : nextHeartbeatAt(existing.heartbeat_minutes, new Date(now))
    : null
  const pausedFromStatus = status === 'paused'
    ? (existing?.status === 'paused' ? existing.paused_from_status : existing?.status) || null
    : null
  getDb().prepare('update automations set status = ?, paused_from_status = ?, updated_at = ?, next_heartbeat_at = ? where id = ?')
    .run(status, pausedFromStatus, now, heartbeatAt, automationId)
  return getAutomationDetail(automationId)
}

export function resumeAutomationStatus(automationId: string) {
  const existing = getAutomationRow(automationId)
  if (!existing) return null
  const detail = getAutomationDetail(automationId)
  const restoredStatus: AutomationStatus = existing.paused_from_status && existing.paused_from_status !== 'paused' && existing.paused_from_status !== 'archived'
    ? existing.paused_from_status as AutomationStatus
    : detail?.brief?.approvedAt
      ? 'ready'
      : hasBlockingInboxItemsForAutomation(automationId)
        ? 'needs_user'
        : detail?.latestRunStatus === 'failed'
          ? 'failed'
          : detail?.latestRunStatus === 'completed'
            ? 'completed'
            : 'draft'
  const now = new Date().toISOString()
  getDb().prepare('update automations set status = ?, paused_from_status = null, updated_at = ?, next_heartbeat_at = ? where id = ?')
    .run(restoredStatus, now, nextHeartbeatAt(existing.heartbeat_minutes, new Date(now)), automationId)
  return getAutomationDetail(automationId)
}

export function saveAutomationBrief(automationId: string, brief: ExecutionBrief) {
  const boundedBrief = normalizeExecutionBriefForStorage(brief)
  withTransaction((db) => {
    const now = new Date().toISOString()
    db.prepare(`
      insert into automation_briefs (automation_id, brief_json, updated_at)
      values (?, ?, ?)
      on conflict(automation_id) do update set brief_json = excluded.brief_json, updated_at = excluded.updated_at
    `).run(automationId, JSON.stringify(boundedBrief), now)
    const status: AutomationStatus = boundedBrief.status === 'needs_user' ? 'needs_user' : boundedBrief.status === 'ready' ? 'ready' : 'draft'
    const automation = getAutomationRow(automationId)
    db.prepare('update automations set status = ?, updated_at = ?, next_heartbeat_at = ? where id = ?')
      .run(status, now, automation ? nextHeartbeatAt(automation.heartbeat_minutes, new Date(now)) : null, automationId)
    const existingItems = new Map(listWorkItemsForAutomation(automationId).map((item) => [item.id, item]))
    const upsert = db.prepare(`
      insert into automation_work_items (id, automation_id, run_id, title, description, status, blocking_reason, owner_agent, depends_on_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(automation_id, id) do update set
        run_id = excluded.run_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        blocking_reason = excluded.blocking_reason,
        owner_agent = excluded.owner_agent,
        depends_on_json = excluded.depends_on_json,
        updated_at = excluded.updated_at
    `)
    const seenIds = new Set<string>()
    for (const item of boundedBrief.workItems) {
      seenIds.add(item.id)
      const existingItem = existingItems.get(item.id)
      const nextStatus = boundedBrief.status === 'ready'
        ? (existingItem?.status === 'completed' || existingItem?.status === 'running' || existingItem?.status === 'failed'
            ? existingItem.status
            : 'ready')
        : (existingItem?.status === 'completed' || existingItem?.status === 'running' || existingItem?.status === 'failed'
            ? existingItem.status
            : 'blocked')
      const nextBlockingReason = nextStatus === 'ready' || nextStatus === 'running' || nextStatus === 'completed'
        ? null
        : nextStatus === 'failed'
          ? existingItem?.blockingReason || 'Work item failed in a previous run.'
          : 'Waiting for execution brief approval.'
      upsert.run(
        item.id,
        automationId,
        existingItem?.runId || null,
        item.title,
        item.description,
        nextStatus,
        nextBlockingReason,
        item.ownerAgent,
        JSON.stringify(item.dependsOn || []),
        existingItem?.createdAt || now,
        now,
      )
    }
    for (const existingItem of existingItems.values()) {
      if (seenIds.has(existingItem.id)) continue
      if (existingItem.status === 'completed' || existingItem.status === 'failed') continue
      db.prepare(`
        update automation_work_items
        set status = ?, blocking_reason = ?, updated_at = ?
        where automation_id = ? and id = ?
      `).run('blocked', 'Not included in the latest brief revision.', now, automationId, existingItem.id)
    }
  })
  return getAutomationDetail(automationId)
}

export function createAutomationRun(
  automationId: string,
  kind: AutomationRunKind,
  title: string,
  options: { attempt?: number, retryOfRunId?: string | null } = {},
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
  options: { attempt?: number, retryOfRunId?: string | null } = {},
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
}

export function createAutomationRunWhenNoActive(
  automationId: string,
  kind: AutomationRunKind,
  title: string,
  options: { attempt?: number, retryOfRunId?: string | null } = {},
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
      db.prepare('update automation_work_items set status = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status = ?')
        .run('running', now, run.automationId, 'ready')
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
