import type {
  AutomationAutonomyPolicy,
  AutomationDeliveryRecord,
  AutomationDetail,
  AutomationDraft,
  AutomationExecutionMode,
  AutomationInboxItem,
  AutomationKind,
  AutomationRun,
  AutomationSchedule,
  AutomationScheduleType,
  AutomationWorkItem,
  BuiltInAgentDetail,
  CustomAgentSummary,
} from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import { formatAgentLabel } from '../chat/chat-input-utils'

export const AUTOMATION_UX_V2_FEATURE_GATE_KEY = 'open-cowork.feature.automationUxV2'

export type DraftState = {
  title: string
  goal: string
  kind: AutomationKind
  scheduleType: AutomationScheduleType
  timezone: string
  runAtHour: string
  runAtMinute: string
  dayOfWeek: string
  dayOfMonth: string
  startAt: string
  heartbeatMinutes: string
  maxRetries: string
  retryBaseDelayMinutes: string
  retryMaxDelayMinutes: string
  dailyRunCap: string
  maxRunDurationMinutes: string
  executionMode: AutomationExecutionMode
  autonomyPolicy: AutomationAutonomyPolicy
  projectDirectory: string
  preferredAgentNames: string[]
}

export type AutomationSchedulePreview = {
  cadence: string
  nextRun: string
  checkIn: string
  quietHours: string | null
}

export type AutomationAgentOption = {
  id: string
  label: string
  description: string
  source: 'builtin' | 'custom'
}

export function createDefaultDraft(overrides: Partial<Pick<DraftState, 'executionMode' | 'autonomyPolicy'>> = {}): DraftState {
  return {
    title: '',
    goal: '',
    kind: 'recurring',
    scheduleType: 'weekly',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    runAtHour: '9',
    runAtMinute: '0',
    dayOfWeek: '1',
    dayOfMonth: '1',
    startAt: '',
    heartbeatMinutes: '15',
    maxRetries: '3',
    retryBaseDelayMinutes: '5',
    retryMaxDelayMinutes: '60',
    dailyRunCap: '6',
    maxRunDurationMinutes: '120',
    executionMode: overrides.executionMode || 'planning_only',
    autonomyPolicy: overrides.autonomyPolicy || 'review-first',
    projectDirectory: '',
    preferredAgentNames: [],
  }
}

export const AUTOMATION_TEMPLATES: Array<{
  id: string
  label: string
  description: string
  apply: (current: DraftState) => DraftState
}> = [
  {
    id: 'weekly-report',
    label: 'Weekly report',
    description: 'Recurring analysis, research, and chart-heavy reporting every Monday morning.',
    apply: (current) => ({
      ...current,
      title: 'Weekly market report',
      goal: 'Build a weekly analysis and market research report, summarize the most important trends, and keep it ready for review every Monday morning.',
      kind: 'recurring',
      scheduleType: 'weekly',
      dayOfWeek: '1',
      runAtHour: '9',
      runAtMinute: '0',
      heartbeatMinutes: '15',
      maxRetries: '3',
      retryBaseDelayMinutes: '5',
      retryMaxDelayMinutes: '60',
      dailyRunCap: '4',
      maxRunDurationMinutes: '90',
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    }),
  },
  {
    id: 'managed-project',
    label: 'Managed project',
    description: 'Maintain a roadmap, prepare the next chunk of work, and keep execution-ready tasks moving.',
    apply: (current) => ({
      ...current,
      title: 'Managed product roadmap',
      goal: 'Maintain a clear roadmap for this project, prepare the next execution-ready tasks, and keep progress moving forward without guessing when context is missing.',
      kind: 'managed-project',
      scheduleType: 'daily',
      runAtHour: '10',
      runAtMinute: '0',
      heartbeatMinutes: '30',
      maxRetries: '3',
      retryBaseDelayMinutes: '10',
      retryMaxDelayMinutes: '60',
      dailyRunCap: '8',
      maxRunDurationMinutes: '180',
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    }),
  },
]

export function formatStatus(status: string) {
  return status.replace(/-/g, ' ')
}

export function formatRunKindForUser(kind: AutomationRun['kind']) {
  if (kind === 'enrichment') return 'brief preparation'
  if (kind === 'heartbeat') return 'work check-in'
  return 'execution'
}

