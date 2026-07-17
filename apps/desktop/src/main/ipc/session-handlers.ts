import { getThreadIndexService } from '@open-cowork/runtime-host/thread-index/thread-index-service'
import { toIsoTimestamp } from '@open-cowork/runtime-host/task-run-utils'
import { getEffectiveSettings, getProviderCredentialValue } from '@open-cowork/runtime-host/settings'
import { getSessionRecord, listSessionRecords, toDisplayDirectory, toRendererSession, toSessionRecord, touchSessionRecord, updateSessionRecord, upsertSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { isSessionPartiallyHydrated, syncSessionView } from '@open-cowork/runtime-host/session-history-loader'
import { dispatchRuntimeSessionEvent, publishSessionMetadata, publishSessionView } from '@open-cowork/runtime-host/session-event-dispatcher'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { getClient, getClientForDirectory, getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { ensureRuntimeContextDirectory } from '@open-cowork/runtime-host/runtime-context'
import { listNativeProviders, type ProviderLike } from '@open-cowork/runtime-host/provider-utils'
import { getNativeProviderAuthMethods } from './provider-handlers.ts'
import { createNativeSession, getNativeSession, interruptNativeSession, normalizeSessionInfo, promptNativeSession } from '@open-cowork/runtime-host'
import type { IpcHandlerContext } from './context.ts'
import { isCloudProjectedSessionEventType, normalizeCloudProjectSource, type CloudProjectSourceInput, type SessionChangeSummary, type SessionImportSelection, shortSessionId } from '@open-cowork/shared'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from 'node:fs'
import { getProviderDescriptor } from '@open-cowork/runtime-host/config'
import { forgetSubmittedPrompt, rememberSubmittedPrompt, trackParentSession } from '../event-task-state.ts'
import { markSessionPromptAdmitted } from '../durable-session-events.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { log } from '@open-cowork/shared/node'
import {
  buildSessionImportInventory,
  buildSessionImportRequest,
  type SessionImportArtifactLoader,
} from '../session-import.ts'
import { registerSessionActionHandlers } from './session-action-handlers.ts'
import { registerSessionCommandHandlers } from './session-command-handlers.ts'
import { registerSessionFileHandlers } from './session-file-handlers.ts'
import { registerSessionInteractionHandlers } from './session-interaction-handlers.ts'
import { registerIpcInvoke, sessionPromptArgs, stringAndObjectArgs } from './schema.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'
import {
  buildCloudProjectSnapshotInventory,
  buildCloudProjectSnapshotUpload,
} from '../project-source-snapshot.ts'
import type { CloudTransportSessionEvent } from '@open-cowork/cloud-server/transport-adapter'
import {
  normalizeComposerPreferences,
  normalizePromptAgent,
  normalizePromptAttachments,
  normalizePromptOptions,
  normalizePromptText,
  normalizeSessionId,
} from './session-handler-validation.ts'

const CLOUD_PROJECTION_REFRESH_DEBOUNCE_MS = 25
const CLOUD_PROJECTION_REFRESH_BACKOFF_BASE_MS = 250
const CLOUD_PROJECTION_REFRESH_BACKOFF_MAX_MS = 5_000

type CloudProjectionRefreshState = {
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  latestSequence: number
  publishedRevision: number
  failedAttempts: number
  nextAllowedAt: number
  retryAfterFailure: boolean
}

const cloudProjectionRefreshes = new Map<string, CloudProjectionRefreshState>()

function cloudProjectionRefreshKey(workspaceId: string | null | undefined, sessionId: string) {
  return `${workspaceId || 'local'}:${sessionId}`
}

function cloudWorkspaceIsStillActive(
  context: IpcHandlerContext,
  sourceEvent: IpcMainInvokeEvent | undefined,
  workspaceId: string | null | undefined,
) {
  if (!sourceEvent || !workspaceId) return true
  try {
    return context.workspaceGateway.activeWorkspaceId(sourceEvent) === workspaceId
  } catch (error) {
    // Resolving the active workspace failed (e.g. the source window/event is gone).
    // Fail closed — don't deliver to a possibly-wrong workspace — but log it so a
    // burst of silently-dropped projection refreshes is diagnosable.
    log('session', `Active-workspace check failed for ${workspaceId}; treating workspace as inactive: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function queueCloudProjectionRefresh(input: {
  context: IpcHandlerContext
  win: BrowserWindow
  sourceEvent?: IpcMainInvokeEvent
  sessionId: string
  workspaceId?: string | null
  sequence: number
}) {
  const { context, win, sourceEvent, sessionId, workspaceId, sequence } = input
  if (!cloudWorkspaceIsStillActive(context, sourceEvent, workspaceId)) return
  const key = cloudProjectionRefreshKey(workspaceId, sessionId)
  const state = cloudProjectionRefreshes.get(key) || {
    timer: null,
    inFlight: false,
    latestSequence: 0,
    publishedRevision: 0,
    failedAttempts: 0,
    nextAllowedAt: 0,
    retryAfterFailure: false,
  }
  state.latestSequence = Math.max(state.latestSequence, sequence)
  cloudProjectionRefreshes.set(key, state)
  if (state.timer) clearTimeout(state.timer)
  const delayMs = Math.max(CLOUD_PROJECTION_REFRESH_DEBOUNCE_MS, state.nextAllowedAt - Date.now())
  state.timer = setTimeout(() => {
    state.timer = null
    void runQueuedCloudProjectionRefresh({
      context,
      win,
      sourceEvent,
      sessionId,
      workspaceId,
      key,
      state,
    })
  }, delayMs)
}

async function runQueuedCloudProjectionRefresh(input: {
  context: IpcHandlerContext
  win: BrowserWindow
  sourceEvent?: IpcMainInvokeEvent
  sessionId: string
  workspaceId?: string | null
  key: string
  state: CloudProjectionRefreshState
}) {
  const { context, win, sourceEvent, sessionId, workspaceId, key, state } = input
  if (state.inFlight) return
  if (win.isDestroyed()) {
    cloudProjectionRefreshes.delete(key)
    return
  }
  if (!cloudWorkspaceIsStillActive(context, sourceEvent, workspaceId)) {
    cloudProjectionRefreshes.delete(key)
    return
  }
  state.inFlight = true
  const requestedSequence = state.latestSequence
  try {
    const view = await context.workspaceGateway.getCloudSessionView(sourceEvent, sessionId, workspaceId)
    if (view.revision < requestedSequence) {
      throw new Error(`Cloud projection revision ${view.revision} is behind event sequence ${requestedSequence}.`)
    }
    if (
      !win.isDestroyed()
      && cloudWorkspaceIsStillActive(context, sourceEvent, workspaceId)
      && view.revision >= state.publishedRevision
    ) {
      state.publishedRevision = view.revision
      win.webContents.send('session:view', { sessionId, workspaceId: workspaceId || undefined, view })
    }
    state.failedAttempts = 0
    state.nextAllowedAt = 0
    state.retryAfterFailure = false
  } catch (error) {
    state.failedAttempts = Math.min(state.failedAttempts + 1, 8)
    const backoffMs = Math.min(
      CLOUD_PROJECTION_REFRESH_BACKOFF_MAX_MS,
      CLOUD_PROJECTION_REFRESH_BACKOFF_BASE_MS * 2 ** (state.failedAttempts - 1),
    )
    state.nextAllowedAt = Date.now() + backoffMs
    state.retryAfterFailure = error instanceof Error && error.message.includes('behind event sequence')
    context.logHandlerError(`cloud session:view ${shortSessionId(sessionId)}`, error)
  } finally {
    state.inFlight = false
    if (state.latestSequence > requestedSequence || state.retryAfterFailure) {
      state.retryAfterFailure = false
      if (state.timer) clearTimeout(state.timer)
      const delayMs = Math.max(CLOUD_PROJECTION_REFRESH_DEBOUNCE_MS, state.nextAllowedAt - Date.now())
      state.timer = setTimeout(() => {
        state.timer = null
        void runQueuedCloudProjectionRefresh(input)
      }, delayMs)
    } else if (!state.timer) {
      const deleteDelayMs = Math.max(0, state.nextAllowedAt - Date.now())
      if (deleteDelayMs > 0) {
        state.timer = setTimeout(() => {
          if (cloudProjectionRefreshes.get(key) === state) cloudProjectionRefreshes.delete(key)
        }, deleteDelayMs)
      } else {
        cloudProjectionRefreshes.delete(key)
      }
    }
  }
}

type PromptAttachment = ReturnType<typeof normalizePromptAttachments>[number]
type PromptPart =
  | { type: 'file'; mime: string; url: string; filename?: string }
  | { type: 'text'; text: string }

const MAX_LOCAL_IMPORT_ARTIFACT_BYTES = 25 * 1024 * 1024

function readCloudProjectSourceOption(input: unknown): CloudProjectSourceInput | null | undefined {
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  if (!Object.prototype.hasOwnProperty.call(input, 'projectSource')) return undefined
  const raw = (input as { projectSource?: unknown }).projectSource
  if (raw === undefined || raw === null) return null
  const normalized = normalizeCloudProjectSource(raw)
  if (!normalized) throw new Error('Cloud project source is invalid.')
  return normalized
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
  if (!cloudWorkspaceIsStillActive(context, sourceEvent, workspaceId)) return
  if (!isCloudProjectedSessionEventType(event.type)) return
  queueCloudProjectionRefresh({
    context,
    win,
    sourceEvent,
    sessionId,
    workspaceId,
    sequence: typeof event.sequence === 'number' && Number.isFinite(event.sequence) ? event.sequence : 0,
  })
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

function normalizeSessionImportSelection(value: unknown): SessionImportSelection {
  const record = asRecord(value) || {}
  const stringArray = (entry: unknown) => Array.isArray(entry)
    ? entry.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined
  return {
    ...(typeof record.includeMessages === 'boolean' ? { includeMessages: record.includeMessages } : {}),
    ...(typeof record.includeArtifacts === 'boolean' ? { includeArtifacts: record.includeArtifacts } : {}),
    ...(typeof record.includeAttachments === 'boolean' ? { includeAttachments: record.includeAttachments } : {}),
    ...(typeof record.includeProjectSource === 'boolean' ? { includeProjectSource: record.includeProjectSource } : {}),
    ...(stringArray(record.artifactIds) ? { artifactIds: stringArray(record.artifactIds) } : {}),
    ...(stringArray(record.attachmentIds) ? { attachmentIds: stringArray(record.attachmentIds) } : {}),
  }
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

function localImportArtifactLoader(
  context: IpcHandlerContext,
  sessionId: string,
): SessionImportArtifactLoader {
  return async (artifact) => {
    const { source } = context.resolvePrivateArtifactPath({
      sessionId,
      filePath: artifact.filePath,
    })
    let fd: number | null = null
    try {
      fd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOCAL_IMPORT_ARTIFACT_BYTES) return null
      return {
        dataBase64: readFileSync(fd).toString('base64'),
        contentType: artifact.mime || null,
      }
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }
}

type ProviderAuthMethodLike = {
  type?: unknown
}

async function getSelectedRuntimeProvider(client: NonNullable<ReturnType<typeof getClient>>, providerId?: string | null) {
  if (!providerId) return null
  try {
    const providers = await listNativeProviders(client)
    return providers.find((provider) => (
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
    const methods = (await getNativeProviderAuthMethods(client))[providerId]
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
  context.ipcMain.handle('project-source:validate', async (event, input?: unknown) => {
    const workspaceId = readWorkspaceIdOption(input)
    const projectSource = readCloudProjectSourceOption(input)
    if (!projectSource) throw new Error('Cloud project source is required.')
    return context.workspaceGateway.validateCloudProjectSource(event, workspaceId, projectSource)
  })

  context.ipcMain.handle('project-source:snapshot-inventory', async (_event, input?: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Snapshot inventory input is required.')
    const directory = context.normalizeDirectory((input as { directory?: unknown }).directory as string | undefined)
    return buildCloudProjectSnapshotInventory(directory)
  })

  context.ipcMain.handle('project-source:upload-snapshot', async (event, input?: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Snapshot upload input is required.')
    const workspaceId = readWorkspaceIdOption(input)
    const record = input as { directory?: unknown; title?: unknown }
    const directory = context.normalizeDirectory(record.directory as string | undefined)
    const upload = await buildCloudProjectSnapshotUpload(directory)
    return context.workspaceGateway.uploadCloudProjectSnapshot(event, workspaceId, {
      ...upload,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : upload.title,
    })
  })

  context.ipcMain.handle('session:create', async (event, directory?: string, options?: unknown) => {
    const workspaceId = readWorkspaceIdOption(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      if (typeof directory === 'string' && directory.trim()) {
        throw new Error('Local project directories are not available in Cloud workspaces.')
      }
      return context.workspaceGateway.createCloudSession(event, workspaceId, {
        projectSource: readCloudProjectSourceOption(options),
      })
    }
    const opencodeDirectory = context.normalizeDirectory(directory)
    await ensureRuntimeContextDirectory(opencodeDirectory)
    const client = getClientForDirectory(opencodeDirectory)
    if (!client) throw new Error('Runtime not started')
    const settings = getEffectiveSettings()

    log('session', 'Creating new session')
    const session = normalizeSessionInfo(await createNativeSession(client, {
      location: { directory: opencodeDirectory },
    }))
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

      const admitted = await promptNativeSession(client, {
        sessionID: sessionId,
        parts,
        model: promptModel
          ? { ...promptModel, variant: promptVariant || undefined }
          : null,
        agent: requestedAgent,
      })
      // V2 prompt is admission-only. Attach the session to the durable
      // v2.session.events tail from admittedSeq so transcript is not lost
      // between the HTTP response and the global SSE stream.
      markSessionPromptAdmitted({
        // Match event-subscription keys (runtime home path, not null).
        directory: record?.opencodeDirectory || getRuntimeHomeDir(),
        sessionId,
        admittedSeq: admitted.admittedSeq,
        admissionId: admitted.id,
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
      const cloudWorkspaceId = workspaceId || context.workspaceGateway.activeWorkspaceId(event)
      await context.workspaceGateway.subscribeCloudSessionEvents(event, sessionId, {
        workspaceId: cloudWorkspaceId,
        onEvent: (cloudEvent) => dispatchCloudWorkspaceSessionEvent(context, cloudEvent, event, cloudWorkspaceId),
        onError: (error) => context.logHandlerError(`cloud session:events ${shortSessionId(sessionId)}`, error),
      })
      return context.workspaceGateway.getCloudSessionView(event, sessionId, cloudWorkspaceId)
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
    if (Object.prototype.hasOwnProperty.call(preferences, 'agentName')) {
      patch.composerAgentName = preferences.agentName ?? null
    }
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
      const session = normalizeSessionInfo(await getNativeSession(client, id))
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

  context.ipcMain.handle('session:import-inventory', async (event, sessionIdInput: unknown) => {
    context.workspaceGateway.assertLocalWorkspace(event)
    const sessionId = normalizeSessionId(sessionIdInput)
    const record = context.ensureSessionRecord(sessionId)
    if (!record) throw new Error(`Unknown local session ${sessionId}.`)
    const view = await syncSessionView(sessionId, { force: true, activate: false })
    return buildSessionImportInventory(record, view)
  })

  registerIpcInvoke(context, 'session:copy-to-cloud', stringAndObjectArgs('session id', 'session import request', { maxBytes: 128 * 1024 }), async (event, sessionIdInput, rawInput) => {
    context.workspaceGateway.assertLocalWorkspace(event)
    const sessionId = normalizeSessionId(sessionIdInput)
    const input = asRecord(rawInput) || {}
    const targetWorkspaceId = typeof input.targetWorkspaceId === 'string' ? input.targetWorkspaceId.trim() : ''
    if (!targetWorkspaceId) throw new Error('Copy to cloud requires a target cloud workspace.')
    const selection = normalizeSessionImportSelection(input.selection)
    const record = context.ensureSessionRecord(sessionId)
    if (!record) throw new Error(`Unknown local session ${sessionId}.`)
    const view = await syncSessionView(sessionId, { force: true, activate: false })
    const importRequest = await buildSessionImportRequest(record, view, selection, localImportArtifactLoader(context, sessionId))
    const result = await context.workspaceGateway.importLocalSessionToCloud(event, importRequest, targetWorkspaceId)
    const win = context.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('workspace:sessions-updated', {
        workspaceId: result.workspaceId,
        sessions: await context.workspaceGateway.listCloudSessions(event, result.workspaceId),
        lastEventSequence: null,
        syncedAt: new Date().toISOString(),
      })
      win.webContents.send('session:view', {
        sessionId: result.sessionId,
        workspaceId: result.workspaceId,
        view: result.view,
      })
    }
    return {
      workspaceId: result.workspaceId,
      sessionId: result.sessionId,
      title: result.title,
      importedAt: result.importedAt,
      itemCounts: result.itemCounts,
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
      await interruptNativeSession(client, sessionId)
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
      await interruptNativeSession(client, childSessionId)
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
      }, { throwOnError: true })
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
          composerAgentName: record?.composerAgentName || null,
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
