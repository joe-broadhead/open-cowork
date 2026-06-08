import type { BrowserWindow } from 'electron'
import type {
  CoordinationProjectInput,
  CoordinationProjectUpdateInput,
  CoordinationTaskAssignInput,
  CoordinationTaskInput,
  CoordinationTaskMoveInput,
  CoordinationTaskUpdateInput,
  CoordinationTaskWorkLinkInput,
  SessionInfo,
} from '@open-cowork/shared'
import {
  assignCoordinationTask as assignTaskState,
  createCoordinationProject as createProjectState,
  createCoordinationTask as createTaskState,
  getCoordinationProject,
  getCoordinationTask,
  linkCoordinationTaskWork,
  listCoordinationBoard as listBoardState,
  listCoordinationProjects as listProjectsState,
  listCoordinationTasks as listTasksState,
  moveCoordinationTask as moveTaskState,
  updateCoordinationProject as updateProjectState,
  updateCoordinationTask as updateTaskState,
} from './coordination-store.ts'
import { getSessionRecord, toRendererSession } from '../session-registry.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null

function publishCoordinationUpdated() {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send('coordination:updated')
}

export function configureCoordinationService(options: { getMainWindow: () => BrowserWindow | null }) {
  getMainWindow = options.getMainWindow
}

export function listCoordinationBoard(options: { workspaceId?: string | null; limit?: number } = {}) {
  return listBoardState(options)
}

export function listCoordinationProjects(options: { workspaceId?: string | null; limit?: number } = {}) {
  return listProjectsState(options)
}

export function listCoordinationTasks(options: { workspaceId?: string | null; projectId?: string | null; limit?: number } = {}) {
  return listTasksState(options)
}

export function createCoordinationProject(input: CoordinationProjectInput) {
  const project = createProjectState(input)
  publishCoordinationUpdated()
  return project
}

export function updateCoordinationProject(projectId: string, input: CoordinationProjectUpdateInput) {
  const project = updateProjectState(projectId, input)
  if (project) publishCoordinationUpdated()
  return project
}

export function createCoordinationTask(input: CoordinationTaskInput) {
  const task = createTaskState(input)
  publishCoordinationUpdated()
  return task
}

export function updateCoordinationTask(taskId: string, input: CoordinationTaskUpdateInput) {
  const task = updateTaskState(taskId, input)
  if (task) publishCoordinationUpdated()
  return task
}

export function moveCoordinationTask(taskId: string, input: CoordinationTaskMoveInput) {
  const task = moveTaskState(taskId, input.column)
  if (task) publishCoordinationUpdated()
  return task
}

export function assignCoordinationTask(taskId: string, input: CoordinationTaskAssignInput) {
  const task = assignTaskState(taskId, input.assigneeAgent)
  if (task) publishCoordinationUpdated()
  return task
}

export function linkCoordinationTaskToSession(taskId: string, input: CoordinationTaskWorkLinkInput) {
  const record = getSessionRecord(input.assignedSessionId)
  if (!record) throw new Error('Assigned OpenCode session was not found.')
  const task = linkCoordinationTaskWork(taskId, {
    ...input,
    assignedRunId: input.assignedRunId ?? record.runId,
  })
  if (task) publishCoordinationUpdated()
  return task
}

export function linkCoordinationTaskToValidatedWork(taskId: string, input: CoordinationTaskWorkLinkInput) {
  const task = linkCoordinationTaskWork(taskId, input)
  if (task) publishCoordinationUpdated()
  return task
}

export function getCoordinationTaskWorkTarget(taskId: string): SessionInfo | null {
  const task = getCoordinationTask(taskId)
  if (!task?.assignedSessionId) return null
  const record = getSessionRecord(task.assignedSessionId)
  return record ? toRendererSession(record) : null
}

export function getCoordinationProjectDetail(projectId: string) {
  return getCoordinationProject(projectId)
}

export function getCoordinationTaskDetail(taskId: string) {
  return getCoordinationTask(taskId)
}
