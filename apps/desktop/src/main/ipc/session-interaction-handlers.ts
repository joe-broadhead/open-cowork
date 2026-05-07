import type { IpcHandlerContext } from './context.ts'
import { normalizeSessionId } from './session-handler-validation.ts'
import { normalizeQuestionAnswers, normalizeQuestionRequestId } from '../question-normalization.ts'
import { clearPermission, getPermissionSession } from '../permission-tracker.ts'
import { dispatchRuntimeSessionEvent } from '../session-event-dispatcher.ts'
import { sessionEngine } from '../session-engine.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { log } from '../logger.ts'

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
  ) => {
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

  context.ipcMain.handle('question:reply', async (_event, sessionIdInput: unknown, requestIdInput: unknown, answersInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const requestId = normalizeQuestionRequestId(requestIdInput)
    const answers = normalizeQuestionAnswers(answersInput)
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

  context.ipcMain.handle('question:reject', async (_event, sessionIdInput: unknown, requestIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const requestId = normalizeQuestionRequestId(requestIdInput)
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
