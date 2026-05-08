import type {
  TaskRunMeta,
  TaskStatus,
} from './event-task-state.ts'

export const nowIso = () => new Date().toISOString()

export const isTerminalTaskStatus = (status: TaskStatus) => {
  return status === 'complete' || status === 'error'
}

export const normalizeTaskTiming = (
  taskRun: TaskRunMeta,
  getTimestamp: () => string = nowIso,
): TaskRunMeta => {
  const startedAt = taskRun.startedAt ?? getTimestamp()
  const finishedAt = taskRun.finishedAt ?? (isTerminalTaskStatus(taskRun.status) ? getTimestamp() : null)
  return { ...taskRun, startedAt, finishedAt }
}

export const applyTaskTimingTransition = (
  existing: TaskRunMeta,
  patch: Partial<TaskRunMeta>,
  getTimestamp: () => string = nowIso,
): TaskRunMeta => {
  const nextStatus = patch.status ?? existing.status
  const timestamp = getTimestamp()
  const startedAt = patch.startedAt
    ?? existing.startedAt
    ?? timestamp
  const finishedAt = patch.finishedAt !== undefined
    ? patch.finishedAt
    : isTerminalTaskStatus(nextStatus)
      ? (existing.finishedAt ?? timestamp)
      : null

  return {
    ...existing,
    ...patch,
    startedAt,
    finishedAt,
  }
}
