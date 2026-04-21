import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AutomationAutonomyPolicy,
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationDraft,
  AutomationExecutionMode,
  AutomationFailureCode,
  AutomationRetryPolicy,
  AutomationRunPolicy,
  AutomationInboxItem,
  AutomationListPayload,
  AutomationRun,
  AutomationRunKind,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationStatus,
  AutomationSummary,
  AutomationWorkItem,
  ExecutionBrief,
} from '@open-cowork/shared'
import { getAppDataDir } from './config-loader.ts'
import { computeNextAutomationRunAt } from './automation-schedule.ts'

type DbRow = Record<string, unknown>

type AutomationRecord = {
  id: string
  title: string
  goal: string
  kind: string
  status: string
  paused_from_status: string | null
  schedule_json: string
  heartbeat_minutes: number
  retry_max_attempts: number
  retry_base_delay_minutes: number
  retry_max_delay_minutes: number
  run_daily_run_cap: number
  run_max_duration_minutes: number
  execution_mode: string
  autonomy_policy: string
  project_directory: string | null
  preferred_agents_json: string
  created_at: string
  updated_at: string
  next_run_at: string | null
  last_run_at: string | null
  next_heartbeat_at: string | null
  last_heartbeat_at: string | null
  latest_run_id: string | null
  latest_run_status: string | null
  latest_session_id: string | null
}

let automationDb: DatabaseSync | null = null

const DEFAULT_RETRY_POLICY: AutomationRetryPolicy = {
  maxRetries: 3,
  baseDelayMinutes: 5,
  maxDelayMinutes: 60,
}

const DEFAULT_RUN_POLICY: AutomationRunPolicy = {
  dailyRunCap: 6,
  maxRunDurationMinutes: 120,
}

function getAutomationDbPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'automation.sqlite')
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function addMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()
}

function nextHeartbeatAt(heartbeatMinutes: number, from = new Date()) {
  return addMinutes(from.toISOString(), Math.max(1, heartbeatMinutes))
}

function sanitizeRetryPolicy(policy?: Partial<AutomationRetryPolicy> | null): AutomationRetryPolicy {
  const rawMaxRetries = policy?.maxRetries
  const rawBaseDelayMinutes = policy?.baseDelayMinutes
  const rawMaxDelayMinutes = policy?.maxDelayMinutes
  const maxRetries = typeof rawMaxRetries === 'number' && Number.isFinite(rawMaxRetries)
    ? Math.max(0, Math.min(10, Math.trunc(rawMaxRetries)))
    : DEFAULT_RETRY_POLICY.maxRetries
  const baseDelayMinutes = typeof rawBaseDelayMinutes === 'number' && Number.isFinite(rawBaseDelayMinutes)
    ? Math.max(1, Math.min(24 * 60, Math.trunc(rawBaseDelayMinutes)))
    : DEFAULT_RETRY_POLICY.baseDelayMinutes
  const maxDelayMinutes = typeof rawMaxDelayMinutes === 'number' && Number.isFinite(rawMaxDelayMinutes)
    ? Math.max(baseDelayMinutes, Math.min(7 * 24 * 60, Math.trunc(rawMaxDelayMinutes)))
    : Math.max(baseDelayMinutes, DEFAULT_RETRY_POLICY.maxDelayMinutes)
  return { maxRetries, baseDelayMinutes, maxDelayMinutes }
}

function sanitizeRunPolicy(policy?: Partial<AutomationRunPolicy> | null): AutomationRunPolicy {
  const rawDailyRunCap = policy?.dailyRunCap
  const rawMaxRunDurationMinutes = policy?.maxRunDurationMinutes
  const dailyRunCap = typeof rawDailyRunCap === 'number' && Number.isFinite(rawDailyRunCap)
    ? Math.max(1, Math.min(100, Math.trunc(rawDailyRunCap)))
    : DEFAULT_RUN_POLICY.dailyRunCap
  const maxRunDurationMinutes = typeof rawMaxRunDurationMinutes === 'number' && Number.isFinite(rawMaxRunDurationMinutes)
    ? Math.max(1, Math.min(24 * 60, Math.trunc(rawMaxRunDurationMinutes)))
    : DEFAULT_RUN_POLICY.maxRunDurationMinutes
  return { dailyRunCap, maxRunDurationMinutes }
}

