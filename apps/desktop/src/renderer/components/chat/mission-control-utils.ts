import type { TaskRun } from '../../stores/session'

// Two-level orchestration tree rendered inline in the chat transcript.
// Root lanes are tasks whose parent isn't another task in the list
// (delegated directly from the primary orchestrator). Each root lane's
// `children` are its direct sub-agent delegations. Anything deeper than
// the child level is summarised via `deeperCount` — the drill-in drawer
// handles recursive depth for users who want to chase a chain.
//
// Previously level-3+ tasks were orphaned into separate root lanes
// because the builder only threaded a single hop from child to parent.
// That made deep chains look flat. Now we:
//   1. Index children by parentSessionId so we can walk down the tree.
//   2. Recursively count descendants beyond the rendered-inline children.
//   3. Attach the deeper count to the lane that spawned them.
export interface OrchestrationLane {
  taskRun: TaskRun
  children: OrchestrationLane[]
  // Count of descendants NOT represented by `children`. For a root lane
  // whose direct children render inline, this is 0 (the children carry
  // their own deeperCount). For a child lane (rendered inline with no
  // further nesting), this is the total count of ITS descendants.
  deeperCount: number
}

export function buildOrchestrationTree(taskRuns: TaskRun[]): OrchestrationLane[] {
  if (taskRuns.length === 0) return []
  const bySource = new Map<string, TaskRun>()
  const tasksByParent = new Map<string, TaskRun[]>()
  for (const task of taskRuns) {
    if (task.sourceSessionId) bySource.set(task.sourceSessionId, task)
    if (task.parentSessionId) {
      const bucket = tasksByParent.get(task.parentSessionId) || []
      bucket.push(task)
      tasksByParent.set(task.parentSessionId, bucket)
    }
  }

  // Count total descendants under a task — recursive walk down the
  // children-by-parent index. `visited` guards against cycles in
  // malformed input.
  function countDescendants(task: TaskRun, visited: Set<string>): number {
    if (visited.has(task.id) || !task.sourceSessionId) return 0
    visited.add(task.id)
    const direct = tasksByParent.get(task.sourceSessionId) || []
    let total = direct.length
    for (const child of direct) {
      total += countDescendants(child, visited)
    }
    return total
  }

  const roots: OrchestrationLane[] = []
  for (const task of taskRuns) {
    const parentIsTask = task.parentSessionId && bySource.has(task.parentSessionId)
    if (parentIsTask) continue

    const directChildren = task.sourceSessionId
      ? (tasksByParent.get(task.sourceSessionId) || [])
      : []
    const childLanes: OrchestrationLane[] = directChildren
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((child) => ({
        taskRun: child,
        children: [],
        // Child lanes render inline WITHOUT their own inline children,
        // so everything under a child lane counts as "deeper".
        deeperCount: countDescendants(child, new Set()),
      }))

    roots.push({
      taskRun: task,
      children: childLanes,
      // Everything deeper is already surfaced via the children's
      // individual deeperCount badges.
      deeperCount: 0,
    })
  }

  return roots.sort((a, b) => a.taskRun.order - b.taskRun.order)
}

// Elapsed time for a lane in ms. For running tasks, uses wall clock;
// for complete/error, uses finishedAt-startedAt; otherwise returns 0.
export function laneElapsedMs(taskRun: TaskRun, now: number = Date.now()): number {
  if (!taskRun.startedAt) return 0
  const start = new Date(taskRun.startedAt).getTime()
  if (!Number.isFinite(start)) return 0
  if (taskRun.status === 'running') {
    return Math.max(0, now - start)
  }
  if (!taskRun.finishedAt) return 0
  const end = new Date(taskRun.finishedAt).getTime()
  if (!Number.isFinite(end)) return 0
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
      const terminalFinish = task.finishedAt || task.startedAt
      if (terminalFinish && (!latestFinish || terminalFinish > latestFinish)) {
        latestFinish = terminalFinish
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
