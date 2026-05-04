import type { IpcHandlerContext } from './context.ts'
import { getEffectiveSettings, getProviderCredentialValue } from '../settings.ts'
import { getBrandName, getProviderDescriptor } from '../config-loader.ts'
import { getClient, getClientForDirectory, getRuntimeHomeDir } from '../runtime.ts'
import { normalizeProviderListResponse, type ProviderLike } from '../provider-utils.ts'
import { isSandboxWorkspaceDir } from '../runtime-paths.ts'
import { removeParentSession } from '../events.ts'
import { forgetSubmittedPrompt, rememberSubmittedPrompt, trackParentSession } from '../event-task-state.ts'
import type { QuestionAnswer } from '@opencode-ai/sdk/v2'
import { dispatchRuntimeSessionEvent, publishSessionView } from '../session-event-dispatcher.ts'
import { sessionEngine } from '../session-engine.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from '../session-status-reconciler.ts'
import {
  getSessionRecord,
  listSessionRecords,
  removeSessionRecord,
  toRendererSession,
  toSessionRecord,
  touchSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from '../session-registry.ts'
import { toIsoTimestamp } from '../task-run-utils.ts'
import {
  clearPermission,
  clearPermissionsForSession,
  getPermissionSession,
} from '../permission-tracker.ts'
import { syncSessionView } from '../session-history-loader.ts'
import { normalizeRuntimeCommands, normalizeSessionInfo, normalizeSessionMessages, normalizeShareUrl } from '../opencode-adapter.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { isInternalCoworkMessage } from '../internal-message-utils.ts'
import { cleanupSandboxWorkspaceForSession } from '../sandbox-storage.ts'
import { log } from '../logger.ts'
import { ensureRuntimeContextDirectory } from '../runtime-context.ts'
import { mergeSessionDiffsWithSynthetic } from '../session-diff-fallback.ts'
import { readFileCheckedSync } from '../fs-read.ts'

type PromptAttachmentInput = {
  mime: string
  url: string
  filename?: string
}

const MAX_PROMPT_TEXT_BYTES = 1_000_000
const MAX_PROMPT_ATTACHMENTS = 10
const MAX_PROMPT_ATTACHMENT_URL_BYTES = 30 * 1024 * 1024
const MAX_PROMPT_ATTACHMENTS_TOTAL_BYTES = 60 * 1024 * 1024
const MAX_PROMPT_ATTACHMENT_MIME_BYTES = 256
const MAX_PROMPT_ATTACHMENT_FILENAME_BYTES = 512
const MAX_PROMPT_AGENT_BYTES = 128
const MAX_SESSION_ID_BYTES = 256
const MAX_COMMAND_NAME_BYTES = 256
const MAX_SESSION_TITLE_BYTES = 512
const MAX_QUESTION_REQUEST_ID_BYTES = 256
const MAX_QUESTION_ANSWERS = 32
const MAX_QUESTION_ANSWER_CHOICES = 16
const MAX_QUESTION_ANSWER_BYTES = 4 * 1024
const MAX_FILE_SNIPPET_BYTES = 5 * 1024 * 1024
const DATA_URL_PREFIX = 'data:'
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9_.+-]+=[a-z0-9_.+-]+)*$/i
const DATA_URL_RE = /^data:([^,;]+(?:;[^,;=]+=[^,;]+)*);base64,[A-Za-z0-9+/]*={0,2}$/i

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function resolveQuestionLocally(context: IpcHandlerContext, sessionId: string, requestId: string) {
  const win = context.getMainWindow()
  dispatchRuntimeSessionEvent(win, {
    type: 'question_resolved',
    sessionId,
    data: {
      type: 'question_resolved',
      id: requestId,
    },
  })
}

