import type {
  CoordinationBoardPayload,
  CoordinationTask,
} from './coordination.js'
import type { TaskRun } from './session.js'

export type ConversationTaskContext = {
  projectId: string
  projectTitle: string
  taskId: string
  taskTitle: string
  taskStatus: CoordinationTask['status']
  taskColumn: CoordinationTask['column']
  taskPriority: CoordinationTask['priority']
  assignedSessionId: string
  assignedRunId?: string | null
  assigneeAgent?: string | null
}

export type TaskRunHandoffSource = Pick<TaskRun, 'agent' | 'sourceSessionId' | 'parentSessionId'>

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function resolveConversationTaskContext(
  board: CoordinationBoardPayload | null | undefined,
  sessionId: string | null | undefined,
): ConversationTaskContext | null {
  const targetSessionId = nonEmptyString(sessionId)
  if (!targetSessionId || !board) return null

  const task = board.tasks.find((candidate) => candidate.assignedSessionId === targetSessionId)
  if (!task) return null

  const project = board.projects.find((candidate) => candidate.id === task.projectId)
  if (!project) return null

  return {
    projectId: project.id,
    projectTitle: project.title,
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    taskColumn: task.column,
    taskPriority: task.priority,
    assignedSessionId: targetSessionId,
    assignedRunId: task.assignedRunId ?? null,
    assigneeAgent: task.assigneeAgent ?? null,
  }
}

export function buildTaskRunAgentBySourceSession(taskRuns: readonly TaskRunHandoffSource[]) {
  const result: Record<string, string> = {}
  for (const taskRun of taskRuns) {
    const sourceSessionId = nonEmptyString(taskRun.sourceSessionId)
    const agent = nonEmptyString(taskRun.agent)
    if (!sourceSessionId || !agent) continue
    result[sourceSessionId] ||= agent
  }
  return result
}

export function resolveTaskRunHandoffAgent(
  taskRun: TaskRunHandoffSource,
  agentBySourceSession: Record<string, string> | null | undefined,
) {
  const parentSessionId = nonEmptyString(taskRun.parentSessionId)
  if (!parentSessionId || !agentBySourceSession) return null
  return agentBySourceSession[parentSessionId] || null
}
