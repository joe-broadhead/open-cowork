import type { BrowserWindow } from 'electron'
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationFailureCode,
  AutomationListPayload,
  AutomationRun,
  AutomationRunKind,
  ExecutionBrief,
} from '@open-cowork/shared'
import {
  attachRunSession,
  clearPendingRetriesForChain,
  countConsecutiveFailedWorkRuns,
  countAutomationWorkRunAttemptsForDay,
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
  markRunFailed,
  markRunNeedsUser,
  markRunStarted,
  openInboxItemsForQuestion,
  resumeRunFromNeedsUser,
  resumeAutomationStatus,
  resolveInboxItem,
  saveAutomationBrief,
  updateAutomation,
  updateAutomationStatus,
} from './automation-store.ts'
import {
  AUTOMATION_CONSECUTIVE_FAILURE_LIMIT,
  classifyAutomationFailure,
} from './automation-failure-policy.ts'
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
import { deliverAutomationDesktopUpdate, deliverAutomationRunResult } from './automation-delivery.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { getEffectiveSettings, loadSettings } from './settings.ts'
import { normalizeSessionInfo, normalizeSessionMessages } from './opencode-adapter.ts'
import { toIsoTimestamp } from './task-run-utils.ts'
import { toSessionRecord, upsertSessionRecord, getSessionRecord } from './session-registry.ts'
import { trackParentSession } from './event-task-state.ts'
import { log } from './logger.ts'
import type { OutputFormat } from '@opencode-ai/sdk/v2'

let getMainWindow: (() => BrowserWindow | null) | null = null
let schedulerTimer: NodeJS.Timeout | null = null
let schedulerInFlight = false
let heartbeatInFlight = false

function getRetryRootRunId(run: AutomationRun) {
  return run.retryOfRunId || run.id
}

class AutomationRunStartError extends Error {
  runId: string | null
  retryScheduled: boolean

  constructor(message: string, options: { runId?: string | null, retryScheduled?: boolean } = {}) {
    super(message)
    this.name = 'AutomationRunStartError'
    this.runId = options.runId ?? null
    this.retryScheduled = options.retryScheduled ?? false
  }
}

class AutomationRunConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutomationRunConflictError'
  }
}

function publishAutomationUpdated() {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send('automation:updated')
}

function requiresManualApproval(automation: AutomationDetail) {
  return automation.autonomyPolicy === 'review-first'
}

function buildApprovalBody(brief: ExecutionBrief) {
  const lines = [
    'The execution brief is ready.',
    '',
    `Deliverables: ${brief.deliverables.join(', ') || 'None specified.'}`,
    `Recommended agents: ${brief.recommendedAgents.join(', ') || 'Use standard plan/build routing.'}`,
    `Approval boundary: ${brief.approvalBoundary}`,
  ]
  if (brief.missingContext.length > 0) {
    lines.push('', 'Missing context:', ...brief.missingContext)
  }
  return lines.join('\n')
}

function hasBlockingInboxItems(automationId: string) {
  return listOpenInboxForAutomation(automationId).some((item) =>
    item.type === 'clarification' || item.type === 'approval' || item.type === 'failure')
}

function maybeResumeRunAfterInboxResolution(automationId: string, runId: string | null) {
  if (!runId) return
  const automation = getAutomationDetail(automationId)
  if (!automation || automation.status === 'paused' || automation.status === 'archived') return
  if (hasBlockingInboxItems(automationId)) return
  resumeRunFromNeedsUser(runId)
}

