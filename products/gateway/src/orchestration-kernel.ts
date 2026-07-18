import type { CapacityAdmission } from './capacity.js'

const TRANSIENT_RETRY_BASE_MS = 60_000
const TRANSIENT_RETRY_MAX_MS = 30 * 60_000

export type CapacityHoldEventType = 'capacity.admission.delayed' | 'capacity.admission.queued'

export interface CapacityHoldTimelinePlan {
  taskPatch?: { note: string; earliestStartAt?: string }
  eventType: CapacityHoldEventType
  eventPayload: {
    dimension: CapacityAdmission['dimension']
    key: string
    used: number
    limit: number
    reason: string
    retryAt?: string
  }
  queueMessage: string
}

export function planCapacityHold(input: {
  task: { title: string; note?: string; earliestStartAt?: string }
  admission: CapacityAdmission
  schedulerIntervalMs: number
  nowMs: number
}): CapacityHoldTimelinePlan {
  const { task, admission, schedulerIntervalMs, nowMs } = input
  const retryAt = admission.dimension === 'global'
    ? undefined
    : new Date(nowMs + Math.max(1000, schedulerIntervalMs)).toISOString()
  const line = `Capacity wait: ${admission.dimension}:${admission.key} ${admission.used}/${admission.limit} (${admission.reason})`
  const baseNote = String(task.note || '')
    .split(/\r?\n/)
    .filter(row => !row.startsWith('Capacity wait:'))
    .join('\n')
    .trim()
  const note = [baseNote, line].filter(Boolean).join('\n')
  const eventPayload: CapacityHoldTimelinePlan['eventPayload'] = {
    dimension: admission.dimension,
    key: admission.key,
    used: admission.used,
    limit: admission.limit,
    reason: admission.reason,
    ...(retryAt ? { retryAt } : {}),
  }
  const shouldUpdateTask = task.note !== note || Boolean(retryAt && task.earliestStartAt !== retryAt)
  return {
    taskPatch: shouldUpdateTask ? (retryAt ? { note, earliestStartAt: retryAt } : { note }) : undefined,
    eventType: retryAt ? 'capacity.admission.delayed' : 'capacity.admission.queued',
    eventPayload,
    queueMessage: `Capacity waiting for ${task.title}: ${admission.reason}`,
  }
}

export type RuntimeFailureTimelinePlan =
  | { action: 'retry'; retryAt: string; taskPatch: { earliestStartAt: string; note: string }; queueMessage: string }
  | { action: 'blocked'; queueMessage: string }
  | { action: 'none' }

export function planRuntimeFailureTimeline(input: {
  taskTitle: string
  runStage: string
  runAttempt: number
  failureSummary: string
  retryStage?: string
  taskStatus?: string
  nowMs: number
}): RuntimeFailureTimelinePlan {
  if (input.retryStage && input.taskStatus === 'pending') {
    const backoffMs = retryBackoffMs(input.runAttempt)
    const retryAt = new Date(input.nowMs + backoffMs).toISOString()
    return {
      action: 'retry',
      retryAt,
      taskPatch: { earliestStartAt: retryAt, note: `${input.failureSummary}; retry after ${retryAt}` },
      queueMessage: `Scheduler retry backoff for ${input.taskTitle}: ${formatDuration(backoffMs)}`,
    }
  }
  if (input.taskStatus === 'blocked') {
    return {
      action: 'blocked',
      queueMessage: `Scheduler blocked ${input.taskTitle} after ${input.runAttempt} ${input.runStage} attempt(s): ${input.failureSummary}`,
    }
  }
  return { action: 'none' }
}

export function retryBackoffMs(attempt: number): number {
  return Math.min(TRANSIENT_RETRY_MAX_MS, TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1))
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

