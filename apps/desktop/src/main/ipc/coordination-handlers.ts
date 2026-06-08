import type {
  CoordinationProjectInput,
  CoordinationProjectUpdateInput,
  CoordinationTaskAssignInput,
  CoordinationTaskInput,
  CoordinationTaskMoveInput,
  CoordinationTaskUpdateInput,
  CoordinationTaskWorkLinkInput,
  WorkspaceOptions,
} from '@open-cowork/shared'
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcHandlerContext } from './context.ts'
import {
  objectArg,
  optionalObjectArg,
  registerIpcInvoke,
  stringAndObjectArgs,
  stringAndOptionalObjectArgs,
} from './schema.ts'
import {
  assignCoordinationTask,
  createCoordinationProject,
  createCoordinationTask,
  getCoordinationProjectDetail,
  getCoordinationTaskDetail,
  getCoordinationTaskWorkTarget,
  linkCoordinationTaskToSession,
  listCoordinationBoard,
  listCoordinationProjects,
  listCoordinationTasks,
  moveCoordinationTask,
  updateCoordinationProject,
  updateCoordinationTask,
} from '../coordination/coordination-service.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

const LOCAL_COORDINATION_WORKSPACE_ID = 'local'

type CoordinationListOptions = WorkspaceOptions & {
  projectId?: string | null
  limit?: number
}

function assertCoordinationId(value: unknown, label = 'coordination id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) {
    throw new Error(`${label} is invalid.`)
  }
  return value.trim()
}

function normalizeWorkspaceOptions(value: Record<string, unknown>): WorkspaceOptions {
  const workspaceId = readWorkspaceIdOption(value)
  return workspaceId ? { workspaceId } : {}
}

function normalizeCoordinationListOptions(value: Record<string, unknown>): CoordinationListOptions {
  const workspaceId = readWorkspaceIdOption(value)
  const projectId = typeof value.projectId === 'string' && value.projectId.trim()
    ? value.projectId.trim()
    : null
  const limit = Number.isInteger(value.limit) && Number(value.limit) > 0
    ? Math.min(Number(value.limit), 1000)
    : undefined
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(limit ? { limit } : {}),
  }
}

function assertLocalWorkspace(context: IpcHandlerContext, event: IpcMainInvokeEvent, options?: unknown) {
  context.workspaceGateway.assertLocalWorkspace(event, readWorkspaceIdOption(options))
}

function isLocalProject(projectId: string) {
  return getCoordinationProjectDetail(projectId)?.workspaceId === LOCAL_COORDINATION_WORKSPACE_ID
}

function isLocalTask(taskId: string) {
  return getCoordinationTaskDetail(taskId)?.workspaceId === LOCAL_COORDINATION_WORKSPACE_ID
}

export function registerCoordinationHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'coordination:board', optionalObjectArg<CoordinationListOptions>('coordination options', normalizeCoordinationListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return listCoordinationBoard(options)
  })

  registerIpcInvoke(context, 'coordination:projects:list', optionalObjectArg<WorkspaceOptions>('workspace options', normalizeWorkspaceOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return listCoordinationProjects(options)
  })

  registerIpcInvoke(context, 'coordination:projects:create', objectArg<CoordinationProjectInput>('coordination project'), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    return createCoordinationProject(input)
  })

  registerIpcInvoke(context, 'coordination:projects:update', stringAndObjectArgs<CoordinationProjectUpdateInput>('project id', 'coordination project update'), async (event, projectId, input) => {
    assertLocalWorkspace(context, event)
    const id = assertCoordinationId(projectId, 'Project id')
    if (!isLocalProject(id)) return null
    return updateCoordinationProject(id, input)
  })

  registerIpcInvoke(context, 'coordination:tasks:list', optionalObjectArg<CoordinationListOptions>('coordination task options', normalizeCoordinationListOptions), async (event, options) => {
    assertLocalWorkspace(context, event, options)
    return listCoordinationTasks(options)
  })

  registerIpcInvoke(context, 'coordination:tasks:create', objectArg<CoordinationTaskInput>('coordination task'), async (event, input) => {
    assertLocalWorkspace(context, event, input)
    return createCoordinationTask(input)
  })

  registerIpcInvoke(context, 'coordination:tasks:update', stringAndObjectArgs<CoordinationTaskUpdateInput>('task id', 'coordination task update'), async (event, taskId, input) => {
    assertLocalWorkspace(context, event)
    const id = assertCoordinationId(taskId, 'Task id')
    if (!isLocalTask(id)) return null
    return updateCoordinationTask(id, input)
  })

  registerIpcInvoke(context, 'coordination:tasks:move', stringAndObjectArgs<CoordinationTaskMoveInput>('task id', 'coordination task move'), async (event, taskId, input) => {
    assertLocalWorkspace(context, event)
    const id = assertCoordinationId(taskId, 'Task id')
    if (!isLocalTask(id)) return null
    return moveCoordinationTask(id, input)
  })

  registerIpcInvoke(context, 'coordination:tasks:assign', stringAndObjectArgs<CoordinationTaskAssignInput>('task id', 'coordination task assignment'), async (event, taskId, input) => {
    assertLocalWorkspace(context, event)
    const id = assertCoordinationId(taskId, 'Task id')
    if (!isLocalTask(id)) return null
    return assignCoordinationTask(id, input)
  })

  registerIpcInvoke(context, 'coordination:tasks:link-work', stringAndObjectArgs<CoordinationTaskWorkLinkInput>('task id', 'coordination task work link'), async (event, taskId, input) => {
    assertLocalWorkspace(context, event)
    const id = assertCoordinationId(taskId, 'Task id')
    if (!isLocalTask(id)) return null
    return linkCoordinationTaskToSession(id, input)
  })

  registerIpcInvoke(context, 'coordination:tasks:work-target', stringAndOptionalObjectArgs<WorkspaceOptions>('task id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, taskId, options) => {
    assertLocalWorkspace(context, event, options)
    const id = assertCoordinationId(taskId, 'Task id')
    if (!isLocalTask(id)) return null
    return getCoordinationTaskWorkTarget(id)
  })
}
