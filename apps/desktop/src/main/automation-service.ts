import type { BrowserWindow } from 'electron'
import type {
  AutomationDraft,
  AutomationListPayload,
  AutomationRun,
  AutomationRunKind,
  ExecutionBrief,
} from '@open-cowork/shared'
import {
  clearPendingRetriesForChain,
  countConsecutiveFailedWorkRuns,
  createAutomation,
  createAutomationRun,
  createAutomationRunWhenNoActive,
  createInboxItem,
  getActiveRunForAutomation,
  getAutomationDetail,
  getInboxItem,
  getNextRetryAttemptForChain,
  getRun,
  listActiveAutomationRuns,
  listAutomationState,
  listDueAutomations,
  listDueHeartbeats,
  listDueRetryRuns,
  listOpenInboxForAutomation,
  markHeartbeatCompleted,
  markRunCancelled,
  markRunCompleted,
  markRunCompletedWithDeliveryRecord,
  markRunFailed,
  markRunNeedsUser,
  openInboxItemsForQuestion,
  resumeAutomationStatus,
  resolveInboxItem,
  saveAutomationBrief,
  updateAutomation,
  updateAutomationStatus,
} from './automation-store.ts'
import {
  agentForAutomationRun,
  createAutomationSession,
  getAutomationSessionMessages,
} from './automation-session-runner.ts'
import {
  AUTOMATION_CONSECUTIVE_FAILURE_LIMIT,
  classifyAutomationFailure,
} from './automation-failure-policy.ts'
import { AutomationRunConflictError, AutomationRunStartError } from './automation-service-errors.ts'
import { buildAutomationApprovalBody, requiresManualApproval } from './automation-service-approval.ts'
import {
  buildRetryScheduledBody,
  getRetryRootRunId,
  hasRemainingWorkRunBudget,
  maybeOpenFailureCircuit,
  maybeReportFailedRun,
  processAutomationRunFailure,
  workRunBudgetMessage,
} from './automation-service-reporting.ts'
import { maybeResumeRunAfterInboxResolution } from './automation-inbox-resolution.ts'
import {
  createAutomationEnrichmentFormat,
  createAutomationEnrichmentPrompt,
  createAutomationExecutionPrompt,
  createAutomationHeartbeatFormat,
  createAutomationHeartbeatPrompt,
} from './automation-prompts.ts'
import {
  extractExecutionBriefFromMessages,
  extractHeartbeatDecisionFromMessages,
  summarizeAutomationMessages,
} from './automation-run-output.ts'
import { deliverAutomationDesktopUpdate } from './automation-delivery.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getClientForDirectory } from './runtime.ts'
import { loadSettings } from './settings.ts'
import { getSessionRecord } from './session-registry.ts'
import { log } from './logger.ts'
import { executionBriefApprovalRevision } from './automation-brief-limits.ts'
import { normalizeSingleQuestionAnswer } from './question-normalization.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import { startSessionStatusReconciliation } from './session-status-reconciler.ts'
import { createPromiseChain } from './promise-chain.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null
let schedulerTimer: NodeJS.Timeout | null = null
let schedulerInFlight = false, heartbeatInFlight = false
const runAutomationControlPlaneSerially = createPromiseChain()
function publishAutomationUpdated() {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send('automation:updated')
}

