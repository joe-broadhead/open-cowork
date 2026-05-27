import type { IpcHandlerContext } from './context.ts'
import type { SessionChangeSummary } from '@open-cowork/shared'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { getEffectiveSettings, getProviderCredentialValue } from '../settings.ts'
import { getProviderDescriptor } from '../config-loader.ts'
import { getClient, getClientForDirectory, getRuntimeHomeDir } from '../runtime.ts'
import { normalizeProviderListResponse, type ProviderLike } from '../provider-utils.ts'
import { forgetSubmittedPrompt, rememberSubmittedPrompt, trackParentSession } from '../event-task-state.ts'
import { dispatchRuntimeSessionEvent, publishSessionMetadata, publishSessionView } from '../session-event-dispatcher.ts'
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
import { isSessionPartiallyHydrated, syncSessionView } from '../session-history-loader.ts'
import { sessionEngine } from '../session-engine.ts'
import { normalizeSessionInfo } from '../opencode-adapter.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { log } from '../logger.ts'
import { ensureRuntimeContextDirectory } from '../runtime-context.ts'
import { getThreadIndexService } from '../thread-index/thread-index-service.ts'
import { registerSessionActionHandlers } from './session-action-handlers.ts'
import { registerSessionCommandHandlers } from './session-command-handlers.ts'
import { registerSessionFileHandlers } from './session-file-handlers.ts'
import { registerSessionInteractionHandlers } from './session-interaction-handlers.ts'
import { registerIpcInvoke, sessionPromptArgs, stringAndObjectArgs } from './schema.ts'
import { sdkErrorMessage } from '../sdk-error.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'
import type { CloudTransportSessionEvent } from '../cloud/transport-adapter.ts'
import {
  normalizeComposerPreferences,
  normalizePromptAgent,
  normalizePromptAttachments,
  normalizePromptOptions,
  normalizePromptText,
  normalizeSessionId,
} from './session-handler-validation.ts'

type PromptAttachment = ReturnType<typeof normalizePromptAttachments>[number]
type PromptPart =
  | { type: 'file'; mime: string; url: string; filename?: string }
  | { type: 'text'; text: string }

function payloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

