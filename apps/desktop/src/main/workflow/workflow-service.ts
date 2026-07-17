import { configureWorkflowToolActions } from '@open-cowork/runtime-host/workflow/workflow-tool-actions'
import { attachWorkflowRunSession, claimDueWorkflowRun, createWorkflowRun, createWorkflowWebhookSecurityStore, getWorkflow, getWorkflowRun, listWorkflows as listWorkflowState, markWorkflowRunCompleted, markWorkflowRunFailed, regenerateWorkflowWebhookSecret, recoverInterruptedWorkflowRuns, updateWorkflowStatus } from '@open-cowork/runtime-host/workflow/workflow-store'
import { getThreadIndexService } from '@open-cowork/runtime-host/thread-index/thread-index-service'
import { toIsoTimestamp } from '@open-cowork/runtime-host/task-run-utils'
import { getEffectiveSettings } from '@open-cowork/runtime-host/settings'
import { getSessionRecord, toRendererSession, toSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { getClientForDirectory, getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { ensureRuntimeContextDirectory } from '@open-cowork/runtime-host/runtime-context'
import { isRuntimeReady } from '@open-cowork/runtime-host/runtime-status'
import {
  createNativeSession,
  listNativeSessionMessages,
  normalizeSessionInfo,
  normalizeSessionMessages,
  promptNativeSession,
  type NormalizedSessionMessage,
} from '@open-cowork/runtime-host'
import { configureWorkflowWebhookServer, ensureWorkflowWebhookServer, getWorkflowWebhookBaseUrl, stopWorkflowWebhookServer, claimWorkflowWebhookSignatureOnce, verifyWorkflowWebhookAuth, WebhookHttpError } from '@open-cowork/shared/node'
import type { BrowserWindow } from 'electron'
import type {
  SessionInfo,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import { getConfiguredAgentsFromConfig } from '@open-cowork/runtime-host/config'
import { trackParentSession } from '../event-task-state.ts'
import { markSessionPromptAdmitted } from '../durable-session-events.ts'
import { log } from '@open-cowork/shared/node'
import { createKeyedPromiseChain } from '../promise-chain.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null
let showDesktopNotification: ((notification: WorkflowDesktopNotification) => void) | null = null
let notificationNow = () => new Date()
let schedulerTimer: NodeJS.Timeout | null = null
let schedulerTickPromise: Promise<void> | null = null
const runWorkflowFinalizerForRun = createKeyedPromiseChain()
const WORKFLOW_DESIGNER_AGENT_NAME = 'workflow-designer'

export interface WorkflowDesktopNotification {
  title: string
  body: string
}

function minutesFromTime(value: string | null | undefined) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '')
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

export function isWorkflowNotificationQuietTime(
  start: string | null | undefined,
  end: string | null | undefined,
  now: Date,
) {
  const startMinutes = minutesFromTime(start)
  const endMinutes = minutesFromTime(end)
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return false
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  return startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes
}

function notifyWorkflowRun(runId: string, outcome: 'completed' | 'failed' | 'needs-attention') {
  try {
    if (!showDesktopNotification) return
    const settings = getEffectiveSettings()
    if (!settings.workflowDesktopNotifications) return
    if (isWorkflowNotificationQuietTime(
      settings.workflowQuietHoursStart,
      settings.workflowQuietHoursEnd,
      notificationNow(),
    )) return
    const run = getWorkflowRun(runId)
    if (!run || (run.triggerType !== 'schedule' && run.triggerType !== 'webhook')) return
    const workflow = getWorkflow(run.workflowId, workflowWebhookBaseUrl())
    const workflowTitle = workflow?.title || 'Playbook'
    const detail = outcome === 'completed'
      ? 'finished successfully.'
      : outcome === 'failed'
        ? 'failed. Open the app for details.'
        : 'needs your attention.'
    showDesktopNotification({
      title: workflowTitle,
      body: `${run.triggerType === 'schedule' ? 'Scheduled' : 'Webhook'} playbook ${detail}`,
    })
  } catch (error) {
    log('error', `Failed to show workflow notification: ${sdkErrorMessage(error)}`)
  }
}

function publishWorkflowUpdated() {
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send('workflow:updated')
}

function workflowWebhookBaseUrl() {
  return getWorkflowWebhookBaseUrl()
}

function workflowDraftPrompt(sessionId: string) {
  return [
    'Help the user create a simple repeatable Open Cowork workflow.',
    'Use the workflow-creator skill as the setup checklist.',
    '',
    'The user should be able to describe the work conversationally. Ask clarifying questions until you know:',
    '- a short workflow title',
    '- the repeatable task instructions',
    '- whether it runs on a schedule, a webhook, manually, or a combination',
    '- which agent should execute it',
    '- which skills/tools matter',
    '- whether a project directory is required',
    '- what output should be produced',
    '',
    'When the workflow is clear, call workflows_preview_workflow and show the proposal to the user.',
    `Set draftSessionId to "${sessionId}" on the preview draft so the saved workflow links back to this setup thread.`,
    'Only after the user explicitly confirms, call workflows_create_workflow with the previewToken returned by the preview tool.',
    'Do not reconstruct or change the draft in create_workflow.',
  ].join('\n')
}

function workflowRunPrompt(workflow: WorkflowDetail, run: WorkflowRun) {
  const payload = run.triggerPayload ? JSON.stringify(run.triggerPayload, null, 2) : '{}'
  return [
    `Execute saved Open Cowork workflow: ${workflow.title}`,
    '',
    'Saved instructions:',
    workflow.instructions,
    '',
    `Trigger: ${run.triggerType}`,
    `Trigger payload:\n${payload}`,
    '',
    workflow.skillNames.length ? `Relevant skills: ${workflow.skillNames.join(', ')}` : 'Relevant skills: use any relevant configured skills.',
    workflow.toolIds.length ? `Relevant tools: ${workflow.toolIds.join(', ')}` : 'Relevant tools: use the tools needed for the task.',
    '',
    'Use OpenCode tools, skills, and delegation normally. Return the final workflow output clearly for the user.',
  ].join('\n')
}

function messageText(message: NormalizedSessionMessage) {
  return message.parts
    .map((part) => part.text || part.raw || '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function summarizeWorkflowMessages(messages: NormalizedSessionMessage[]) {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant' && messageText(message))
  const text = assistant ? messageText(assistant) : ''
  return text.slice(0, 4000) || 'Workflow run completed.'
}

async function getWorkflowSessionMessages(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record) return []
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  if (!client) return []
  return normalizeSessionMessages(await listNativeSessionMessages(client, sessionId))
}

async function createWorkflowThread(input: {
  title: string
  directory: string | null
  kind: 'workflow_draft' | 'workflow_run'
  workflowId?: string | null
  runId?: string | null
  agent: string
  prompt: string | ((sessionId: string) => string)
  onSessionCreated?: (sessionId: string) => void
}): Promise<SessionInfo> {
  const opencodeDirectory = input.directory || getRuntimeHomeDir()
  await ensureRuntimeContextDirectory(opencodeDirectory)
  const client = getClientForDirectory(opencodeDirectory)
  if (!client) throw new Error('Runtime not started.')
  const session = normalizeSessionInfo(await createNativeSession(client, {
    location: { directory: opencodeDirectory },
  }))
  if (!session?.id) throw new Error('Runtime returned an invalid session payload.')
  const settings = getEffectiveSettings()
  const record = upsertSessionRecord(toSessionRecord({
    id: session.id,
    title: input.title,
    createdAt: toIsoTimestamp(session.time.created),
    updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
    opencodeDirectory,
    providerId: settings.effectiveProviderId || null,
    modelId: settings.effectiveModel || null,
    kind: input.kind,
    workflowId: input.workflowId || null,
    runId: input.runId || null,
  }))
  if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)
  trackParentSession(session.id)
  input.onSessionCreated?.(session.id)
  const prompt = typeof input.prompt === 'function' ? input.prompt(session.id) : input.prompt
  const admitted = await promptNativeSession(client, {
    sessionID: session.id,
    parts: [{ type: 'text', text: prompt }],
    agent: input.agent,
  })
  markSessionPromptAdmitted({
    directory: opencodeDirectory,
    sessionId: session.id,
    admittedSeq: admitted.admittedSeq,
    admissionId: admitted.id,
  })
  if (input.kind === 'workflow_run') {
    startSessionStatusReconciliation(session.id, {
      getMainWindow: () => getMainWindow?.() ?? null,
      onIdle: async (_win, reconciledSessionId) => {
        await handleWorkflowSessionIdle(reconciledSessionId)
      },
    })
  }
  return toRendererSession(record!)
}

