import { getThreadIndexService } from '@open-cowork/runtime-host/thread-index/thread-index-service'
import { toIsoTimestamp } from '@open-cowork/runtime-host/task-run-utils'
import { getEffectiveSettings } from '@open-cowork/runtime-host/settings'
import { getSessionRecord, listSessionRecords, toRendererSession, toSessionRecord, touchSessionRecord, updateSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { getClientForDirectory } from '@open-cowork/runtime-host/runtime'
import { ensureRuntimeContextDirectory } from '@open-cowork/runtime-host/runtime-context'
import {
  createNativeSession,
  findNativePermissionSession,
  findNativeQuestionSession,
  getNativeSession,
  interruptNativeSession,
  listNativePendingPermissions,
  listNativePendingQuestions,
  normalizeSessionInfo,
  promptNativeSession,
} from '@open-cowork/runtime-host'
import { shortSessionId } from '@open-cowork/shared'
import { randomUUID } from 'node:crypto'
import type { SessionInfo } from '@open-cowork/shared'
import { trackParentSession } from '../event-task-state.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { log } from '@open-cowork/shared/node'
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

const MAX_NATIVE_SESSION_ANCESTRY_DEPTH = 64
type NativeOpencodeClient = Parameters<typeof getNativeSession>[0]

async function nativeSessionBelongsToRoot(
  client: NativeOpencodeClient,
  rootSessionId: string,
  sourceSessionId: string,
) {
  if (sourceSessionId === rootSessionId) return true
  const seen = new Set<string>([sourceSessionId])
  let currentSessionId = sourceSessionId

  for (let depth = 0; depth < MAX_NATIVE_SESSION_ANCESTRY_DEPTH; depth += 1) {
    let session
    try {
      session = await getNativeSession(client, currentSessionId)
    } catch {
      return false
    }
    const parentSessionId = session.parentID
    if (!parentSessionId) return false
    if (parentSessionId === rootSessionId) return true
    if (seen.has(parentSessionId)) return false
    seen.add(parentSessionId)
    currentSessionId = parentSessionId
  }
  return false
}

async function resolveNativePermissionOwner(
  client: NativeOpencodeClient,
  rootSessionId: string,
  permissionId: string,
) {
  const sourceSessionId = findNativePermissionSession(
    await listNativePendingPermissions(client),
    permissionId,
  )
  if (
    !sourceSessionId
    || !await nativeSessionBelongsToRoot(client, rootSessionId, sourceSessionId)
  ) {
    throw new Error('Permission request is not pending for this paired session.')
  }
  return sourceSessionId
}

async function resolveNativeQuestionOwner(
  client: NativeOpencodeClient,
  rootSessionId: string,
  requestId: string,
) {
  const sourceSessionId = findNativeQuestionSession(
    await listNativePendingQuestions(client),
    requestId,
  )
  if (
    !sourceSessionId
    || !await nativeSessionBelongsToRoot(client, rootSessionId, sourceSessionId)
  ) {
    throw new Error('Question request is not pending for this paired session.')
  }
  return sourceSessionId
}

export function createDesktopPairingLocalExecutor(context: IpcHandlerContext): DesktopPairingCommandExecutor {
  return {
    async createSession() {
      const opencodeDirectory = context.normalizeDirectory(null)
      await ensureRuntimeContextDirectory(opencodeDirectory)
      const client = getClientForDirectory(opencodeDirectory)
      if (!client) throw new Error('Runtime not started')
      const settings = getEffectiveSettings()
      const session = normalizeSessionInfo(await createNativeSession(client, {
        location: { directory: opencodeDirectory },
      }))
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
      await promptNativeSession(client, {
        sessionID: input.sessionId,
        parts: promptParts(text, attachments),
        model: model ? { ...model, variant: options.variant || undefined } : null,
        agent,
      })
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
      await interruptNativeSession(client, sessionId)
    },

    async respondPermission(input) {
      const { client } = await context.getSessionV2Client(input.sessionId)
      const sourceSessionId = await resolveNativePermissionOwner(
        client,
        input.sessionId,
        input.permissionId,
      )
      await client.v2.session.permission.reply({
        sessionID: sourceSessionId,
        requestID: input.permissionId,
        reply: input.allowed ? 'once' : 'reject',
      }, { throwOnError: true })
    },

    async replyQuestion(input) {
      const { client } = await context.getSessionV2Client(input.sessionId)
      const sourceSessionId = await resolveNativeQuestionOwner(
        client,
        input.sessionId,
        input.requestId,
      )
      await client.v2.session.question.reply({
        sessionID: sourceSessionId,
        requestID: input.requestId,
        questionV2Reply: { answers: input.answers as string[][] },
      }, { throwOnError: true })
    },

    async rejectQuestion(input) {
      const { client } = await context.getSessionV2Client(input.sessionId)
      const sourceSessionId = await resolveNativeQuestionOwner(
        client,
        input.sessionId,
        input.requestId,
      )
      await client.v2.session.question.reject({
        sessionID: sourceSessionId,
        requestID: input.requestId,
      }, { throwOnError: true })
    },

    async listSessions() {
      return listSessionRecords().map(toRendererSession)
    },
  }
}