function payloadRecord(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function payloadQuestionTool(payload: Record<string, unknown>) {
  const value = payload.tool
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const tool = value as Record<string, unknown>
  return {
    messageId: typeof tool.messageId === 'string' ? tool.messageId : typeof tool.messageID === 'string' ? tool.messageID : '',
    callId: typeof tool.callId === 'string' ? tool.callId : typeof tool.callID === 'string' ? tool.callID : '',
  }
}

function dispatchCloudWorkspaceSessionEvent(
  context: IpcHandlerContext,
  event: CloudTransportSessionEvent,
  sourceEvent?: IpcMainInvokeEvent,
  workspaceId?: string | null,
) {
  const sessionId = event.sessionId
  if (!sessionId) return
  const win = context.getMainWindow()
  if (!win || win.isDestroyed()) return
  const payload = event.payload || {}
  const eventAt = event.sequence || Date.now()
  const dispatchCloudRuntimeEvent = (runtimeEvent: Parameters<typeof dispatchRuntimeSessionEvent>[1]) => {
    dispatchRuntimeSessionEvent(win, {
      ...runtimeEvent,
      workspaceId: workspaceId || undefined,
    })
  }
  if (event.type === 'prompt.submitted') {
    const messageId = payloadString(payload, 'messageId') || `${sessionId}:${event.sequence}:cloud-user`
    dispatchCloudRuntimeEvent({
      type: 'text',
      sessionId,
      data: {
        type: 'text',
        role: 'user',
        content: payloadString(payload, 'text'),
        mode: 'replace',
        messageId,
        partId: `${messageId}:text`,
        eventAt,
      },
    })
    dispatchCloudRuntimeEvent({
      type: 'busy',
      sessionId,
      data: { type: 'busy' },
    })
  } else if (event.type === 'assistant.message') {
    const messageId = payloadString(payload, 'messageId') || `${sessionId}:${event.sequence}:cloud-assistant`
    dispatchCloudRuntimeEvent({
      type: 'text',
      sessionId,
      data: {
        type: 'text',
        role: 'assistant',
        content: payloadString(payload, 'content'),
        mode: 'replace',
        messageId,
        partId: `${messageId}:text`,
        eventAt,
      },
    })
    dispatchCloudRuntimeEvent({
      type: 'done',
      sessionId,
      data: { type: 'done', synthetic: true },
    })
  } else if (event.type === 'tool.call') {
    dispatchCloudRuntimeEvent({
      type: 'tool_call',
      sessionId,
      data: {
        type: 'tool_call',
        id: payloadString(payload, 'id') || payloadString(payload, 'callId') || `${sessionId}:tool:${event.sequence}`,
        name: payloadString(payload, 'name') || payloadString(payload, 'tool') || 'tool',
        input: payloadRecord(payload, 'input'),
        status: payloadString(payload, 'status') || 'running',
        output: payload.output,
        agent: payloadString(payload, 'agent') || null,
        taskRunId: payloadString(payload, 'taskRunId') || null,
        sourceSessionId: payloadString(payload, 'sourceSessionId') || sessionId,
      },
    })
  } else if (event.type === 'task.run') {
    dispatchCloudRuntimeEvent({
      type: 'task_run',
      sessionId,
      data: {
        type: 'task_run',
        id: payloadString(payload, 'taskRunId') || payloadString(payload, 'id') || `${sessionId}:task:${event.sequence}`,
        title: payloadString(payload, 'title') || 'Task',
        agent: payloadString(payload, 'agent') || null,
        status: payloadString(payload, 'status') || 'queued',
        sourceSessionId: payloadString(payload, 'sourceSessionId') || null,
        parentSessionId: payloadString(payload, 'parentSessionId') || null,
        startedAt: payloadString(payload, 'startedAt') || null,
        finishedAt: payloadString(payload, 'finishedAt') || null,
      },
    })
  } else if (event.type === 'permission.requested') {
    const permissionId = payloadString(payload, 'permissionId') || payloadString(payload, 'id') || `${sessionId}:permission:${event.sequence}`
    dispatchCloudRuntimeEvent({
      type: 'approval',
      sessionId,
      data: {
        type: 'approval',
        id: permissionId,
        taskRunId: payloadString(payload, 'taskRunId') || null,
        tool: payloadString(payload, 'tool') || 'permission',
        input: payloadRecord(payload, 'input'),
        description: payloadString(payload, 'description') || payloadString(payload, 'tool') || 'Permission requested',
        sourceSessionId: payloadString(payload, 'sourceSessionId') || sessionId,
      },
    })
  } else if (event.type === 'permission.resolved') {
    dispatchCloudRuntimeEvent({
      type: 'approval_resolved',
      sessionId,
      data: {
        type: 'approval_resolved',
        id: payloadString(payload, 'permissionId') || payloadString(payload, 'id'),
      },
    })
  } else if (event.type === 'question.asked') {
    dispatchCloudRuntimeEvent({
      type: 'question_asked',
      sessionId,
      data: {
        type: 'question_asked',
        id: payloadString(payload, 'requestId') || payloadString(payload, 'id') || `${sessionId}:question:${event.sequence}`,
        questions: Array.isArray(payload.questions) ? payload.questions as NonNullable<Parameters<typeof dispatchRuntimeSessionEvent>[1]['data']>['questions'] : [],
        tool: payloadQuestionTool(payload),
        sourceSessionId: payloadString(payload, 'sourceSessionId') || sessionId,
      },
    })
  } else if (event.type === 'question.resolved') {
    dispatchCloudRuntimeEvent({
      type: 'question_resolved',
      sessionId,
      data: {
        type: 'question_resolved',
        id: payloadString(payload, 'requestId') || payloadString(payload, 'id'),
        sourceSessionId: payloadString(payload, 'sourceSessionId') || sessionId,
      },
    })
  } else if (event.type === 'todos.updated') {
    dispatchCloudRuntimeEvent({
      type: 'todos',
      sessionId,
      data: {
        type: 'todos',
        todos: Array.isArray(payload.todos) ? payload.todos as NonNullable<Parameters<typeof dispatchRuntimeSessionEvent>[1]['data']>['todos'] : [],
      },
    })
  } else if (event.type === 'cost.updated') {
    dispatchCloudRuntimeEvent({
      type: 'cost',
      sessionId,
      data: {
        type: 'cost',
        id: payloadString(payload, 'id') || `${sessionId}:cost:${event.sequence}`,
        cost: typeof payload.cost === 'number' ? payload.cost : 0,
        tokens: payloadRecord(payload, 'tokens') as NonNullable<Parameters<typeof dispatchRuntimeSessionEvent>[1]['data']>['tokens'],
        taskRunId: payloadString(payload, 'taskRunId') || null,
        sourceSessionId: payloadString(payload, 'sourceSessionId') || sessionId,
      },
    })
  } else if (event.type === 'artifact.created') {
    void context.workspaceGateway.getCloudSessionView(sourceEvent, sessionId, workspaceId)
      .then((view) => {
        if (!win.isDestroyed()) win.webContents.send('session:view', { sessionId, workspaceId: workspaceId || undefined, view })
      })
      .catch((error) => context.logHandlerError(`cloud artifact ${shortSessionId(sessionId)}`, error))
  } else if (event.type === 'session.status') {
    const statusType = payloadString(payload, 'statusType')
    dispatchCloudRuntimeEvent({
      type: statusType === 'busy' || statusType === 'running' ? 'busy' : 'done',
      sessionId,
      data: statusType === 'busy' || statusType === 'running'
        ? { type: 'busy' }
        : { type: 'done', synthetic: true },
    })
  } else if (event.type === 'session.aborted' || event.type === 'session.idle') {
    dispatchCloudRuntimeEvent({
      type: 'done',
      sessionId,
      data: { type: 'done', synthetic: true },
    })
  } else if (event.type === 'runtime.error') {
    dispatchCloudRuntimeEvent({
      type: 'error',
      sessionId,
      data: {
        type: 'error',
        message: payloadString(payload, 'message') || 'Cloud runtime command failed.',
      },
    })
    dispatchCloudRuntimeEvent({
      type: 'done',
      sessionId,
      data: { type: 'done', synthetic: true },
    })
  }
}

function resolvePromptModel(
  settings: ReturnType<typeof getEffectiveSettings>,
  runtimeProvider?: ProviderLike | null,
  composerModelId?: string | null,
) {
  if (!settings.effectiveProviderId || !settings.effectiveModel) return null
  const prefix = `${settings.effectiveProviderId}/`
  const stripProviderPrefix = (modelId: string) => modelId.startsWith(prefix)
    ? modelId.slice(prefix.length)
    : modelId
  const configuredModel = stripProviderPrefix(composerModelId || settings.effectiveModel)
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

function promptModelToStoredModelId(promptModel: ReturnType<typeof resolvePromptModel>, settings: ReturnType<typeof getEffectiveSettings>) {
  if (!promptModel) return settings.effectiveModel || null
  return `${promptModel.providerID}/${promptModel.modelID}`
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
    log('provider', `Could not resolve live provider metadata for ${providerId}: ${sdkErrorMessage(err)}`)
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
    log('provider', `Could not resolve auth methods for ${providerId}: ${sdkErrorMessage(err)}`)
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
  context.ipcMain.handle('session:create', async (event, directory?: string, options?: unknown) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      if (typeof directory === 'string' && directory.trim()) {
        throw new Error('Local project directories are not available in Cloud workspaces.')
      }
      return context.workspaceGateway.createCloudSession(event, workspaceId)
    }
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

  registerIpcInvoke(context, 'session:prompt', sessionPromptArgs(), async (event, sessionId, text, attachments, agent, options) => {
    const workspaceId = readWorkspaceIdOption(options)
    const promptText = normalizePromptText(text)
    const promptAttachments = normalizePromptAttachments(attachments)
    const requestedAgent = normalizePromptAgent(agent)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      await context.workspaceGateway.promptCloudSession(event, sessionId, {
        text: promptText,
        attachments: promptAttachments,
        agent: requestedAgent,
      }, workspaceId)
      return
    }
    const promptOptions = normalizePromptOptions(options)
    const { client, record } = await context.getSessionClient(sessionId)
    const settings = getEffectiveSettings()
    const parts = buildPromptParts(promptText, promptAttachments)

    trackParentSession(sessionId)
    touchSessionRecord(sessionId)
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
      const promptModel = resolvePromptModel(settings, runtimeProvider, record?.composerModelId)
      const requestedVariant = promptOptions.variant ?? record?.composerReasoningVariant ?? undefined
      const promptVariant = resolvePromptVariant(requestedVariant, promptModel, runtimeProvider)
      const promptRecord = updateSessionRecord(sessionId, {
        providerId: settings.effectiveProviderId || null,
        modelId: promptModelToStoredModelId(promptModel, settings),
        updatedAt: new Date().toISOString(),
      })
      if (promptRecord) getThreadIndexService().upsertThreadFromSessionRecord(promptRecord)

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
      const message = sdkErrorMessage(err, 'Prompt failed')
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

  context.ipcMain.handle('session:activate', async (event, sessionIdInput: unknown, options?: { force?: boolean; workspaceId?: string }) => {
    const workspaceId = readWorkspaceIdOption(options)
    const sessionId = normalizeSessionId(sessionIdInput)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      await context.workspaceGateway.subscribeCloudSessionEvents(event, sessionId, {
        workspaceId,
        onEvent: (cloudEvent) => dispatchCloudWorkspaceSessionEvent(context, cloudEvent, event, workspaceId),
        onError: (error) => context.logHandlerError(`cloud session:events ${shortSessionId(sessionId)}`, error),
      })
      return context.workspaceGateway.getCloudSessionView(event, sessionId, workspaceId)
    }
    try {
      const shouldRetryFullHydration = !options?.force && isSessionPartiallyHydrated(sessionId)
      const progressive = !options?.force && (
        !sessionEngine.isHydrated(sessionId)
        || shouldRetryFullHydration
      )
      const view = await syncSessionView(sessionId, {
        force: options?.force,
        activate: true,
        progressive,
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
        publishSessionMetadata(win, sessionId)
      }
      if (progressive) {
        void syncSessionView(sessionId, {
          force: true,
          activate: false,
        }).then((hydratedView) => {
          getThreadIndexService().refreshThreadMetadata(sessionId, hydratedView)
          const hydratedWin = context.getMainWindow()
          if (!hydratedWin || hydratedWin.isDestroyed()) return
          publishSessionView(hydratedWin, sessionId)
          publishSessionMetadata(hydratedWin, sessionId)
        }).catch((err) => {
          context.logHandlerError(`session:activate hydrate ${shortSessionId(sessionId)}`, err)
        })
      }
      return view
    } catch (err) {
      context.logHandlerError(`session:activate ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  context.ipcMain.handle('session:list', async (event, options?: unknown) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.listCloudSessions(event, workspaceId)
    }
    return listSessionRecords().map(toRendererSession)
  })

  registerIpcInvoke(context, 'session:set-composer-preferences', stringAndObjectArgs('session id', 'composer preferences', { maxBytes: 512 }), async (_event, sessionIdInput, rawPreferences) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const preferences = normalizeComposerPreferences(rawPreferences)
    const patch: Parameters<typeof updateSessionRecord>[1] = {}
    if (Object.prototype.hasOwnProperty.call(preferences, 'modelId')) {
      patch.composerModelId = preferences.modelId ?? null
    }
    if (Object.prototype.hasOwnProperty.call(preferences, 'reasoningVariant')) {
      patch.composerReasoningVariant = preferences.reasoningVariant ?? null
    }
    const record = Object.keys(patch).length > 0
      ? updateSessionRecord(sessionId, patch)
      : getSessionRecord(sessionId)
    return record ? toRendererSession(record) : null
  })

  context.ipcMain.handle('session:get', async (event, idInput: unknown, options?: unknown) => {
    const workspaceId = readWorkspaceIdOption(options)
    const id = normalizeSessionId(idInput)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.getCloudSessionInfo(event, id, workspaceId)
    }
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

  context.ipcMain.handle('session:abort', async (event, sessionIdInput: unknown, options?: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      await context.workspaceGateway.abortCloudSession(event, sessionId, workspaceId)
      return
    }
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
    rootSessionIdInput: unknown,
    childSessionIdInput: unknown,
  ) => {
    const rootSessionId = normalizeSessionId(rootSessionIdInput)
    const childSessionId = normalizeSessionId(childSessionIdInput)
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

  context.ipcMain.handle('session:fork', async (_event, sessionIdInput: unknown, messageId?: string) => {
    const sessionId = normalizeSessionId(sessionIdInput)
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
          composerModelId: record?.composerModelId || null,
          composerReasoningVariant: record?.composerReasoningVariant || null,
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
