import type { AutomationDetail, AutomationRun, AutomationRunKind, ExecutionBrief, SopTriggerType } from '@open-cowork/shared'
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
import { type SopRunStartContext, resolveSopRunContextForAutomationStart } from './sop-run-context.ts'
import {
  enqueueAutomationOperationalQueueItem,
  listQueuedAutomationOperationalQueueItems,
  startAutomationOperationalQueueItem,
  syncAutomationOperationalQueueStatus,
} from './automation-operational-queue.ts'
import { log } from './logger.ts'

export interface StartAutomationRunOptions {
  attempt?: number
  retryOfRunId?: string | null
  title?: string
  sopTriggerType?: SopTriggerType | null
  sopInputs?: Record<string, unknown>
  sopRunContext?: SopRunStartContext | null
  workspaceProfileId?: string | null
  channelId?: string | null
}

function automationRunTitle(automation: AutomationDetail, kind: AutomationRunKind) {
  return kind === 'enrichment'
    ? `Enrich ${automation.title}`
    : kind === 'execution'
      ? `Execute ${automation.title}`
      : `Heartbeat ${automation.title}`
}

function buildAutomationPromptAndFormat(automation: AutomationDetail, kind: AutomationRunKind) {
  const prompt = kind === 'enrichment'
    ? createAutomationEnrichmentPrompt(automation)
    : kind === 'execution'
      ? createAutomationExecutionPrompt(automation, automation.brief as ExecutionBrief)
      : createAutomationHeartbeatPrompt({
        automation,
        openInbox: listOpenInboxForAutomation(automation.id),
        recentRuns: listAutomationState().runs.filter((entry) => entry.automationId === automation.id).slice(0, 5),
      })
  const format = kind === 'enrichment'
    ? createAutomationEnrichmentFormat()
    : kind === 'heartbeat'
      ? createAutomationHeartbeatFormat()
      : undefined
  return { prompt, format }
}

function recordAutomationRunStartFailure(run: AutomationRun, error: unknown) {
  const failureMessage = error instanceof Error ? error.message : String(error)
  const disposition = classifyAutomationFailure(failureMessage)
  const failedRun = markRunFailed(run.id, failureMessage, undefined, {
    retryable: disposition.retryable,
    failureCode: disposition.code,
  })
  syncAutomationOperationalQueueStatus(failedRun, failureMessage)
  if (failedRun) {
    const consecutiveFailures = countConsecutiveFailedWorkRuns(run.automationId)
    const shouldPause = failedRun.kind !== 'heartbeat' && (!disposition.retryable || consecutiveFailures >= AUTOMATION_CONSECUTIVE_FAILURE_LIMIT)
    if (shouldPause) {
      clearPendingRetriesForChain(failedRun.retryOfRunId || failedRun.id)
      updateAutomationStatus(run.automationId, 'paused')
    }
  }
  return new AutomationRunStartError(failureMessage, {
    runId: failedRun?.id,
    retryScheduled: Boolean(getRun(failedRun?.id || '')?.nextRetryAt),
  })
}

async function dispatchAutomationRunThroughOpenCode(
  automation: AutomationDetail,
  run: AutomationRun,
  publishAutomationUpdated: () => void,
) {
  const { prompt, format } = buildAutomationPromptAndFormat(automation, run.kind)
  try {
    await createAutomationSession({
      automationId: automation.id,
      runId: run.id,
      title: run.title,
      directory: automation.projectDirectory,
      agent: agentForAutomationRun(run.kind),
      prompt,
      format,
    }, publishAutomationUpdated)
    return getRun(run.id)
  } catch (error) {
    throw recordAutomationRunStartFailure(run, error)
  }
}

export async function dispatchRunnableAutomationQueueItems(
  publishAutomationUpdated: () => void,
  limit = 5,
) {
  const dispatched: AutomationRun[] = []
  const dispatchLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  let attemptedDispatches = 0
  const queued = listQueuedAutomationOperationalQueueItems()
  for (const item of queued) {
    if (attemptedDispatches >= dispatchLimit) break
    const run = getRun(item.runId)
    if (!run) {
      syncAutomationOperationalQueueStatus({
        id: item.runId,
        automationId: 'unknown',
        sessionId: null,
        kind: 'execution',
        status: 'failed',
        title: item.title,
        summary: null,
        error: 'Automation run is missing.',
        attempt: 1,
        retryOfRunId: null,
        nextRetryAt: null,
        createdAt: item.createdAt,
        startedAt: null,
        finishedAt: null,
      }, 'Automation run is missing.')
      continue
    }
    const automation = getAutomationDetail(run.automationId)
    if (!automation) {
      syncAutomationOperationalQueueStatus(markRunFailed(run.id, 'Automation record is missing.', undefined, {
        retryable: false,
        failureCode: 'configuration_invalid',
      }), 'Automation record is missing.')
      continue
    }
    const started = startAutomationOperationalQueueItem(run.id)
    if (!started || started.status !== 'running') continue
    attemptedDispatches += 1
    try {
      const startedRun = await dispatchAutomationRunThroughOpenCode(automation, run, publishAutomationUpdated)
      if (startedRun) dispatched.push(startedRun)
    } catch (error) {
      log('error', `Failed to dispatch queued automation run ${run.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (dispatched.length > 0) publishAutomationUpdated()
  return dispatched
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
  const sopRunLink = kind === 'execution' && options.sopRunContext
    ? options.sopRunContext
    : resolveSopRunContextForAutomationStart({
      automation,
      kind,
      triggerType: options.sopTriggerType,
      retryOfRunId: options.retryOfRunId,
      inputs: options.sopInputs,
    })
  const run = createAutomationRunWhenNoActive(
    automationId,
    kind,
    options.title || automationRunTitle(automation, kind),
    {
      attempt: options.attempt,
      retryOfRunId: options.retryOfRunId,
      sopRunLink,
    },
  )
  if (!run) throw new AutomationRunConflictError('Automation already has an active run.')
  enqueueAutomationOperationalQueueItem(automation, run, {
    runKind: sopRunLink ? 'sop' : 'automation',
    workspaceProfileId: options.workspaceProfileId,
    channelId: options.channelId,
  })
  const started = startAutomationOperationalQueueItem(run.id)
  if (!started || started.status !== 'running') {
    publishAutomationUpdated()
    return getRun(run.id)
  }
  const startedRun = await dispatchAutomationRunThroughOpenCode(automation, run, publishAutomationUpdated)
  syncAutomationOperationalQueueStatus(startedRun)
  return startedRun
}