function sanitizePreferredAgentNames(names?: string[] | null) {
  return Array.from(new Set(
    (Array.isArray(names) ? names : [])
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
      .filter((name) => name !== 'build' && name !== 'plan' && name !== 'cowork-exec'),
  )).slice(0, 16)
}

function computeRetryDelayMinutes(policy: AutomationRetryPolicy, attempt: number) {
  const exponent = Math.max(0, attempt - 1)
  const raw = policy.baseDelayMinutes * 2 ** exponent
  return Math.min(policy.maxDelayMinutes, raw)
}

function computeNextRetryAt(policy: AutomationRetryPolicy, attempt: number, fromIso: string) {
  return addMinutes(fromIso, computeRetryDelayMinutes(policy, attempt))
}

function formatDayKey(value: Date | string, timezone: string) {
  const date = value instanceof Date ? value : new Date(value)
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name?: string }>
  if (rows.some((row) => row.name === column)) return
  db.exec(`alter table ${table} add column ${column} ${definition}`)
}

function getDb() {
  if (automationDb) return automationDb
  const db = new DatabaseSync(getAutomationDbPath())
  db.exec('pragma journal_mode = WAL;')
  db.exec(`
    create table if not exists automations (
      id text primary key,
      title text not null,
      goal text not null,
      kind text not null,
      status text not null,
      paused_from_status text,
      schedule_json text not null,
      heartbeat_minutes integer not null,
      retry_max_attempts integer not null default 3,
      retry_base_delay_minutes integer not null default 5,
      retry_max_delay_minutes integer not null default 60,
      run_daily_run_cap integer not null default 6,
      run_max_duration_minutes integer not null default 120,
      execution_mode text not null,
      autonomy_policy text not null,
      project_directory text,
      preferred_agents_json text not null default '[]',
      created_at text not null,
      updated_at text not null,
      next_run_at text,
      last_run_at text,
      next_heartbeat_at text,
      last_heartbeat_at text,
      latest_run_id text,
      latest_run_status text,
      latest_session_id text
    );

    create table if not exists automation_briefs (
      automation_id text primary key,
      brief_json text not null,
      updated_at text not null
    );

    create table if not exists automation_runs (
      id text primary key,
      automation_id text not null,
      session_id text,
      kind text not null,
      status text not null,
      title text not null,
      summary text,
      error text,
      failure_code text,
      attempt integer not null default 1,
      retry_of_run_id text,
      next_retry_at text,
      created_at text not null,
      started_at text,
      finished_at text
    );

    create table if not exists automation_work_items (
      id text not null,
      automation_id text not null,
      run_id text,
      title text not null,
      description text not null,
      status text not null,
      blocking_reason text,
      owner_agent text,
      depends_on_json text not null,
      created_at text not null,
      updated_at text not null,
      primary key (automation_id, id)
    );

    create table if not exists automation_inbox (
      id text primary key,
      automation_id text not null,
      run_id text,
      session_id text,
      question_id text,
      type text not null,
      status text not null,
      title text not null,
      body text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists automation_deliveries (
      id text primary key,
      automation_id text not null,
      run_id text,
      provider text not null,
      target text not null,
      status text not null,
      title text not null,
      body text not null,
      created_at text not null
    );
  `)
  const workItemsSql = db.prepare("select sql from sqlite_master where type = 'table' and name = 'automation_work_items'").get() as { sql?: string } | undefined
  if (!workItemsSql?.sql?.includes('primary key (automation_id, id)')) {
    db.exec(`
      create table automation_work_items_v2 (
        id text not null,
        automation_id text not null,
        run_id text,
        title text not null,
        description text not null,
        status text not null,
        blocking_reason text,
        owner_agent text,
        depends_on_json text not null,
        created_at text not null,
        updated_at text not null,
        primary key (automation_id, id)
      );
      insert into automation_work_items_v2 (
        id, automation_id, run_id, title, description, status, blocking_reason, owner_agent, depends_on_json, created_at, updated_at
      )
      select id, automation_id, run_id, title, description, status, blocking_reason, owner_agent, depends_on_json, created_at, updated_at
      from automation_work_items;
      drop table automation_work_items;
      alter table automation_work_items_v2 rename to automation_work_items;
    `)
  }
  ensureColumn(db, 'automations', 'paused_from_status', 'text')
  ensureColumn(db, 'automations', 'next_heartbeat_at', 'text')
  ensureColumn(db, 'automations', 'last_heartbeat_at', 'text')
  ensureColumn(db, 'automations', 'retry_max_attempts', 'integer not null default 3')
  ensureColumn(db, 'automations', 'retry_base_delay_minutes', 'integer not null default 5')
  ensureColumn(db, 'automations', 'retry_max_delay_minutes', 'integer not null default 60')
  ensureColumn(db, 'automations', 'run_daily_run_cap', 'integer not null default 6')
  ensureColumn(db, 'automations', 'run_max_duration_minutes', 'integer not null default 120')
  ensureColumn(db, 'automations', 'preferred_agents_json', `text not null default '[]'`)
  ensureColumn(db, 'automation_runs', 'attempt', 'integer not null default 1')
  ensureColumn(db, 'automation_runs', 'retry_of_run_id', 'text')
  ensureColumn(db, 'automation_runs', 'next_retry_at', 'text')
  ensureColumn(db, 'automation_runs', 'failure_code', 'text')
  automationDb = db
  return db
}