async function startRun(
  automationId: string,
  kind: AutomationRunKind,
  options: { attempt?: number, retryOfRunId?: string | null, title?: string } = {},
) {
  const automation = getAutomationDetail(automationId)
  if (!automation) throw new Error('Automation not found')
  if (automation.status === 'archived') {
    throw new Error('Archived automations cannot be started.')
  }
  if (kind !== 'heartbeat' && !hasRemainingWorkRunBudget(automation)) {
    throw new Error(workRunBudgetMessage(automation))
  }
  const activeRun = getActiveRunForAutomation(automationId)
  if (activeRun) {
    throw new AutomationRunConflictError(`Automation already has an active ${activeRun.kind} run.`)
  }
  const run = createAutomationRunWhenNoActive(
    automationId,
    kind,
    options.title || (
      kind === 'enrichment'
        ? `Enrich ${automation.title}`
        : kind === 'execution'
          ? `Execute ${automation.title}`
          : `Heartbeat ${automation.title}`
    ),
    {
      attempt: options.attempt,
      retryOfRunId: options.retryOfRunId,
    },
  )
  if (!run) throw new AutomationRunConflictError('Automation already has an active run.')
  const prompt = kind === 'enrichment'
    ? createAutomationEnrichmentPrompt(automation)
    : kind === 'execution'
      ? createAutomationExecutionPrompt(automation, automation.brief as ExecutionBrief)
      : createAutomationHeartbeatPrompt({
        automation,
        openInbox: listOpenInboxForAutomation(automationId),
        recentRuns: listAutomationState().runs.filter((entry) => entry.automationId === automationId).slice(0, 5),
      })
  const format = kind === 'enrichment'
    ? createAutomationEnrichmentFormat()
    : kind === 'heartbeat'
      ? createAutomationHeartbeatFormat()
      : undefined
  try {
    await createAutomationSession({
      automationId,
      runId: run.id,
      title: run.title,
      directory: automation.projectDirectory,
      agent: agentForAutomationRun(kind),
      prompt,
      format,
    }, publishAutomationUpdated)
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error)
    const disposition = classifyAutomationFailure(failureMessage)
    const failedRun = markRunFailed(run.id, failureMessage, undefined, {
      retryable: disposition.retryable,
      failureCode: disposition.code,
    })
    if (failedRun) {
      const consecutiveFailures = countConsecutiveFailedWorkRuns(automationId)
      const shouldPause = failedRun.kind !== 'heartbeat' && (!disposition.retryable || consecutiveFailures >= AUTOMATION_CONSECUTIVE_FAILURE_LIMIT)
      if (shouldPause) {
        clearPendingRetriesForChain(failedRun.retryOfRunId || failedRun.id)
        updateAutomationStatus(automationId, 'paused')
      }
    }
    throw new AutomationRunStartError(error instanceof Error ? error.message : String(error), {
      runId: failedRun?.id,
      retryScheduled: Boolean(getRun(failedRun?.id || '')?.nextRetryAt),
    })
  }
  return getRun(run.id)
}

async function maybeRunDueRetries(now = new Date()) {
  const dueRetries = listDueRetryRuns(now)
  const processedRoots = new Set<string>()
  for (const run of dueRetries) {
    const retryRootRunId = getRetryRootRunId(run)
    if (processedRoots.has(retryRootRunId)) continue
    processedRoots.add(retryRootRunId)
    const detail = getAutomationDetail(run.automationId)
    if (!detail || detail.status === 'paused' || detail.status === 'archived') continue
    if (getActiveRunForAutomation(run.automationId)) continue
    if (!hasRemainingWorkRunBudget(detail, now)) continue
    clearPendingRetriesForChain(retryRootRunId)
    const nextAttempt = getNextRetryAttemptForChain(retryRootRunId)
    try {
      await startRun(run.automationId, run.kind, {
        attempt: nextAttempt,
        retryOfRunId: retryRootRunId,
        title: `${run.title} (retry ${nextAttempt})`,
      })
    } catch (error) {
      if (error instanceof AutomationRunConflictError) continue
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Failed to start retry for automation ${run.automationId}: ${message}`)
      if (error instanceof AutomationRunStartError && error.retryScheduled) continue
      const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
      maybeReportFailedRun(run.automationId, failedRun, 'Automation retry failed to start', message)
    }
  }
}

async function maybeRunDueAutomations(now = new Date()) {
  const due = listDueAutomations(now)
  for (const automation of due) {
    if (automation.status === 'paused' || automation.status === 'archived' || automation.status === 'needs_user' || automation.status === 'running') continue
    const detail = getAutomationDetail(automation.id)
    if (!detail) continue
    if (!hasRemainingWorkRunBudget(detail, now)) continue
    if (getActiveRunForAutomation(automation.id)) continue
    const shouldEnrich = !detail.brief || !detail.brief.approvedAt || detail.status === 'draft'
    try {
      await startRun(automation.id, shouldEnrich ? 'enrichment' : 'execution')
    } catch (error) {
      if (error instanceof AutomationRunConflictError) continue
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Failed to start automation ${automation.id}: ${message}`)
      if (error instanceof AutomationRunStartError && error.retryScheduled) continue
      const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
      maybeReportFailedRun(automation.id, failedRun, 'Automation could not start', message)
    }
  }
}

