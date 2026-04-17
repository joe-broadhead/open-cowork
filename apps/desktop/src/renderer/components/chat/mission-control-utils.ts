import type { TaskRun } from '../../stores/session'

// Two-level orchestration tree. Root lanes are tasks whose
// `parentSessionId` points at the primary session (or is unset). Child
// lanes are tasks whose `parentSessionId` matches another task's
// `sourceSessionId`. Anything deeper than two levels collapses into
// the nearest parent — the drill-in drawer handles recursive depth.
export interface OrchestrationLane {
  taskRun: TaskRun
  children: TaskRun[]
}

export function buildOrchestrationTree(taskRuns: TaskRun[]): OrchestrationLane[] {
  if (taskRuns.length === 0) return []
  const bySource = new Map<string, TaskRun>()
  for (const task of taskRuns) {
    if (task.sourceSessionId) bySource.set(task.sourceSessionId, task)
  }

  const roots: OrchestrationLane[] = []
  const childrenByParentId = new Map<string, TaskRun[]>()

  for (const task of taskRuns) {
    const parentSessionId = task.parentSessionId || null
    const parentTask = parentSessionId ? bySource.get(parentSessionId) : null
    if (parentTask && parentTask.id !== task.id) {
      const bucket = childrenByParentId.get(parentTask.id) || []
      bucket.push(task)
      childrenByParentId.set(parentTask.id, bucket)
      continue
    }
    roots.push({ taskRun: task, children: [] })
  }

  for (const lane of roots) {
    const childrenForRoot = childrenByParentId.get(lane.taskRun.id) || []
    lane.children = childrenForRoot.sort((a, b) => a.order - b.order)
  }

  return roots.sort((a, b) => a.taskRun.order - b.taskRun.order)
}

// Elapsed time for a lane in ms. For running tasks, uses wall clock;
// for complete/error, uses finishedAt-startedAt; otherwise returns 0.
export function laneElapsedMs(taskRun: TaskRun, now: number = Date.now()): number {
  if (!taskRun.startedAt) return 0
  const start = new Date(taskRun.startedAt).getTime()
  if (!Number.isFinite(start)) return 0
  const end = taskRun.finishedAt ? new Date(taskRun.finishedAt).getTime() : now
  return Math.max(0, end - start)
}

// Lane fill ratio for the progress bar. Complete tasks are 100%. Running
// tasks scale against the group's current max elapsed time — the longest
// running lane hits the cap and shorter lanes stay proportional, which
// makes parallel dispatch visually legible. Queued tasks return 0.
export function computeLaneProgress(
  taskRun: TaskRun,
  groupMaxElapsedMs: number,
): number {
  if (taskRun.status === 'complete' || taskRun.status === 'error') return 1
  if (taskRun.status === 'queued') return 0
  if (groupMaxElapsedMs <= 0) return 0
  const elapsed = laneElapsedMs(taskRun)
  return Math.max(0.04, Math.min(1, elapsed / groupMaxElapsedMs))
}

export function groupMaxElapsed(taskRuns: TaskRun[], now: number = Date.now()): number {
  let max = 0
  for (const task of taskRuns) {
    const elapsed = laneElapsedMs(task, now)
    if (elapsed > max) max = elapsed
  }
  return max
}

// Aggregate timing for the block header — earliest running start (or
// earliest finished start if all complete) and latest finish. Matches
// the semantics that were in ParallelTaskBlock's selectAggregateTiming.
export function selectAggregateTiming(taskRuns: TaskRun[]) {
  let earliestRunningStart: string | null = null
  let earliestFinishedStart: string | null = null
  let latestFinish: string | null = null
  let anyRunning = false

  for (const task of taskRuns) {
    if (!task.startedAt) continue
    if (task.status === 'running') {
      anyRunning = true
      if (!earliestRunningStart || task.startedAt < earliestRunningStart) {
        earliestRunningStart = task.startedAt
      }
    } else if (task.status === 'complete' || task.status === 'error') {
      if (!earliestFinishedStart || task.startedAt < earliestFinishedStart) {
        earliestFinishedStart = task.startedAt
      }
      if (task.finishedAt && (!latestFinish || task.finishedAt > latestFinish)) {
        latestFinish = task.finishedAt
      }
    }
  }

  if (anyRunning) return { startedAt: earliestRunningStart, finishedAt: null }
  if (earliestFinishedStart) return { startedAt: earliestFinishedStart, finishedAt: latestFinish }
  return { startedAt: null, finishedAt: null }
}

export function summarizeStatus(taskRuns: TaskRun[]): string {
  const running = taskRuns.filter((task) => task.status === 'running' || task.status === 'queued').length
  const complete = taskRuns.filter((task) => task.status === 'complete').length
  const errored = taskRuns.filter((task) => task.status === 'error').length

  if (running > 0) return `${running} running`
  if (errored > 0) return `${errored} errored`
  if (complete > 0) return `${complete} complete`
  return 'Queued'
}

export function formatAgentName(name: string | null | undefined): string {
  if (!name) return 'Sub-agent'
  return name
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

// Re-export the shared formatters. `mission-control-utils` callers pass
// the `'compact'` cost style explicitly via the local `formatCost`
// re-export below.
export { formatTokensCompact } from '../../helpers/format.ts'

export function sumTokens(taskRun: TaskRun): number {
  const { input, output, reasoning, cacheRead, cacheWrite } = taskRun.sessionTokens
  return input + output + reasoning + cacheRead + cacheWrite
}

export function groupTokenTotal(taskRuns: TaskRun[]): number {
  return taskRuns.reduce((acc, task) => acc + sumTokens(task), 0)
}

export function groupCostTotal(taskRuns: TaskRun[]): number {
  return taskRuns.reduce((acc, task) => acc + (task.sessionCost || 0), 0)
}

// Lane pills prefer the compact-style readout — empty for zero, "<$0.01"
// for sub-cent — so the in-chat timeline doesn't clutter with $0.00
// chips on short-lived research lanes. Callers import `formatCost` from
// here and don't need to know the style; keeping a wrapper so the
// contract is explicit.
import { formatCost as sharedFormatCost } from '../../helpers/format.ts'
export function formatCost(value: number): string {
  return sharedFormatCost(value, 'compact')
}
