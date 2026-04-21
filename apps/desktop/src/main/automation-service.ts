import type { BrowserWindow } from 'electron'
import type {
  AutomationDetail,
  AutomationDraft,
  AutomationListPayload,
  AutomationRun,
  AutomationRunKind,
  ExecutionBrief,
} from '@open-cowork/shared'
import {
  attachRunSession,
  createAutomation,
  createAutomationRun,
  createInboxItem,
  getActiveRunForAutomation,
  getAutomationDetail,
  getInboxItem,
  getRun,
  listAutomationState,
  listDueAutomations,
  listDueHeartbeats,
  listOpenInboxForAutomation,
  listInboxForSession,
  markHeartbeatCompleted,
  markRunCancelled,
  markRunCompleted,
  markRunFailed,
  markRunNeedsUser,
  markRunStarted,
  openInboxItemsForQuestion,
  resumeAutomationStatus,
  resolveInboxItem,
  saveAutomationBrief,
  updateAutomation,
  updateAutomationStatus,
} from './automation-store.ts'
import {
  createAutomationEnrichmentPrompt,
  createAutomationExecutionPrompt,
  createAutomationHeartbeatPrompt,
  extractBriefFromAssistantText,
  extractHeartbeatDecisionFromAssistantText,
} from './automation-prompts.ts'
import { deliverAutomationDesktopUpdate, deliverAutomationRunResult } from './automation-delivery.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { getEffectiveSettings, loadSettings } from './settings.ts'
import { normalizeSessionInfo, normalizeSessionMessages } from './opencode-adapter.ts'
import { toIsoTimestamp } from './task-run-utils.ts'
import { toSessionRecord, upsertSessionRecord, getSessionRecord } from './session-registry.ts'
import { trackParentSession } from './event-task-state.ts'
import { log } from './logger.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null
let schedulerTimer: NodeJS.Timeout | null = null
let schedulerInFlight = false
let heartbeatInFlight = false

function publishAutomationUpdated() {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send('automation:updated')
}

function summarizeMessages(sessionId: string, messages: ReturnType<typeof normalizeSessionMessages>) {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!assistant) return `Automation session ${sessionId} completed.`
  const text = assistant.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n\n')
  return text || `Automation session ${sessionId} completed.`
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

async function createAutomationSession(options: {
  automationId: string
  runId: string
  title: string
  directory: string | null
  agent: 'plan' | 'build' | 'cowork-exec'
  prompt: string
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
  }, { throwOnError: true })
  return session.id
}

async function startRun(automationId: string, kind: AutomationRunKind) {
  const automation = getAutomationDetail(automationId)
  if (!automation) throw new Error('Automation not found')
  if (automation.status === 'archived') {
    throw new Error('Archived automations cannot be started.')
  }
  const activeRun = getActiveRunForAutomation(automationId)
  if (activeRun) {
    throw new Error(`Automation already has an active ${activeRun.kind} run.`)
  }
  const run = createAutomationRun(
    automationId,
    kind,
    kind === 'enrichment'
      ? `Enrich ${automation.title}`
      : kind === 'execution'
        ? `Execute ${automation.title}`
        : `Heartbeat ${automation.title}`,
  )
  if (!run) throw new Error('Failed to create automation run')
  const prompt = kind === 'enrichment'
    ? createAutomationEnrichmentPrompt(automation)
    : kind === 'execution'
      ? createAutomationExecutionPrompt(automation, automation.brief as ExecutionBrief)
      : createAutomationHeartbeatPrompt({
        automation,
        openInbox: listOpenInboxForAutomation(automationId),
        recentRuns: listAutomationState().runs.filter((entry) => entry.automationId === automationId).slice(0, 5),
      })
  try {
    await createAutomationSession({
      automationId,
      runId: run.id,
      title: run.title,
      directory: automation.projectDirectory,
      agent: kind === 'enrichment' ? 'plan' : kind === 'execution' ? 'build' : 'cowork-exec',
      prompt,
    })
  } catch (error) {
    markRunFailed(run.id, error instanceof Error ? error.message : String(error))
    throw error
  }
  return getRun(run.id)
}

