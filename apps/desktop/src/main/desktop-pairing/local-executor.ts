import { normalizeSessionInfo } from '@open-cowork/runtime-host'
import { shortSessionId } from '@open-cowork/shared'
import { randomUUID } from 'node:crypto'
import type { SessionInfo } from '@open-cowork/shared'
import { getEffectiveSettings } from '../settings.ts'
import { getClientForDirectory } from '../runtime.ts'
import { ensureRuntimeContextDirectory } from '../runtime-context.ts'
import {
  getSessionRecord,
  listSessionRecords,
  toRendererSession,
  toSessionRecord,
  touchSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from '../session-registry.ts'
import { toIsoTimestamp } from '../task-run-utils.ts'
import { trackParentSession } from '../event-task-state.ts'
import { getThreadIndexService } from '../thread-index/thread-index-service.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { log } from '../logger.ts'
import type { IpcHandlerContext } from '../ipc/context.ts'
import type { DesktopPairingCommandExecutor } from './service.ts'
import {
  normalizePromptAgent,
  normalizePromptAttachments,
  normalizePromptOptions,
  normalizePromptText,
} from '../ipc/session-handler-validation.ts'

function promptParts(text: string, attachments: Array<{ mime: string; url: string; filename?: string }> = []) {
  return [
    ...attachments.map((attachment) => ({
      type: 'file' as const,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename,
    })),
    { type: 'text' as const, text },
  ]
}

function promptModel(settings: ReturnType<typeof getEffectiveSettings>, composerModelId?: string | null) {
  if (!settings.effectiveProviderId || !settings.effectiveModel) return null
  const prefix = `${settings.effectiveProviderId}/`
  const configured = composerModelId || settings.effectiveModel
  return {
    providerID: settings.effectiveProviderId,
    modelID: configured.startsWith(prefix) ? configured.slice(prefix.length) : configured,
  }
}

function storedModelId(model: ReturnType<typeof promptModel>, settings: ReturnType<typeof getEffectiveSettings>) {
  if (!model) return settings.effectiveModel || null
  return `${model.providerID}/${model.modelID}`
}

function rendererSessionFromSdk(input: {
  id: string
  title: string
  directory: string
  createdAt: string
  updatedAt: string
}): SessionInfo {
  return {
    id: input.id,
    title: input.title,
    directory: input.directory,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
}

export function createDesktopPairingLocalExecutor(context: IpcHandlerContext): DesktopPairingCommandExecutor {
  return {
    async createSession() {
      const opencodeDirectory = context.normalizeDirectory(null)
      await ensureRuntimeContextDirectory(opencodeDirectory)
      const client = getClientForDirectory(opencodeDirectory)
      if (!client) throw new Error('Runtime not started')
      const settings = getEffectiveSettings()
      const result = await client.session.create({}, { throwOnError: true })
      const session = normalizeSessionInfo(result.data)
      if (!session) throw new Error('Runtime returned an invalid session payload')
      trackParentSession(session.id)
      const record = upsertSessionRecord(
        toSessionRecord({
          id: session.id,
          title: session.title || 'Remote desktop thread',
          createdAt: toIsoTimestamp(session.time.created),
          updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
          opencodeDirectory,
          providerId: settings.effectiveProviderId || null,
          modelId: settings.effectiveModel || null,
        }),
      )
      if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)
      log('desktop-pairing', `Created paired desktop session ${shortSessionId(session.id)}`)
      return record
        ? toRendererSession(record)
        : rendererSessionFromSdk({
            id: session.id,
            title: session.title || 'Remote desktop thread',
            directory: opencodeDirectory,
            createdAt: toIsoTimestamp(session.time.created),
            updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
          })
    },

    async prompt(input) {
      const text = normalizePromptText(input.text)
      const attachments = normalizePromptAttachments(input.attachments)
      const agent = normalizePromptAgent(input.agent)
      const options = normalizePromptOptions({ variant: input.variant })
      const { client, record } = await context.getSessionClient(input.sessionId)
      const settings = getEffectiveSettings()
      const model = promptModel(settings, record?.composerModelId)
      const promptRecord = updateSessionRecord(input.sessionId, {
        providerId: settings.effectiveProviderId || null,
        modelId: storedModelId(model, settings),
        updatedAt: new Date().toISOString(),
      })
      if (promptRecord) getThreadIndexService().upsertThreadFromSessionRecord(promptRecord)
      trackParentSession(input.sessionId)
      touchSessionRecord(input.sessionId)
      await client.session.promptAsync({
        sessionID: input.sessionId,
        parts: promptParts(text, attachments),
        ...(model ? { model } : {}),
        ...(options.variant ? { variant: options.variant } : {}),
        agent,
      }, { throwOnError: true })
      startSessionStatusReconciliation(input.sessionId, {
        getMainWindow: context.getMainWindow,
        onIdle: (_win, sessionId) => context.reconcileIdleSession(sessionId),
      })
      log('desktop-pairing', `Prompted paired desktop session ${shortSessionId(input.sessionId)} remotePrompt=${randomUUID().slice(0, 8)}`)
      return getSessionRecord(input.sessionId)
        ? toRendererSession(getSessionRecord(input.sessionId)!)
        : null
    },

    async abort(sessionId) {
      const { client } = await context.getSessionClient(sessionId)
      stopSessionStatusReconciliation(sessionId)
      await client.session.abort({ sessionID: sessionId })
    },

    async respondPermission(input) {
      const { client } = await context.getSessionV2Client(input.sessionId)
      await client.permission.reply({
        requestID: input.permissionId,
        reply: input.allowed ? 'once' : 'reject',
      }, { throwOnError: true })
    },

    async replyQuestion(input) {
      const { client } = await context.getSessionV2Client(input.sessionId)
      await client.question.reply({
        requestID: input.requestId,
        answers: input.answers,
      }, { throwOnError: true })
    },

    async rejectQuestion(input) {
      const { client } = await context.getSessionV2Client(input.sessionId)
      await client.question.reject({
        requestID: input.requestId,
      }, { throwOnError: true })
    },

    async listSessions() {
      return listSessionRecords().map(toRendererSession)
    },
  }
}
