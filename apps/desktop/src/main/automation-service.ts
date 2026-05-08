import type { BrowserWindow } from 'electron'
import type {
  AutomationDraft,
  AutomationListPayload,
  AutomationRun,
  ExecutionBrief,
} from '@open-cowork/shared'
import {
  createInboxItem,
  getAutomationDetail,
  getInboxItem,
  getRun,
  listAutomationState,
  listOpenInboxForAutomation,
  markHeartbeatCompleted,
  markRunCompleted,
  markRunCompletedWithDeliveryRecord,
  markRunFailed,
  markRunNeedsUser,
  openInboxItemsForQuestion,
  resolveInboxItem,
  saveAutomationBrief,
} from './automation-store.ts'
import { getAutomationSessionMessages } from './automation-session-runner.ts'
import { classifyAutomationFailure } from './automation-failure-policy.ts'
import { AutomationRunConflictError, AutomationRunStartError } from './automation-service-errors.ts'
import { buildAutomationApprovalBody, requiresManualApproval } from './automation-service-approval.ts'
import {
  buildRetryScheduledBody,
  maybeOpenFailureCircuit,
  maybeReportFailedRun,
  processAutomationRunFailure,
} from './automation-service-reporting.ts'
import { retryAutomationRunWithContext } from './automation-retry.ts'
import { runAutomationHeartbeatReviews } from './automation-heartbeat.ts'
import { runAutomationScheduler } from './automation-scheduler.ts'
import { enforceAutomationRunTimeLimits } from './automation-timeouts.ts'
import { maybeResumeRunAfterInboxResolution } from './automation-inbox-resolution.ts'
import { cancelAutomationRunWithContext } from './automation-cancellation.ts'
import {
  approveAutomationBriefWithContext,
  previewAutomationBriefWithContext,
  runAutomationNowWithContext,
} from './automation-manual-actions.ts'
import {
  archiveAutomationRecordWithContext,
  createAutomationRecordWithContext,
  pauseAutomationRecordWithContext,
  resumeAutomationRecordWithContext,
  updateAutomationRecordWithContext,
} from './automation-record-actions.ts'
import {
  extractExecutionBriefFromMessages,
  extractHeartbeatDecisionFromMessages,
  summarizeAutomationMessages,
} from './automation-run-output.ts'
import { startAutomationRun } from './automation-run-starter.ts'
import { deliverAutomationDesktopUpdate } from './automation-delivery.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getClientForDirectory } from './runtime.ts'
import { loadSettings } from './settings.ts'
import { getSessionRecord } from './session-registry.ts'
import { executionBriefApprovalRevision } from './automation-brief-limits.ts'
import { normalizeSingleQuestionAnswer } from './question-normalization.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import { startSessionStatusReconciliation } from './session-status-reconciler.ts'
import { createPromiseChain } from './promise-chain.ts'
import { createCoalescedControlPlaneTask } from './automation-control-plane-queue.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null
let schedulerTimer: NodeJS.Timeout | null = null
const runAutomationControlPlaneSerially = createPromiseChain()
const runSchedulerTick = createCoalescedControlPlaneTask(runAutomationControlPlaneSerially)
const runHeartbeatTick = createCoalescedControlPlaneTask(runAutomationControlPlaneSerially)
function publishAutomationUpdated() {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send('automation:updated')
}

async function maybeRunAutomationScheduler(now = new Date()) {
  await runSchedulerTick.run(async () => {
    try {
      await runAutomationScheduler(now, publishAutomationUpdated)
    } finally {
      publishAutomationUpdated()
    }
  })
}

async function maybeRunHeartbeatReviews(now = new Date()) {
  await runHeartbeatTick.run(async () => {
    await runAutomationHeartbeatReviews(now, publishAutomationUpdated)
  })
}

async function maybeEnforceRunTimeLimits(now = new Date()) {
  await enforceAutomationRunTimeLimits(now, handleAutomationSessionError, publishAutomationUpdated)
}

export function configureAutomationService(options: {
  getMainWindow: () => BrowserWindow | null
}) {
  getMainWindow = options.getMainWindow
}

