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
import type { CloudApiRouteInput } from './types.ts'
import {
  assignCoordinationTask,
  createCoordinationProject,
  createCoordinationTask,
  getCoordinationProjectDetail,
  getCoordinationTaskDetail,
  linkCoordinationTaskToValidatedWork,
  listCoordinationBoard,
  listCoordinationProjects,
  listCoordinationTasks,
  moveCoordinationTask,
  updateCoordinationProject,
  updateCoordinationTask,
} from '../../coordination/coordination-service.ts'

function coordinationWorkspaceId(context: CloudApiRouteInput['context']) {
  return `cloud:${context.principal.tenantId.trim() || context.principal.orgId || context.principal.userId || 'default'}`
}

function coordinationErrorStatus(error: unknown) {
  const status = Number((error as { status?: unknown } | null)?.status)
  if (Number.isInteger(status) && status >= 400 && status < 600) return status
  if (!(error instanceof Error)) return 500
  if (/\bnot found\b/i.test(error.message)) return 404
  if (/(required|invalid|must|too large|cannot|workspace|parent|artifact|assignee|title|objective|status|column|priority)/i.test(error.message)) {
    return 400
  }
  return 500
}

function writeCoordinationError(input: CloudApiRouteInput, error: unknown) {
  const status = coordinationErrorStatus(error)
  const message = error instanceof Error && status < 500 ? error.message : 'Coordination request failed.'
  input.tools.writeError(input.res, status, message, input.options.corsOrigin)
}

function taskProjectId(body: Record<string, unknown>) {
  return typeof body.projectId === 'string' ? body.projectId.trim() : ''
}

function taskParentId(body: Record<string, unknown>) {
  return typeof body.parentTaskId === 'string' ? body.parentTaskId.trim() : ''
}

function workLinkSessionId(body: Record<string, unknown>) {
  return typeof body.assignedSessionId === 'string' ? body.assignedSessionId.trim() : ''
}

function cloudSessionInfo(view: Awaited<ReturnType<CloudApiRouteInput['options']['service']['getSessionView']>>): SessionInfo {
  return {
    id: view.session.sessionId,
    title: view.session.title || undefined,
    createdAt: view.session.createdAt,
    updatedAt: view.session.updatedAt,
    kind: 'interactive',
  }
}

function requireProjectInWorkspace(input: CloudApiRouteInput, projectId: string, workspaceId: string) {
  const project = getCoordinationProjectDetail(projectId)
  if (!project || project.workspaceId !== workspaceId) {
    input.tools.writeError(input.res, 404, 'Coordination project was not found.', input.options.corsOrigin)
    return null
  }
  return project
}

function requireTaskInWorkspace(input: CloudApiRouteInput, taskId: string, workspaceId: string) {
  const task = getCoordinationTaskDetail(taskId)
  if (!task || task.workspaceId !== workspaceId) {
    input.tools.writeError(input.res, 404, 'Coordination task was not found.', input.options.corsOrigin)
    return null
  }
  return task
}

