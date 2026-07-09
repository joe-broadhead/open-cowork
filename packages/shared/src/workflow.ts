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

export interface WorkflowStep {
  id: string
  title: string
  detail?: string | null
}

export interface WorkflowDraft {
  title: string
  instructions: string
  agentName: string
  skillNames?: string[]
  toolIds?: string[]
  steps?: WorkflowStep[]
  projectDirectory?: string | null
  draftSessionId?: string | null
  triggers: WorkflowTrigger[]
}

export type WorkflowValidationGapSeverity = 'required' | 'optional'

export interface WorkflowValidationGap {
  severity: WorkflowValidationGapSeverity
  field: string
  value: string
  message: string
}

export interface WorkflowSummary {
  id: string
  title: string
  instructions: string
  agentName: string
  skillNames: string[]
  toolIds: string[]
  steps: WorkflowStep[]
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
  nextCursor?: string | null
  totalEstimate?: number
}

export interface WorkflowListRequest {
  limit?: number | null
  cursor?: string | null
}

export interface WorkflowToolPreview {
  ok: boolean
  title: string
  summary: string
  missing: string[]
  gaps?: WorkflowValidationGap[]
  normalizedDraft?: WorkflowDraft
  previewToken?: string
}

export interface WorkflowToolCreateRequest {
  previewToken: string
}

export interface WorkflowToolCreateResult {
  ok: true
  workflow: WorkflowDetail
}

const VALID_SCHEDULE_TYPES = new Set<WorkflowScheduleType>(['one_time', 'daily', 'weekly', 'monthly'])
const MAX_WORKFLOW_STEPS = 8
const MAX_WORKFLOW_STEP_TITLE_LENGTH = 160
const MAX_WORKFLOW_STEP_DETAIL_LENGTH = 500

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

function trimmedString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return ''
  return compactWhitespace(value).slice(0, maxLength).trim()
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isWhitespace(value: string | undefined) {
  return value === ' ' || value === '\t' || value === '\n' || value === '\r' || value === '\f'
}

function isAsciiDigit(value: string | undefined) {
  if (!value) return false
  const code = value.charCodeAt(0)
  return code >= 48 && code <= 57
}

function isSentencePunctuation(value: string | undefined) {
  return value === '.' || value === '!' || value === '?'
}

function compactWhitespace(value: string) {
  let result = ''
  let pendingSpace = false
  for (const character of value.trim()) {
    if (isWhitespace(character)) {
      pendingSpace = result.length > 0
      continue
    }
    if (pendingSpace) {
      result += ' '
      pendingSpace = false
    }
    result += character
  }
  return result
}

function firstNonWhitespaceIndex(value: string, fromIndex: number) {
  let index = fromIndex
  while (index < value.length && isWhitespace(value[index])) index += 1
  return index
}

function stripInstructionListMarker(value: string) {
  const line = value.trim()
  if (!line) return ''

  let index = 0
  while (isAsciiDigit(line[index])) index += 1
  if (index > 0 && (line[index] === '.' || line[index] === ')')) {
    const next = firstNonWhitespaceIndex(line, index + 1)
    if (next > index + 1) return line.slice(next).trim()
  }

  if (line[0] === '-' || line[0] === '*' || line[0] === '•') {
    const next = firstNonWhitespaceIndex(line, 1)
    if (next > 1) return line.slice(next).trim()
  }

  return line
}

function stripTrailingSentencePunctuation(value: string) {
  let end = value.length
  while (end > 0 && isSentencePunctuation(value[end - 1])) end -= 1
  return value.slice(0, end)
}

function collectExplicitInstructionLines(instructions: string) {
  const lines: string[] = []
  let current = ''
  for (let index = 0; index < instructions.length; index += 1) {
    const character = instructions[index]
    if (character === '\n' || character === '\r') {
      const title = stripInstructionListMarker(current)
      if (title) lines.push(title)
      current = ''
      if (character === '\r' && instructions[index + 1] === '\n') index += 1
      continue
    }
    current += character
  }
  const title = stripInstructionListMarker(current)
  if (title) lines.push(title)
  return lines.slice(0, MAX_WORKFLOW_STEPS)
}

function collectSentenceInstructionLines(instructions: string) {
  const limit = Math.min(3, MAX_WORKFLOW_STEPS)
  const lines: string[] = []
  let current = ''
  for (let index = 0; index < instructions.length && lines.length < limit; index += 1) {
    const character = instructions[index]
    current += character
    if (!isSentencePunctuation(character)) continue

    let next = index + 1
    while (next < instructions.length && isSentencePunctuation(instructions[next])) {
      current += instructions[next]
      index = next
      next += 1
    }

    if (next < instructions.length && !isWhitespace(instructions[next])) continue

    const title = trimmedString(stripTrailingSentencePunctuation(current), MAX_WORKFLOW_STEP_TITLE_LENGTH)
    if (title) lines.push(title)
    current = ''
    while (next < instructions.length && isWhitespace(instructions[next])) {
      index = next
      next += 1
    }
  }

  if (lines.length < limit) {
    const title = trimmedString(stripTrailingSentencePunctuation(current), MAX_WORKFLOW_STEP_TITLE_LENGTH)
    if (title) lines.push(title)
  }

  return lines
}

function normalizeWorkflowStepEntry(value: unknown, index: number): WorkflowStep | null {
  if (typeof value === 'string') {
    const title = trimmedString(value, MAX_WORKFLOW_STEP_TITLE_LENGTH)
    return title ? { id: `step-${index + 1}`, title, detail: null } : null
  }
  const record = recordValue(value)
  const title = trimmedString(record.title || record.name || record.label || record.summary, MAX_WORKFLOW_STEP_TITLE_LENGTH)
  if (!title) return null
  const id = trimmedString(record.id, 64) || `step-${index + 1}`
  const detail = trimmedString(record.detail || record.description || record.instructions, MAX_WORKFLOW_STEP_DETAIL_LENGTH) || null
  return { id, title, detail }
}