export function configureWorkflowService(options: {
  getMainWindow: () => BrowserWindow | null
  showDesktopNotification?: (notification: WorkflowDesktopNotification) => void
  notificationNow?: () => Date
}) {
  getMainWindow = options.getMainWindow
  showDesktopNotification = options.showDesktopNotification || null
  notificationNow = options.notificationNow || (() => new Date())
  configureWorkflowToolActions({ publishWorkflowUpdated })
  configureWorkflowWebhookServer(async ({ workflowId, auth, payload }) => {
    const workflow = getWorkflow(workflowId, workflowWebhookBaseUrl())
    const webhook = workflow?.triggers.find((trigger) => (
      trigger.type === 'webhook'
      && trigger.enabled
      && typeof trigger.webhookSecret === 'string'
      && verifyWorkflowWebhookAuth(auth, trigger.webhookSecret)
    ))
    if (!workflow || !webhook) {
      throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    }
    const replayClaim = await claimWorkflowWebhookSignatureOnce(auth, workflowId)
    if (!replayClaim) throw new WebhookHttpError(401, 'Workflow webhook authorization failed.')
    try {
      await runWorkflow(workflowId, 'webhook', payload)
      await replayClaim.accept()
    } catch (error) {
      await replayClaim.release()
      throw error
    }
  }, { securityStore: createWorkflowWebhookSecurityStore() })
}