export function startAutomationService() {
  if (schedulerTimer) return
  void runAutomationServiceTick()
  schedulerTimer = setInterval(() => {
    void runAutomationServiceTick()
  }, 60_000)
}

export function stopAutomationService() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
}

export async function runAutomationServiceTick(now = new Date()) {
  await maybeEnforceRunTimeLimits(now)
  await maybeRunAutomationScheduler(now)
  await maybeRunHeartbeatReviews(now)
}

export function listAutomations(): AutomationListPayload {
  return listAutomationState()
}

export function getAutomation(automationId: string) {
  return getAutomationDetail(automationId)
}

export function createAutomationRecord(draft: AutomationDraft) {
  return createAutomationRecordWithContext(draft, publishAutomationUpdated)
}

export function updateAutomationRecord(automationId: string, draft: Partial<AutomationDraft>) {
  return updateAutomationRecordWithContext(automationId, draft, publishAutomationUpdated)
}

export function pauseAutomationRecord(automationId: string) {
  return pauseAutomationRecordWithContext(automationId, publishAutomationUpdated)
}

export function resumeAutomationRecord(automationId: string) {
  return resumeAutomationRecordWithContext(automationId, publishAutomationUpdated)
}

export function archiveAutomationRecord(automationId: string) {
  return archiveAutomationRecordWithContext(automationId, publishAutomationUpdated)
}

export async function previewAutomationBrief(automationId: string) {
  return previewAutomationBriefWithContext(automationId, publishAutomationUpdated)
}

export function approveAutomationBrief(automationId: string) {
  return approveAutomationBriefWithContext(automationId, publishAutomationUpdated)
}

export async function runAutomationNow(automationId: string): Promise<AutomationRun | null> {
  return runAutomationNowWithContext(automationId, publishAutomationUpdated)
}

export async function retryAutomationRun(runId: string): Promise<AutomationRun | null> {
  return retryAutomationRunWithContext(runId, publishAutomationUpdated)
}

export async function cancelAutomationRun(runId: string) {
  return cancelAutomationRunWithContext(runId, publishAutomationUpdated)
}

export async function respondToAutomationInbox(itemId: string, response: string) {
  const item = getInboxItem(itemId)
  if (!item || !item.sessionId || !item.questionId) return false
  const answer = normalizeSingleQuestionAnswer(response)
  const record = getSessionRecord(item.sessionId)
  if (!record) return false
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  if (!client) return false
  await client.question.reply({
    requestID: item.questionId,
    answers: [[answer]],
  }, { throwOnError: true })
  dispatchRuntimeSessionEvent(getMainWindow?.(), {
    type: 'question_resolved',
    sessionId: item.sessionId,
    data: { type: 'question_resolved', id: item.questionId },
  })
  startSessionStatusReconciliation(item.sessionId, {
    getMainWindow: () => getMainWindow?.() || null,
    onIdle: (_win, reconciledSessionId) => {
      void handleAutomationSessionIdle(reconciledSessionId)
    },
  })
  resolveInboxItem(itemId, 'resolved')
  maybeResumeRunAfterInboxResolution(item.automationId, item.runId)
  publishAutomationUpdated()
  return true
}

export function dismissAutomationInbox(itemId: string) {
  const resolved = resolveInboxItem(itemId, 'dismissed')
  publishAutomationUpdated()
  return Boolean(resolved)
}

