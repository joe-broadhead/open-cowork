import type { AutomationRunKind } from '@open-cowork/shared'
import type { OutputFormat } from '@opencode-ai/sdk/v2'
import { attachRunSession, markRunStarted } from './automation-store.ts'
import { trackParentSession } from './event-task-state.ts'
import { normalizeSessionInfo, normalizeSessionMessages } from './opencode-adapter.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { getEffectiveSettings } from './settings.ts'
import { getSessionRecord, toSessionRecord, upsertSessionRecord } from './session-registry.ts'
import { toIsoTimestamp } from './task-run-utils.ts'

export async function createAutomationSession(options: {
  automationId: string
  runId: string
  title: string
  directory: string | null
  agent: 'plan' | 'build' | 'cowork-exec'
  prompt: string
  format?: OutputFormat
}, onUpdated?: () => void) {
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
  attachRunSession(options.runId, options.automationId, session.id)
  markRunStarted(options.runId, session.id)
  onUpdated?.()
  await client.session.promptAsync({
    sessionID: session.id,
    parts: [{ type: 'text', text: options.prompt }],
    agent: options.agent,
    ...(options.format ? { format: options.format } : {}),
  }, { throwOnError: true })
  return session.id
}

export async function getAutomationSessionMessages(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record) return []
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  if (!client) return []
  const result = await client.session.messages({ sessionID: sessionId }, { throwOnError: true })
  return normalizeSessionMessages(result.data)
}

export function agentForAutomationRun(kind: AutomationRunKind) {
  return kind === 'enrichment' ? 'plan' : kind === 'execution' ? 'build' : 'cowork-exec'
}