function requireBoundedString(value: unknown, fieldName: string, maxBytes: number) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`)
  }
  if (byteLength(value) > maxBytes) {
    throw new Error(`${fieldName} exceeds ${maxBytes} bytes`)
  }
  return value
}

function normalizePromptText(text: unknown) {
  return requireBoundedString(text, 'Prompt text', MAX_PROMPT_TEXT_BYTES)
}

function normalizePromptAgent(agent: unknown) {
  if (agent == null || agent === '') return 'build'
  return requireBoundedString(agent, 'Prompt agent', MAX_PROMPT_AGENT_BYTES)
}

function assertPromptAttachmentDataUrl(url: string, mime: string, index: number) {
  if (!MIME_TYPE_RE.test(mime)) {
    throw new Error(`Prompt attachment ${index + 1} MIME type is invalid`)
  }
  if (!url.startsWith(DATA_URL_PREFIX)) {
    throw new Error(`Prompt attachment ${index + 1} URL must be a base64 data URL`)
  }
  const match = DATA_URL_RE.exec(url)
  if (!match) {
    throw new Error(`Prompt attachment ${index + 1} URL must be a base64 data URL`)
  }
  if (match[1]?.toLowerCase() !== mime.toLowerCase()) {
    throw new Error(`Prompt attachment ${index + 1} data URL MIME type must match its declared MIME type`)
  }
}

function normalizeSessionId(value: unknown) {
  const sessionId = requireBoundedString(value, 'Session id', MAX_SESSION_ID_BYTES).trim()
  if (!sessionId) throw new Error('Session id is required')
  return sessionId
}

function normalizeCommandName(value: unknown) {
  const commandName = requireBoundedString(value, 'Command name', MAX_COMMAND_NAME_BYTES).trim()
  if (!commandName) throw new Error('Command name is required')
  return commandName
}

function normalizeSessionTitle(value: unknown) {
  const title = requireBoundedString(value, 'Session title', MAX_SESSION_TITLE_BYTES).trim()
  if (!title) throw new Error('Session title is required')
  return title
}

function normalizeQuestionRequestId(value: unknown) {
  const requestId = requireBoundedString(value, 'Question request id', MAX_QUESTION_REQUEST_ID_BYTES).trim()
  if (!requestId) throw new Error('Question request id is required')
  return requestId
}

function normalizeQuestionAnswers(value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value)) throw new Error('Question answers must be an array')
  if (value.length > MAX_QUESTION_ANSWERS) throw new Error('Too many question answers')
  return value.map((answer) => {
    if (!Array.isArray(answer)) throw new Error('Question answer must be an array')
    if (answer.length > MAX_QUESTION_ANSWER_CHOICES) throw new Error('Too many question answer choices')
    return answer.map((choice) => {
      const normalized = requireBoundedString(choice, 'Question answer choice', MAX_QUESTION_ANSWER_BYTES).trim()
      if (!normalized) throw new Error('Question answer choice is required')
      return normalized
    })
  })
}

function resolvePromptModel(settings: ReturnType<typeof getEffectiveSettings>, runtimeProvider?: ProviderLike | null) {
  if (!settings.effectiveProviderId || !settings.effectiveModel) return null
  const prefix = `${settings.effectiveProviderId}/`
  const stripProviderPrefix = (modelId: string) => modelId.startsWith(prefix)
    ? modelId.slice(prefix.length)
    : modelId
  const configuredModel = stripProviderPrefix(settings.effectiveModel)
  const runtimeModels = runtimeProvider?.models || null
  const runtimeDefault = runtimeProvider?.defaultModel ? stripProviderPrefix(runtimeProvider.defaultModel) : undefined
  const modelID = runtimeModels
    && !Object.prototype.hasOwnProperty.call(runtimeModels, configuredModel)
    && runtimeDefault
    ? runtimeDefault
    : configuredModel
  if (modelID !== configuredModel) {
    log('provider', `Selected model ${settings.effectiveProviderId}/${configuredModel} is not in the live OpenCode catalog; using default ${settings.effectiveProviderId}/${modelID}`)
  }
  return {
    providerID: settings.effectiveProviderId,
    modelID,
  }
}

type ProviderAuthMethodLike = {
  type?: unknown
}

async function getSelectedRuntimeProvider(client: NonNullable<ReturnType<typeof getClient>>, providerId?: string | null) {
  if (!providerId) return null
  try {
    const providerList = await client.provider.list()
    return normalizeProviderListResponse(providerList.data).find((provider) => (
      provider.id === providerId || provider.name === providerId
    )) || null
  } catch (err) {
    log('provider', `Could not resolve live provider metadata for ${providerId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function hasSavedApiCredential(settings: ReturnType<typeof getEffectiveSettings>, providerId: string) {
  const descriptor = getProviderDescriptor(providerId)
  if (!descriptor) return false
  return descriptor.credentials.some((credential) => {
    const runtimeKey = credential.runtimeKey || credential.key
    const looksLikeApiKey = runtimeKey === 'apiKey' || /api.*key/i.test(`${credential.key} ${credential.label}`)
    return looksLikeApiKey && Boolean(getProviderCredentialValue(settings, providerId, credential.key))
  })
}

async function getRuntimeProviderAuthMethods(
  client: NonNullable<ReturnType<typeof getClient>>,
  providerId: string,
): Promise<ProviderAuthMethodLike[]> {
  try {
    const result = await client.provider.auth()
    const methods = result.data?.[providerId]
    return Array.isArray(methods) ? methods : []
  } catch (err) {
    log('provider', `Could not resolve auth methods for ${providerId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function assertSelectedProviderReadyForPrompt(
  client: NonNullable<ReturnType<typeof getClient>>,
  settings: ReturnType<typeof getEffectiveSettings>,
  runtimeProvider: ProviderLike | null,
) {
  const providerId = settings.effectiveProviderId
  if (!providerId || !runtimeProvider || runtimeProvider.connected !== false) return
  if (hasSavedApiCredential(settings, providerId)) return

  const methods = await getRuntimeProviderAuthMethods(client, providerId)
  const hasOauthMethod = methods.some((method) => method.type === 'oauth')
  const hasApiMethod = methods.some((method) => method.type === 'api')
  const providerName = runtimeProvider.name || getProviderDescriptor(providerId)?.name || providerId

  if (hasOauthMethod) {
    throw new Error(`${providerName} is not signed in. Use the OpenCode login button in Settings, or enter an API key and save before chatting.`)
  }

  if (hasApiMethod) {
    throw new Error(`${providerName} is not connected. Enter the provider credentials in Settings and save before chatting.`)
  }

  throw new Error(`${providerName} is not connected. This bundled OpenCode runtime does not expose a browser login method for ${providerName}; enter an API key in Settings and save before chatting.`)
}

function normalizePromptAttachments(attachments: unknown): PromptAttachmentInput[] {
  if (attachments == null) return []
  if (!Array.isArray(attachments)) {
    throw new Error('Prompt attachments must be an array')
  }
  if (attachments.length > MAX_PROMPT_ATTACHMENTS) {
    throw new Error(`Prompt attachments exceed ${MAX_PROMPT_ATTACHMENTS} files`)
  }

  let totalBytes = 0
  return attachments.map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      throw new Error(`Prompt attachment ${index + 1} must be an object`)
    }
    const record = attachment as Record<string, unknown>
    const mime = requireBoundedString(record.mime, `Prompt attachment ${index + 1} MIME type`, MAX_PROMPT_ATTACHMENT_MIME_BYTES)
    const url = requireBoundedString(record.url, `Prompt attachment ${index + 1} URL`, MAX_PROMPT_ATTACHMENT_URL_BYTES)
    const filename = record.filename == null
      ? undefined
      : requireBoundedString(record.filename, `Prompt attachment ${index + 1} filename`, MAX_PROMPT_ATTACHMENT_FILENAME_BYTES)
    assertPromptAttachmentDataUrl(url, mime, index)

    totalBytes += byteLength(mime) + byteLength(url) + (filename ? byteLength(filename) : 0)
    if (totalBytes > MAX_PROMPT_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(`Prompt attachments exceed ${MAX_PROMPT_ATTACHMENTS_TOTAL_BYTES} total bytes`)
    }

    return filename === undefined
      ? { mime, url }
      : { mime, url, filename }
  })
}

export function registerSessionHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('session:create', async (_event, directory?: string) => {
    const opencodeDirectory = context.normalizeDirectory(directory)
    await ensureRuntimeContextDirectory(opencodeDirectory)
    const client = getClientForDirectory(opencodeDirectory)
    if (!client) throw new Error('Runtime not started')
    const settings = getEffectiveSettings()

    log('session', 'Creating new session')
    const result = await client.session.create({}, { throwOnError: true })
    const session = normalizeSessionInfo(result.data)
    if (!session) {
      throw new Error('Runtime returned an invalid session payload')
    }
    log('session', `Created session ${shortSessionId(session.id)}`)
    trackParentSession(session.id)
    const record = upsertSessionRecord(
      toSessionRecord({
        id: session.id,
        title: session.title || 'New session',
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        opencodeDirectory,
        providerId: settings.effectiveProviderId || null,
        modelId: settings.effectiveModel || null,
      }),
    )
    return record
      ? toRendererSession(record)
      : {
          id: session.id,
          title: session.title || 'New session',
          directory: opencodeDirectory === getRuntimeHomeDir() || isSandboxWorkspaceDir(opencodeDirectory) ? null : opencodeDirectory,
          createdAt: toIsoTimestamp(session.time.created),
          updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        }
  })

  context.ipcMain.handle('session:prompt', async (_event, sessionId: string, text: unknown, attachments?: unknown, agent?: unknown) => {
    const promptText = normalizePromptText(text)
    const promptAttachments = normalizePromptAttachments(attachments)
    const requestedAgent = normalizePromptAgent(agent)
    const { client } = await context.getSessionClient(sessionId)
    const settings = getEffectiveSettings()
    const parts: Array<
      | { type: 'file'; mime: string; url: string; filename?: string }
      | { type: 'text'; text: string }
    > = []
    for (const attachment of promptAttachments) {
      parts.push({ type: 'file', mime: attachment.mime, url: attachment.url, filename: attachment.filename })
    }
    parts.push({ type: 'text', text: promptText })

    trackParentSession(sessionId)
    touchSessionRecord(sessionId)
    updateSessionRecord(sessionId, {
      providerId: settings.effectiveProviderId || null,
      modelId: settings.effectiveModel || null,
      updatedAt: new Date().toISOString(),
    })
    log('prompt', `Sending prompt to ${shortSessionId(sessionId)} attachments=${promptAttachments.length} agent=${requestedAgent}`)
    try {
      const win = context.getMainWindow()
      // Use a known live-placeholder suffix so the real user message from
      // OpenCode absorbs this optimistic insert via
      // moveLivePlaceholderStateToMessage — otherwise the UI renders two
      // bubbles (the optimistic one and the server-confirmed one).
      const optimisticMessageId = `${sessionId}:user:live`
      const optimisticSegmentId = `${sessionId}:user:segment:live`
      rememberSubmittedPrompt(sessionId, promptText)
      dispatchRuntimeSessionEvent(win, {
        type: 'text',
        sessionId,
        data: {
          type: 'text',
          role: 'user',
          content: promptText,
          attachments: promptAttachments,
          mode: 'replace',
          messageId: optimisticMessageId,
          partId: optimisticSegmentId,
        },
      })
      dispatchRuntimeSessionEvent(win, {
        type: 'busy',
        sessionId,
        data: { type: 'busy' },
      })
      const runtimeProvider = await getSelectedRuntimeProvider(client, settings.effectiveProviderId)
      await assertSelectedProviderReadyForPrompt(client, settings, runtimeProvider)
      const promptModel = resolvePromptModel(settings, runtimeProvider)

      await client.session.promptAsync({
        sessionID: sessionId,
        parts,
        ...(promptModel ? { model: promptModel } : {}),
        agent: requestedAgent,
      }, {
        throwOnError: true,
      })

      startSessionStatusReconciliation(sessionId, {
        getMainWindow: context.getMainWindow,
        onIdle: (_win, reconciledSessionId) => {
          context.reconcileIdleSession(reconciledSessionId)
        },
      })
    } catch (err) {
      forgetSubmittedPrompt(sessionId)
      const win = context.getMainWindow()
      const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Prompt failed'
      dispatchRuntimeSessionEvent(win, {
        type: 'error',
        sessionId,
        data: {
          type: 'error',
          message,
        },
      })
      dispatchRuntimeSessionEvent(win, {
        type: 'done',
        sessionId,
        data: {
          type: 'done',
          synthetic: true,
        },
      })
      context.logHandlerError(`session:prompt ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  context.ipcMain.handle('session:activate', async (_event, sessionId: string, options?: { force?: boolean }) => {
    try {
      const view = await syncSessionView(sessionId, {
        force: options?.force,
        activate: true,
      })
      if (view.isGenerating) {
        startSessionStatusReconciliation(sessionId, {
          getMainWindow: context.getMainWindow,
          onIdle: (_win, reconciledSessionId) => {
            context.reconcileIdleSession(reconciledSessionId)
          },
        })
      }
      const win = context.getMainWindow()
      if (win && !win.isDestroyed()) {
        publishSessionView(win, sessionId)
        // Broadcast SDK-owned fields that syncSessionView refreshed (parent,
        // summary, revertedMessageId) so the sidebar/header chips update
        // without waiting for a session.updated SSE event.
        const record = getSessionRecord(sessionId)
        if (record) {
          win.webContents.send('session:updated', {
            id: record.id,
            title: record.title || null,
            parentSessionId: record.parentSessionId,
            changeSummary: record.changeSummary,
            revertedMessageId: record.revertedMessageId,
          })
        }
      }
      return view
    } catch (err) {
      context.logHandlerError(`session:activate ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  context.ipcMain.handle('session:list', async () => {
    return listSessionRecords().map(toRendererSession)
  })

  context.ipcMain.handle('session:get', async (_event, id: string) => {
    const record = context.ensureSessionRecord(id)
    if (!record) return null
    try {
      const client = getClientForDirectory(record.opencodeDirectory)
      if (!client) return toRendererSession(record)
      const result = await client.session.get({ sessionID: id })
      const session = normalizeSessionInfo(result.data)
      if (!session) return null
      const updated = updateSessionRecord(id, {
        title: session.title || undefined,
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        parentSessionId: session.parentID || record.parentSessionId || null,
        changeSummary: session.summary,
        revertedMessageId: session.revertedMessageId,
      })
      return updated ? toRendererSession(updated) : toRendererSession(record)
    } catch (err) {
      context.logHandlerError(`session:get ${shortSessionId(id)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    log('session', `Aborting ${shortSessionId(sessionId)}`)
    stopSessionStatusReconciliation(sessionId)
    const win = context.getMainWindow()
    if (win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'done',
        sessionId,
        data: {
          type: 'done',
          synthetic: true,
        },
      })
    }
    try {
      await client.session.abort({ sessionID: sessionId })
    } catch (err) {
      context.logHandlerError(`session:abort ${shortSessionId(sessionId)}`, err)
    }
  })

  // Abort just one sub-agent's child session while leaving its siblings
  // (and the primary orchestrator) running. Child sessions aren't in the
  // local registry, so we can't go through `getSessionClient(childId)` —
  // instead we resolve the directory via the parent/root session record
  // and reuse its client to issue the abort against the child id.
  context.ipcMain.handle('session:abort-task', async (
    _event,
    rootSessionId: string,
    childSessionId: string,
  ) => {
    const { client } = await context.getSessionClient(rootSessionId)
    log('session', `Aborting task ${shortSessionId(childSessionId)} under ${shortSessionId(rootSessionId)}`)
    try {
      await client.session.abort({ sessionID: childSessionId })
    } catch (err) {
      context.logHandlerError(
        `session:abort-task ${shortSessionId(childSessionId)} (root ${shortSessionId(rootSessionId)})`,
        err,
      )
    }
  })

  context.ipcMain.handle('session:fork', async (_event, sessionId: string, messageId?: string) => {
    const { client, record } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.fork({
        sessionID: sessionId,
        ...(messageId ? { messageID: messageId } : {}),
      })
      const session = normalizeSessionInfo(result.data)
      if (!session) return null
      log('session', `Forked ${shortSessionId(sessionId)} -> ${shortSessionId(session.id)}${messageId ? ' at message' : ''}`)
      trackParentSession(session.id)
      const settings = getEffectiveSettings()
      const forked = upsertSessionRecord(
        toSessionRecord({
          id: session.id,
          title: session.title || 'Forked thread',
          createdAt: toIsoTimestamp(session.time.created),
          updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
          opencodeDirectory: record?.opencodeDirectory || getRuntimeHomeDir(),
          providerId: record?.providerId || settings.effectiveProviderId || null,
          modelId: record?.modelId || settings.effectiveModel || null,
          parentSessionId: session.parentID || sessionId,
          changeSummary: session.summary,
          revertedMessageId: session.revertedMessageId,
        }),
      )
      return forked
        ? toRendererSession(forked)
        : {
            id: session.id,
            title: session.title || 'Forked thread',
            directory: record?.directory || null,
            createdAt: toIsoTimestamp(session.time.created),
            updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
            parentSessionId: session.parentID || sessionId,
            changeSummary: session.summary,
            revertedMessageId: session.revertedMessageId,
          }
    } catch (err) {
      context.logHandlerError(`session:fork ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:export', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const session = await client.session.get({ sessionID: sessionId })
      const normalizedSession = normalizeSessionInfo(session.data)
      const messagesResult = await client.session.messages({ sessionID: sessionId }, { throwOnError: true })
      const messages = normalizeSessionMessages(messagesResult.data)
      if (!messages) return null

      let markdown = `# ${normalizedSession?.title || 'Thread'}\n\n`
      markdown += `_Exported from ${getBrandName()}_\n\n---\n\n`
      for (const message of messages) {
        let text = ''
        for (const part of message.parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text || isInternalCoworkMessage(text)) continue
        markdown += message.role === 'user'
          ? `## User\n\n${text}\n\n`
          : `## Assistant\n\n${text}\n\n`
      }
      return markdown
    } catch (err) {
      context.logHandlerError(`session:export ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:share', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.share({ sessionID: sessionId })
      const url = normalizeShareUrl(result.data)
      log('session', `Shared ${shortSessionId(sessionId)} hasUrl=${!!url}`)
      return url
    } catch (err) {
      context.logHandlerError(`session:share ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:unshare', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.unshare({ sessionID: sessionId })
      log('session', `Unshared ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:unshare ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  // Manually trigger OpenCode's session summarizer. Used by the "Summarize
  // now" action in the context panel so a user can pre-empt an imminent
  // auto-compaction (or just trim history proactively). The runtime then
  // emits session.compacted + a CompactionPart which our event handlers
  // render as a CompactionNoticeCard in the timeline.
  context.ipcMain.handle('session:summarize', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    log('session', `Summarizing ${shortSessionId(sessionId)}`)
    try {
      await client.session.summarize({ sessionID: sessionId }, { throwOnError: true })
      startSessionStatusReconciliation(sessionId, {
        getMainWindow: context.getMainWindow,
        onIdle: (_win, reconciledSessionId) => {
          context.reconcileIdleSession(reconciledSessionId)
        },
      })
      return { ok: true as const }
    } catch (err) {
      context.logHandlerError(`session:summarize ${shortSessionId(sessionId)}`, err)
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, message }
    }
  })

  context.ipcMain.handle('session:revert', async (_event, sessionId: string, messageId?: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.revert({
        sessionID: sessionId,
        ...(messageId ? { messageID: messageId } : {}),
      })
      log('session', `Reverted ${shortSessionId(sessionId)}${messageId ? ' to message' : ''}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:revert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:unrevert', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.unrevert({ sessionID: sessionId })
      log('session', `Unreverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:unrevert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:children', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.children({ sessionID: sessionId })
      return result.data || []
    } catch (err) {
      context.logHandlerError(`session:children ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  context.ipcMain.handle('session:diff', async (_event, sessionId: string, messageId?: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.diff({
        sessionID: sessionId,
        ...(messageId ? { messageID: messageId } : {}),
      })
      const diffs = result.data || []
      if (messageId) return diffs

      const record = getSessionRecord(sessionId)
      const view = sessionEngine.getSessionView(sessionId)
      const rootDir = record?.opencodeDirectory || getRuntimeHomeDir()
      return mergeSessionDiffsWithSynthetic(diffs, view, rootDir)
    } catch (err) {
      context.logHandlerError(`session:diff ${shortSessionId(sessionId)}${messageId ? ' message' : ''}`, err)
      return []
    }
  })

  // File-snippet reader used by the diff viewer's "Show N unchanged
  // lines" affordance. Reads a byte range from a file that must live
  // under the session's working directory — rejects any path that
  // tries to escape via `..`, absolute prefixes, or pointing outside
  // the session directory. Returns a string[] keyed by 1-based line
  // numbers so the caller can render the unchanged context inline.
  context.ipcMain.handle('session:file-snippet', async (
    _event,
    request: { sessionId: string; filePath: string; startLine: number; endLine: number },
  ) => {
    const { sessionId, filePath, startLine, endLine } = request
    const record = getSessionRecord(sessionId)
    if (!record) throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)

    const root = record.opencodeDirectory || getRuntimeHomeDir()
    const { resolve } = await import('path')
    const { realpathSync } = await import('fs')

    const absoluteRoot = resolve(root)
    const absolutePath = resolve(absoluteRoot, filePath)
    // Dereference symlinks on BOTH sides. Prefix-matching the
    // un-resolved path lets a symlink inside the project dir (e.g.
    // `link -> /etc/passwd`) bypass the containment check; realpath
    // collapses the symlink so the prefix check is semantically
    // meaningful.
    let realRoot: string
    let realPath: string
    try {
      realRoot = realpathSync.native(absoluteRoot)
      realPath = realpathSync.native(absolutePath)
    } catch (err) {
      throw new Error('File is not available for snippet read.', { cause: err })
    }
    if (!(realPath === realRoot || realPath.startsWith(`${realRoot}/`))) {
      throw new Error('File snippet path escapes the session directory.')
    }
    let bytes: Buffer
    try {
      ({ bytes } = readFileCheckedSync(realPath, { maxBytes: MAX_FILE_SNIPPET_BYTES }))
    } catch (err) {
      if (err instanceof Error && err.name === 'FileTooLargeError') {
        throw new Error('File is too large for snippet read.', { cause: err })
      }
      throw new Error('File is not available for snippet read.', { cause: err })
    }

    // Cap the range so a pathological request (huge file, wide gap)
    // doesn't paste thousands of lines into the viewer. 500 is plenty
    // of headroom for normal collapsed-context expansion.
    const MAX_LINES = 500
    const safeStart = Math.max(1, Math.floor(startLine))
    const safeEnd = Math.max(safeStart, Math.min(Math.floor(endLine), safeStart + MAX_LINES - 1))

    if (bytes.includes(0)) {
      throw new Error('Binary files are not available for snippet read.')
    }
    const contents = bytes.toString('utf-8')
    const lines = contents.split('\n')
    return lines.slice(safeStart - 1, safeEnd)
  })

  context.ipcMain.handle('command:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.command.list()
      return normalizeRuntimeCommands(result.data)
    } catch (err) {
      context.logHandlerError('command:list', err)
      return []
    }
  })

  context.ipcMain.handle('command:run', async (_event, sessionIdInput: unknown, commandNameInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const commandName = normalizeCommandName(commandNameInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      trackParentSession(sessionId)
      await client.session.command({ sessionID: sessionId, command: commandName })
      touchSessionRecord(sessionId)
      return true
    } catch (err) {
      context.logHandlerError(`command:run ${shortSessionId(sessionId)}:${commandName}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:rename', async (_event, sessionIdInput: unknown, titleInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const title = normalizeSessionTitle(titleInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.update({ sessionID: sessionId, title })
      log('session', `Renamed ${shortSessionId(sessionId)}`)
      updateSessionRecord(sessionId, { title, updatedAt: new Date().toISOString() })
      return true
    } catch (err) {
      context.logHandlerError(`session:rename ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:delete', async (_event, sessionId: string, confirmationToken?: string | null) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'session.delete', sessionId }, confirmationToken)) {
        throw new Error('Confirmation required before deleting a thread.')
      }
      const record = context.ensureSessionRecord(sessionId)
      await client.session.delete({ sessionID: sessionId })
      clearPermissionsForSession(sessionId)
      removeParentSession(sessionId)
      removeSessionRecord(sessionId)
      const removedWorkspace = cleanupSandboxWorkspaceForSession(record)
      sessionEngine.removeSession(sessionId)
      log('session', `Deleted ${shortSessionId(sessionId)}`)
      if (removedWorkspace) {
        log('artifact', `Removed sandbox workspace for ${shortSessionId(sessionId)}`)
      }
      log('audit', `session.delete completed session=${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:delete ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('permission:respond', async (
    _event,
    permissionId: string,
    allowed: boolean,
    explicitSessionId?: string | null,
  ) => {
    const sessionId = explicitSessionId || getPermissionSession(permissionId)
    if (!sessionId) throw new Error(`No session for permission ${permissionId}`)
    const { client } = await context.getSessionV2Client(sessionId)

    log('permission', `${allowed ? 'Approved' : 'Denied'} ${permissionId}`)
    await client.permission.reply({
      requestID: permissionId,
      reply: allowed ? 'once' : 'reject',
    }, {
      throwOnError: true,
    })
    clearPermission(permissionId)
    const resolvedSessionId = sessionEngine.resolveApproval(permissionId)
    const win = context.getMainWindow()
    if (resolvedSessionId && win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'approval_resolved',
        sessionId: resolvedSessionId,
        data: { type: 'approval_resolved', id: permissionId },
      })
    }
  })

  context.ipcMain.handle('question:reply', async (_event, sessionIdInput: unknown, requestIdInput: unknown, answersInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const requestId = normalizeQuestionRequestId(requestIdInput)
    const answers = normalizeQuestionAnswers(answersInput)
    const { client } = await context.getSessionV2Client(sessionId)
    await client.question.reply({
      requestID: requestId,
      answers,
    }, { throwOnError: true })
    resolveQuestionLocally(context, sessionId, requestId)
    startSessionStatusReconciliation(sessionId, {
      getMainWindow: context.getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        context.reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  context.ipcMain.handle('question:reject', async (_event, sessionIdInput: unknown, requestIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const requestId = normalizeQuestionRequestId(requestIdInput)
    const { client } = await context.getSessionV2Client(sessionId)
    await client.question.reject({
      requestID: requestId,
    }, { throwOnError: true })
    resolveQuestionLocally(context, sessionId, requestId)
    startSessionStatusReconciliation(sessionId, {
      getMainWindow: context.getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        context.reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  ipcCommandAndTodoHandlers(context)
}

function ipcCommandAndTodoHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('session:todo', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.todo({ sessionID: sessionId })
      return result.data || []
    } catch (err) {
      context.logHandlerError(`session:todo ${shortSessionId(sessionId)}`, err)
      return []
    }
  })
}