export function startWorkflowService() {
  if (schedulerTimer) return
  const recoveredRuns = recoverInterruptedWorkflowRuns()
  if (recoveredRuns.length > 0) {
    log('workflow', `Recovered ${recoveredRuns.length} interrupted workflow run${recoveredRuns.length === 1 ? '' : 's'}.`)
    publishWorkflowUpdated()
  }
  void ensureWorkflowWebhookServer().then(() => publishWorkflowUpdated()).catch((error) => {
    log('error', `Failed to start workflow webhook server: ${sdkErrorMessage(error)}`)
  })
  void runWorkflowSchedulerTick()
  schedulerTimer = setInterval(() => {
    void runWorkflowSchedulerTick()
  }, 60_000)
}

export function stopWorkflowService() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
  stopWorkflowWebhookServer()
}

export function listWorkflows(): WorkflowListPayload {
  return listWorkflowState(workflowWebhookBaseUrl())
}

export function getWorkflowDetail(workflowId: string): WorkflowDetail | null {
  return getWorkflow(workflowId, workflowWebhookBaseUrl())
}

export async function startWorkflowDraft(directory?: string | null) {
  const settings = getEffectiveSettings()
  if (settings.runtimeConfigSource === 'machine') {
    throw new Error('Workflow setup threads require the isolated in-app OpenCode config so the Workflow Designer agent and Workflows tool are available. Switch OpenCode config source to In app to add workflows.')
  }
  if (!getConfiguredAgentsFromConfig().some((agent) => agent.name === WORKFLOW_DESIGNER_AGENT_NAME)) {
    throw new Error(`Workflow setup threads require the configured ${WORKFLOW_DESIGNER_AGENT_NAME} agent. Restore that agent in open-cowork.config.json or update the workflow setup policy.`)
  }
  const session = await createWorkflowThread({
    title: 'New workflow draft',
    directory: directory || null,
    kind: 'workflow_draft',
    agent: WORKFLOW_DESIGNER_AGENT_NAME,
    prompt: workflowDraftPrompt,
  })
  return session
}

