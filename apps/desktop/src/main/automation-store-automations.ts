import type {
  AutomationDetail,
  AutomationDraft,
  AutomationListPayload,
  AutomationStatus,
  ExecutionBrief,
} from '@open-cowork/shared'
import { computeNextAutomationRunAt } from './automation-schedule.ts'
import { normalizeExecutionBriefForStorage } from './automation-brief-limits.ts'
import { getDb, withTransaction } from './automation-store-db.ts'
import {
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

export const AUTOMATION_LIST_INBOX_PER_AUTOMATION_LIMIT = 1000
export const AUTOMATION_LIST_WORK_ITEM_PER_AUTOMATION_LIMIT = 1000

function getBrief(automationId: string): ExecutionBrief | null {
  const row = getDb().prepare('select brief_json from automation_briefs where automation_id = ?').get(automationId) as { brief_json?: string } | undefined
  return row ? parseJson<ExecutionBrief | null>(row.brief_json, null) : null
}

export function getAutomationRow(automationId: string) {
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
  const inbox = (db.prepare(`
    select *
    from (
      select *, row_number() over (partition by automation_id order by updated_at desc, id desc) as list_rank
      from automation_inbox
      where status = ?
    )
    where list_rank <= ?
    order by updated_at desc, id desc
  `).all('open', AUTOMATION_LIST_INBOX_PER_AUTOMATION_LIMIT) as DbRow[]).map(rowToInbox)
  const workItems = (db.prepare(`
    select *
    from (
      select *, row_number() over (partition by automation_id order by updated_at desc, id desc) as list_rank
      from automation_work_items
    )
    where list_rank <= ?
    order by updated_at desc, id desc
  `).all(AUTOMATION_LIST_WORK_ITEM_PER_AUTOMATION_LIMIT) as DbRow[]).map(rowToWorkItem)
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
