import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import type {
  CapabilityToolEntry,
  DestructiveConfirmationRequest,
  RuntimeContextOptions,
  ScopedArtifactRef,
  SessionArtifactRequest,
  ToolListOptions,
} from '@open-cowork/shared'
import { isMcpAuthRequiredStatus } from '@open-cowork/shared'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { getChartArtifactsRoot } from './chart-artifacts.ts'
import {
  getClient,
  getClientForDirectory,
  getRuntimeHomeDir,
  getV2ClientForDirectory,
} from './runtime.ts'
import { getEffectiveSettings } from './settings.ts'
import { getBrandName } from './config-loader.ts'
import { log } from './logger.ts'
import { getMcpStatus } from './events.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { dispatchRuntimeSessionEvent, setSessionHistoryRefreshHandler } from './session-event-dispatcher.ts'
import { getSessionRecord, listSessionRecords } from './session-registry.ts'
import { syncSessionView } from './session-history-loader.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { isVisibleRuntimeToolId, runtimeToolId } from './runtime-tools.ts'
import { createSandboxWorkspaceDir, isSandboxWorkspaceDir } from './runtime-paths.ts'
import { createDestructiveConfirmationManager } from './destructive-actions.ts'
import { sessionEngine } from './session-engine.ts'
import { listAutomationState } from './automation-store.ts'
import { observePerf } from './perf-metrics.ts'
import { registerAppHandlers } from './ipc/app-handlers.ts'
import { registerArtifactHandlers } from './ipc/artifact-handlers.ts'
import { registerAutomationHandlers } from './ipc/automation-handlers.ts'
import { registerSessionHandlers } from './ipc/session-handlers.ts'
import { registerCatalogHandlers } from './ipc/catalog-handlers.ts'
import { registerCustomContentHandlers } from './ipc/custom-content-handlers.ts'
import { registerExplorerHandlers } from './ipc/explorer-handlers.ts'
import type { IpcHandlerContext } from './ipc/context.ts'
import { clearPermissionsForSession, trackPermission } from './permission-tracker.ts'
import { ProjectDirectoryGrantRegistry, trustedRecordDirectoryMatches } from './directory-grants.ts'
import { resolveContainedArtifactPath } from './artifact-path-policy.ts'
import { isTrustedRendererIpcUrl } from './main-window-lifecycle.ts'
import { delay } from './delay.ts'
import {
  buildCustomAgentPermission,
  createCapabilityToolDiscovery,
  isLikelyMcpAuthError,
  listToolsFromMcpEntry,
} from './capability-tool-discovery.ts'

import { RUNTIME_TOOL_CACHE_TTL_MS, runtimeToolCache } from './runtime-tool-cache.ts'
export { invalidateRuntimeToolCache } from './runtime-tool-cache.ts'

type IpcSenderEvent = IpcMainEvent | IpcMainInvokeEvent

function currentModuleDirname() {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url))
}

function expectedRendererEntryPath() {
  return join(currentModuleDirname(), '../index.html')
}

export function isTrustedIpcSenderUrl(rawUrl: string, devServerUrl = process.env.VITE_DEV_SERVER_URL) {
  return isTrustedRendererIpcUrl({
    rawUrl,
    devServerUrl,
    expectedRendererPath: expectedRendererEntryPath(),
  })
}

function assertTrustedIpcSender(event: IpcSenderEvent, channel: string) {
  const senderFrame = (event as { senderFrame?: { url?: unknown } | null }).senderFrame
  const senderUrl = typeof senderFrame?.url === 'string' ? senderFrame.url : ''
  if (isTrustedIpcSenderUrl(senderUrl)) return
  log('security', `Rejected IPC ${channel} from untrusted sender frame: ${senderUrl || 'unknown'}`)
  throw new Error('Rejected IPC request from untrusted renderer frame.')
}