async function maybeRunAutomationScheduler(now = new Date()) {
  if (schedulerInFlight) return
  schedulerInFlight = true
  await runAutomationControlPlaneSerially(async () => {
    try {
      await maybeRunDueRetries(now)
      await maybeRunDueAutomations(now)
    } finally {
      schedulerInFlight = false
      publishAutomationUpdated()
    }
  })
}

async function maybeRunHeartbeatReviews(now = new Date()) {
  if (heartbeatInFlight) return
  heartbeatInFlight = true
  await runAutomationControlPlaneSerially(async () => {
    const due = listDueHeartbeats(now)
    try {
      for (const automation of due) {
        const detail = getAutomationDetail(automation.id)
        if (!detail) continue
        const openInbox = listOpenInboxForAutomation(automation.id)
        if (detail.status === 'needs_user') {
          const heartbeatRun = createAutomationRun(automation.id, 'heartbeat', `Heartbeat ${automation.title}`)
          if (!heartbeatRun) continue
          const summary = openInbox.length > 0
            ? `Waiting on user input or approval (${openInbox.length} open item${openInbox.length === 1 ? '' : 's'}).`
            : 'Waiting on user input.'
          if (openInbox.length === 0) {
            createInboxItem({
              automationId: automation.id,
              runId: heartbeatRun.id,
              type: 'info',
              title: 'Automation waiting for input',
              body: 'This automation is paused until the missing context or approval is provided.',
            })
          }
          markHeartbeatCompleted(heartbeatRun.id, summary)
          continue
        }
        try {
          await startRun(automation.id, 'heartbeat')
        } catch (error) {
          if (error instanceof AutomationRunConflictError) continue
          const message = error instanceof Error ? error.message : String(error)
          log('error', `Failed to start automation heartbeat ${automation.id}: ${message}`)
          const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
          maybeReportFailedRun(automation.id, failedRun, 'Automation heartbeat failed to start', message)
        }
      }
    } finally {
      heartbeatInFlight = false
    }
  })
}

