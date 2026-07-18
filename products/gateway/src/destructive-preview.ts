import type { WorkDependencyRecord, WorkState } from './work-store.js'

/**
 * Blast-radius previews for destructive, agent-invokable work-store operations.
 *
 * These are pure functions over an already-loaded WorkState snapshot: they never
 * mutate durable state, so a `dryRun`/`preview` request can show the operator
 * exactly what a delete/bulk operation would remove (counts and redacted-safe
 * ids) before it is committed. The daemon routes call these and short-circuit
 * before the real mutation when dry-run is requested.
 */

export interface TaskDeleteBlastRadius {
  operation: 'task_delete'
  dryRun: true
  mutates: false
  found: boolean
  taskId: string
  roadmapId?: string
  title?: string
  status?: string
  runsDeleted: number
  runIds: string[]
  activeRunSessionIds: string[]
  dependencyEdgesRemoved: number
  dependentTaskIds: string[]
  summary: string
}

export interface RoadmapDeleteBlastRadius {
  operation: 'roadmap_delete'
  dryRun: true
  mutates: false
  found: boolean
  roadmapId: string
  title?: string
  tasksDeleted: number
  taskIds: string[]
  runsDeleted: number
  supervisorsRemoved: number
  completionProposalsRemoved: number
  projectBindingsRemoved: number
  activeRunSessionIds: string[]
  summary: string
}

export interface BulkTaskUpdateBlastRadius {
  operation: 'task_bulk_update'
  dryRun: true
  mutates: false
  requested: number
  matched: number
  missing: number
  missingTaskIds: string[]
  changes: Array<{ taskId: string; currentStatus?: string; requestedStatus?: string }>
  summary: string
}

const ACTIVE_RUN_STATUSES = new Set(['running', 'starting', 'dispatched'])

function activeSessionIds(runs: { taskId: string; sessionId?: string; status: string }[], taskIds: Set<string>): string[] {
  return runs
    .filter(run => taskIds.has(run.taskId) && run.sessionId && ACTIVE_RUN_STATUSES.has(String(run.status)))
    .map(run => String(run.sessionId))
}

export function previewTaskDelete(taskId: string, state: WorkState): TaskDeleteBlastRadius {
  const task = state.tasks.find(row => row.id === taskId)
  const runs = state.runs.filter(run => run.taskId === taskId)
  const dependencies = state.dependencies || []
  const dependents = dependencies.filter(dep => dep.dependsOnTaskId === taskId)
  const ownEdges = dependencies.filter(dep => dep.taskId === taskId)
  const edgesRemoved = new Set<WorkDependencyRecord>([...dependents, ...ownEdges]).size
  const activeSessions = activeSessionIds(runs, new Set([taskId]))
  return {
    operation: 'task_delete',
    dryRun: true,
    mutates: false,
    found: Boolean(task),
    taskId,
    roadmapId: task?.roadmapId,
    title: task?.title,
    status: task?.status,
    runsDeleted: runs.length,
    runIds: runs.map(run => run.id),
    activeRunSessionIds: activeSessions,
    dependencyEdgesRemoved: edgesRemoved,
    dependentTaskIds: dependents.map(dep => dep.taskId),
    summary: task
      ? `Would delete task ${taskId} (${runs.length} run(s), ${edgesRemoved} dependency edge(s), ${dependents.length} dependent task(s) unblocked, ${activeSessions.length} active session(s) aborted).`
      : `Task ${taskId} not found; nothing would be deleted.`,
  }
}

export function previewRoadmapDelete(roadmapId: string, state: WorkState): RoadmapDeleteBlastRadius {
  const roadmap = state.roadmaps.find(row => row.id === roadmapId)
  const tasks = state.tasks.filter(task => task.roadmapId === roadmapId)
  const taskIds = new Set(tasks.map(task => task.id))
  const runs = state.runs.filter(run => taskIds.has(run.taskId))
  const supervisors = state.supervisors.filter(sup => sup.roadmapId === roadmapId)
  const completionProposals = (state.completionProposals || []).filter(proposal => proposal.roadmapId === roadmapId)
  const projectBindings = (state.projectBindings || []).filter(binding => binding.roadmapId === roadmapId)
  const activeSessions = activeSessionIds(runs, taskIds)
  return {
    operation: 'roadmap_delete',
    dryRun: true,
    mutates: false,
    found: Boolean(roadmap),
    roadmapId,
    title: roadmap?.title,
    tasksDeleted: tasks.length,
    taskIds: [...taskIds],
    runsDeleted: runs.length,
    supervisorsRemoved: supervisors.length,
    completionProposalsRemoved: completionProposals.length,
    projectBindingsRemoved: projectBindings.length,
    activeRunSessionIds: activeSessions,
    summary: roadmap
      ? `Would delete roadmap ${roadmapId} with ${tasks.length} task(s), ${runs.length} run(s), ${supervisors.length} supervisor(s), ${completionProposals.length} completion proposal(s), ${projectBindings.length} project binding(s), ${activeSessions.length} active session(s) aborted.`
      : `Roadmap ${roadmapId} not found; nothing would be deleted.`,
  }
}

export function previewBulkTaskUpdate(updates: Array<Record<string, unknown>>, state: WorkState): BulkTaskUpdateBlastRadius {
  const byId = new Map(state.tasks.map(task => [task.id, task]))
  const matched: BulkTaskUpdateBlastRadius['changes'] = []
  const missingTaskIds: string[] = []
  for (const update of updates || []) {
    const taskId = String(update?.['taskId'] || '')
    if (!taskId) continue
    const task = byId.get(taskId)
    if (!task) {
      missingTaskIds.push(taskId)
      continue
    }
    matched.push({
      taskId,
      currentStatus: task.status,
      requestedStatus: update?.['status'] === undefined ? undefined : String(update['status']),
    })
  }
  return {
    operation: 'task_bulk_update',
    dryRun: true,
    mutates: false,
    requested: (updates || []).length,
    matched: matched.length,
    missing: missingTaskIds.length,
    missingTaskIds,
    changes: matched,
    summary: `Would update ${matched.length} task(s); ${missingTaskIds.length} requested id(s) not found.`,
  }
}