async function runWorkflow(workflowId: string, triggerType: WorkflowTriggerType, payload: Record<string, unknown> | null = null) {
  if (!isRuntimeReady()) throw new Error('OpenCode runtime is not ready for workflow execution.')
  const run = createWorkflowRun(workflowId, triggerType, payload)
  return startClaimedWorkflowRun(run)
}

async function startClaimedWorkflowRun(run: WorkflowRun | null) {
  if (!run) return null
  const workflow = getWorkflow(run.workflowId, workflowWebhookBaseUrl())
  if (!workflow) return null
  try {
    await createWorkflowThread({
      title: `Run ${workflow.title}`,
      directory: workflow.projectDirectory,
      kind: 'workflow_run',
      workflowId: workflow.id,
      runId: run.id,
      agent: workflow.agentName || 'build',
      prompt: workflowRunPrompt(workflow, run),
      onSessionCreated: (sessionId) => {
        attachWorkflowRunSession(workflow.id, run.id, sessionId)
      },
    })
    publishWorkflowUpdated()
    return getWorkflowRun(run.id)
  } catch (error) {
    const message = sdkErrorMessage(error, 'Workflow run failed to start.')
    markWorkflowRunFailed(run.id, message)
    notifyWorkflowRun(run.id, 'failed')
    publishWorkflowUpdated()
    throw error
  }
}

export async function runWorkflowNow(workflowId: string) {
  return runWorkflow(workflowId, 'manual', { source: 'run_now', requestedAt: new Date().toISOString() })
}

export function pauseWorkflow(workflowId: string) {
  const updated = updateWorkflowStatus(workflowId, 'paused', workflowWebhookBaseUrl())
  publishWorkflowUpdated()
  return updated
}

export function resumeWorkflow(workflowId: string) {
  const updated = updateWorkflowStatus(workflowId, 'active', workflowWebhookBaseUrl())
  publishWorkflowUpdated()
  return updated
}

export function archiveWorkflow(workflowId: string) {
  const updated = updateWorkflowStatus(workflowId, 'archived', workflowWebhookBaseUrl())
  publishWorkflowUpdated()
  return updated
}

export function regenerateWebhookSecret(workflowId: string) {
  const updated = regenerateWorkflowWebhookSecret(workflowId, workflowWebhookBaseUrl())
  publishWorkflowUpdated()
  return updated
}

async function runWorkflowSchedulerTickNow(now = new Date()) {
  if (!isRuntimeReady()) return
  while (true) {
    const run = claimDueWorkflowRun(now)
    if (!run) break
    try {
      await startClaimedWorkflowRun(run)
    } catch (error) {
      log('error', `Failed to start workflow ${run.workflowId}: ${sdkErrorMessage(error)}`)
    }
  }
}

export async function runWorkflowSchedulerTick(now = new Date()) {
  if (schedulerTickPromise) return schedulerTickPromise
  schedulerTickPromise = runWorkflowSchedulerTickNow(now).finally(() => {
    schedulerTickPromise = null
  })
  return schedulerTickPromise
}

export async function handleWorkflowSessionIdle(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record || record.kind !== 'workflow_run' || !record.runId) return
  const runId = record.runId
  await runWorkflowFinalizerForRun(runId, async () => {
    const run = getWorkflowRun(runId)
    if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
    const messages = await getWorkflowSessionMessages(sessionId)
    markWorkflowRunCompleted(runId, summarizeWorkflowMessages(messages))
    notifyWorkflowRun(runId, 'completed')
    publishWorkflowUpdated()
  })
}

export async function handleWorkflowSessionError(sessionId: string, message: string) {
  const record = getSessionRecord(sessionId)
  if (!record || record.kind !== 'workflow_run' || !record.runId) return
  const runId = record.runId
  await runWorkflowFinalizerForRun(runId, async () => {
    const run = getWorkflowRun(runId)
    if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return
    markWorkflowRunFailed(runId, message)
    notifyWorkflowRun(runId, 'failed')
    publishWorkflowUpdated()
  })
}

export function handleWorkflowSessionNeedsAttention(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record || record.kind !== 'workflow_run' || !record.runId) return
  notifyWorkflowRun(record.runId, 'needs-attention')
}