function rowToAutomationSummary(row: AutomationRecord): AutomationSummary {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    kind: row.kind as AutomationSummary['kind'],
    status: row.status as AutomationStatus,
    schedule: parseJson<AutomationSchedule>(row.schedule_json, {
      type: 'weekly',
      timezone: 'UTC',
      dayOfWeek: 1,
      runAtHour: 9,
      runAtMinute: 0,
    }),
    heartbeatMinutes: row.heartbeat_minutes,
    retryPolicy: sanitizeRetryPolicy({
      maxRetries: row.retry_max_attempts,
      baseDelayMinutes: row.retry_base_delay_minutes,
      maxDelayMinutes: row.retry_max_delay_minutes,
    }),
    runPolicy: sanitizeRunPolicy({
      dailyRunCap: row.run_daily_run_cap,
      maxRunDurationMinutes: row.run_max_duration_minutes,
    }),
    executionMode: row.execution_mode as AutomationExecutionMode,
    autonomyPolicy: row.autonomy_policy as AutomationAutonomyPolicy,
    projectDirectory: row.project_directory,
    preferredAgentNames: sanitizePreferredAgentNames(parseJson<string[]>(row.preferred_agents_json, [])),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    nextHeartbeatAt: row.next_heartbeat_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    latestRunStatus: row.latest_run_status as AutomationRunStatus | null,
    latestRunId: row.latest_run_id,
  }
}

function rowToRun(row: DbRow): AutomationRun {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    kind: String(row.kind) as AutomationRunKind,
    status: String(row.status) as AutomationRunStatus,
    title: String(row.title),
    summary: typeof row.summary === 'string' ? row.summary : null,
    error: typeof row.error === 'string' ? row.error : null,
    failureCode: typeof row.failure_code === 'string' ? row.failure_code as AutomationFailureCode : null,
    attempt: Number(row.attempt) || 1,
    retryOfRunId: typeof row.retry_of_run_id === 'string' ? row.retry_of_run_id : null,
    nextRetryAt: typeof row.next_retry_at === 'string' ? row.next_retry_at : null,
    createdAt: String(row.created_at),
    startedAt: typeof row.started_at === 'string' ? row.started_at : null,
    finishedAt: typeof row.finished_at === 'string' ? row.finished_at : null,
  }
}

