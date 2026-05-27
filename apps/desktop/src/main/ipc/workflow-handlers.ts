import type { IpcHandlerContext } from './context.ts'
import type { WorkspaceOptions } from '@open-cowork/shared'
import {
  optionalObjectArg,
  optionalStringArg,
  registerIpcInvoke,
  stringAndOptionalObjectArgs,
  stringArg,
} from './schema.ts'
import {
  archiveWorkflow,
  getWorkflowDetail,
  listWorkflows,
  pauseWorkflow,
  regenerateWebhookSecret,
  resumeWorkflow,
  runWorkflowNow,
  startWorkflowDraft,
} from '../workflow/workflow-service.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

function assertWorkflowId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error('Workflow id is invalid.')
  }
  return value.trim()
}

function resolveOptionalDirectory(context: IpcHandlerContext, value: unknown) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error('Workflow directory must be a string.')
  const trimmed = value.trim()
  if (!trimmed) return null
  return context.resolveGrantedProjectDirectory(trimmed)
}

function normalizeWorkspaceOptions(value: Record<string, unknown>): WorkspaceOptions {
  const workspaceId = readWorkspaceIdOption(value)
  return workspaceId ? { workspaceId } : {}
}

export function registerWorkflowHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'workflows:list', optionalObjectArg<WorkspaceOptions>('workspace options', normalizeWorkspaceOptions), async (event, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.listCloudWorkflows(event, workspaceId)
    }
    return listWorkflows()
  })

  registerIpcInvoke(context, 'workflows:get', stringAndOptionalObjectArgs<WorkspaceOptions>('workflow id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, workflowId, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.getCloudWorkflow(event, assertWorkflowId(workflowId), workspaceId)
    }
    return getWorkflowDetail(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:start-draft', optionalStringArg('workflow directory'), async (event, directory) => {
    context.workspaceGateway.assertLocalWorkspace(event)
    return startWorkflowDraft(resolveOptionalDirectory(context, directory))
  })

  registerIpcInvoke(context, 'workflows:run-now', stringAndOptionalObjectArgs<WorkspaceOptions>('workflow id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, workflowId, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.runCloudWorkflow(event, assertWorkflowId(workflowId), workspaceId)
    }
    return runWorkflowNow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:pause', stringAndOptionalObjectArgs<WorkspaceOptions>('workflow id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, workflowId, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.pauseCloudWorkflow(event, assertWorkflowId(workflowId), workspaceId)
    }
    return pauseWorkflow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:resume', stringAndOptionalObjectArgs<WorkspaceOptions>('workflow id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, workflowId, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.resumeCloudWorkflow(event, assertWorkflowId(workflowId), workspaceId)
    }
    return resumeWorkflow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:archive', stringAndOptionalObjectArgs<WorkspaceOptions>('workflow id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, workflowId, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.archiveCloudWorkflow(event, assertWorkflowId(workflowId), workspaceId)
    }
    return archiveWorkflow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:regenerate-webhook-secret', stringArg('workflow id'), async (event, workflowId) => {
    context.workspaceGateway.assertLocalWorkspace(event)
    return regenerateWebhookSecret(assertWorkflowId(workflowId))
  })
}
