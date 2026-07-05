import { dispatchRuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import type { IpcHandlerContext } from './context.ts'
import type { IpcMainInvokeEvent } from 'electron'
import { normalizeSessionId } from './session-handler-validation.ts'
import { normalizeQuestionAnswers, normalizeQuestionRequestId } from '../question-normalization.ts'
import { clearPermission, getPermissionSession } from '../permission-tracker.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { log } from '../logger.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

async function publishCloudSessionView(
  context: IpcHandlerContext,
  event: IpcMainInvokeEvent,
  sessionId: string,
  workspaceId?: string | null,
) {
  const win = context.getMainWindow()
  if (!win || win.isDestroyed()) return
  const view = await context.workspaceGateway.getCloudSessionView(event, sessionId, workspaceId)
  if (!win.isDestroyed()) {
    win.webContents.send('session:view', {
      sessionId,
      workspaceId: workspaceId || undefined,
      view,
    })
  }
}

function resolveQuestionLocally(context: IpcHandlerContext, sessionId: string, requestId: string) {
  const win = context.getMainWindow()
  dispatchRuntimeSessionEvent(win, {
    type: 'question_resolved',
    sessionId,
    data: {
      type: 'question_resolved',
      id: requestId,
    },
  })
}

export function registerSessionInteractionHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('permission:respond', async (
    _event,
    permissionId: string,
    allowed: boolean,
    explicitSessionId?: string | null,
    optionsInput?: unknown,
  ) => {
    const workspaceId = readWorkspaceIdOption(optionsInput)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      const sessionId = normalizeSessionId(explicitSessionId)
      await context.workspaceGateway.respondCloudPermission(_event, sessionId, permissionId, allowed, workspaceId)
      await publishCloudSessionView(context, _event, sessionId, workspaceId)
      return
    }

    const sessionId = explicitSessionId || getPermissionSession(permissionId)
    if (!sessionId) throw new Error(`No session for permission ${permissionId}`)
    const { client } = await context.getSessionV2Client(sessionId)

    log('permission', `${allowed ? 'Approved' : 'Denied'} ${permissionId}`)
    await client.permission.reply({
      requestID: permissionId,
      reply: allowed ? 'once' : 'reject',
    }, {
      throwOnError: true,
    })
    clearPermission(permissionId)
    const resolvedSessionId = sessionEngine.resolveApproval(permissionId)
    const win = context.getMainWindow()
    if (resolvedSessionId && win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'approval_resolved',
        sessionId: resolvedSessionId,
        data: { type: 'approval_resolved', id: permissionId },
      })
    }
  })

  context.ipcMain.handle('question:reply', async (_event, sessionIdInput: unknown, requestIdInput: unknown, answersInput: unknown, optionsInput?: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const requestId = normalizeQuestionRequestId(requestIdInput)
    const answers = normalizeQuestionAnswers(answersInput)
    const workspaceId = readWorkspaceIdOption(optionsInput)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      await context.workspaceGateway.replyCloudQuestion(_event, sessionId, requestId, answers, workspaceId)
      await publishCloudSessionView(context, _event, sessionId, workspaceId)
      return
    }

    const { client } = await context.getSessionV2Client(sessionId)
    await client.question.reply({
      requestID: requestId,
      answers,
    }, { throwOnError: true })
    resolveQuestionLocally(context, sessionId, requestId)
    startSessionStatusReconciliation(sessionId, {
      getMainWindow: context.getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        context.reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  context.ipcMain.handle('question:reject', async (_event, sessionIdInput: unknown, requestIdInput: unknown, optionsInput?: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const requestId = normalizeQuestionRequestId(requestIdInput)
    const workspaceId = readWorkspaceIdOption(optionsInput)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      await context.workspaceGateway.rejectCloudQuestion(_event, sessionId, requestId, workspaceId)
      await publishCloudSessionView(context, _event, sessionId, workspaceId)
      return
    }

    const { client } = await context.getSessionV2Client(sessionId)
    await client.question.reject({
      requestID: requestId,
    }, { throwOnError: true })
    resolveQuestionLocally(context, sessionId, requestId)
    startSessionStatusReconciliation(sessionId, {
      getMainWindow: context.getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        context.reconcileIdleSession(reconciledSessionId)
      },
    })
  })
}
