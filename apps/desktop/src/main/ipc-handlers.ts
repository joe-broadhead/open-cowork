import type { BrowserWindow, IpcMain } from 'electron'
import type {
  CapabilityTool,
  CapabilityToolEntry,
  CustomAgentConfig,
  DestructiveConfirmationRequest,
  RuntimeContextOptions,
  ScopedArtifactRef,
  SessionArtifactRequest,
  ToolListOptions,
} from '@open-cowork/shared'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import {
  getClient,
  getClientForDirectory,
  getRuntimeHomeDir,
  getV2ClientForDirectory,
} from './runtime.ts'
import { getEffectiveSettings } from './settings.ts'
import { log } from './logger.ts'
import { getMcpStatus } from './events.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { dispatchRuntimeSessionEvent, setSessionHistoryRefreshHandler } from './session-event-dispatcher.ts'
import { getCustomAgentCatalog } from './custom-agents.ts'
import { listBuiltInAgentDetails } from './agent-config.ts'
import { getSessionRecord } from './session-registry.ts'
import { syncSessionView } from './session-history-loader.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { humanizeToolId, isVisibleRuntimeToolId, runtimeToolId } from './runtime-tools.ts'
import { validateCustomMcpStdioCommand } from './mcp-stdio-policy.ts'
import { createSandboxWorkspaceDir, isSandboxWorkspaceDir } from './runtime-paths.ts'
import { listCustomMcps } from './native-customizations.ts'
import { createDestructiveConfirmationManager } from './destructive-actions.ts'
import { sessionEngine } from './session-engine.ts'
import {
  type ResolvedRuntimeMcpEntry,
  resolveConfiguredMcpRuntimeEntry,
  resolveCustomMcpRuntimeEntry,
} from './runtime-mcp.ts'
import { registerAppHandlers } from './ipc/app-handlers.ts'
import { registerArtifactHandlers } from './ipc/artifact-handlers.ts'
import { registerSessionHandlers } from './ipc/session-handlers.ts'
import { registerCatalogHandlers } from './ipc/catalog-handlers.ts'
import { registerCustomContentHandlers } from './ipc/custom-content-handlers.ts'
import type { IpcHandlerContext } from './ipc/context.ts'
import { clearPermissionsForSession, trackPermission } from './permission-tracker.ts'

