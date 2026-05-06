import type {
  AutomationAutonomyPolicy,
  AutomationDeliveryRecord,
  AutomationExecutionMode,
  AutomationFailureCode,
  AutomationInboxItem,
  AutomationRetryPolicy,
  AutomationRun,
  AutomationRunKind,
  AutomationRunPolicy,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationStatus,
  AutomationSummary,
  AutomationWorkItem,
} from '@open-cowork/shared'

export type DbRow = Record<string, unknown>

export type AutomationRecord = {
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

const DEFAULT_RETRY_POLICY: AutomationRetryPolicy = {
  maxRetries: 3,
  baseDelayMinutes: 5,
  maxDelayMinutes: 60,
}

const DEFAULT_RUN_POLICY: AutomationRunPolicy = {
  dailyRunCap: 6,
  maxRunDurationMinutes: 120,
}

export function parseJson<T>(value: unknown, fallback: T): T {
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

export function nextHeartbeatAt(heartbeatMinutes: number, from = new Date()) {
  return addMinutes(from.toISOString(), Math.max(1, heartbeatMinutes))
}

export function sanitizeRetryPolicy(policy?: Partial<AutomationRetryPolicy> | null): AutomationRetryPolicy {
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

export function sanitizeRunPolicy(policy?: Partial<AutomationRunPolicy> | null): AutomationRunPolicy {
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

export function sanitizePreferredAgentNames(names?: string[] | null) {
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

export function computeNextRetryAt(policy: AutomationRetryPolicy, attempt: number, fromIso: string) {
  return addMinutes(fromIso, computeRetryDelayMinutes(policy, attempt))
}

export function formatDayKey(value: Date | string, timezone: string) {
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

export function rowToAutomationSummary(row: AutomationRecord): AutomationSummary {
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

export function rowToRun(row: DbRow): AutomationRun {
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

export function rowToInbox(row: DbRow): AutomationInboxItem {
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

export function rowToWorkItem(row: DbRow): AutomationWorkItem {
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

export function rowToDelivery(row: DbRow): AutomationDeliveryRecord {
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
