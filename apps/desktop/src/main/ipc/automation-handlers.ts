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

export function registerAutomationHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('automation:list', async () => {
    return listAutomations()
  })

  context.ipcMain.handle('automation:get', async (_event, automationId: string) => {
    return getAutomation(automationId)
  })

  context.ipcMain.handle('automation:create', async (_event, draft: AutomationDraft) => {
    const error = validateAutomationDraft(draft)
    if (error) throw new Error(error)
    return createAutomationRecord(draft)
  })

  context.ipcMain.handle('automation:update', async (_event, automationId: string, draft: Partial<AutomationDraft>) => {
    const current = getAutomation(automationId)
    if (!current) throw new Error('Automation not found.')
    const mergedDraft: AutomationDraft = {
      title: draft.title ?? current.title,
      goal: draft.goal ?? current.goal,
      kind: draft.kind ?? current.kind,
      schedule: draft.schedule ?? current.schedule,
      heartbeatMinutes: draft.heartbeatMinutes ?? current.heartbeatMinutes,
      retryPolicy: draft.retryPolicy ?? current.retryPolicy,
      executionMode: draft.executionMode ?? current.executionMode,
      autonomyPolicy: draft.autonomyPolicy ?? current.autonomyPolicy,
      projectDirectory: draft.projectDirectory === undefined ? current.projectDirectory : draft.projectDirectory,
    }
    const error = validateAutomationDraft(mergedDraft)
    if (error) throw new Error(error)
    return updateAutomationRecord(automationId, draft)
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
