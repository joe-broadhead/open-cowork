import type { CloudProjectionFenceToken } from './cloud-session-contract.js'

export type WorkflowSurface = 'chat' | 'workflow' | 'both'

export type WorkflowStatus = 'active' | 'paused' | 'running' | 'failed' | 'archived'
export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowTriggerType = 'manual' | 'schedule' | 'webhook'
export type WorkflowScheduleType = 'one_time' | 'daily' | 'weekly' | 'monthly'

export interface WorkflowSchedule {
  type: WorkflowScheduleType
  timezone: string
  runAtHour?: number | null
  runAtMinute?: number | null
  dayOfWeek?: number | null
  dayOfMonth?: number | null
  startAt?: string | null
}

export interface WorkflowTrigger {
  id: string
  type: WorkflowTriggerType
  enabled: boolean
  schedule?: WorkflowSchedule | null
  webhookSecret?: string | null
}

export interface WorkflowDraft {
  title: string
  instructions: string
  agentName: string
  skillNames?: string[]
  toolIds?: string[]
  projectDirectory?: string | null
  draftSessionId?: string | null
  triggers: WorkflowTrigger[]
}

export interface WorkflowSummary {
  id: string
  title: string
  instructions: string
  agentName: string
  skillNames: string[]
  toolIds: string[]
  status: WorkflowStatus
  projectDirectory: string | null
  draftSessionId: string | null
  triggers: WorkflowTrigger[]
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt: string | null
  latestRunId: string | null
  latestRunStatus: WorkflowRunStatus | null
  latestRunSessionId: string | null
  latestRunSummary: string | null
  webhookUrl: string | null
}

export interface WorkflowRun {
  id: string
  workflowId: string
  sessionId: string | null
  triggerType: WorkflowTriggerType
  triggerPayload: Record<string, unknown> | null
  status: WorkflowRunStatus
  title: string
  summary: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  projectionFence?: CloudProjectionFenceToken | null
}

export interface WorkflowDetail extends WorkflowSummary {
  runs: WorkflowRun[]
}

export interface WorkflowListPayload {
  workflows: WorkflowSummary[]
  runs: WorkflowRun[]
}

export interface WorkflowToolPreview {
  ok: boolean
  title: string
  summary: string
  missing: string[]
  normalizedDraft?: WorkflowDraft
}

export interface WorkflowToolCreateResult {
  ok: true
  workflow: WorkflowDetail
}

const VALID_SCHEDULE_TYPES = new Set<WorkflowScheduleType>(['one_time', 'daily', 'weekly', 'monthly'])

type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function toNumber(value: string | undefined, fallback = 0) {
  const numeric = Number.parseInt(value || '', 10)
  return Number.isFinite(numeric) ? numeric : fallback
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const map = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return {
    year: toNumber(map.year),
    month: toNumber(map.month),
    day: toNumber(map.day),
    hour: toNumber(map.hour),
    minute: toNumber(map.minute),
    second: toNumber(map.second),
  }
}

function getTimeZoneOffsetMs(timeZone: string, date: Date) {
  const zoned = getZonedParts(date, timeZone)
  const utc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second)
  return utc - date.getTime()
}

function zonedDateTimeToUtc(timeZone: string, year: number, month: number, day: number, hour: number, minute: number) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0))
  const firstOffset = getTimeZoneOffsetMs(timeZone, guess)
  const candidate = new Date(guess.getTime() - firstOffset)
  const secondOffset = getTimeZoneOffsetMs(timeZone, candidate)
  return new Date(guess.getTime() - (secondOffset !== firstOffset ? secondOffset : firstOffset))
}

function addDays(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, parts.second))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function clampDayOfMonth(year: number, month: number, requested: number) {
  return Math.max(1, Math.min(requested, daysInMonth(year, month)))
}

function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}

