import {
  clearPendingRetriesForChain,
  getActiveRunForAutomation,
  getAutomationDetail,
  getNextRetryAttemptForChain,
  getRun,
  listDueAutomations,
  listDueRetryRuns,
} from './automation-store.ts'
import { startAutomationRun } from './automation-run-starter.ts'
import { AutomationRunConflictError, AutomationRunStartError } from './automation-service-errors.ts'
import {
  getRetryRootRunId,
  hasRemainingWorkRunBudget,
  maybeReportFailedRun,
} from './automation-service-reporting.ts'
import { log } from './logger.ts'

export type AutomationUpdatePublisher = () => void

async function maybeRunDueRetries(now: Date, publishAutomationUpdated: AutomationUpdatePublisher) {
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
      await startAutomationRun(run.automationId, run.kind, publishAutomationUpdated, {
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

async function maybeRunDueAutomations(now: Date, publishAutomationUpdated: AutomationUpdatePublisher) {
  const due = listDueAutomations(now)
  for (const automation of due) {
    if (automation.status === 'paused' || automation.status === 'archived' || automation.status === 'needs_user' || automation.status === 'running') continue
    const detail = getAutomationDetail(automation.id)
    if (!detail) continue
    if (!hasRemainingWorkRunBudget(detail, now)) continue
    if (getActiveRunForAutomation(automation.id)) continue
    const shouldEnrich = !detail.brief || !detail.brief.approvedAt || detail.status === 'draft'
    try {
      await startAutomationRun(automation.id, shouldEnrich ? 'enrichment' : 'execution', publishAutomationUpdated, shouldEnrich
        ? {}
        : {
            sopTriggerType: 'schedule',
            sopInputs: {
              source: 'automation_schedule',
              scheduledFor: automation.nextRunAt || now.toISOString(),
            },
          })
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

export async function runAutomationScheduler(now: Date, publishAutomationUpdated: AutomationUpdatePublisher) {
  await maybeRunDueRetries(now, publishAutomationUpdated)
  await maybeRunDueAutomations(now, publishAutomationUpdated)
}