function storageOrNull(storage?: Storage | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function isAutomationUxV2Enabled(storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    return target.getItem(AUTOMATION_UX_V2_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clampClock(value: number | null | undefined, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Number(value))) : fallback
}

function formatClock(hour: number | null | undefined, minute: number | null | undefined) {
  const safeHour = clampClock(hour, 0, 23, 9)
  const safeMinute = clampClock(minute, 0, 59, 0)
  return `${String(safeHour).padStart(2, '0')}:${String(safeMinute).padStart(2, '0')}`
}

export function formatSchedule(schedule: AutomationSchedule) {
  const time = formatClock(schedule.runAtHour, schedule.runAtMinute)
  if (schedule.type === 'one_time') return schedule.startAt ? `Once on ${formatTimestamp(schedule.startAt, '')}` : 'Manual one-time run'
  if (schedule.type === 'daily') return `Every day at ${time}`
  if (schedule.type === 'weekly') return `Every ${WEEKDAY_NAMES[clampClock(schedule.dayOfWeek, 0, 6, 1)] || 'Monday'} at ${time}`
  return `Every month on day ${clampClock(schedule.dayOfMonth, 1, 31, 1)} at ${time}`
}

export function formatTimestamp(value: string | null | undefined, empty = 'Not scheduled') {
  return value ? new Date(value).toLocaleString() : empty
}

function parseClockMinutes(value: string | null | undefined) {
  if (!value) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number.parseInt(match[1]!, 10)
  const minute = Number.parseInt(match[2]!, 10)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function isMinuteWithinQuietHours(minute: number, quietStart: string | null | undefined, quietEnd: string | null | undefined) {
  const start = parseClockMinutes(quietStart)
  const end = parseClockMinutes(quietEnd)
  if (start === null || end === null || start === end) return false
  if (start < end) return minute >= start && minute < end
  return minute >= start || minute < end
}

export function describeQuietHoursImpact(input: {
  schedule: Pick<AutomationSchedule, 'runAtHour' | 'runAtMinute'>
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
}) {
  if (!input.quietHoursStart || !input.quietHoursEnd) return null
  const runMinute = clampClock(input.schedule.runAtHour, 0, 23, 9) * 60 + clampClock(input.schedule.runAtMinute, 0, 59, 0)
  const quietWindow = `${input.quietHoursStart}-${input.quietHoursEnd}`
  if (isMinuteWithinQuietHours(runMinute, input.quietHoursStart, input.quietHoursEnd)) {
    return `Run time falls inside notification quiet hours (${quietWindow}); work can still queue, but desktop alerts stay quiet.`
  }
  return `Notification quiet hours (${quietWindow}) do not overlap the scheduled run time.`
}

function scheduleFromDraft(draft: DraftState): AutomationSchedule | null {
  try {
    return draftToPayload(draft).schedule
  } catch {
    return null
  }
}

function nextRunPreviewFromSchedule(schedule: AutomationSchedule, from = new Date()) {
  if (schedule.type === 'one_time') {
    const at = schedule.startAt ? new Date(schedule.startAt) : null
    if (!at || Number.isNaN(at.getTime())) return null
    return at.getTime() > from.getTime() ? at.toISOString() : null
  }

  const runAtHour = clampClock(schedule.runAtHour, 0, 23, 9)
  const runAtMinute = clampClock(schedule.runAtMinute, 0, 59, 0)
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setHours(runAtHour, runAtMinute, 0, 0)

  if (schedule.type === 'daily') {
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1)
    return candidate.toISOString()
  }

  if (schedule.type === 'weekly') {
    const targetDay = clampClock(schedule.dayOfWeek, 0, 6, 1)
    let delta = targetDay - candidate.getDay()
    if (delta < 0 || (delta === 0 && candidate.getTime() <= from.getTime())) delta += 7
    candidate.setDate(candidate.getDate() + delta)
    return candidate.toISOString()
  }

  const targetDay = clampClock(schedule.dayOfMonth, 1, 31, 1)
  candidate.setDate(Math.min(targetDay, new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()))
  if (candidate.getTime() <= from.getTime()) {
    candidate.setMonth(candidate.getMonth() + 1, 1)
    candidate.setDate(Math.min(targetDay, new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()))
  }
  return candidate.toISOString()
}

export function buildAutomationSchedulePreview(input: {
  schedule: AutomationSchedule
  status?: AutomationDetail['status']
  nextRunAt?: string | null
  nextHeartbeatAt?: string | null
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
}): AutomationSchedulePreview {
  const paused = input.status === 'paused' || input.status === 'archived'
  return {
    cadence: formatSchedule(input.schedule),
    nextRun: paused
      ? 'Paused; scheduled runs resume only after you resume this automation.'
      : input.nextRunAt
        ? `Next run ${formatTimestamp(input.nextRunAt, '')}`
        : input.schedule.type === 'one_time'
          ? 'No future one-time run is scheduled.'
          : 'Next run will be calculated after the automation is saved.',
    checkIn: input.nextHeartbeatAt ? `Next check-in ${formatTimestamp(input.nextHeartbeatAt, '')}` : 'No check-in is currently scheduled.',
    quietHours: describeQuietHoursImpact({
      schedule: input.schedule,
      quietHoursStart: input.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd,
    }),
  }
}

export function buildDraftSchedulePreview(input: {
  draft: DraftState
  quietHoursStart?: string | null
  quietHoursEnd?: string | null
}): AutomationSchedulePreview {
  const schedule = scheduleFromDraft(input.draft)
  if (!schedule) {
    return {
      cadence: 'Check the schedule fields before creating this automation.',
      nextRun: 'Next run cannot be previewed yet.',
      checkIn: `${input.draft.heartbeatMinutes || '15'} minute check-ins after creation.`,
      quietHours: null,
    }
  }
  const nextRunAt = nextRunPreviewFromSchedule(schedule)
  return {
    cadence: formatSchedule(schedule),
    nextRun: nextRunAt
      ? `First run ${formatTimestamp(nextRunAt, '')}`
      : schedule.type === 'one_time'
        ? 'No future one-time run is scheduled.'
        : 'First run will be calculated after creation.',
    checkIn: `${Number.parseInt(input.draft.heartbeatMinutes, 10) || 15} minute check-ins after creation.`,
    quietHours: describeQuietHoursImpact({
      schedule,
      quietHoursStart: input.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd,
    }),
  }
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function summarizeWorkItems(items: AutomationWorkItem[]) {
  return {
    total: items.length,
    completed: items.filter((item) => item.status === 'completed').length,
    ready: items.filter((item) => item.status === 'ready').length,
    running: items.filter((item) => item.status === 'running').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    failed: items.filter((item) => item.status === 'failed').length,
  }
}

export function deriveReliabilityState(input: {
  automation: AutomationDetail
  inbox: AutomationInboxItem[]
  activeRun: AutomationRun | null
  latestRun: AutomationRun | null
}) {
  const { automation, inbox, activeRun, latestRun } = input
  const hasFailureInbox = inbox.some((item) => item.type === 'failure')
  if (automation.status === 'paused' && hasFailureInbox) {
    return {
      value: 'Circuit open',
      detail: 'Paused after repeated or deterministic failures until you review it and resume.',
    }
  }
  if (latestRun?.status === 'failed' && latestRun.nextRetryAt) {
    return {
      value: 'Retry queued',
      detail: `Attempt ${latestRun.attempt + 1} is scheduled for ${formatTimestamp(latestRun.nextRetryAt, '')}.`,
    }
  }
  if (automation.status === 'needs_user') {
    const reviewItems = pluralize(inbox.length, 'open review item')
    return {
      value: 'Waiting on you',
      detail: inbox.length > 0 ? `${reviewItems} ${inbox.length === 1 ? 'is' : 'are'} blocking progress.` : 'Waiting for clarification or approval.',
    }
  }
  if (activeRun) {
    return {
      value: 'Running',
      detail: `${formatRunKindForUser(activeRun.kind)} is active right now.`,
    }
  }
  if (latestRun?.status === 'failed') {
    return {
      value: 'Needs review',
      detail: latestRun.error || 'The latest run failed without an automatic retry.',
    }
  }
  return {
    value: 'Healthy',
    detail: automation.nextHeartbeatAt ? `Next check-in ${formatTimestamp(automation.nextHeartbeatAt)}.` : 'No check-in is currently scheduled.',
  }
}

export function describeRunPolicy(automation: AutomationDetail, latestRun: AutomationRun | null) {
  if (latestRun?.error?.includes('attempt cap reached')) {
    return latestRun.error
  }
  if (latestRun?.error?.includes('timed out')) {
    return latestRun.error
  }
  return `${automation.runPolicy.dailyRunCap} execution attempt${automation.runPolicy.dailyRunCap === 1 ? '' : 's'} per day (including retries) · ${automation.runPolicy.maxRunDurationMinutes} minute max per run · ${automation.retryPolicy.maxRetries} ${automation.retryPolicy.maxRetries === 1 ? 'retry' : 'retries'} available.`
}

export function latestRunSummary(run: AutomationRun | null) {
  if (!run) return 'No runs yet'
  if (run.status === 'running') return `Running ${formatRunKindForUser(run.kind)}`
  if (run.status === 'queued') return `Queued ${formatRunKindForUser(run.kind)}`
  if (run.status === 'failed' && run.nextRetryAt) return `Retry scheduled ${formatTimestamp(run.nextRetryAt, '')}`
  return `${formatStatus(run.status)} ${formatRunKindForUser(run.kind)}`
}

export function deriveNextAction(input: {
  automation: AutomationDetail
  inbox: AutomationInboxItem[]
  activeRun: AutomationRun | null
  latestRun: AutomationRun | null
  latestDelivery: AutomationDeliveryRecord | null
}) {
  const { automation, inbox, activeRun, latestRun, latestDelivery } = input
  if (activeRun) return `Monitor the ${formatRunKindForUser(activeRun.kind)} run in progress`
  if (automation.status === 'needs_user') {
    return inbox.length > 0 ? `Resolve ${pluralize(inbox.length, 'open review item')}` : 'Provide the missing context'
  }
  if (automation.status === 'paused') return 'Resume when you want work to continue'
  if (!automation.brief) return 'Prepare the brief'
  if (!automation.brief.approvedAt) return 'Approve the prepared brief'
  if (automation.status === 'failed') {
    return latestRun?.nextRetryAt
      ? 'Wait for the scheduled retry or inspect the failed run'
      : 'Inspect the failed run and retry when ready'
  }
  if (automation.status === 'ready' || automation.status === 'draft') return 'Run the next execution pass'
  if (latestDelivery) return 'Review the latest delivery and linked thread'
  return 'Review the latest run summary'
}

export function buildAutomationAgentOptions(input: {
  builtinAgents: BuiltInAgentDetail[]
  customAgents: CustomAgentSummary[]
  selectedNames?: string[]
}) {
  const options = new Map<string, AutomationAgentOption>()
  for (const agent of input.builtinAgents) {
    if (agent.mode !== 'subagent' || agent.hidden || agent.disabled || agent.surface === 'automation') continue
    options.set(agent.name, {
      id: agent.name,
      label: agent.label || formatAgentLabel(agent.name),
      description: agent.description || 'Built-in specialist',
      source: 'builtin',
    })
  }
  for (const agent of input.customAgents) {
    if (!agent.enabled || !agent.valid) continue
    options.set(agent.name, {
      id: agent.name,
      label: formatAgentLabel(agent.name),
      description: agent.description || 'Custom specialist',
      source: 'custom',
    })
  }
  for (const name of input.selectedNames || []) {
    if (!options.has(name)) {
      options.set(name, {
        id: name,
        label: `${formatAgentLabel(name)} (unavailable)`,
        description: 'Previously selected but not available in this context',
        source: 'custom',
      })
    }
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function resolveAgentLabels(names: string[], options: AutomationAgentOption[]) {
  const labels = new Map(options.map((option) => [option.id, option.label.replace(/\s+\(unavailable\)$/i, '')]))
  return names.map((name) => labels.get(name) || formatAgentLabel(name))
}

export function draftToPayload(draft: DraftState): AutomationDraft {
  const schedule: AutomationSchedule = {
    type: draft.scheduleType,
    timezone: draft.timezone,
    runAtHour: Number.parseInt(draft.runAtHour, 10) || 9,
    runAtMinute: Number.parseInt(draft.runAtMinute, 10) || 0,
  }
  if (draft.scheduleType === 'weekly') schedule.dayOfWeek = Number.parseInt(draft.dayOfWeek, 10) || 1
  if (draft.scheduleType === 'monthly') schedule.dayOfMonth = Number.parseInt(draft.dayOfMonth, 10) || 1
  if (draft.scheduleType === 'one_time' && draft.startAt.trim()) schedule.startAt = new Date(draft.startAt).toISOString()

  return {
    title: draft.title.trim(),
    goal: draft.goal.trim(),
    kind: draft.kind,
    schedule,
    heartbeatMinutes: Number.parseInt(draft.heartbeatMinutes, 10) || 15,
    retryPolicy: {
      maxRetries: Math.max(0, Number.parseInt(draft.maxRetries, 10) || 0),
      baseDelayMinutes: Math.max(1, Number.parseInt(draft.retryBaseDelayMinutes, 10) || 5),
      maxDelayMinutes: Math.max(
        Math.max(1, Number.parseInt(draft.retryBaseDelayMinutes, 10) || 5),
        Number.parseInt(draft.retryMaxDelayMinutes, 10) || 60,
      ),
    },
    runPolicy: {
      dailyRunCap: Math.max(1, Number.parseInt(draft.dailyRunCap, 10) || 1),
      maxRunDurationMinutes: Math.max(1, Number.parseInt(draft.maxRunDurationMinutes, 10) || 1),
    },
    executionMode: draft.executionMode,
    autonomyPolicy: draft.autonomyPolicy,
    projectDirectory: draft.projectDirectory.trim() || null,
    preferredAgentNames: draft.preferredAgentNames,
  }
}

export function dailyRunAttemptCapLabel(count: number) {
  return `${count} attempt${count === 1 ? '' : 's'} / day`
}

export function dailyRunAttemptCapPlaceholder() {
  return t('automations.dailyRunAttemptCapPlaceholder', 'Daily execution attempt cap')
}