async function maybeRunDueAutomations() {
  if (schedulerInFlight) return
  schedulerInFlight = true
  try {
    const due = listDueAutomations()
    for (const automation of due) {
      if (automation.status === 'paused' || automation.status === 'archived' || automation.status === 'needs_user' || automation.status === 'running') continue
      const detail = getAutomationDetail(automation.id)
      if (!detail) continue
      const shouldEnrich = !detail.brief || !detail.brief.approvedAt || detail.status === 'draft'
      try {
        await startRun(automation.id, shouldEnrich ? 'enrichment' : 'execution')
      } catch (error) {
        log('error', `Failed to start automation ${automation.id}: ${error instanceof Error ? error.message : String(error)}`)
        reportAutomationFailure(automation.id, 'Automation could not start', error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    schedulerInFlight = false
    publishAutomationUpdated()
  }
}

async function maybeRunHeartbeatReviews() {
  if (heartbeatInFlight) return
  heartbeatInFlight = true
  const due = listDueHeartbeats()
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
        log('error', `Failed to start automation heartbeat ${automation.id}: ${error instanceof Error ? error.message : String(error)}`)
        reportAutomationFailure(
          automation.id,
          'Automation heartbeat failed to start',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  } finally {
    heartbeatInFlight = false
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
  void maybeRunDueAutomations().then(() => maybeRunHeartbeatReviews())
  schedulerTimer = setInterval(() => {
    void maybeRunDueAutomations().then(() => maybeRunHeartbeatReviews())
  }, 60_000)
}

export function stopAutomationService() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
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
    resolveInboxItem(item.id, 'resolved')
  }
  publishAutomationUpdated()
  return updated
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
  return startRun(run.automationId, run.kind)
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
  if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
  const messages = await getSessionMessages(sessionId)
  const summary = summarizeMessages(sessionId, messages)
  if (run.kind === 'heartbeat') {
    const automation = getAutomationDetail(record.automationId)
    const decision = extractHeartbeatDecisionFromAssistantText(summary)
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
          reportAutomationFailure(
            record.automationId,
            'Automation brief refresh could not start',
            error instanceof Error ? error.message : String(error),
            run.id,
            sessionId,
          )
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
          reportAutomationFailure(
            record.automationId,
            'Automation execution could not start',
            error instanceof Error ? error.message : String(error),
            run.id,
            sessionId,
          )
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
    const brief = extractBriefFromAssistantText(summary)
    if (!brief) {
      markRunFailed(run.id, 'Automation enrichment did not return a parseable execution brief.', sessionId)
      createInboxItem({
        automationId: record.automationId,
        runId: run.id,
        sessionId,
        type: 'failure',
        title: 'Enrichment needs attention',
        body: 'The automation planner did not return a parseable execution brief. Open the linked run thread to inspect the output.',
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
          reportAutomationFailure(
            record.automationId,
            'Automation execution could not start',
            error instanceof Error ? error.message : String(error),
            run.id,
            sessionId,
          )
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
  if (!run || run.status === 'cancelled') return
  markRunFailed(record.runId, message, sessionId)
  createInboxItem({
    automationId: record.automationId,
    runId: record.runId,
    sessionId,
    type: 'failure',
    title: 'Automation run failed',
    body: message,
  })
  const automation = getAutomationDetail(record.automationId)
  if (automation) {
    deliverAutomationDesktopUpdate({
      automation,
      runId: record.runId,
      settings: loadSettings(),
      title: 'Automation run failed',
      body: message,
    })
  }
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

export function handleAutomationQuestionResolved(questionId: string) {
  for (const item of openInboxItemsForQuestion(questionId)) {
    resolveInboxItem(item.id, 'resolved')
  }
  publishAutomationUpdated()
}

export function getAutomationSessionInbox(sessionId: string) {
  return listInboxForSession(sessionId)
}