export function setupIpcHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  setSessionHistoryRefreshHandler(async (sessionId: string) => {
    await syncSessionView(sessionId, {
      force: true,
      activate: false,
    })
    const record = getSessionRecord(sessionId)
    const win = getMainWindow()
    if (!record || !win || win.isDestroyed()) return
    win.webContents.send('session:updated', {
      id: record.id,
      title: record.title || null,
      parentSessionId: record.parentSessionId,
      changeSummary: record.changeSummary,
      revertedMessageId: record.revertedMessageId,
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
          assertTrustedIpcSender(args[0], channel)
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
        assertTrustedIpcSender(event, channel)
        return listener(event, ...args)
      })
    },
  } satisfies Pick<IpcMain, 'handle' | 'on'>


  const destructiveConfirmations = createDestructiveConfirmationManager()
  const capabilityToolMethodCache = new Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>()
  const approvedSkillImportDirectories = new Map<string, string>()

  const projectDirectoryGrants = new ProjectDirectoryGrantRegistry((directory) => {
    const knownSession = listSessionRecords().find((record) => (
      trustedRecordDirectoryMatches(directory, record.directory)
      || trustedRecordDirectoryMatches(directory, record.opencodeDirectory)
    ))
    if (knownSession) return 'session-record'
    const knownAutomation = listAutomationState().automations.find((automation) => (
      trustedRecordDirectoryMatches(directory, automation.projectDirectory)
    ))
    return knownAutomation ? 'automation-record' : null
  })

  function normalizeDirectory(directory?: string | null) {
    if (!directory) return createSandboxWorkspaceDir()
    return projectDirectoryGrants.resolve(directory) || createSandboxWorkspaceDir()
  }

  function ensureSessionRecord(sessionId: string) {
    return getSessionRecord(sessionId)
  }

  function resolvePrivateArtifactPath(request: SessionArtifactRequest) {
    const record = ensureSessionRecord(request.sessionId)
    if (!record) throw new Error(`Unknown ${getBrandName()} session: ${request.sessionId}`)

    const source = resolve(request.filePath)

    // Chart PNGs live outside the session's working directory so they
    // don't pollute user project dirs. Whitelist them explicitly here
    // so the standard export/reveal IPC works uniformly across file
    // artifacts and chart artifacts without forking the channel.
    const chartRoot = resolve(getChartArtifactsRoot(request.sessionId))
    if (source === chartRoot || source.startsWith(`${chartRoot}/`)) {
      return resolveContainedArtifactPath(chartRoot, source)
    }

    const root = resolve(record.opencodeDirectory || getRuntimeHomeDir())
    const privateWorkspace = root === resolve(getRuntimeHomeDir()) || isSandboxWorkspaceDir(root)
    if (!privateWorkspace) {
      throw new Error('Artifacts can only be accessed from Cowork private workspaces.')
    }

    return resolveContainedArtifactPath(root, source)
  }

  function resolveSessionRuntimeModel(sessionId: string) {
    const settings = getEffectiveSettings()
    const view = sessionEngine.getSessionView(sessionId)
    const latestModeledMessage = [...view.messages]
      .reverse()
      .find((message) => message.providerId || message.modelId) || null
    const record = ensureSessionRecord(sessionId)

    return {
      provider: latestModeledMessage?.providerId || record?.providerId || settings.effectiveProviderId || '',
      model: latestModeledMessage?.modelId || record?.modelId || settings.effectiveModel || '',
      directory: record?.opencodeDirectory || getRuntimeHomeDir(),
    }
  }

  function resolveContextDirectory(options?: RuntimeContextOptions) {
    if (options?.sessionId) {
      const record = ensureSessionRecord(options.sessionId)
      return record?.directory ? projectDirectoryGrants.resolve(record.directory) : null
    }
    return projectDirectoryGrants.resolve(options?.directory)
  }

  function resolveScopedTarget<T extends ScopedArtifactRef>(target: T): T & { directory: string | null } {
    if (target.scope === 'project') {
      const directory = projectDirectoryGrants.resolve(target.directory)
      if (!directory) {
        throw new Error('Project scope requires an active project directory.')
      }
      return { ...target, directory }
    }
    return { ...target, directory: null }
  }

  function logHandlerError(handler: string, err: unknown) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err)
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

  async function getSessionClient(sessionId: string) {
    const record = ensureSessionRecord(sessionId)
    if (!record) {
      throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)
    }
    const directory = record.opencodeDirectory || getRuntimeHomeDir()
    await ensureRuntimeContextDirectory(directory)
    const client = getClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return { client, record }
  }

  async function getSessionV2Client(sessionId: string) {
    const record = ensureSessionRecord(sessionId)
    if (!record) {
      throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)
    }
    const directory = record.opencodeDirectory || getRuntimeHomeDir()
    await ensureRuntimeContextDirectory(directory)
    const client = getV2ClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return { client, record, directory }
  }

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
      await client.mcp.auth.authenticate({ name })
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
      const sessionContext = resolveSessionRuntimeModel(options.sessionId)
      provider = options?.provider || sessionContext.provider
      model = options?.model || sessionContext.model
      directory = sessionContext.directory
    } else if (options?.directory) {
      directory = projectDirectoryGrants.resolve(options.directory) || getRuntimeHomeDir()
    }

    if (!provider || !model) return []

    const cacheKey = `${directory}|${provider}|${model}`
    const now = Date.now()
    const cached = runtimeToolCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return cached.tools
    }

    await ensureRuntimeContextDirectory(directory)

    const client = getV2ClientForDirectory(directory)
    if (!client) return []

    try {
      const result = await client.tool.list({
        directory,
        provider,
        model,
      }, {
        throwOnError: true,
      })
      const tools = (result.data || []).filter((entry) => isVisibleRuntimeToolId(runtimeToolId(entry)))
      runtimeToolCache.set(cacheKey, { expiresAt: now + RUNTIME_TOOL_CACHE_TTL_MS, tools })
      return tools
    } catch (err) {
      logHandlerError('tool:list', err)
      return []
    }
  }

  const capabilityToolDiscovery = createCapabilityToolDiscovery({
    resolveContextDirectory,
    logHandlerError,
    capabilityToolMethodCache,
  })

  const context: IpcHandlerContext = {
    ipcMain: instrumentedIpcMain,
    getMainWindow,
    normalizeDirectory,
    ensureSessionRecord,
    resolvePrivateArtifactPath,
    grantProjectDirectory: (directory) => projectDirectoryGrants.grant(directory),
    resolveGrantedProjectDirectory: (directory) => projectDirectoryGrants.resolve(directory),
    resolveContextDirectory,
    resolveScopedTarget,
    buildCustomAgentPermission,
    logHandlerError,
    describeDestructiveRequest,
    consumeDestructiveConfirmation,
    reconcileIdleSession,
    getSessionClient,
    getSessionV2Client,
    listRuntimeTools,
    withDiscoveredBuiltInTools: capabilityToolDiscovery.withDiscoveredBuiltInTools,
    listToolsFromMcpEntry,
    isLikelyMcpAuthError,
    authenticateNewRemoteMcpIfNeeded,
    approvedSkillImportDirectories,
    capabilityToolMethodCache,
  }

  instrumentedIpcMain.handle('confirm:request-destructive', async (_event, request: DestructiveConfirmationRequest) => {
    const grant = destructiveConfirmations.issue(request)
    log('audit', `confirmation.issued ${request.action} ${describeDestructiveRequest(request)}`)
    return grant
  })

  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerAutomationHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
}

export { trackPermission, clearPermissionsForSession }
