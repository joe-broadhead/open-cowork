import { dispatchRuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import type { IpcHandlerContext } from './context.ts'
import type { IpcMainInvokeEvent } from 'electron'
import { normalizeSessionId } from './session-handler-validation.ts'
import { normalizeQuestionAnswers, normalizeQuestionRequestId } from '../question-normalization.ts'
import { clearPermission, getPermissionSession } from '../permission-tracker.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { log } from '@open-cowork/shared/node'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

const MAX_PERMISSION_REQUEST_ID_BYTES = 256

function normalizePermissionRequestId(value: unknown) {
  if (typeof value !== 'string') throw new Error('Permission request id must be a string')
  if (Buffer.byteLength(value, 'utf8') > MAX_PERMISSION_REQUEST_ID_BYTES) {
    throw new Error(`Permission request id exceeds ${MAX_PERMISSION_REQUEST_ID_BYTES} bytes`)
  }
  const requestId = value.trim()
  if (!requestId) throw new Error('Permission request id is required')
  return requestId
}

function normalizePermissionDecision(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Permission decision must be a boolean')
  return value
}

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
    permissionId: unknown,
    allowed: unknown,
    explicitSessionId?: unknown,
    optionsInput?: unknown,
  ) => {
    const normalizedPermissionId = normalizePermissionRequestId(permissionId)
    const normalizedAllowed = normalizePermissionDecision(allowed)
    const normalizedExplicitSessionId = explicitSessionId == null
      ? null
      : normalizeSessionId(explicitSessionId)
    const workspaceId = readWorkspaceIdOption(optionsInput)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      if (!normalizedExplicitSessionId) throw new Error('Session id is required')
      const sessionId = normalizedExplicitSessionId
      await context.workspaceGateway.respondCloudPermission(_event, sessionId, normalizedPermissionId, normalizedAllowed, workspaceId)
      await publishCloudSessionView(context, _event, sessionId, workspaceId)
      return
    }

    const pendingApproval = sessionEngine.getPendingApprovals()
      .find((entry) => entry.approval.id === normalizedPermissionId)?.approval
    const rootSessionId = pendingApproval?.sessionId || normalizedExplicitSessionId
    const sourceSessionId = getPermissionSession(normalizedPermissionId)
      || pendingApproval?.sourceSessionId
      || rootSessionId
    if (!rootSessionId || !sourceSessionId) throw new Error(`No session for permission ${normalizedPermissionId}`)
    const { client } = await context.getSessionV2Client(rootSessionId)

    log('permission', `${normalizedAllowed ? 'Approved' : 'Denied'} ${normalizedPermissionId}`)
    await client.v2.session.permission.reply({
      sessionID: sourceSessionId,
      requestID: normalizedPermissionId,
      reply: normalizedAllowed ? 'once' : 'reject',
    }, {
      throwOnError: true,
    })
    clearPermission(normalizedPermissionId)
    const resolvedSessionId = sessionEngine.resolveApproval(normalizedPermissionId)
    const win = context.getMainWindow()
    if (resolvedSessionId && win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'approval_resolved',
        sessionId: resolvedSessionId,
        data: { type: 'approval_resolved', id: normalizedPermissionId },
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

    const pendingQuestion = sessionEngine.getPendingQuestions()
      .find((entry) => entry.question.id === requestId)?.question
    const sourceSessionId = pendingQuestion?.sourceSessionId || sessionId
    const { client } = await context.getSessionV2Client(sessionId)
    await client.v2.session.question.reply({
      sessionID: sourceSessionId,
      requestID: requestId,
      questionV2Reply: { answers },
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

    const pendingQuestion = sessionEngine.getPendingQuestions()
      .find((entry) => entry.question.id === requestId)?.question
    const sourceSessionId = pendingQuestion?.sourceSessionId || sessionId
    const { client } = await context.getSessionV2Client(sessionId)
    await client.v2.session.question.reject({
      sessionID: sourceSessionId,
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
