import type { IpcHandlerContext } from './context.ts'
import {
  archiveWorkflow,
  getWorkflowDetail,
  listWorkflows,
  pauseWorkflow,
  regenerateWebhookSecret,
  resumeWorkflow,
  runWorkflowNow,
  startWorkflowDraft,
} from '../workflow-service.ts'

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
  context.ipcMain.handle('workflows:list', async () => {
    return listWorkflows()
  })

  context.ipcMain.handle('workflows:get', async (_event, workflowId: string) => {
    return getWorkflowDetail(assertWorkflowId(workflowId))
  })

  context.ipcMain.handle('workflows:start-draft', async (_event, directory?: string | null) => {
    return startWorkflowDraft(resolveOptionalDirectory(context, directory))
  })

  context.ipcMain.handle('workflows:run-now', async (_event, workflowId: string) => {
    return runWorkflowNow(assertWorkflowId(workflowId))
  })

  context.ipcMain.handle('workflows:pause', async (_event, workflowId: string) => {
    return pauseWorkflow(assertWorkflowId(workflowId))
  })

  context.ipcMain.handle('workflows:resume', async (_event, workflowId: string) => {
    return resumeWorkflow(assertWorkflowId(workflowId))
  })

  context.ipcMain.handle('workflows:archive', async (_event, workflowId: string) => {
    return archiveWorkflow(assertWorkflowId(workflowId))
  })

  context.ipcMain.handle('workflows:regenerate-webhook-secret', async (_event, workflowId: string) => {
    return regenerateWebhookSecret(assertWorkflowId(workflowId))
  })
}