function reportAutomationFailure(automationId: string, title: string, body: string, runId?: string | null, sessionId?: string | null) {
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

function buildRetryScheduledBody(run: AutomationRun, message: string) {
  if (!run.nextRetryAt) return message
  return `${message}\n\nRetry attempt ${run.attempt + 1} is scheduled for ${new Date(run.nextRetryAt).toLocaleString()}.`
}

function maybeReportFailedRun(automationId: string, run: AutomationRun | null, title: string, message: string, sessionId?: string | null) {
  if (!run) {
    reportAutomationFailure(automationId, title, message, null, sessionId)
    return
  }
  if (run.nextRetryAt) return
  reportAutomationFailure(automationId, title, message, run.id, sessionId)
}

function maybeOpenFailureCircuit(options: {
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

function hasRemainingWorkRunBudget(automation: AutomationDetail, now = new Date()) {
  const usedRuns = countAutomationWorkRunAttemptsForDay(automation.id, automation.schedule.timezone, now)
  return usedRuns < automation.runPolicy.dailyRunCap
}

function workRunBudgetMessage(automation: AutomationDetail) {
  return `Automation daily work-run attempt cap reached (${automation.runPolicy.dailyRunCap} attempt${automation.runPolicy.dailyRunCap === 1 ? '' : 's'} per day, including retries).`
}

function processAutomationRunFailure(input: {
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
  publishAutomationUpdated()
  return failedRun
}

async function createAutomationSession(options: {
  automationId: string
  runId: string
  title: string
  directory: string | null
  agent: 'plan' | 'build' | 'cowork-exec'
  prompt: string
  format?: OutputFormat
}) {
  const opencodeDirectory = options.directory || getRuntimeHomeDir()
  await ensureRuntimeContextDirectory(opencodeDirectory)
  const client = getClientForDirectory(opencodeDirectory)
  if (!client) throw new Error('Runtime not started')
  const created = await client.session.create({}, { throwOnError: true })
  const session = normalizeSessionInfo(created.data)
  if (!session?.id) throw new Error('Runtime returned an invalid session payload')
  const settings = getEffectiveSettings()
  const sessionRecord = toSessionRecord({
    id: session.id,
    title: options.title,
    createdAt: toIsoTimestamp(session.time.created),
    updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
    opencodeDirectory,
    providerId: settings.effectiveProviderId || null,
    modelId: settings.effectiveModel || null,
    kind: 'automation',
    automationId: options.automationId,
    runId: options.runId,
  })
  upsertSessionRecord(sessionRecord)
  trackParentSession(session.id)
  attachRunSession(options.runId, session.id)
  markRunStarted(options.runId, session.id)
  publishAutomationUpdated()
  await client.session.promptAsync({
    sessionID: session.id,
    parts: [{ type: 'text', text: options.prompt }],
    agent: options.agent,
    ...(options.format ? { format: options.format } : {}),
  }, { throwOnError: true })
  return session.id
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
      agent: kind === 'enrichment' ? 'plan' : kind === 'execution' ? 'build' : 'cowork-exec',
      prompt,
      format,
    })
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
  try {
    await maybeRunDueRetries(now)
    await maybeRunDueAutomations(now)
  } finally {
    schedulerInFlight = false
    publishAutomationUpdated()
  }
}

async function maybeRunHeartbeatReviews(now = new Date()) {
  if (heartbeatInFlight) return
  heartbeatInFlight = true
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
  }
}

async function getSessionMessages(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record) return []
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  if (!client) return []
  const result = await client.session.messages({ sessionID: sessionId }, { throwOnError: true })
  return normalizeSessionMessages(result.data)
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
  const record = getSessionRecord(item.sessionId)
  if (!record) return false
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  if (!client) return false
  await client.question.reply({
    requestID: item.questionId,
    answers: [[response]],
  }, { throwOnError: true })
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
  const messages = await getSessionMessages(sessionId)
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
      const openInbox = listOpenInboxForAutomation(record.automationId)
      if (automation.brief?.approvedAt && openInbox.length === 0 && automation.status !== 'paused' && automation.status !== 'archived') {
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
            body: buildApprovalBody(brief),
          })
        }
        const refreshedAutomation = getAutomationDetail(record.automationId)
        if (refreshedAutomation) {
          deliverAutomationDesktopUpdate({
            automation: refreshedAutomation,
            runId: run.id,
            settings: loadSettings(),
            title: 'Execution brief ready for approval',
            body: buildApprovalBody(brief),
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

  markRunCompleted(run.id, summary, sessionId)
  const automation = getAutomationDetail(record.automationId)
  const completedRun = getRun(run.id)
  if (automation && completedRun?.status === 'completed') {
    deliverAutomationRunResult({ automation, run: completedRun, summary })
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
