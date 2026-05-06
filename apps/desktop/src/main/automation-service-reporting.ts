import type { AutomationDetail, AutomationFailureCode, AutomationRun } from '@open-cowork/shared'
import { deliverAutomationDesktopUpdate } from './automation-delivery.ts'
import {
  AUTOMATION_CONSECUTIVE_FAILURE_LIMIT,
  classifyAutomationFailure,
} from './automation-failure-policy.ts'
import {
  clearPendingRetriesForChain,
  countAutomationWorkRunAttemptsForDay,
  countConsecutiveFailedWorkRuns,
  createInboxItem,
  getAutomationDetail,
  getRun,
  markRunFailed,
  updateAutomationStatus,
} from './automation-store.ts'
import { loadSettings } from './settings.ts'

export function getRetryRootRunId(run: AutomationRun) {
  return run.retryOfRunId || run.id
}

export function reportAutomationFailure(automationId: string, title: string, body: string, runId?: string | null, sessionId?: string | null) {
  createInboxItem({
    automationId,
    runId: runId || null,
    sessionId: sessionId || null,
    type: 'failure',
    title,
    body,
  })
  const automation = getAutomationDetail(automationId)
  if (automation) {
    deliverAutomationDesktopUpdate({
      automation,
      runId: runId || undefined,
      settings: loadSettings(),
      title,
      body,
    })
  }
}

export function buildRetryScheduledBody(run: AutomationRun, message: string) {
  if (!run.nextRetryAt) return message
  return `${message}\n\nRetry attempt ${run.attempt + 1} is scheduled for ${new Date(run.nextRetryAt).toLocaleString()}.`
}

export function maybeReportFailedRun(automationId: string, run: AutomationRun | null, title: string, message: string, sessionId?: string | null) {
  if (!run) {
    reportAutomationFailure(automationId, title, message, null, sessionId)
    return
  }
  if (run.nextRetryAt) return
  reportAutomationFailure(automationId, title, message, run.id, sessionId)
}

export function maybeOpenFailureCircuit(options: {
  automationId: string
  run: AutomationRun | null
  message: string
  title: string
  sessionId?: string | null
  circuitReason?: string | null
}) {
  const { automationId, run, message, title, sessionId, circuitReason } = options
  if (!run) {
    maybeReportFailedRun(automationId, run, title, message, sessionId)
    return null
  }

  if (circuitReason && run.kind !== 'heartbeat') {
    const retryRootRunId = run.retryOfRunId || run.id
    clearPendingRetriesForChain(retryRootRunId)
    const refreshedRun = getRun(run.id)
    const body = `${message}\n\n${circuitReason}\n\nThe automation has been paused until you review it and resume it.`
    maybeReportFailedRun(automationId, refreshedRun, title, body, sessionId)
    updateAutomationStatus(automationId, 'paused')
    return refreshedRun
  }

  maybeReportFailedRun(automationId, run, title, message, sessionId)
  return run
}

export function hasRemainingWorkRunBudget(automation: AutomationDetail, now = new Date()) {
  const usedRuns = countAutomationWorkRunAttemptsForDay(automation.id, automation.schedule.timezone, now)
  return usedRuns < automation.runPolicy.dailyRunCap
}

export function workRunBudgetMessage(automation: AutomationDetail) {
  return `Automation daily work-run attempt cap reached (${automation.runPolicy.dailyRunCap} attempt${automation.runPolicy.dailyRunCap === 1 ? '' : 's'} per day, including retries).`
}

export function processAutomationRunFailure(input: {
  automationId: string
  run: AutomationRun
  message: string
  title: string
  sessionId?: string | null
  failureCode?: AutomationFailureCode | null
}) {
  const disposition = classifyAutomationFailure({
    code: input.failureCode || null,
    message: input.message,
  })
  const failedRun = markRunFailed(input.run.id, input.message, input.sessionId, {
    retryable: disposition.retryable,
    failureCode: disposition.code,
  })
  const consecutiveFailures = countConsecutiveFailedWorkRuns(input.automationId)
  const circuitReason = input.run.kind === 'heartbeat'
    ? null
    : disposition.retryable
      ? consecutiveFailures >= AUTOMATION_CONSECUTIVE_FAILURE_LIMIT
        ? `The automation has failed ${consecutiveFailures} work runs in a row, so the retry circuit opened to stop repeated churn.`
        : null
      : disposition.reason
  maybeOpenFailureCircuit({
    automationId: input.automationId,
    run: failedRun,
    title: input.title,
    message: buildRetryScheduledBody(failedRun || input.run, input.message),
    sessionId: input.sessionId,
    circuitReason,
  })
  return failedRun
}