export async function handleCoordinationApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId: collection, action: itemId, artifactId: itemAction, tools } = input
  const limit = tools.parseLimit(context.url)
  const workspaceId = coordinationWorkspaceId(context)

  if (collection === 'board' && !itemId && req.method === 'GET') {
    tools.writeJson(res, 200, listCoordinationBoard({ workspaceId, limit }), options.corsOrigin)
    return true
  }

  if (collection === 'projects') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, listCoordinationProjects({ workspaceId, limit }), options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        tools.writeJson(res, 201, createCoordinationProject({
          ...(body as CoordinationProjectInput),
          workspaceId,
        }), options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
    if (itemId && !itemAction && req.method === 'POST') {
      if (!requireProjectInWorkspace(input, itemId, workspaceId)) return true
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        const project = updateCoordinationProject(itemId, body as CoordinationProjectUpdateInput)
        if (!project) {
          tools.writeError(res, 404, 'Coordination project was not found.', options.corsOrigin)
          return true
        }
        tools.writeJson(res, 200, project, options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
  }

  if (collection === 'tasks') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, listCoordinationTasks({
        workspaceId,
        projectId: context.url.searchParams.get('projectId'),
        limit,
      }), options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const projectId = taskProjectId(body)
      if (!projectId) {
        tools.writeError(res, 400, 'Task project id is required.', options.corsOrigin)
        return true
      }
      if (!requireProjectInWorkspace(input, projectId, workspaceId)) return true
      const parentTaskId = taskParentId(body)
      if (parentTaskId) {
        const parentTask = getCoordinationTaskDetail(parentTaskId)
        if (!parentTask || parentTask.workspaceId !== workspaceId || parentTask.projectId !== projectId) {
          tools.writeError(res, 404, 'Parent coordination task was not found.', options.corsOrigin)
          return true
        }
      }
      try {
        tools.writeJson(res, 201, createCoordinationTask({
          ...(body as CoordinationTaskInput),
          workspaceId,
        }), options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
    if (itemId && !itemAction && req.method === 'POST') {
      const existing = requireTaskInWorkspace(input, itemId, workspaceId)
      if (!existing) return true
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const parentTaskId = taskParentId(body)
      if (parentTaskId) {
        const parentTask = getCoordinationTaskDetail(parentTaskId)
        if (!parentTask || parentTask.workspaceId !== workspaceId || parentTask.projectId !== existing.projectId) {
          tools.writeError(res, 404, 'Parent coordination task was not found.', options.corsOrigin)
          return true
        }
      }
      try {
        const task = updateCoordinationTask(itemId, body as CoordinationTaskUpdateInput)
        if (!task) {
          tools.writeError(res, 404, 'Coordination task was not found.', options.corsOrigin)
          return true
        }
        tools.writeJson(res, 200, task, options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
    if (itemId && itemAction === 'move' && req.method === 'POST') {
      if (!requireTaskInWorkspace(input, itemId, workspaceId)) return true
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        const task = moveCoordinationTask(itemId, body as CoordinationTaskMoveInput)
        if (!task) {
          tools.writeError(res, 404, 'Coordination task was not found.', options.corsOrigin)
          return true
        }
        tools.writeJson(res, 200, task, options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
    if (itemId && itemAction === 'assign' && req.method === 'POST') {
      if (!requireTaskInWorkspace(input, itemId, workspaceId)) return true
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      try {
        const task = assignCoordinationTask(itemId, body as CoordinationTaskAssignInput)
        if (!task) {
          tools.writeError(res, 404, 'Coordination task was not found.', options.corsOrigin)
          return true
        }
        tools.writeJson(res, 200, task, options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
    if (itemId && itemAction === 'link-work' && req.method === 'POST') {
      if (!requireTaskInWorkspace(input, itemId, workspaceId)) return true
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const assignedSessionId = workLinkSessionId(body)
      if (!assignedSessionId) {
        tools.writeError(res, 400, 'Assigned session id is required.', options.corsOrigin)
        return true
      }
      try {
        const sessionView = await options.service.getSessionView(context.principal, assignedSessionId)
        const task = linkCoordinationTaskToValidatedWork(itemId, {
          ...(body as CoordinationTaskWorkLinkInput),
          assignedSessionId: sessionView.session.sessionId,
        })
        if (!task) {
          tools.writeError(res, 404, 'Coordination task was not found.', options.corsOrigin)
          return true
        }
        tools.writeJson(res, 200, task, options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
    if (itemId && itemAction === 'work-target' && req.method === 'GET') {
      const task = requireTaskInWorkspace(input, itemId, workspaceId)
      if (!task) return true
      if (!task.assignedSessionId) {
        tools.writeJson(res, 200, null, options.corsOrigin)
        return true
      }
      try {
        const sessionView = await options.service.getSessionView(context.principal, task.assignedSessionId)
        tools.writeJson(res, 200, cloudSessionInfo(sessionView), options.corsOrigin)
      } catch (error) {
        writeCoordinationError(input, error)
      }
      return true
    }
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