function rowToInbox(row: DbRow): AutomationInboxItem {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    questionId: typeof row.question_id === 'string' ? row.question_id : null,
    type: String(row.type) as AutomationInboxItem['type'],
    status: String(row.status) as AutomationInboxItem['status'],
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToWorkItem(row: DbRow): AutomationWorkItem {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as AutomationWorkItem['status'],
    blockingReason: typeof row.blocking_reason === 'string' ? row.blocking_reason : null,
    ownerAgent: typeof row.owner_agent === 'string' ? row.owner_agent : null,
    dependsOn: parseJson<string[]>(row.depends_on_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToDelivery(row: DbRow): AutomationDeliveryRecord {
  return {
    id: String(row.id),
    automationId: String(row.automation_id),
    runId: typeof row.run_id === 'string' ? row.run_id : null,
    provider: String(row.provider) as AutomationDeliveryRecord['provider'],
    target: String(row.target),
    status: String(row.status) as AutomationDeliveryRecord['status'],
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
  }
}

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

export function clearAutomationStoreCache() {
  automationDb?.close()
  automationDb = null
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
  const db = getDb()
  const now = new Date().toISOString()
  db.prepare(`
    insert into automation_briefs (automation_id, brief_json, updated_at)
    values (?, ?, ?)
    on conflict(automation_id) do update set brief_json = excluded.brief_json, updated_at = excluded.updated_at
  `).run(automationId, JSON.stringify(brief), now)
  const status: AutomationStatus = brief.status === 'needs_user' ? 'needs_user' : brief.status === 'ready' ? 'ready' : 'draft'
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
  for (const item of brief.workItems) {
    seenIds.add(item.id)
    const existingItem = existingItems.get(item.id)
    const nextStatus = brief.status === 'ready'
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
  return getAutomationDetail(automationId)
}

export function createAutomationRun(
  automationId: string,
  kind: AutomationRunKind,
  title: string,
  options: { attempt?: number, retryOfRunId?: string | null } = {},
) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const automation = getAutomationRow(automationId)
  const schedule = automation ? parseJson<AutomationSchedule>(automation.schedule_json, { type: 'weekly', timezone: 'UTC' }) : null
  const nextStatus = kind === 'heartbeat'
    ? (automation?.status as AutomationStatus | undefined) || 'draft'
    : 'running'
  const nextRunAt = automation && kind !== 'heartbeat' && automation.next_run_at && automation.next_run_at <= now && schedule
    ? computeNextAutomationRunAt(schedule, new Date(now))
    : automation?.next_run_at || null
  getDb().prepare(`
    insert into automation_runs (
      id, automation_id, session_id, kind, status, title, summary, error, failure_code, attempt, retry_of_run_id, next_retry_at, created_at, started_at, finished_at
    ) values (?, ?, null, ?, ?, ?, null, null, null, ?, ?, null, ?, null, null)
  `).run(id, automationId, kind, 'queued', title, options.attempt || 1, options.retryOfRunId || null, now)
  getDb().prepare('update automations set latest_run_id = ?, latest_run_status = ?, updated_at = ?, status = ?, next_run_at = ? where id = ?')
    .run(id, 'queued', now, nextStatus, nextRunAt, automationId)
  return getRun(id)
}

export function getActiveRunForAutomation(automationId: string) {
  const row = getDb().prepare(`
    select *
    from automation_runs
    where automation_id = ?
      and status in ('queued', 'running')
    order by created_at desc
    limit 1
  `).get(automationId) as DbRow | undefined
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
  const now = new Date().toISOString()
  const run = getRun(runId)
  if (!run) return null
  getDb().prepare('update automation_runs set status = ?, session_id = ?, started_at = ? where id = ?')
    .run('running', sessionId, now, runId)
  getDb().prepare('update automations set latest_run_status = ?, latest_run_id = ?, latest_session_id = ?, updated_at = ?, status = ? where id = ?')
    .run('running', runId, sessionId, now, 'running', run.automationId)
  if (run.kind === 'execution') {
    getDb().prepare('update automation_work_items set status = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status = ?')
      .run('running', now, run.automationId, 'ready')
  }
  return getRun(runId)
}

export function markHeartbeatCompleted(runId: string, summary: string | null) {
  const now = new Date().toISOString()
  const run = getRun(runId)
  if (!run) return null
  const automation = getAutomationDetail(run.automationId)
  getDb().prepare('update automation_runs set status = ?, summary = ?, finished_at = ? where id = ?')
    .run('completed', summary, now, runId)
  if (automation) {
    getDb().prepare('update automations set latest_run_status = ?, updated_at = ?, next_heartbeat_at = ?, last_heartbeat_at = ? where id = ?')
      .run('completed', now, nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)), now, run.automationId)
  }
  return getRun(runId)
}

export function markRunNeedsUser(runId: string, summary: string | null = null) {
  const now = new Date().toISOString()
  const run = getRun(runId)
  if (!run) return null
  getDb().prepare('update automation_runs set status = ?, summary = ?, finished_at = ? where id = ?')
    .run('needs_user', summary, now, runId)
  const automation = getAutomationDetail(run.automationId)
  getDb().prepare('update automations set latest_run_status = ?, updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
    .run('needs_user', now, 'needs_user', automation ? nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)) : null, run.automationId)
  return getRun(runId)
}

