import { lookupWorkflowDirectoryTrust } from '@open-cowork/runtime-host/workflow/workflow-store'
import { getThreadIndexService } from '@open-cowork/runtime-host/thread-index/thread-index-service'
import { getEffectiveSettings } from '@open-cowork/runtime-host/settings'
import { getSessionRecord, lookupSessionDirectoryTrust } from '@open-cowork/runtime-host/session-registry'
import { setSessionHistoryChildLineageSeedHandler, syncSessionView } from '@open-cowork/runtime-host/session-history-loader'
import { addRuntimeSessionEventObserver, dispatchRuntimeSessionEvent, setSessionHistoryRefreshHandler } from '@open-cowork/runtime-host/session-event-dispatcher'
import { configureSemanticUiBridge } from '@open-cowork/runtime-host/semantic-ui-bridge'
import { buildDiagnosticsBundle } from './diagnostics-export.ts'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { getClient, getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { listRuntimeToolsForResolvedContext } from '@open-cowork/runtime-host/runtime-tools'
import { createSandboxWorkspaceDir } from '@open-cowork/runtime-host/runtime-paths'
import { observePerf } from '@open-cowork/runtime-host/perf-metrics'
import { configureKnowledgeService } from '@open-cowork/runtime-host/knowledge/knowledge-service'
import { delay } from '@open-cowork/runtime-host/delay'
import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type {
  CapabilityToolEntry,
  DestructiveConfirmationRequest,
  ToolListOptions,
} from '@open-cowork/shared'
import { isMcpAuthRequiredStatus, shortSessionId } from '@open-cowork/shared'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { getAppConfig } from '@open-cowork/runtime-host/config'
import { log } from '@open-cowork/shared/node'
import { getMcpStatus } from './events.ts'
import { createDestructiveConfirmationManager } from './destructive-actions.ts'
import { registerAppHandlers } from './ipc/app-handlers.ts'
import { registerArtifactHandlers } from './ipc/artifact-handlers.ts'
import { registerLaunchpadHandlers } from './ipc/launchpad-handlers.ts'
import { registerKnowledgeHandlers } from './ipc/knowledge-handlers.ts'
import { registerSessionHandlers } from './ipc/session-handlers.ts'
import { registerCatalogHandlers } from './ipc/catalog-handlers.ts'
import { registerCoordinationHandlers } from './ipc/coordination-handlers.ts'
import { registerChannelHandlers } from './ipc/channel-handlers.ts'
import { registerWorkflowHandlers } from './ipc/workflow-handlers.ts'
import { registerCustomContentHandlers } from './ipc/custom-content-handlers.ts'
import { registerExplorerHandlers } from './ipc/explorer-handlers.ts'
import { registerThreadHandlers } from './ipc/thread-handlers.ts'
import { registerAdminHandlers } from './ipc/admin-handlers.ts'
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.ts'
import { registerDesktopPairingHandlers } from './ipc/desktop-pairing-handlers.ts'
import type { IpcHandlerContext } from './ipc/context.ts'
import { objectArg, registerIpcInvoke } from './ipc/schema.ts'
import { validateDestructiveConfirmationRequest } from './ipc/object-validators.ts'
import { clearPermissionsForSession, trackPermission } from './permission-tracker.ts'
import { ProjectDirectoryGrantRegistry } from './directory-grants.ts'
import { isTrustedRendererIpcUrl } from './main-window-lifecycle.ts'
import {
  buildCustomAgentPermission,
  createCapabilityToolDiscovery,
  isLikelyMcpAuthError,
  listToolsFromMcpEntry,
} from './capability-tool-discovery.ts'
import { resolvePrivateSessionArtifactPath } from './ipc-artifact-access.ts'
import { createIpcRuntimeContext } from './ipc-runtime-context.ts'
import { showNativeConfirmation, type NativeConfirmationOptions } from './native-confirmation.ts'
import { createWorkspaceGateway } from './workspace-gateway.ts'
import { createDesktopPairingService } from './desktop-pairing/service.ts'
import { createDesktopPairingLocalExecutor } from './desktop-pairing/local-executor.ts'
import {
  createSemanticUiLocalActionList,
  executeSemanticUiLocalAction,
} from './semantic-ui-local-actions.ts'
import { seedReplayedChildSessionLineage } from './event-task-state.ts'

export { invalidateRuntimeToolCache } from '@open-cowork/runtime-host/runtime-tool-cache'

type IpcSenderEvent = IpcMainEvent | IpcMainInvokeEvent

function currentModuleDirname() {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
}

function expectedRendererEntryPath() {
  return join(currentModuleDirname(), '../index.html')
}

function expectedTrustedRendererPaths() {
  return [
    expectedRendererEntryPath(),
    join(currentModuleDirname(), '../loading.html'),
  ]
}

export function isTrustedIpcSenderUrl(rawUrl: string, devServerUrl: string | null | undefined = process.env.VITE_DEV_SERVER_URL) {
  return isTrustedRendererIpcUrl({
    rawUrl,
    devServerUrl,
    expectedRendererPath: expectedTrustedRendererPaths(),
  })
}

function assertTrustedIpcSender(event: IpcSenderEvent, channel: string, devServerUrl?: string | null) {
  const senderFrame = (event as { senderFrame?: { url?: unknown } | null }).senderFrame
  const senderUrl = typeof senderFrame?.url === 'string' ? senderFrame.url : ''
  if (isTrustedIpcSenderUrl(senderUrl, devServerUrl)) return
  log('security', `Rejected IPC ${channel} from untrusted sender frame: ${senderUrl || 'unknown'}`)
  throw new Error('Rejected IPC request from untrusted renderer frame.')
}

export function setupIpcHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
  handlerOptions: { devServerUrl?: string | null } = {},
) {
  setSessionHistoryChildLineageSeedHandler(({ rootSessionId, children }) => {
    seedReplayedChildSessionLineage(rootSessionId, children)
  })

  setSessionHistoryRefreshHandler(async (sessionId: string) => {
    await syncSessionView(sessionId, {
      force: true,
      activate: false,
    })
    const record = getSessionRecord(sessionId)
    const win = getMainWindow()
    if (!record || !win || win.isDestroyed()) return
    getThreadIndexService().refreshThreadMetadata(sessionId)
    win.webContents.send('session:updated', {
      id: record.id,
      workspaceId: 'local',
      title: record.title || null,
      parentSessionId: record.parentSessionId,
      changeSummary: record.changeSummary,
      revertedMessageId: record.revertedMessageId,
      composerAgentName: record.composerAgentName,
      composerModelId: record.composerModelId,
      composerReasoningVariant: record.composerReasoningVariant,
    })
  })

  // Wrap ipcMain.handle so every registered handler records a
  // per-channel duration distribution (visible via `diagnostics:perf`).
  // Failures are recorded too — the distribution keeps flowing, and the
  // error still propagates to the renderer. Handlers that return a
  // sentinel on error (most of them) get measured as normal successes
  // since no exception is thrown.
  const instrumentedIpcMain = {
    handle(channel: string, listener: Parameters<IpcMain['handle']>[1]) {
      return ipcMain.handle(channel, async (...args) => {
        const start = performance.now()
        try {
          assertTrustedIpcSender(args[0], channel, handlerOptions.devServerUrl)
          return await listener(...args)
        } finally {
          observePerf(`ipc.${channel}`, performance.now() - start, { slowThresholdMs: 500 })
        }
      })
    },
    on(channel: string, listener: Parameters<IpcMain['on']>[1]) {
      // Fire-and-forget channels (renderer uses `ipcRenderer.send`) skip
      // the perf histograms because there's no reply to time — they're
      // one-way notifications by design.
      return ipcMain.on(channel, (event, ...args) => {
        assertTrustedIpcSender(event, channel, handlerOptions.devServerUrl)
        return listener(event, ...args)
      })
    },
  } satisfies Pick<IpcMain, 'handle' | 'on'>


  const destructiveConfirmations = createDestructiveConfirmationManager()
  const workspaceGateway = createWorkspaceGateway({
    cloudDesktop: getAppConfig().cloudDesktop,
    cloudLoginBrandName: getAppConfig().branding.name,
  })
  const capabilityToolMethodCache = new Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>()
  const approvedSkillImportDirectories = new Map<string, string>()

  // JOE-843 / JOE-896: inverted indexes on session + workflow project directories.
  // Never listSessionRecords()/listWorkflows() (full clone/sort + runs) on this hot path.
  const projectDirectoryGrants = new ProjectDirectoryGrantRegistry((directory) => {
    const sessionTrust = lookupSessionDirectoryTrust(directory)
    if (sessionTrust) return sessionTrust
    return lookupWorkflowDirectoryTrust(directory)
  })

  function normalizeDirectory(directory?: string | null) {
    if (!directory) return createSandboxWorkspaceDir()
    return projectDirectoryGrants.resolve(directory) || createSandboxWorkspaceDir()
  }

  function ensureSessionRecord(sessionId: string) {
    return getSessionRecord(sessionId)
  }

  function logHandlerError(handler: string, err: unknown) {
    const message = sdkErrorMessage(err, 'IPC handler failed')
    log('error', `${handler} failed: ${message}`)
  }

  function describeDestructiveRequest(request: DestructiveConfirmationRequest) {
    if (request.action === 'session.delete') {
      return `session=${shortSessionId(request.sessionId)}`
    }
    if (request.action === 'app.reset') {
      return 'app=reset'
    }
    const target = request.target
    return `${target.scope}:${target.name}${target.directory ? `@${target.directory}` : ''}`
  }

  function destructiveConfirmationPrompt(request: DestructiveConfirmationRequest): NativeConfirmationOptions {
    if (request.action === 'session.delete') {
      return {
        title: 'Delete thread?',
        message: 'Delete this thread? This cannot be undone.',
        detail: `Thread: ${shortSessionId(request.sessionId)}`,
        confirmLabel: 'Delete',
      }
    }
    if (request.action === 'app.reset') {
      return {
        title: 'Reset app data?',
        message: 'Reset all app data? This cannot be undone.',
        detail: 'This deletes every saved thread, credential, custom agent, skill, MCP, and sandbox workspace from this machine. The app will relaunch with a fresh first-run experience.',
        confirmLabel: 'Reset',
      }
    }
    const target = request.target
    const noun = request.action === 'agent.remove'
      ? 'agent'
      : request.action === 'mcp.remove'
        ? 'MCP'
        : 'skill'
    return {
      title: `Remove ${noun}?`,
      message: `Remove ${noun} "${target.name}"? This cannot be undone.`,
      detail: `Scope: ${target.scope}${target.directory ? `\nProject: ${target.directory}` : ''}`,
      confirmLabel: 'Remove',
    }
  }

  function consumeDestructiveConfirmation(request: DestructiveConfirmationRequest, token?: string | null) {
    const ok = destructiveConfirmations.consume(request, token)
    log('audit', `${request.action} ${ok ? 'confirmed' : 'blocked'} ${describeDestructiveRequest(request)}`)
    return ok
  }

  function reconcileIdleSession(sessionId: string) {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    dispatchRuntimeSessionEvent(win, {
      type: 'history_refresh',
      sessionId,
      data: { type: 'history_refresh' },
    })
    dispatchRuntimeSessionEvent(win, {
      type: 'done',
      sessionId,
      data: {
        type: 'done',
        synthetic: true,
      },
    })
  }

  const runtimeContext = createIpcRuntimeContext({
    ensureSessionRecord,
    resolveGrantedProjectDirectory: (directory) => projectDirectoryGrants.resolve(directory),
  })

  async function waitForMcpStatus(name: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const client = getClient()
      if (client) {
        const statuses = await getMcpStatus(client)
        const match = statuses.find((entry) => entry.name === name)
        if (match) return match
      }
      await delay(500)
    }
    return null
  }

  async function authenticateNewRemoteMcpIfNeeded(name: string) {
    const status = await waitForMcpStatus(name)
    if (!status) return
    if (!isMcpAuthRequiredStatus(status.rawStatus)) return

    const client = getClient()
    if (!client) return

    log('mcp', `Auto-authenticating newly added MCP ${name}`)
    try {
      await client.mcp.auth.authenticate({ name }, { throwOnError: true })
      log('mcp', `OAuth complete for ${name}`)
    } catch (error) {
      logHandlerError(`custom:add-mcp auth ${name}`, error)
    }
  }

  async function listRuntimeTools(options?: ToolListOptions) {
    const settings = getEffectiveSettings()
    let provider = options?.provider || settings.effectiveProviderId || ''
    let model = options?.model || settings.effectiveModel || ''
    let directory = getRuntimeHomeDir()

    if (options?.sessionId) {
      const sessionContext = runtimeContext.resolveSessionRuntimeModel(options.sessionId)
      provider = options?.provider || sessionContext.provider
      model = options?.model || sessionContext.model
      directory = sessionContext.directory
    } else if (options?.directory) {
      directory = projectDirectoryGrants.resolve(options.directory) || getRuntimeHomeDir()
    }

    if (!provider || !model) return []

    return listRuntimeToolsForResolvedContext({
      directory,
      provider,
      model,
      logScope: 'tool:list',
    })
  }

  const capabilityToolDiscovery = createCapabilityToolDiscovery({
    resolveContextDirectory: runtimeContext.resolveContextDirectory,
    logHandlerError,
    capabilityToolMethodCache,
  })

  let context!: IpcHandlerContext
  let desktopPairingExecutor: ReturnType<typeof createDesktopPairingLocalExecutor> | null = null
  const getDesktopPairingExecutor = () => {
    desktopPairingExecutor ||= createDesktopPairingLocalExecutor(context)
    return desktopPairingExecutor
  }
  const desktopPairingService = createDesktopPairingService({
    executor: {
      createSession: async (...args) => getDesktopPairingExecutor().createSession(...args),
      prompt: async (...args) => getDesktopPairingExecutor().prompt(...args),
      abort: async (...args) => getDesktopPairingExecutor().abort(...args),
      respondPermission: async (...args) => getDesktopPairingExecutor().respondPermission(...args),
      replyQuestion: async (...args) => getDesktopPairingExecutor().replyQuestion(...args),
      rejectQuestion: async (...args) => getDesktopPairingExecutor().rejectQuestion(...args),
      listSessions: async (...args) => getDesktopPairingExecutor().listSessions(...args),
    },
  })
  workspaceGateway.setDesktopPairingProvider(() => desktopPairingService.list())
  addRuntimeSessionEventObserver((event) => desktopPairingService.observeRuntimeEvent(event))

  context = {
    ipcMain: instrumentedIpcMain,
    workspaceGateway,
    desktopPairingService,
    getMainWindow,
    normalizeDirectory,
    ensureSessionRecord,
    resolvePrivateArtifactPath: (request) => resolvePrivateSessionArtifactPath(request, { ensureSessionRecord }),
    grantProjectDirectory: (directory) => projectDirectoryGrants.grant(directory),
    resolveGrantedProjectDirectory: (directory) => projectDirectoryGrants.resolve(directory),
    resolveContextDirectory: runtimeContext.resolveContextDirectory,
    resolveScopedTarget: runtimeContext.resolveScopedTarget,
    buildCustomAgentPermission,
    requestNativeConfirmation: (options) => showNativeConfirmation(getMainWindow(), options),
    logHandlerError,
    describeDestructiveRequest,
    consumeDestructiveConfirmation,
    reconcileIdleSession,
    getSessionClient: runtimeContext.getSessionClient,
    getSessionV2Client: runtimeContext.getSessionV2Client,
    listRuntimeTools,
    withDiscoveredBuiltInTools: capabilityToolDiscovery.withDiscoveredBuiltInTools,
    listToolsFromMcpEntry,
    isLikelyMcpAuthError,
    authenticateNewRemoteMcpIfNeeded,
    approvedSkillImportDirectories,
    capabilityToolMethodCache,
  }

  configureSemanticUiBridge({
    actionListProvider: () => createSemanticUiLocalActionList('desktop-local'),
    actionExecutor: (actionId, input) => executeSemanticUiLocalAction(context, actionId, input),
    diagnosticsBundleBuilder: () => buildDiagnosticsBundle(),
  })
  configureKnowledgeService({
    getMainWindow,
  })

  registerIpcInvoke(context, 'confirm:request-destructive', objectArg<DestructiveConfirmationRequest>('destructive confirmation request', validateDestructiveConfirmationRequest), async (_event, request) => {
    const confirmed = await showNativeConfirmation(getMainWindow(), destructiveConfirmationPrompt(request))
    if (!confirmed) {
      log('audit', `confirmation.cancelled ${request.action} ${describeDestructiveRequest(request)}`)
      return null
    }
    const grant = destructiveConfirmations.issue(request)
    log('audit', `confirmation.issued ${request.action} ${describeDestructiveRequest(request)}`)
    return grant
  })

  getThreadIndexService().reconcileThreadIndexFromRegistry()

  registerWorkspaceHandlers(context)
  registerDesktopPairingHandlers(context)
  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerLaunchpadHandlers(context)
  registerKnowledgeHandlers(context)
  registerCoordinationHandlers(context)
  registerChannelHandlers(context)
  registerWorkflowHandlers(context)

  registerThreadHandlers(context)
  registerAdminHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
}

export { trackPermission, clearPermissionsForSession }
