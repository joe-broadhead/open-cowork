import type { IpcHandlerContext } from './context.ts'
import type { SessionChangeSummary } from '@open-cowork/shared'
import { randomUUID } from 'node:crypto'
import { getEffectiveSettings, getProviderCredentialValue } from '../settings.ts'
import { getProviderDescriptor } from '../config-loader.ts'
import { getClient, getClientForDirectory, getRuntimeHomeDir } from '../runtime.ts'
import { normalizeProviderListResponse, type ProviderLike } from '../provider-utils.ts'
import { forgetSubmittedPrompt, rememberSubmittedPrompt, trackParentSession } from '../event-task-state.ts'
import { dispatchRuntimeSessionEvent, publishSessionView } from '../session-event-dispatcher.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from '../session-status-reconciler.ts'
import {
  getSessionRecord,
  listSessionRecords,
  toDisplayDirectory,
  toRendererSession,
  toSessionRecord,
  touchSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from '../session-registry.ts'
import { toIsoTimestamp } from '../task-run-utils.ts'
import { syncSessionView } from '../session-history-loader.ts'
import { normalizeSessionInfo } from '../opencode-adapter.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { log } from '../logger.ts'
import { ensureRuntimeContextDirectory } from '../runtime-context.ts'
import { getThreadIndexService } from '../thread-index-service.ts'
import { registerSessionActionHandlers } from './session-action-handlers.ts'
import { registerSessionCommandHandlers } from './session-command-handlers.ts'
import { registerSessionFileHandlers } from './session-file-handlers.ts'
import { registerSessionInteractionHandlers } from './session-interaction-handlers.ts'
import { registerIpcInvoke, sessionPromptArgs } from './schema.ts'
import {
  normalizePromptAgent,
  normalizePromptAttachments,
  normalizePromptOptions,
  normalizePromptText,
} from './session-handler-validation.ts'

type PromptAttachment = ReturnType<typeof normalizePromptAttachments>[number]
type PromptPart =
  | { type: 'file'; mime: string; url: string; filename?: string }
  | { type: 'text'; text: string }

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function resolvePromptVariant(
  requestedVariant: string | undefined,
  promptModel: ReturnType<typeof resolvePromptModel>,
  runtimeProvider?: ProviderLike | null,
) {
  if (!requestedVariant || !promptModel) return null
  const runtimeModels = runtimeProvider?.models || null
  if (!runtimeModels) return null
  const rawModel = runtimeModels[promptModel.modelID]
    || runtimeModels[`${promptModel.providerID}/${promptModel.modelID}`]
  const variants = asRecord(asRecord(rawModel)?.variants)
  if (!variants || !Object.prototype.hasOwnProperty.call(variants, requestedVariant)) {
    log('provider', `Ignoring unavailable model variant ${promptModel.providerID}/${promptModel.modelID}:${requestedVariant}`)
    return null
  }
  if (asRecord(variants[requestedVariant])?.disabled === true) {
    log('provider', `Ignoring disabled model variant ${promptModel.providerID}/${promptModel.modelID}:${requestedVariant}`)
    return null
  }
  return requestedVariant
}

function buildPromptParts(promptText: string, attachments: PromptAttachment[]): PromptPart[] {
  return [
    ...attachments.map((attachment) => ({
      type: 'file' as const,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename,
    })),
    { type: 'text', text: promptText },
  ]
}

function buildPromptRequest(input: {
  sessionId: string
  parts: PromptPart[]
  model: ReturnType<typeof resolvePromptModel>
  variant: string | null
  agent: string
}) {
  return {
    sessionID: input.sessionId,
    parts: input.parts,
    ...(input.model ? { model: input.model } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
    agent: input.agent,
  }
}

function buildRendererSessionFallback(input: {
  id: string
  title: string
  opencodeDirectory: string
  createdAt: string
  updatedAt: string
  parentSessionId?: string | null
  changeSummary?: SessionChangeSummary | null
  revertedMessageId?: string | null
}) {
  return {
    id: input.id,
    title: input.title,
    directory: toDisplayDirectory(input.opencodeDirectory),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
    ...(input.revertedMessageId !== undefined ? { revertedMessageId: input.revertedMessageId } : {}),
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
    if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)
    return record
      ? toRendererSession(record)
      : buildRendererSessionFallback({
          id: session.id,
          title: session.title || 'New session',
          opencodeDirectory,
          createdAt: toIsoTimestamp(session.time.created),
          updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        })
  })

  registerIpcInvoke(context, 'session:prompt', sessionPromptArgs(), async (_event, sessionId, text, attachments, agent, options) => {
    const promptText = normalizePromptText(text)
    const promptAttachments = normalizePromptAttachments(attachments)
    const requestedAgent = normalizePromptAgent(agent)
    const promptOptions = normalizePromptOptions(options)
    const { client } = await context.getSessionClient(sessionId)
    const settings = getEffectiveSettings()
    const parts = buildPromptParts(promptText, promptAttachments)

    trackParentSession(sessionId)
    touchSessionRecord(sessionId)
    const promptRecord = updateSessionRecord(sessionId, {
      providerId: settings.effectiveProviderId || null,
      modelId: settings.effectiveModel || null,
      updatedAt: new Date().toISOString(),
    })
    if (promptRecord) getThreadIndexService().upsertThreadFromSessionRecord(promptRecord)
    log('prompt', `Sending prompt to ${shortSessionId(sessionId)} attachments=${promptAttachments.length} agent=${requestedAgent}`)
    try {
      const win = context.getMainWindow()
      // Use a known live-placeholder suffix so the real user message from
      // OpenCode absorbs this optimistic insert via
      // moveLivePlaceholderStateToMessage — otherwise the UI renders two
      // bubbles (the optimistic one and the server-confirmed one).
      const optimisticPromptId = randomUUID()
      const optimisticMessageId = `${sessionId}:${optimisticPromptId}:user:live`
      const optimisticSegmentId = `${sessionId}:${optimisticPromptId}:user:segment:live`
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
      const promptVariant = resolvePromptVariant(promptOptions.variant, promptModel, runtimeProvider)

      await client.session.promptAsync(buildPromptRequest({
        sessionId,
        parts,
        model: promptModel,
        variant: promptVariant,
        agent: requestedAgent,
      }), {
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
      getThreadIndexService().refreshThreadMetadata(sessionId, view)
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
      if (updated) getThreadIndexService().upsertThreadFromSessionRecord(updated)
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
      if (forked) getThreadIndexService().upsertThreadFromSessionRecord(forked)
      return forked
        ? toRendererSession(forked)
        : buildRendererSessionFallback({
            id: session.id,
            title: session.title || 'Forked thread',
            opencodeDirectory: record?.opencodeDirectory || getRuntimeHomeDir(),
            createdAt: toIsoTimestamp(session.time.created),
            updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
            parentSessionId: session.parentID || sessionId,
            changeSummary: session.summary,
            revertedMessageId: session.revertedMessageId,
          })
    } catch (err) {
      context.logHandlerError(`session:fork ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  registerSessionActionHandlers(context)

  registerSessionFileHandlers(context)

  registerSessionCommandHandlers(context)

  registerSessionInteractionHandlers(context)
}