export function setupIpcHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  setSessionHistoryRefreshHandler(async (sessionId: string) => {
    await syncSessionView(sessionId, {
      force: true,
      activate: false,
    })
  })

  const destructiveConfirmations = createDestructiveConfirmationManager()
  const capabilityToolMethodCache = new Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>()
  const approvedSkillImportDirectories = new Map<string, string>()

  function normalizeDirectory(directory?: string | null) {
    return directory ? resolve(directory) : createSandboxWorkspaceDir()
  }

  function ensureSessionRecord(sessionId: string) {
    return getSessionRecord(sessionId)
  }

  function resolvePrivateArtifactPath(request: SessionArtifactRequest) {
    const record = ensureSessionRecord(request.sessionId)
    if (!record) throw new Error(`Unknown Open Cowork session: ${request.sessionId}`)

    const root = resolve(record.opencodeDirectory || getRuntimeHomeDir())
    const privateWorkspace = root === resolve(getRuntimeHomeDir()) || isSandboxWorkspaceDir(root)
    if (!privateWorkspace) {
      throw new Error('Artifacts can only be accessed from Cowork private workspaces.')
    }

    const source = resolve(request.filePath)
    if (!(source === root || source.startsWith(`${root}/`))) {
      throw new Error('Artifact path is outside the current private workspace.')
    }
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error('Artifact file is no longer available.')
    }

    return { root, source }
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
      return record?.directory || null
    }
    return options?.directory ? resolve(options.directory) : null
  }

  function resolveScopedTarget<T extends ScopedArtifactRef>(target: T): T & { directory: string | null } {
    if (target.scope === 'project') {
      const directory = target.directory ? resolve(target.directory) : null
      if (!directory) {
        throw new Error('Project scope requires an active project directory.')
      }
      return { ...target, directory }
    }
    return { ...target, directory: null }
  }

  async function buildCustomAgentPermission(agent: CustomAgentConfig, options?: RuntimeContextOptions) {
    const catalog = await getCustomAgentCatalog(options)
    const selectedTools = catalog.tools.filter((tool) => agent.toolIds.includes(tool.id))
    const allowPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.allowPatterns)))
    const askPatterns = Array.from(new Set(selectedTools.flatMap((tool) => tool.askPatterns)))

    const permission: Record<string, unknown> = {}
    if ((agent.skillNames || []).length > 0) {
      permission.skill = Object.fromEntries((agent.skillNames || []).map((name) => [name, 'allow']))
    }

    for (const pattern of allowPatterns) permission[pattern] = 'allow'
    for (const pattern of askPatterns) permission[pattern] = 'ask'
    return permission
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
      throw new Error(`Unknown Open Cowork session: ${sessionId}`)
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
      throw new Error(`Unknown Open Cowork session: ${sessionId}`)
    }
    const directory = record.opencodeDirectory || getRuntimeHomeDir()
    await ensureRuntimeContextDirectory(directory)
    const client = getV2ClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return { client, record, directory }
  }

  function capabilityToolPrefixes(tool: CapabilityTool) {
    const prefixes = new Set<string>()

    if (tool.namespace) {
      prefixes.add(`mcp__${tool.namespace}__`)
      prefixes.add(`${tool.namespace}_`)
    }

    prefixes.add(`mcp__${tool.id}__`)
    prefixes.add(`${tool.id}_`)

    return Array.from(prefixes)
  }

  function runtimeToolMatchesCapability(entry: unknown, tool: CapabilityTool) {
    const id = runtimeToolId(entry)
    if (!id) return false
    if (id === tool.id) return true
    return capabilityToolPrefixes(tool).some((prefix) => id.startsWith(prefix))
  }

  function isMcpBackedCapability(tool: CapabilityTool) {
    return Boolean(tool.namespace) || tool.patterns.some((pattern) => pattern.startsWith('mcp__'))
  }

  async function listToolsFromMcpEntry(entry: unknown) {
    if (!entry) return []

    const runtimeEntry = entry as ResolvedRuntimeMcpEntry
    const client = new McpClient(
      { name: 'open-cowork-capabilities', version: '1.0.0' },
      { capabilities: {} },
    )

    if (runtimeEntry.type === 'local') {
      const [command, ...args] = runtimeEntry.command
      if (!command) return []
      const transport = new StdioClientTransport({
        command,
        args,
        env: runtimeEntry.environment,
        stderr: 'pipe',
      })
      await client.connect(transport)
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(runtimeEntry.url), {
        requestInit: runtimeEntry.headers
          ? { headers: runtimeEntry.headers }
          : undefined,
      })
      await client.connect(transport)
    }

    try {
      const result = await client.listTools()
      return (result.tools || []).map((tool: { name: string; description?: string }) => ({
        id: tool.name,
        description: tool.description?.trim() || 'No description available for this MCP method.',
      }))
    } finally {
      await client.close().catch(() => {})
    }
  }

  function isLikelyMcpAuthError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || '')
    return /missing authorization header|invalid_token|unauthorized|401|needs_auth|oauth/i.test(message)
  }

  function wait(ms: number) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
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
      await wait(500)
    }
    return null
  }

  async function authenticateNewRemoteMcpIfNeeded(name: string) {
    const status = await waitForMcpStatus(name)
    if (!status) return
    if (status.rawStatus !== 'needs_auth' && status.rawStatus !== 'needs_client_registration') return

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

  async function discoverCapabilityToolEntries(tool: CapabilityTool, options?: RuntimeContextOptions) {
    if (!isMcpBackedCapability(tool)) return tool.availableTools || []

    const cacheKey = `${tool.source}:${tool.id}:${tool.namespace || ''}:${resolveContextDirectory(options) || 'machine'}`
    const cached = capabilityToolMethodCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.entries
    }

    const settings = getEffectiveSettings()
    const builtinEntry = tool.source === 'builtin'
      ? resolveConfiguredMcpRuntimeEntry(tool.namespace || tool.id, settings)
      : null
    const matchingCustomMcp = tool.source === 'custom'
      ? listCustomMcps(options).find((entry) => entry.name === tool.id || entry.name === tool.namespace) || null
      : null
    const customEntry = matchingCustomMcp
      ? resolveCustomMcpRuntimeEntry(matchingCustomMcp)
      : null

    if (matchingCustomMcp?.type === 'stdio') {
      try {
        validateCustomMcpStdioCommand(matchingCustomMcp)
      } catch (error) {
        logHandlerError(`capability:mcp-tools ${tool.id}`, error)
        return []
      }
    }

    const shouldSkipDirectProbe = Boolean(
      matchingCustomMcp
      && matchingCustomMcp.type === 'http'
      && (!matchingCustomMcp.headers || Object.keys(matchingCustomMcp.headers).length === 0),
    )
    if (shouldSkipDirectProbe) return []

    const entries = await listToolsFromMcpEntry(builtinEntry || customEntry).catch((error) => {
      logHandlerError(`capability:mcp-tools ${tool.id}`, error)
      return []
    })

    capabilityToolMethodCache.set(cacheKey, {
      expiresAt: Date.now() + 30_000,
      entries,
    })

    return entries
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
      directory = normalizeDirectory(options.directory)
    }

    if (!provider || !model) return []

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
      return (result.data || []).filter((entry) => isVisibleRuntimeToolId(runtimeToolId(entry)))
    } catch (err) {
      logHandlerError('tool:list', err)
      return []
    }
  }

  async function withDiscoveredBuiltInTools(tools: CapabilityTool[], runtimeTools: unknown[], options?: RuntimeContextOptions) {
    const builtInAgentDetails = listBuiltInAgentDetails()
    const nativeToolEntries = new Map<string, CapabilityTool>()

    for (const entry of runtimeTools) {
      const id = runtimeToolId(entry)
      if (!id) continue
      if (!isVisibleRuntimeToolId(id)) continue
      if (id.startsWith('mcp__')) continue
      if (tools.some((tool) => runtimeToolMatchesCapability(entry, tool))) continue

      const agentNames = builtInAgentDetails
        .filter((agent) => agent.nativeToolIds.includes(id))
        .map((agent) => agent.label)

      nativeToolEntries.set(id, {
        id,
        name: humanizeToolId(id),
        description: typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
          ? (entry as { description?: string }).description!.trim()
          : 'Native OpenCode tool available in the current runtime context.',
        kind: 'built-in',
        source: 'builtin',
        origin: 'opencode',
        namespace: null,
        patterns: [id],
        availableTools: [
          {
            id,
            description: typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
              ? (entry as { description?: string }).description!.trim()
              : 'Native OpenCode tool available in the current runtime context.',
          },
        ],
        agentNames,
      })
    }

    const combined = [...tools, ...nativeToolEntries.values()].sort((a, b) => a.name.localeCompare(b.name))

    return Promise.all(combined.map(async (tool) => {
      const runtimeEntries = runtimeTools
        .filter((entry) => runtimeToolMatchesCapability(entry, tool))
        .map((entry) => ({
          id: runtimeToolId(entry),
          description: typeof (entry as { description?: string })?.description === 'string' && (entry as { description?: string }).description!.trim().length > 0
            ? (entry as { description?: string }).description!.trim()
            : 'No description available for this MCP method.',
        }))
        .filter((entry): entry is CapabilityToolEntry => Boolean(entry.id))

      if (runtimeEntries.length > 0) {
        return { ...tool, availableTools: runtimeEntries }
      }

      if (!isMcpBackedCapability(tool)) {
        return tool
      }

      const fallbackEntries = await discoverCapabilityToolEntries(tool, options)
      if (fallbackEntries.length > 0) {
        return { ...tool, availableTools: fallbackEntries }
      }

      return tool
    }))
  }

  const context: IpcHandlerContext = {
    ipcMain,
    getMainWindow,
    normalizeDirectory,
    ensureSessionRecord,
    resolvePrivateArtifactPath,
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
    withDiscoveredBuiltInTools,
    listToolsFromMcpEntry,
    isLikelyMcpAuthError,
    authenticateNewRemoteMcpIfNeeded,
    approvedSkillImportDirectories,
    capabilityToolMethodCache,
  }

  ipcMain.handle('confirm:request-destructive', async (_event, request: DestructiveConfirmationRequest) => {
    const grant = destructiveConfirmations.issue(request)
    log('audit', `confirmation.issued ${request.action} ${describeDestructiveRequest(request)}`)
    return grant
  })

  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
}

export { trackPermission, clearPermissionsForSession }