export function validateWorkflowSchedule(schedule: WorkflowSchedule) {
  if (!schedule?.type) return 'Schedule type is required.'
  if (!VALID_SCHEDULE_TYPES.has(schedule.type)) return 'Schedule type is invalid.'
  if (!schedule.timezone) return 'Schedule timezone is required.'
  if (!isValidTimeZone(schedule.timezone)) return 'Schedule timezone is invalid.'
  if (schedule.type === 'weekly' && (typeof schedule.dayOfWeek !== 'number' || schedule.dayOfWeek < 0 || schedule.dayOfWeek > 6)) {
    return 'Weekly schedules require dayOfWeek between 0 and 6.'
  }
  if (schedule.type === 'monthly' && (typeof schedule.dayOfMonth !== 'number' || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) {
    return 'Monthly schedules require dayOfMonth between 1 and 31.'
  }
  if (schedule.type === 'one_time' && !schedule.startAt) return 'One-time schedules require startAt.'
  return null
}

export function computeNextWorkflowScheduleRunAt(schedule: WorkflowSchedule, from = new Date()) {
  const runAtHour = schedule.runAtHour ?? 9
  const runAtMinute = schedule.runAtMinute ?? 0
  const zonedNow = getZonedParts(from, schedule.timezone)

  if (schedule.type === 'one_time') {
    const at = schedule.startAt ? new Date(schedule.startAt) : null
    return at && !Number.isNaN(at.getTime()) && at.getTime() > from.getTime() ? at.toISOString() : null
  }

  if (schedule.type === 'daily') {
    let candidate = zonedDateTimeToUtc(schedule.timezone, zonedNow.year, zonedNow.month, zonedNow.day, runAtHour, runAtMinute)
    if (candidate.getTime() <= from.getTime()) {
      const tomorrow = addDays(zonedNow, 1)
      candidate = zonedDateTimeToUtc(schedule.timezone, tomorrow.year, tomorrow.month, tomorrow.day, runAtHour, runAtMinute)
    }
    return candidate.toISOString()
  }

  if (schedule.type === 'weekly') {
    const currentDay = new Date(Date.UTC(zonedNow.year, zonedNow.month - 1, zonedNow.day)).getUTCDay()
    const targetDay = schedule.dayOfWeek ?? 1
    let delta = targetDay - currentDay
    if (delta < 0) delta += 7
    let target = addDays(zonedNow, delta)
    let candidate = zonedDateTimeToUtc(schedule.timezone, target.year, target.month, target.day, runAtHour, runAtMinute)
    if (candidate.getTime() <= from.getTime()) {
      target = addDays(target, 7)
      candidate = zonedDateTimeToUtc(schedule.timezone, target.year, target.month, target.day, runAtHour, runAtMinute)
    }
    return candidate.toISOString()
  }

  const requestedDay = schedule.dayOfMonth ?? 1
  const day = clampDayOfMonth(zonedNow.year, zonedNow.month, requestedDay)
  let candidate = zonedDateTimeToUtc(schedule.timezone, zonedNow.year, zonedNow.month, day, runAtHour, runAtMinute)
  if (candidate.getTime() <= from.getTime()) {
    const nextMonth = zonedNow.month === 12
      ? { year: zonedNow.year + 1, month: 1 }
      : { year: zonedNow.year, month: zonedNow.month + 1 }
    candidate = zonedDateTimeToUtc(
      schedule.timezone,
      nextMonth.year,
      nextMonth.month,
      clampDayOfMonth(nextMonth.year, nextMonth.month, requestedDay),
      runAtHour,
      runAtMinute,
    )
  }
  return candidate.toISOString()
}

export function computeNextWorkflowRunAt(triggers: WorkflowTrigger[], from = new Date()) {
  const candidates = triggers
    .filter((trigger) => trigger.enabled && trigger.type === 'schedule' && trigger.schedule)
    .map((trigger) => computeNextWorkflowScheduleRunAt(trigger.schedule!, from))
    .filter((value): value is string => Boolean(value))
    .sort()
  return candidates[0] || null
}
