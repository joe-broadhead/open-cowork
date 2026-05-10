import type { AutomationRunKind, ExecutionBrief, SopTriggerType } from '@open-cowork/shared'
import {
  clearPendingRetriesForChain,
  countConsecutiveFailedWorkRuns,
  createAutomationRunWhenNoActive,
  getActiveRunForAutomation,
  getAutomationDetail,
  getRun,
  listAutomationState,
  listOpenInboxForAutomation,
  markRunFailed,
  updateAutomationStatus,
} from './automation-store.ts'
import {
  agentForAutomationRun,
  createAutomationSession,
} from './automation-session-runner.ts'
import {
  AUTOMATION_CONSECUTIVE_FAILURE_LIMIT,
  classifyAutomationFailure,
} from './automation-failure-policy.ts'
import { AutomationRunConflictError, AutomationRunStartError } from './automation-service-errors.ts'
import {
  hasRemainingWorkRunBudget,
  workRunBudgetMessage,
} from './automation-service-reporting.ts'
import {
  createAutomationEnrichmentFormat,
  createAutomationEnrichmentPrompt,
  createAutomationExecutionPrompt,
  createAutomationHeartbeatFormat,
  createAutomationHeartbeatPrompt,
} from './automation-prompts.ts'
import { resolveSopRunContextForAutomationStart } from './sop-run-context.ts'

export interface StartAutomationRunOptions {
  attempt?: number
  retryOfRunId?: string | null
  title?: string
  sopTriggerType?: SopTriggerType | null
  sopInputs?: Record<string, unknown>
}

export async function startAutomationRun(
  automationId: string,
  kind: AutomationRunKind,
  publishAutomationUpdated: () => void,
  options: StartAutomationRunOptions = {},
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
  const sopRunLink = resolveSopRunContextForAutomationStart({
    automation,
    kind,
    triggerType: options.sopTriggerType,
    retryOfRunId: options.retryOfRunId,
    inputs: options.sopInputs,
  })
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
      sopRunLink,
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