export function markRunCompleted(runId: string, summary: string | null, sessionId?: string | null) {
  const now = new Date().toISOString()
  const run = getRun(runId)
  if (!run) return null
  const retryRootRunId = run.retryOfRunId || run.id
  getDb().prepare('update automation_runs set status = ?, summary = ?, error = null, failure_code = null, session_id = coalesce(?, session_id), finished_at = ? where id = ?')
    .run('completed', summary, sessionId || null, now, runId)
  clearPendingRetriesForChain(retryRootRunId)
  const row = getAutomationRow(run.automationId)
  if (row) {
    const schedule = parseJson<AutomationSchedule>(row.schedule_json, { type: 'weekly', timezone: 'UTC' })
    if (run.kind === 'execution') {
      getDb().prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, last_run_at = ?, next_run_at = ?, next_heartbeat_at = ? where id = ?')
        .run('completed', sessionId || null, now, 'completed', now, computeNextAutomationRunAt(schedule, new Date(now)), nextHeartbeatAt(row.heartbeat_minutes, new Date(now)), run.automationId)
    } else {
      getDb().prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
        .run('completed', sessionId || null, now, 'ready', nextHeartbeatAt(row.heartbeat_minutes, new Date(now)), run.automationId)
    }
  }
  if (run.kind === 'execution') {
    getDb().prepare('update automation_work_items set status = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status in (\'ready\', \'running\')')
      .run('completed', now, run.automationId)
  }
  return getRun(runId)
}

export function markRunFailed(
  runId: string,
  error: string,
  sessionId?: string | null,
  options: { retryable?: boolean, failureCode?: AutomationFailureCode | null } = {},
) {
  const now = new Date().toISOString()
  const run = getRun(runId)
  if (!run) return null
  const automation = getAutomationDetail(run.automationId)
  const retryPolicy = sanitizeRetryPolicy(automation?.retryPolicy)
  const allowRetry = options.retryable !== false
  const nextRetryAt = automation && allowRetry && run.kind !== 'heartbeat' && run.attempt <= retryPolicy.maxRetries
    ? computeNextRetryAt(retryPolicy, run.attempt, now)
    : null
  getDb().prepare('update automation_runs set status = ?, error = ?, failure_code = ?, session_id = coalesce(?, session_id), next_retry_at = ?, finished_at = ? where id = ?')
    .run('failed', error, options.failureCode || null, sessionId || null, nextRetryAt, now, runId)
  getDb().prepare('update automations set latest_run_status = ?, latest_session_id = coalesce(?, latest_session_id), updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
    .run('failed', sessionId || null, now, 'failed', automation ? nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)) : null, run.automationId)
  if (run.kind === 'execution') {
    if (nextRetryAt) {
      getDb().prepare('update automation_work_items set status = ?, blocking_reason = null, updated_at = ? where automation_id = ? and status = ?')
        .run('ready', now, run.automationId, 'running')
    } else {
      getDb().prepare('update automation_work_items set status = ?, blocking_reason = ?, updated_at = ? where automation_id = ? and status = ?')
        .run('failed', error, now, run.automationId, 'running')
    }
  }
  return getRun(runId)
}

