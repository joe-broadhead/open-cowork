import type {
  WorkflowListPayload,
  WorkflowRun,
  WorkflowSchedule,
  WorkflowSummary,
  WorkflowTrigger,
} from '@open-cowork/shared'

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function optionalFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : value === null
      ? null
      : undefined
}

function optionalString(value: unknown) {
  return typeof value === 'string'
    ? value
    : value === null
      ? null
      : undefined
}

function redactWorkflowSchedule(value: unknown): WorkflowSchedule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = record.type
  if (
    (type !== 'one_time' && type !== 'daily' && type !== 'weekly' && type !== 'monthly')
    || typeof record.timezone !== 'string'
  ) return null
  return {
    type,
    timezone: record.timezone,
    runAtHour: optionalFiniteNumber(record.runAtHour),
    runAtMinute: optionalFiniteNumber(record.runAtMinute),
    dayOfWeek: optionalFiniteNumber(record.dayOfWeek),
    dayOfMonth: optionalFiniteNumber(record.dayOfMonth),
    startAt: optionalString(record.startAt),
  }
}

function redactWorkflowTrigger(value: unknown): WorkflowTrigger | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = record.type
  if (
    typeof record.id !== 'string'
    || (type !== 'manual' && type !== 'schedule' && type !== 'webhook')
  ) return null
  const schedule = redactWorkflowSchedule(record.schedule)
  return {
    id: record.id,
    type,
    enabled: record.enabled !== false,
    ...(type === 'schedule' ? { schedule } : {}),
  }
}

function redactWorkflowSummary(value: unknown): WorkflowSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.title !== 'string') return null
  return {
    id: record.id,
    title: record.title,
    instructions: typeof record.instructions === 'string' ? record.instructions : '',
    agentName: typeof record.agentName === 'string' ? record.agentName : 'build',
    skillNames: stringArray(record.skillNames),
    toolIds: stringArray(record.toolIds),
    steps: Array.isArray(record.steps)
      ? record.steps.flatMap((step) => {
          if (!step || typeof step !== 'object' || Array.isArray(step)) return []
          const entry = step as Record<string, unknown>
          if (typeof entry.id !== 'string' || typeof entry.title !== 'string') return []
          return [{
            id: entry.id,
            title: entry.title,
            detail: stringOrNull(entry.detail),
          }]
        })
      : [],
    status: record.status === 'paused'
      || record.status === 'running'
      || record.status === 'failed'
      || record.status === 'archived'
      ? record.status
      : 'active',
    projectDirectory: stringOrNull(record.projectDirectory),
    draftSessionId: stringOrNull(record.draftSessionId),
    triggers: Array.isArray(record.triggers)
      ? record.triggers
          .map(redactWorkflowTrigger)
          .filter((trigger): trigger is WorkflowTrigger => Boolean(trigger))
      : [],
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    nextRunAt: stringOrNull(record.nextRunAt),
    lastRunAt: stringOrNull(record.lastRunAt),
    latestRunId: stringOrNull(record.latestRunId),
    latestRunStatus: record.latestRunStatus === 'queued'
      || record.latestRunStatus === 'running'
      || record.latestRunStatus === 'completed'
      || record.latestRunStatus === 'failed'
      || record.latestRunStatus === 'cancelled'
      ? record.latestRunStatus
      : null,
    latestRunSessionId: stringOrNull(record.latestRunSessionId),
    latestRunSummary: stringOrNull(record.latestRunSummary),
    webhookUrl: stringOrNull(record.webhookUrl),
  }
}

function redactWorkflowRun(value: unknown): WorkflowRun | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== 'string'
    || typeof record.workflowId !== 'string'
    || (record.triggerType !== 'manual' && record.triggerType !== 'schedule' && record.triggerType !== 'webhook')
  ) return null
  const status = record.status === 'running'
    || record.status === 'completed'
    || record.status === 'failed'
    || record.status === 'cancelled'
    ? record.status
    : 'queued'
  return {
    id: record.id,
    workflowId: record.workflowId,
    sessionId: stringOrNull(record.sessionId),
    triggerType: record.triggerType,
    // Arbitrary caller input is not used by the offline playbook UI and can
    // contain credentials or PII. It never crosses the cache boundary.
    triggerPayload: null,
    status,
    title: typeof record.title === 'string' ? record.title : '',
    summary: stringOrNull(record.summary),
    error: stringOrNull(record.error),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    startedAt: stringOrNull(record.startedAt),
    finishedAt: stringOrNull(record.finishedAt),
  }
}

/**
 * Converts an untrusted workflow response into the only workflow shape that is
 * permitted in the offline cache. This module deliberately imports public
 * workflow contracts only; internal webhook-secret shapes cannot escape it.
 */
export function redactWorkflowListForCache(value: unknown): WorkflowListPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<WorkflowListPayload>
  return {
    workflows: Array.isArray(record.workflows)
      ? record.workflows
          .map(redactWorkflowSummary)
          .filter((workflow): workflow is WorkflowSummary => Boolean(workflow))
      : [],
    runs: Array.isArray(record.runs)
      ? record.runs
          .map(redactWorkflowRun)
          .filter((run): run is WorkflowRun => Boolean(run))
      : [],
    nextCursor: stringOrNull(record.nextCursor),
    totalEstimate: typeof record.totalEstimate === 'number' && Number.isFinite(record.totalEstimate)
      ? record.totalEstimate
      : undefined,
  }
}
