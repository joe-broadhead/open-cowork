import { validateAutomationDraft } from '../automation-validation.ts'
import {
  approveAutomationBrief,
  archiveAutomationRecord,
  cancelAutomationRun,
  createAutomationRecord,
  dismissAutomationInbox,
  getAutomation,
  listAutomations,
  pauseAutomationRecord,
  previewAutomationBrief,
  retryAutomationRun,
  respondToAutomationInbox,
  resumeAutomationRecord,
  runAutomationNow,
  updateAutomationRecord,
} from '../automation-service.ts'
import type { IpcHandlerContext } from './context.ts'
import type { AutomationDraft } from '@open-cowork/shared'

function resolveAutomationProjectDirectory(context: IpcHandlerContext, directory: string | null | undefined) {
  const trimmed = typeof directory === 'string' ? directory.trim() : ''
  return trimmed ? context.resolveGrantedProjectDirectory(trimmed) : null
}

function normalizeAutomationDraft(context: IpcHandlerContext, draft: AutomationDraft): AutomationDraft {
  return {
    ...draft,
    projectDirectory: resolveAutomationProjectDirectory(context, draft.projectDirectory),
  }
}

function normalizeAutomationPatch(context: IpcHandlerContext, patch: Partial<AutomationDraft>): Partial<AutomationDraft> {
  if (!Object.prototype.hasOwnProperty.call(patch, 'projectDirectory')) return patch
  return {
    ...patch,
    projectDirectory: resolveAutomationProjectDirectory(context, patch.projectDirectory),
  }
}

export function registerAutomationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('automation:list', async () => {
    return listAutomations()
  })

  context.ipcMain.handle('automation:get', async (_event, automationId: string) => {
    return getAutomation(automationId)
  })

  context.ipcMain.handle('automation:create', async (_event, draft: AutomationDraft) => {
    const normalizedDraft = normalizeAutomationDraft(context, draft)
    const error = validateAutomationDraft(normalizedDraft)
    if (error) throw new Error(error)
    return createAutomationRecord(normalizedDraft)
  })

  context.ipcMain.handle('automation:update', async (_event, automationId: string, draft: Partial<AutomationDraft>) => {
    const current = getAutomation(automationId)
    if (!current) throw new Error('Automation not found.')
    const normalizedPatch = normalizeAutomationPatch(context, draft)
    const mergedDraft: AutomationDraft = {
      title: normalizedPatch.title ?? current.title,
      goal: normalizedPatch.goal ?? current.goal,
      kind: normalizedPatch.kind ?? current.kind,
      schedule: normalizedPatch.schedule ?? current.schedule,
      heartbeatMinutes: normalizedPatch.heartbeatMinutes ?? current.heartbeatMinutes,
      retryPolicy: normalizedPatch.retryPolicy ?? current.retryPolicy,
      runPolicy: normalizedPatch.runPolicy ?? current.runPolicy,
      executionMode: normalizedPatch.executionMode ?? current.executionMode,
      autonomyPolicy: normalizedPatch.autonomyPolicy ?? current.autonomyPolicy,
      projectDirectory: normalizedPatch.projectDirectory === undefined ? current.projectDirectory : normalizedPatch.projectDirectory,
      preferredAgentNames: normalizedPatch.preferredAgentNames ?? current.preferredAgentNames,
    }
    const error = validateAutomationDraft(mergedDraft)
    if (error) throw new Error(error)
    return updateAutomationRecord(automationId, normalizedPatch)
  })

  context.ipcMain.handle('automation:pause', async (_event, automationId: string) => {
    return pauseAutomationRecord(automationId)
  })

  context.ipcMain.handle('automation:resume', async (_event, automationId: string) => {
    return resumeAutomationRecord(automationId)
  })

  context.ipcMain.handle('automation:archive', async (_event, automationId: string) => {
    return archiveAutomationRecord(automationId)
  })

  context.ipcMain.handle('automation:run-now', async (_event, automationId: string) => {
    return runAutomationNow(automationId)
  })

  context.ipcMain.handle('automation:retry-run', async (_event, runId: string) => {
    return retryAutomationRun(runId)
  })

  context.ipcMain.handle('automation:cancel-run', async (_event, runId: string) => {
    return cancelAutomationRun(runId)
  })

  context.ipcMain.handle('automation:preview-brief', async (_event, automationId: string) => {
    return previewAutomationBrief(automationId)
  })

  context.ipcMain.handle('automation:approve-brief', async (_event, automationId: string) => {
    return approveAutomationBrief(automationId)
  })

  context.ipcMain.handle('automation:inbox-respond', async (_event, itemId: string, response: string) => {
    return respondToAutomationInbox(itemId, response)
  })

  context.ipcMain.handle('automation:inbox-dismiss', async (_event, itemId: string) => {
    return dismissAutomationInbox(itemId)
  })
}
