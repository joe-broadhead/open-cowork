import type { WorkStatus } from './workflow.js'

export type TaskCounts = {
  total?: number
  pending?: number
  running?: number
  done?: number
  blocked?: number
  paused?: number
  cancelled?: number
  archived?: number
}

export const ACTIVE_TASK_STATUSES = ['pending', 'running', 'blocked', 'paused'] as const satisfies readonly WorkStatus[]

export function isActiveTaskStatus(status: unknown): boolean {
  return (ACTIVE_TASK_STATUSES as readonly string[]).includes(String(status || ''))
}

export function formatTaskCounts(counts: TaskCounts = {}, options: { includeArchived?: boolean; includeCancelled?: boolean } = {}): string {
  const parts = [
    `${counts.pending || 0} pending`,
    `${counts.running || 0} running`,
    `${counts.done || 0} done`,
    `${counts.blocked || 0} blocked`,
    `${counts.paused || 0} paused`,
  ]
  if (options.includeCancelled) parts.push(`${counts.cancelled || 0} cancelled`)
  if (options.includeArchived) parts.push(`${counts.archived || 0} archived`)
  return parts.join(' | ')
}