export function markRunCancelled(runId: string, summary: string | null = null) {
  const now = new Date().toISOString()
  const run = getRun(runId)
  if (!run) return null
  const automation = getAutomationDetail(run.automationId)
  const nextStatus: AutomationStatus = run.kind === 'execution' && automation?.brief?.approvedAt
    ? 'ready'
    : run.kind === 'enrichment'
      ? 'draft'
      : automation?.status || 'draft'
  getDb().prepare('update automation_runs set status = ?, summary = ?, finished_at = ? where id = ?')
    .run('cancelled', summary, now, runId)
  getDb().prepare('update automations set latest_run_status = ?, updated_at = ?, status = ?, next_heartbeat_at = ? where id = ?')
    .run('cancelled', now, nextStatus, automation ? nextHeartbeatAt(automation.heartbeatMinutes, new Date(now)) : null, run.automationId)
  if (run.kind === 'execution') {
    getDb().prepare('update automation_work_items set status = ?, blocking_reason = ?, updated_at = ? where automation_id = ? and status = ?')
      .run('ready', 'Execution was cancelled before completion.', now, run.automationId, 'running')
  }
  return getRun(runId)
}

export function createInboxItem(input: {
  automationId: string
  runId?: string | null
  sessionId?: string | null
  questionId?: string | null
  type: AutomationInboxItem['type']
  title: string
  body: string
  promoteAutomationStatus?: boolean
}) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  getDb().prepare(`
    insert into automation_inbox (id, automation_id, run_id, session_id, question_id, type, status, title, body, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
  `).run(id, input.automationId, input.runId || null, input.sessionId || null, input.questionId || null, input.type, input.title, input.body, now, now)
  const shouldPromote = input.promoteAutomationStatus ?? (
    input.type === 'clarification'
    || input.type === 'approval'
    || input.type === 'failure'
  )
  if (shouldPromote) {
    getDb().prepare('update automations set status = ?, updated_at = ? where id = ?').run('needs_user', now, input.automationId)
  }
  return getInboxItem(id)
}

export function getInboxItem(itemId: string) {
  const row = getDb().prepare('select * from automation_inbox where id = ?').get(itemId) as DbRow | undefined
  return row ? rowToInbox(row) : null
}

export function resolveInboxItem(itemId: string, status: AutomationInboxItem['status']) {
  getDb().prepare('update automation_inbox set status = ?, updated_at = ? where id = ?').run(status, new Date().toISOString(), itemId)
  return getInboxItem(itemId)
}

export function listOpenInboxForAutomation(automationId: string, type?: AutomationInboxItem['type']) {
  if (type) {
    return (getDb().prepare('select * from automation_inbox where automation_id = ? and type = ? and status = ? order by updated_at desc').all(automationId, type, 'open') as DbRow[]).map(rowToInbox)
  }
  return (getDb().prepare('select * from automation_inbox where automation_id = ? and status = ? order by updated_at desc').all(automationId, 'open') as DbRow[]).map(rowToInbox)
}

export function openInboxItemsForQuestion(questionId: string) {
  return (getDb().prepare('select * from automation_inbox where question_id = ? and status = ?').all(questionId, 'open') as DbRow[]).map(rowToInbox)
}

export function listInboxForSession(sessionId: string) {
  return (getDb().prepare('select * from automation_inbox where session_id = ? and status = ?').all(sessionId, 'open') as DbRow[]).map(rowToInbox)
}

export function attachRunSession(runId: string, sessionId: string) {
  const run = getRun(runId)
  if (!run) return null
  const now = new Date().toISOString()
  getDb().prepare('update automation_runs set session_id = ?, started_at = coalesce(started_at, ?) where id = ?').run(sessionId, now, runId)
  getDb().prepare('update automations set latest_session_id = ?, updated_at = ? where id = ?').run(sessionId, now, run.automationId)
  return getRun(runId)
}

export function createDeliveryRecord(input: {
  automationId: string
  runId?: string | null
  provider: AutomationDeliveryRecord['provider']
  target: string
  status: AutomationDeliveryRecord['status']
  title: string
  body: string
}) {
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  getDb().prepare(`
    insert into automation_deliveries (id, automation_id, run_id, provider, target, status, title, body, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.automationId, input.runId || null, input.provider, input.target, input.status, input.title, input.body, createdAt)
  const row = getDb().prepare('select * from automation_deliveries where id = ?').get(id) as DbRow | undefined
  return row ? rowToDelivery(row) : null
}
