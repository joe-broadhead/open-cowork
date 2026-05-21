import type { IpcHandlerContext } from './context.ts'
import { noIpcArgs, optionalStringArg, registerIpcInvoke, stringArg } from './schema.ts'
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

export function registerWorkflowHandlers(context: IpcHandlerContext) {
  registerIpcInvoke(context, 'workflows:list', noIpcArgs, async () => {
    return listWorkflows()
  })

  registerIpcInvoke(context, 'workflows:get', stringArg('workflow id'), async (_event, workflowId) => {
    return getWorkflowDetail(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:start-draft', optionalStringArg('workflow directory'), async (_event, directory) => {
    return startWorkflowDraft(resolveOptionalDirectory(context, directory))
  })

  registerIpcInvoke(context, 'workflows:run-now', stringArg('workflow id'), async (_event, workflowId) => {
    return runWorkflowNow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:pause', stringArg('workflow id'), async (_event, workflowId) => {
    return pauseWorkflow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:resume', stringArg('workflow id'), async (_event, workflowId) => {
    return resumeWorkflow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:archive', stringArg('workflow id'), async (_event, workflowId) => {
    return archiveWorkflow(assertWorkflowId(workflowId))
  })

  registerIpcInvoke(context, 'workflows:regenerate-webhook-secret', stringArg('workflow id'), async (_event, workflowId) => {
    return regenerateWebhookSecret(assertWorkflowId(workflowId))
  })
}
