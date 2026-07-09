import { dispatchRuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import {
  createSemanticUiActionList,
  createSemanticUiActionResult,
  type SemanticUiActionId,
  type SemanticUiActionList,
  type SemanticUiActionResult,
} from '@open-cowork/shared'
import type { IpcHandlerContext } from './ipc/context.ts'
import { buildDiagnosticsBundle } from './diagnostics-export.ts'
import { clearPermission, getPermissionSession } from './permission-tracker.ts'
import { normalizeQuestionAnswers, normalizeQuestionRequestId } from './question-normalization.ts'
import { startSessionStatusReconciliation } from './session-status-reconciler.ts'
import { log } from './logger.ts'

function nowIso() {
  return new Date().toISOString()
}

function disabledActionList(reasonCode: string): SemanticUiActionList {
  return createSemanticUiActionList({
    capturedAt: nowIso(),
    actions: [
      {
        id: 'diagnostics.export',
        label: 'Export diagnostics',
        description: 'Return the redacted diagnostics bundle text for local support and release evidence.',
        destructive: false,
        requiresAudit: true,
        enabled: true,
      },
      {
        id: 'approval.allow',
        label: 'Allow approval',
        description: 'Allow a visible local approval request.',
        destructive: false,
        requiresAudit: true,
        auditEventType: 'semantic_ui.approval.allow',
        enabled: false,
        reasonCode,
      },
      {
        id: 'approval.deny',
        label: 'Deny approval',
        description: 'Deny a visible local approval request.',
        destructive: true,
        requiresAudit: true,
        auditEventType: 'semantic_ui.approval.deny',
        enabled: false,
        reasonCode,
      },
      {
        id: 'question.answer',
        label: 'Answer question',
        description: 'Answer a visible local runtime question.',
        destructive: false,
        requiresAudit: true,
        auditEventType: 'semantic_ui.question.answer',
        enabled: false,
        reasonCode,
      },
      {
        id: 'question.reject',
        label: 'Reject question',
        description: 'Reject a visible local runtime question.',
        destructive: true,
        requiresAudit: true,
        auditEventType: 'semantic_ui.question.reject',
        enabled: false,
        reasonCode,
      },
    ],
  })
}

export function createSemanticUiLocalActionList(authority: string): SemanticUiActionList {
  if (authority !== 'desktop-local') {
    return disabledActionList('semantic-ui-action-product-mode-unsupported')
  }
  const pendingApprovals = sessionEngine.getPendingApprovals()
  const pendingQuestions = sessionEngine.getPendingQuestions()
  return createSemanticUiActionList({
    capturedAt: nowIso(),
    actions: [
      {
        id: 'diagnostics.export',
        label: 'Export diagnostics',
        description: 'Return the redacted diagnostics bundle text for local support and release evidence.',
        destructive: false,
        requiresAudit: true,
        enabled: true,
      },
      ...(pendingApprovals.length > 0 ? [
        {
          id: 'approval.allow' as const,
          label: 'Allow approval',
          description: 'Allow a visible local approval request.',
          destructive: false,
          requiresAudit: true,
          auditEventType: 'semantic_ui.approval.allow',
          enabled: true,
        },
        {
          id: 'approval.deny' as const,
          label: 'Deny approval',
          description: 'Deny a visible local approval request.',
          destructive: true,
          requiresAudit: true,
          auditEventType: 'semantic_ui.approval.deny',
          enabled: true,
        },
      ] : []),
      ...(pendingQuestions.length > 0 ? [
        {
          id: 'question.answer' as const,
          label: 'Answer question',
          description: 'Answer a visible local runtime question.',
          destructive: false,
          requiresAudit: true,
          auditEventType: 'semantic_ui.question.answer',
          enabled: true,
        },
        {
          id: 'question.reject' as const,
          label: 'Reject question',
          description: 'Reject a visible local runtime question.',
          destructive: true,
          requiresAudit: true,
          auditEventType: 'semantic_ui.question.reject',
          enabled: true,
        },
      ] : []),
    ],
  })
}

function actionError(actionId: SemanticUiActionId, errorCode: string, message: string): SemanticUiActionResult {
  return createSemanticUiActionResult({
    capturedAt: nowIso(),
    actionId,
    ok: false,
    errorCode,
    message,
  })
}

function readRequiredString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveQuestionLocally(context: IpcHandlerContext, sessionId: string, questionId: string) {
  dispatchRuntimeSessionEvent(context.getMainWindow(), {
    type: 'question_resolved',
    sessionId,
    data: {
      type: 'question_resolved',
      id: questionId,
    },
  })
  startSessionStatusReconciliation(sessionId, {
    getMainWindow: context.getMainWindow,
    onIdle: (_win, reconciledSessionId) => {
      context.reconcileIdleSession(reconciledSessionId)
    },
  })
}

async function executeApprovalAction(
  context: IpcHandlerContext,
  actionId: Extract<SemanticUiActionId, 'approval.allow' | 'approval.deny'>,
  input: Record<string, unknown>,
) {
  const approvalId = readRequiredString(input, 'approvalId')
  if (!approvalId) return actionError(actionId, 'semantic-ui-action-input-invalid', 'approvalId is required.')
  const pending = sessionEngine.getPendingApprovals().find((entry) => entry.approval.id === approvalId)
  if (!pending) return actionError(actionId, 'semantic-ui-action-stale', 'The requested approval is no longer pending.')
  const sessionId = pending.approval.sessionId || getPermissionSession(approvalId) || pending.sessionId
  const { client } = await context.getSessionV2Client(sessionId)
  const allowed = actionId === 'approval.allow'
  await client.permission.reply({
    requestID: approvalId,
    reply: allowed ? 'once' : 'reject',
  }, {
    throwOnError: true,
  })
  clearPermission(approvalId)
  const resolvedSessionId = sessionEngine.resolveApproval(approvalId)
  if (resolvedSessionId) {
    dispatchRuntimeSessionEvent(context.getMainWindow(), {
      type: 'approval_resolved',
      sessionId: resolvedSessionId,
      data: { type: 'approval_resolved', id: approvalId },
    })
  }
  log('audit', `${actionId} semantic-ui target=${approvalId} session=${sessionId}`)
  return createSemanticUiActionResult({
    capturedAt: nowIso(),
    actionId,
    ok: true,
    content: {
      audited: true,
      auditEventType: `semantic_ui.${actionId}`,
      approvalId,
      sessionId,
    },
  })
}

async function executeQuestionAction(
  context: IpcHandlerContext,
  actionId: Extract<SemanticUiActionId, 'question.answer' | 'question.reject'>,
  input: Record<string, unknown>,
) {
  const questionIdInput = readRequiredString(input, 'questionId')
  if (!questionIdInput) return actionError(actionId, 'semantic-ui-action-input-invalid', 'questionId is required.')
  const questionId = normalizeQuestionRequestId(questionIdInput)
  const pending = sessionEngine.getPendingQuestions().find((entry) => entry.question.id === questionId)
  if (!pending) return actionError(actionId, 'semantic-ui-action-stale', 'The requested question is no longer pending.')
  const { client } = await context.getSessionV2Client(pending.sessionId)
  if (actionId === 'question.answer') {
    const answers = normalizeQuestionAnswers(input.answers)
    await client.question.reply({
      requestID: questionId,
      answers,
    }, { throwOnError: true })
  } else {
    await client.question.reject({
      requestID: questionId,
    }, { throwOnError: true })
  }
  resolveQuestionLocally(context, pending.sessionId, questionId)
  log('audit', `${actionId} semantic-ui target=${questionId} session=${pending.sessionId}`)
  return createSemanticUiActionResult({
    capturedAt: nowIso(),
    actionId,
    ok: true,
    content: {
      audited: true,
      auditEventType: `semantic_ui.${actionId}`,
      questionId,
      sessionId: pending.sessionId,
    },
  })
}

export async function executeSemanticUiLocalAction(
  context: IpcHandlerContext,
  actionId: SemanticUiActionId,
  input: Record<string, unknown>,
) {
  if (actionId === 'diagnostics.export') {
    if (Object.keys(input).length > 0) {
      return actionError(actionId, 'semantic-ui-action-input-unsupported', 'This action does not accept input.')
    }
    log('audit', 'diagnostics.export semantic-ui')
    return createSemanticUiActionResult({
      capturedAt: nowIso(),
      actionId,
      ok: true,
      content: {
        mime: 'text/plain',
        text: buildDiagnosticsBundle(),
        audited: true,
        auditEventType: 'semantic_ui.diagnostics.export',
      },
    })
  }
  if (actionId === 'approval.allow' || actionId === 'approval.deny') {
    return executeApprovalAction(context, actionId, input)
  }
  if (actionId === 'question.answer' || actionId === 'question.reject') {
    return executeQuestionAction(context, actionId, input)
  }
  throw new Error(`Unsupported local semantic UI action ${actionId}`)
}