export async function handleAutomationSessionIdle(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record || record.kind !== 'automation' || !record.runId || !record.automationId) return
  const run = getRun(record.runId)
  if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'needs_user') return
  const messages = await getAutomationSessionMessages(sessionId)
  const summary = summarizeAutomationMessages(sessionId, messages)
  if (run.kind === 'heartbeat') {
    const automation = getAutomationDetail(record.automationId)
    const decision = extractHeartbeatDecisionFromMessages(messages)
    if (!automation || !decision) {
      markHeartbeatCompleted(run.id, summary)
      publishAutomationUpdated()
      return
    }

    const completionSummary = decision.summary || summary
    if (decision.action === 'request_user') {
      createInboxItem({
        automationId: record.automationId,
        runId: run.id,
        sessionId,
        type: 'clarification',
        title: 'Heartbeat review needs input',
        body: decision.userMessage || decision.reason || completionSummary,
      })
      deliverAutomationDesktopUpdate({
        automation,
        runId: run.id,
        settings: loadSettings(),
        title: 'Automation needs input',
        body: decision.userMessage || decision.reason || completionSummary,
      })
      markHeartbeatCompleted(run.id, completionSummary)
      publishAutomationUpdated()
      return
    }

    if (decision.action === 'refresh_brief') {
      markHeartbeatCompleted(run.id, `${completionSummary} Brief refresh queued.`)
      if (automation.status !== 'paused' && automation.status !== 'archived') {
        try {
          await startAutomationRun(record.automationId, 'enrichment', publishAutomationUpdated)
        } catch (error) {
          if (error instanceof AutomationRunConflictError) {
            publishAutomationUpdated()
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
          maybeReportFailedRun(record.automationId, failedRun, 'Automation brief refresh could not start', message, sessionId)
        }
      }
      publishAutomationUpdated()
      return
    }

    if (decision.action === 'run_execution') {
      const approvedRevision = executionBriefApprovalRevision(automation.brief)
      const openInbox = listOpenInboxForAutomation(record.automationId)
      const latestAutomation = getAutomationDetail(record.automationId)
      if (
        approvedRevision
        && latestAutomation
        && executionBriefApprovalRevision(latestAutomation.brief) === approvedRevision
        && openInbox.length === 0
        && latestAutomation.status !== 'paused'
        && latestAutomation.status !== 'archived'
      ) {
        markHeartbeatCompleted(run.id, `${completionSummary} Execution queued.`)
        try {
          await startAutomationRun(record.automationId, 'execution', publishAutomationUpdated)
        } catch (error) {
          if (error instanceof AutomationRunConflictError) {
            publishAutomationUpdated()
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
          maybeReportFailedRun(record.automationId, failedRun, 'Automation execution could not start', message, sessionId)
        }
      } else {
        markHeartbeatCompleted(run.id, `${completionSummary} Execution was not queued because input or approval is still pending.`)
      }
      publishAutomationUpdated()
      return
    }

    markHeartbeatCompleted(run.id, completionSummary)
    publishAutomationUpdated()
    return
  }
  if (run.kind === 'enrichment') {
    const brief = extractExecutionBriefFromMessages(messages)
    if (!brief) {
      const failureMessage = 'Automation enrichment did not return a parseable execution brief.'
      const disposition = classifyAutomationFailure({
        code: 'brief_unparseable',
        message: failureMessage,
      })
      const failedRun = markRunFailed(run.id, failureMessage, sessionId, {
        retryable: disposition.retryable,
        failureCode: disposition.code,
      })
      maybeOpenFailureCircuit({
        automationId: record.automationId,
        run: failedRun,
        title: 'Enrichment needs attention',
        message: buildRetryScheduledBody(
          failedRun || run,
          'The automation planner did not return a parseable execution brief. Open the linked run thread to inspect the output.',
        ),
        sessionId,
        circuitReason: disposition.retryable ? null : disposition.reason,
      })
      publishAutomationUpdated()
      return
    }
    const automation = getAutomationDetail(record.automationId)
    if (!automation) return
    saveAutomationBrief(record.automationId, brief)
    if (brief.status === 'needs_user') {
      markRunNeedsUser(run.id, 'Waiting for clarification before execution can begin.')
      if (brief.missingContext.length > 0) {
        createInboxItem({
          automationId: record.automationId,
          runId: run.id,
          sessionId,
          type: 'clarification',
          title: 'More context needed',
          body: brief.missingContext.join('\n'),
        })
        const refreshedAutomation = getAutomationDetail(record.automationId)
        if (refreshedAutomation) {
          deliverAutomationDesktopUpdate({
            automation: refreshedAutomation,
            runId: run.id,
            settings: loadSettings(),
            title: 'Automation needs more context',
            body: brief.missingContext.join('\n'),
          })
        }
      }
    } else {
      if (requiresManualApproval(automation)) {
        if (listOpenInboxForAutomation(record.automationId, 'approval').length === 0) {
          createInboxItem({
            automationId: record.automationId,
            runId: run.id,
            sessionId,
            type: 'approval',
            title: 'Execution brief ready for approval',
            body: buildAutomationApprovalBody(brief),
          })
        }
        const refreshedAutomation = getAutomationDetail(record.automationId)
        if (refreshedAutomation) {
          deliverAutomationDesktopUpdate({
            automation: refreshedAutomation,
            runId: run.id,
            settings: loadSettings(),
            title: 'Execution brief ready for approval',
            body: buildAutomationApprovalBody(brief),
          })
        }
        markRunNeedsUser(run.id, 'Execution brief is ready for approval.')
      } else {
        const approvedBrief: ExecutionBrief = {
          ...brief,
          approvedAt: new Date().toISOString(),
          status: 'ready',
        }
        saveAutomationBrief(record.automationId, approvedBrief)
        markRunCompleted(run.id, 'Execution brief auto-approved and ready for execution.', sessionId)
        try {
          await startAutomationRun(record.automationId, 'execution', publishAutomationUpdated)
        } catch (error) {
          if (error instanceof AutomationRunConflictError) {
            publishAutomationUpdated()
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
          maybeReportFailedRun(record.automationId, failedRun, 'Automation execution could not start', message, sessionId)
        }
      }
    }
    publishAutomationUpdated()
    return
  }

  const automation = getAutomationDetail(record.automationId)
  const completed = automation
    ? markRunCompletedWithDeliveryRecord(run.id, summary, sessionId, {
        provider: 'in_app',
        target: 'automation-inbox',
        status: 'delivered',
        title: `${automation.title} output ready`,
        body: summary,
      })
    : { run: markRunCompleted(run.id, summary, sessionId), delivery: null }
  const completedRun = completed.run
  if (automation && completedRun?.status === 'completed') {
    createInboxItem({
      automationId: record.automationId,
      runId: run.id,
      sessionId,
      type: 'info',
      title: 'Automation output ready',
      body: summary,
      promoteAutomationStatus: false,
    })
    deliverAutomationDesktopUpdate({
      automation,
      runId: run.id,
      settings: loadSettings(),
      title: 'Automation output ready',
      body: summary,
    })
  }
  publishAutomationUpdated()
}

export function handleAutomationSessionError(sessionId: string, message: string) {
  const record = getSessionRecord(sessionId)
  if (!record || record.kind !== 'automation' || !record.runId || !record.automationId) return
  const run = getRun(record.runId)
  if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
  processAutomationRunFailure({
    automationId: record.automationId,
    run,
    title: 'Automation run failed',
    message,
    sessionId,
  })
  publishAutomationUpdated()
}

export function handleAutomationQuestionAsked(input: {
  sessionId: string
  questionId: string
  header: string
  question: string
}) {
  const record = getSessionRecord(input.sessionId)
  if (!record || record.kind !== 'automation' || !record.automationId || !record.runId) return
  const run = getRun(record.runId)
  if (!run || run.status === 'cancelled') return
  const existing = openInboxItemsForQuestion(input.questionId)
  if (existing.length > 0) return
  createInboxItem({
    automationId: record.automationId,
    runId: record.runId,
    sessionId: input.sessionId,
    questionId: input.questionId,
    type: 'clarification',
    title: input.header || 'Automation needs input',
    body: input.question,
  })
  const automation = getAutomationDetail(record.automationId)
  if (automation) {
    deliverAutomationDesktopUpdate({
      automation,
      runId: record.runId,
      settings: loadSettings(),
      title: input.header || 'Automation needs input',
      body: input.question,
    })
  }
  markRunNeedsUser(record.runId, input.question)
  publishAutomationUpdated()
}

export function handleAutomationQuestionResolved(questionId: string, options: { resume?: boolean } = {}) {
  const items = openInboxItemsForQuestion(questionId)
  for (const item of items) {
    resolveInboxItem(item.id, 'resolved')
  }
  if (options.resume) {
    for (const item of items) {
      maybeResumeRunAfterInboxResolution(item.automationId, item.runId)
    }
  }
  publishAutomationUpdated()
}