async function maybeEnforceRunTimeLimits(now = new Date()) {
  const activeRuns = listActiveAutomationRuns()
  for (const run of activeRuns) {
    if (run.kind === 'heartbeat') continue
    const automation = getAutomationDetail(run.automationId)
    if (!automation) continue
    const startedAt = run.startedAt || run.createdAt
    if (!startedAt) continue
    const elapsedMs = now.getTime() - new Date(startedAt).getTime()
    if (elapsedMs < automation.runPolicy.maxRunDurationMinutes * 60_000) continue
    const message = `Automation run timed out after exceeding the ${automation.runPolicy.maxRunDurationMinutes}-minute run cap.`
    if (run.sessionId) {
      const record = getSessionRecord(run.sessionId)
      if (record) {
        await ensureRuntimeContextDirectory(record.opencodeDirectory)
        const client = getClientForDirectory(record.opencodeDirectory)
        try {
          await client?.session.abort({ sessionID: run.sessionId })
        } catch (error) {
          log('error', `Failed to abort timed-out automation run ${run.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        handleAutomationSessionError(run.sessionId, message)
        continue
      }
    }
    processAutomationRunFailure({
      automationId: run.automationId,
      run,
      title: 'Automation run timed out',
      message,
      sessionId: null,
      failureCode: 'run_timeout',
    })
    publishAutomationUpdated()
  }
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
  const created = createAutomation(draft)
  publishAutomationUpdated()
  return created
}

export function updateAutomationRecord(automationId: string, draft: Partial<AutomationDraft>) {
  const updated = updateAutomation(automationId, draft)
  publishAutomationUpdated()
  return updated
}

export function pauseAutomationRecord(automationId: string) {
  const updated = updateAutomationStatus(automationId, 'paused')
  publishAutomationUpdated()
  return updated
}

export function resumeAutomationRecord(automationId: string) {
  const updated = resumeAutomationStatus(automationId)
  publishAutomationUpdated()
  return updated
}

export function archiveAutomationRecord(automationId: string) {
  const updated = updateAutomationStatus(automationId, 'archived')
  publishAutomationUpdated()
  return updated
}

export async function previewAutomationBrief(automationId: string) {
  const automation = getAutomationDetail(automationId)
  if (!automation) return null
  await startRun(automationId, 'enrichment')
  publishAutomationUpdated()
  return getAutomationDetail(automationId)
}

export function approveAutomationBrief(automationId: string) {
  const automation = getAutomationDetail(automationId)
  if (!automation?.brief) return null
  const approvedBrief: ExecutionBrief = {
    ...automation.brief,
    status: 'ready',
    approvedAt: new Date().toISOString(),
  }
  const updated = saveAutomationBrief(automationId, approvedBrief)
  for (const item of listOpenInboxForAutomation(automationId, 'approval')) {
    if (item.runId) {
      const run = getRun(item.runId)
      if (run?.automationId === automationId && run.kind === 'enrichment' && run.status === 'needs_user') {
        markRunCompleted(item.runId, 'Execution brief approved.', item.sessionId)
      }
    }
    resolveInboxItem(item.id, 'resolved')
  }
  publishAutomationUpdated()
  return getAutomationDetail(automationId) || updated
}

export async function runAutomationNow(automationId: string): Promise<AutomationRun | null> {
  const automation = getAutomationDetail(automationId)
  if (!automation) return null
  if (!automation.brief || !automation.brief.approvedAt) {
    await previewAutomationBrief(automationId)
    return null
  }
  const run = await startRun(automationId, 'execution')
  publishAutomationUpdated()
  return run
}

export async function retryAutomationRun(runId: string): Promise<AutomationRun | null> {
  const run = getRun(runId)
  if (!run || run.status === 'running') return null
  const automation = getAutomationDetail(run.automationId)
  if (!automation) return null
  if (automation.status === 'archived') {
    throw new Error('Archived automations cannot be started.')
  }
  const activeRun = getActiveRunForAutomation(run.automationId)
  if (activeRun) {
    throw new Error(`Automation already has an active ${activeRun.kind} run.`)
  }
  const retryRootRunId = getRetryRootRunId(run)
  const nextAttempt = getNextRetryAttemptForChain(retryRootRunId)
  try {
    const started = await startRun(run.automationId, run.kind, {
      attempt: nextAttempt,
      retryOfRunId: retryRootRunId,
      title: `${run.title} (retry ${nextAttempt})`,
    })
    if (started) clearPendingRetriesForChain(retryRootRunId, started.id)
    return started
  } catch (error) {
    if (error instanceof AutomationRunStartError && error.runId) {
      clearPendingRetriesForChain(retryRootRunId, error.runId)
    }
    throw error
  }
}

export async function cancelAutomationRun(runId: string) {
  const run = getRun(runId)
  if (!run || !run.sessionId || run.status !== 'running') return false
  const record = getSessionRecord(run.sessionId)
  if (!record) {
    markRunCancelled(runId, 'Automation run cancelled.')
    publishAutomationUpdated()
    return true
  }
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  try {
    await client?.session.abort({ sessionID: run.sessionId })
  } catch (error) {
    log('error', `Failed to abort automation run ${run.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
  markRunCancelled(runId, 'Automation run cancelled.')
  publishAutomationUpdated()
  return true
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
          await startRun(record.automationId, 'enrichment')
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
          await startRun(record.automationId, 'execution')
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
          await startRun(record.automationId, 'execution')
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
