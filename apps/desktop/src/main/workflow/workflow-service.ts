import { configureWorkflowWebhookServer, ensureWorkflowWebhookServer, getWorkflowWebhookBaseUrl, stopWorkflowWebhookServer, claimWorkflowWebhookSignatureOnce, verifyWorkflowWebhookAuth, WebhookHttpError } from '@open-cowork/shared/node'
import type { BrowserWindow } from 'electron'
import type {
  SessionInfo,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import {
  attachWorkflowRunSession,
  claimDueWorkflowRun,
  createWorkflowRun,
  getWorkflow,
  getWorkflowRun,
  listWorkflows as listWorkflowState,
  markWorkflowRunCompleted,
  markWorkflowRunFailed,
  regenerateWorkflowWebhookSecret,
  recoverInterruptedWorkflowRuns,
  updateWorkflowStatus,
} from './workflow-store.ts'
import { configureWorkflowToolActions } from './workflow-tool-actions.ts'
import { getClientForDirectory, getRuntimeHomeDir } from '../runtime.ts'
import { ensureRuntimeContextDirectory } from '../runtime-context.ts'
import { getConfiguredAgentsFromConfig } from '../config-loader.ts'
import { getEffectiveSettings } from '../settings.ts'
import { trackParentSession } from '../event-task-state.ts'
import { normalizeSessionInfo, normalizeSessionMessages, type NormalizedSessionMessage } from '../opencode-adapter.ts'
import { getSessionRecord, toRendererSession, toSessionRecord, upsertSessionRecord } from '../session-registry.ts'
import { getThreadIndexService } from '../thread-index/thread-index-service.ts'
import { toIsoTimestamp } from '../task-run-utils.ts'
import { log } from '../logger.ts'
import { createKeyedPromiseChain } from '../promise-chain.ts'
import { sdkErrorMessage } from '../sdk-error.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'

let getMainWindow: (() => BrowserWindow | null) | null = null
let schedulerTimer: NodeJS.Timeout | null = null
let schedulerTickPromise: Promise<void> | null = null
const runWorkflowFinalizerForRun = createKeyedPromiseChain()
const WORKFLOW_DESIGNER_AGENT_NAME = 'workflow-designer'

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
    'When the workflow is clear, call mcp__workflows__preview_workflow and show the proposal to the user.',
    `Set draftSessionId to "${sessionId}" on the preview draft so the saved workflow links back to this setup thread.`,
    'Only after the user explicitly confirms, call mcp__workflows__create_workflow with the previewToken returned by the preview tool.',
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
  const result = await client.session.messages({ sessionID: sessionId }, { throwOnError: true })
  return normalizeSessionMessages(result.data)
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
  const created = await client.session.create({}, { throwOnError: true })
  const session = normalizeSessionInfo(created.data)
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
  await client.session.promptAsync({
    sessionID: session.id,
    parts: [{ type: 'text', text: prompt }],
    agent: input.agent,
  }, { throwOnError: true })
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

export function configureWorkflowService(options: { getMainWindow: () => BrowserWindow | null }) {
  getMainWindow = options.getMainWindow
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
  })
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
    publishWorkflowUpdated()
  })
}