function instructionStepLines(instructions: unknown): string[] {
  if (typeof instructions !== 'string') return []
  const explicit = collectExplicitInstructionLines(instructions)
  if (explicit.length > 1) return explicit

  return collectSentenceInstructionLines(instructions)
}

export function normalizeWorkflowSteps(
  value: unknown,
  context: {
    instructions?: unknown
    agentName?: unknown
    skillNames?: unknown
    toolIds?: unknown
  } = {},
): WorkflowStep[] {
  if (Array.isArray(value)) {
    const steps = value
      .slice(0, MAX_WORKFLOW_STEPS)
      .map(normalizeWorkflowStepEntry)
      .filter((step): step is WorkflowStep => Boolean(step))
    if (steps.length > 0) return steps
  }

  const derived = instructionStepLines(context.instructions).map((title, index) => ({
    id: `step-${index + 1}`,
    title: trimmedString(title, MAX_WORKFLOW_STEP_TITLE_LENGTH) || `Step ${index + 1}`,
    detail: null,
  }))
  if (derived.length > 1) return derived

  const agentName = trimmedString(context.agentName, 80) || 'build'
  const skillCount = Array.isArray(context.skillNames) ? context.skillNames.length : 0
  const toolCount = Array.isArray(context.toolIds) ? context.toolIds.length : 0
  const capabilityDetail = [
    `Runs as ${agentName}.`,
    skillCount ? `${skillCount} skill${skillCount === 1 ? '' : 's'}.` : null,
    toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}.` : null,
  ].filter(Boolean).join(' ')
  const instructionDetail = typeof context.instructions === 'string'
    ? trimmedString(context.instructions, MAX_WORKFLOW_STEP_DETAIL_LENGTH)
    : ''
  return [
    { id: 'step-1', title: 'Prepare run context', detail: capabilityDetail || null },
    { id: 'step-2', title: 'Execute saved instructions', detail: instructionDetail || null },
    { id: 'step-3', title: 'Review and summarize output', detail: 'Capture the run result, errors, and follow-up actions.' },
  ]
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

function isIntegerInRange(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function parseScheduleStartAt(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

export function validateWorkflowSchedule(schedule: WorkflowSchedule, from?: Date) {
  if (!schedule?.type) return 'Schedule type is required.'
  if (!VALID_SCHEDULE_TYPES.has(schedule.type)) return 'Schedule type is invalid.'
  if (!schedule.timezone) return 'Schedule timezone is required.'
  if (!isValidTimeZone(schedule.timezone)) return 'Schedule timezone is invalid.'
  if (schedule.runAtHour !== null && schedule.runAtHour !== undefined && !isIntegerInRange(schedule.runAtHour, 0, 23)) {
    return 'Schedule runAtHour must be an integer between 0 and 23.'
  }
  if (schedule.runAtMinute !== null && schedule.runAtMinute !== undefined && !isIntegerInRange(schedule.runAtMinute, 0, 59)) {
    return 'Schedule runAtMinute must be an integer between 0 and 59.'
  }
  if (schedule.type === 'weekly' && !isIntegerInRange(schedule.dayOfWeek, 0, 6)) {
    return 'Weekly schedules require dayOfWeek between 0 and 6.'
  }
  if (schedule.type === 'monthly' && !isIntegerInRange(schedule.dayOfMonth, 1, 31)) {
    return 'Monthly schedules require dayOfMonth between 1 and 31.'
  }
  if (schedule.type === 'one_time' && !schedule.startAt) return 'One-time schedules require startAt.'
  if (schedule.startAt) {
    const startAt = parseScheduleStartAt(schedule.startAt)
    if (!startAt) return 'Schedule startAt must be a valid ISO timestamp.'
    if (from && startAt.getTime() <= from.getTime()) return 'Schedule startAt must be in the future.'
  }
  return null
}

export function computeNextWorkflowScheduleRunAt(schedule: WorkflowSchedule, from = new Date()) {
  const runAtHour = schedule.runAtHour ?? 9
  const runAtMinute = schedule.runAtMinute ?? 0

  if (schedule.type === 'one_time') {
    const at = schedule.startAt ? new Date(schedule.startAt) : null
    return at && !Number.isNaN(at.getTime()) && at.getTime() > from.getTime() ? at.toISOString() : null
  }

  const startAt = parseScheduleStartAt(schedule.startAt)
  const recurrenceFrom = startAt && startAt.getTime() > from.getTime()
    ? new Date(startAt.getTime() - 1)
    : from
  const zonedNow = getZonedParts(recurrenceFrom, schedule.timezone)

  if (schedule.type === 'daily') {
    let candidate = zonedDateTimeToUtc(schedule.timezone, zonedNow.year, zonedNow.month, zonedNow.day, runAtHour, runAtMinute)
    if (candidate.getTime() <= recurrenceFrom.getTime()) {
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
    if (candidate.getTime() <= recurrenceFrom.getTime()) {
      target = addDays(target, 7)
      candidate = zonedDateTimeToUtc(schedule.timezone, target.year, target.month, target.day, runAtHour, runAtMinute)
    }
    return candidate.toISOString()
  }

  const requestedDay = schedule.dayOfMonth ?? 1
  const day = clampDayOfMonth(zonedNow.year, zonedNow.month, requestedDay)
  let candidate = zonedDateTimeToUtc(schedule.timezone, zonedNow.year, zonedNow.month, day, runAtHour, runAtMinute)
  if (candidate.getTime() <= recurrenceFrom.getTime()) {
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
