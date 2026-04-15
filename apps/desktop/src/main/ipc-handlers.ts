import type { IpcMain, BrowserWindow } from 'electron'
import type {
  CapabilityTool,
  CapabilityToolEntry,
  CustomAgentConfig,
  CustomMcpConfig,
  CustomSkillConfig,
  ToolListOptions,
  CustomMcpTestResult,
  RuntimeContextOptions,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'
import {
  getClient,
  getClientForDirectory,
  getModelInfo,
  getRuntimeHomeDir,
  getV2ClientForDirectory,
  resolveConfiguredMcpRuntimeEntry,
  resolveCustomMcpRuntimeEntry,
} from './runtime'
import { getEffectiveSettings, saveSettings, loadSettings, isSetupComplete, type CoworkSettings } from './settings'
import { getAuthState, loginWithGoogle, getCachedAccessToken } from './auth'
import { log } from './logger'
import { getMcpStatus, trackParentSession, removeParentSession } from './events'
import { shortSessionId } from './log-sanitizer'
import { isInternalCoworkMessage } from './internal-message-utils'
import { syncSessionView } from './session-history-loader'
import { rejectQuestion, replyToQuestion } from './question-client'
import { dispatchRuntimeSessionEvent, publishSessionView, setSessionHistoryRefreshHandler } from './session-event-dispatcher.ts'
import { getCustomAgentCatalog, getCustomAgentSummaries, normalizeCustomAgent, validateCustomAgent } from './custom-agents'
import { listBuiltInAgentDetails } from './agent-config'
import { normalizeProviderListResponse } from './provider-utils'
import { sessionEngine } from './session-engine'
import { getPerfSnapshot } from './perf-metrics.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from './session-status-reconciler.ts'
import {
  getSessionRecord,
  listSessionRecords,
  removeSessionRecord,
  toRendererSession,
  toSessionRecord,
  touchSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from './session-registry'
import { toIsoTimestamp } from './task-run-utils'
import { getConfigError, getPublicAppConfig } from './config-loader'
import { getRuntimeStatus } from './runtime-status'
import { getCapabilitySkillBundle, getCapabilityTool, listCapabilitySkills, listCapabilityTools } from './capability-catalog.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { humanizeToolId, runtimeToolId } from './runtime-tools.ts'
import {
  listCustomAgents,
  listCustomMcps,
  listCustomSkills,
  readSkillBundleDirectory,
  removeCustomAgent,
  removeCustomMcp,
  removeCustomSkill,
  saveCustomAgent,
  saveCustomMcp,
  saveCustomSkill,
} from './native-customizations.ts'

export function setupIpcHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  setSessionHistoryRefreshHandler(async (sessionId: string) => {
    await syncSessionView(sessionId, { force: true, activate: false })
  })

  function normalizeDirectory(directory?: string | null) {
    return directory ? resolve(directory) : getRuntimeHomeDir()
  }

  function ensureSessionRecord(sessionId: string) {
    return getSessionRecord(sessionId)
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

  function resolveScopedTarget(target: ScopedArtifactRef) {
    if (target.scope === 'project') {
      const directory = target.directory ? resolve(target.directory) : null
      if (!directory) {
        throw new Error('Project scope requires an active project directory.')
      }
      return { ...target, directory }
    }

    return {
      ...target,
      directory: null,
    }
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

    for (const pattern of allowPatterns) {
      permission[pattern] = 'allow'
    }
    for (const pattern of askPatterns) {
      permission[pattern] = 'ask'
    }

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
    const directory = record?.opencodeDirectory || getRuntimeHomeDir()
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

  function runtimeToolMatchesCapability(entry: any, tool: CapabilityTool) {
    const id = runtimeToolId(entry)
    if (!id) return false
    if (id === tool.id) return true
    return capabilityToolPrefixes(tool).some((prefix) => id.startsWith(prefix))
  }

  const capabilityToolMethodCache = new Map<string, { expiresAt: number; entries: CapabilityToolEntry[] }>()

  function isMcpBackedCapability(tool: CapabilityTool) {
    return Boolean(tool.namespace) || tool.patterns.some((pattern) => pattern.startsWith('mcp__'))
  }

  async function listToolsFromMcpEntry(entry: ReturnType<typeof resolveConfiguredMcpRuntimeEntry> | ReturnType<typeof resolveCustomMcpRuntimeEntry>) {
    if (!entry) return []

    const client = new McpClient(
      { name: 'open-cowork-capabilities', version: '1.0.0' },
      { capabilities: {} },
    )

    if (entry.type === 'local') {
      const [command, ...args] = entry.command
      if (!command) return []
      const transport = new StdioClientTransport({
        command,
        args,
        env: entry.environment,
        stderr: 'pipe',
      })
      await client.connect(transport)
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: entry.headers
          ? { headers: entry.headers }
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
    return new Promise((resolve) => setTimeout(resolve, ms))
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
      await client.mcp.auth.authenticate({
        path: { name },
      })
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
      return result.data || []
    } catch (err) {
      logHandlerError('tool:list', err)
      return []
    }
  }

  async function withDiscoveredBuiltInTools(tools: CapabilityTool[], runtimeTools: any[], options?: RuntimeContextOptions) {
    const builtInAgentDetails = listBuiltInAgentDetails()
    const nativeToolEntries = new Map<string, CapabilityTool>()

    for (const entry of runtimeTools) {
      const id = runtimeToolId(entry)
      if (!id) continue
      if (id.startsWith('mcp__')) continue
      if (tools.some((tool) => runtimeToolMatchesCapability(entry, tool))) continue

      const agentNames = builtInAgentDetails
        .filter((agent) => agent.nativeToolIds.includes(id))
        .map((agent) => agent.label)

      nativeToolEntries.set(id, {
        id,
        name: humanizeToolId(id),
        description: typeof entry?.description === 'string' && entry.description.trim().length > 0
          ? entry.description.trim()
          : 'Native OpenCode tool available in the current runtime context.',
        kind: 'built-in',
        source: 'builtin',
        origin: 'opencode',
        namespace: null,
        patterns: [id],
        availableTools: [
          {
            id,
            description: typeof entry?.description === 'string' && entry.description.trim().length > 0
              ? entry.description.trim()
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
          description: typeof entry?.description === 'string' && entry.description.trim().length > 0
            ? entry.description.trim()
            : 'No description available for this MCP method.',
        }))
        .filter((entry) => entry.id)

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

  // Auth handlers
  ipcMain.handle('auth:status', async () => {
    return getAuthState()
  })

  ipcMain.handle('auth:login', async () => {
    log('auth', 'User initiated login')
    const state = await loginWithGoogle()
    if (state.authenticated && isSetupComplete()) {
      log('auth', 'Login completed')
      const token = getCachedAccessToken()
      if (token) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
      const { bootRuntime } = await import('./index')
      await bootRuntime()
    }
    return state
  })

  ipcMain.handle('app:config', async () => {
    return getPublicAppConfig()
  })

  ipcMain.handle('settings:get', async () => {
    return getEffectiveSettings()
  })

  ipcMain.handle('settings:set', async (_event, updates: Partial<CoworkSettings>) => {
    const result = saveSettings(updates)
    const runtimeSensitiveUpdate = Boolean(
      updates.selectedProviderId !== undefined
      || updates.selectedModelId !== undefined
      || updates.providerCredentials !== undefined
      || updates.integrationCredentials !== undefined
      || updates.enableBash !== undefined
      || updates.enableFileWrite !== undefined,
    )

    if (isSetupComplete(result)) {
      const activeClient = getClient()
      if (activeClient && runtimeSensitiveUpdate) {
        const { rebootRuntime } = await import('./index')
        await rebootRuntime()
      } else if (!activeClient) {
        const { bootRuntime } = await import('./index')
        await bootRuntime()
      }
    }

    return result
  })

  ipcMain.handle('model:info', async () => {
    return getModelInfo()
  })

  ipcMain.handle('provider:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.provider.list()
      const raw = result.data as any
      const data = normalizeProviderListResponse(raw)
      log('provider', `Listed ${data.length} providers: ${data.map((p: any) => `${p.id || p.name}(${Object.keys(p.models || {}).length} models)`).join(', ')}`)
      return data
    } catch (err: any) {
      log('error', `Provider list failed: ${err?.message}`)
      return []
    }
  })

  ipcMain.handle('runtime:status', async () => {
    const status = getRuntimeStatus()
    return {
      ...status,
      error: status.error || getConfigError(),
    }
  })

  ipcMain.handle('diagnostics:perf', async () => {
    return getPerfSnapshot()
  })

  ipcMain.handle('session:create', async (_event, directory?: string) => {
    const opencodeDirectory = normalizeDirectory(directory)
    await ensureRuntimeContextDirectory(opencodeDirectory)
    const client = getClientForDirectory(opencodeDirectory)
    if (!client) throw new Error('Runtime not started')
    const settings = getEffectiveSettings()

    log('session', 'Creating new session')
    const result = await client.session.create({
      throwOnError: true,
    })
    const session = result.data as any
    log('session', `Created session ${shortSessionId(session.id)}`)
    trackParentSession(session.id)
    const record = upsertSessionRecord(
      toSessionRecord({
        id: session.id,
        title: session.title || 'New session',
        createdAt: toIsoTimestamp(session.time?.created),
        updatedAt: toIsoTimestamp(session.time?.updated || session.time?.created),
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
          directory: opencodeDirectory === getRuntimeHomeDir() ? null : opencodeDirectory,
          createdAt: toIsoTimestamp(session.time?.created),
          updatedAt: toIsoTimestamp(session.time?.updated || session.time?.created),
        }
  })

  ipcMain.handle('dialog:select-directory', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Project Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('session:prompt', async (_event, sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string) => {
    const { client } = await getSessionClient(sessionId)
    const requestedAgent = agent || 'build'
    const settings = getEffectiveSettings()
    const parts: any[] = []
    if (attachments) {
      for (const a of attachments) {
        parts.push({ type: 'file', mime: a.mime, url: a.url, filename: a.filename })
      }
    }
    parts.push({ type: 'text', text })

    trackParentSession(sessionId)
    touchSessionRecord(sessionId)
    updateSessionRecord(sessionId, {
      providerId: settings.effectiveProviderId || null,
      modelId: settings.effectiveModel || null,
      updatedAt: new Date().toISOString(),
    })
    log('prompt', `Sending prompt to ${shortSessionId(sessionId)} attachments=${attachments?.length || 0} agent=${requestedAgent}`)
    try {
      const win = getMainWindow()
      const optimisticMessageId = crypto.randomUUID()
      dispatchRuntimeSessionEvent(win, {
        type: 'text',
        sessionId,
        data: {
          type: 'text',
          role: 'user',
          content: text,
          attachments: attachments || [],
          mode: 'replace',
          messageId: optimisticMessageId,
          partId: `${optimisticMessageId}:part:0`,
        },
      })
      dispatchRuntimeSessionEvent(win, {
        type: 'busy',
        sessionId,
        data: { type: 'busy' },
      })

      await client.session.promptAsync({
        throwOnError: true,
        path: { id: sessionId },
        body: { parts, agent: requestedAgent },
      })

      startSessionStatusReconciliation(sessionId, {
        getMainWindow,
        onIdle: (_win, reconciledSessionId) => {
          reconcileIdleSession(reconciledSessionId)
        },
      })
    } catch (err) {
      const win = getMainWindow()
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
      logHandlerError(`session:prompt ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  ipcMain.handle('session:activate', async (_event, sessionId: string, options?: { force?: boolean }) => {
    try {
      const view = await syncSessionView(sessionId, {
        force: options?.force,
        activate: true,
      })
      if (view.isGenerating) {
        startSessionStatusReconciliation(sessionId, {
          getMainWindow,
          onIdle: (_win, reconciledSessionId) => {
            reconcileIdleSession(reconciledSessionId)
          },
        })
      }
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        publishSessionView(win, sessionId)
      }
      return view
    } catch (err) {
      logHandlerError(`session:activate ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  ipcMain.handle('session:list', async () => {
    return listSessionRecords().map(toRendererSession)
  })

  ipcMain.handle('session:get', async (_event, id: string) => {
    const record = ensureSessionRecord(id)
    if (!record) return null
    try {
      const client = getClientForDirectory(record.opencodeDirectory)
      if (!client) return toRendererSession(record)
      const result = await client.session.get({ path: { id } })
      const s = result.data as any
      if (!s) return null
      const updated = updateSessionRecord(id, {
        title: s.title,
        updatedAt: toIsoTimestamp(s.time?.updated || s.time?.created),
      })
      return updated ? toRendererSession(updated) : toRendererSession(record)
    } catch (err) {
      logHandlerError(`session:get ${shortSessionId(id)}`, err)
      return null
    }
  })

  ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    log('session', `Aborting ${shortSessionId(sessionId)}`)
    stopSessionStatusReconciliation(sessionId)
    const win = getMainWindow()
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
    try { await client.session.abort({ path: { id: sessionId } }) } catch (e: any) { log('error', `Abort: ${e?.message}`) }
  })

  ipcMain.handle('session:fork', async (_event, sessionId: string, messageId?: string) => {
    const { client, record } = await getSessionClient(sessionId)
    try {
      const result = await client.session.fork({
        path: { id: sessionId },
        body: messageId ? { messageID: messageId } : {},
      })
      const s = result.data as any
      if (!s) return null
      log('session', `Forked ${shortSessionId(sessionId)} -> ${shortSessionId(s.id)}${messageId ? ' at message' : ''}`)
      trackParentSession(s.id)
      const forked = upsertSessionRecord(
        toSessionRecord({
          id: s.id,
          title: s.title || 'Forked thread',
          createdAt: toIsoTimestamp(s.time?.created),
          updatedAt: toIsoTimestamp(s.time?.updated || s.time?.created),
          opencodeDirectory: record?.opencodeDirectory || getRuntimeHomeDir(),
          providerId: record?.providerId || getEffectiveSettings().effectiveProviderId || null,
          modelId: record?.modelId || getEffectiveSettings().effectiveModel || null,
        }),
      )
      return forked
        ? toRendererSession(forked)
        : {
            id: s.id,
            title: s.title || 'Forked thread',
            directory: record?.directory || null,
            createdAt: toIsoTimestamp(s.time?.created),
            updatedAt: toIsoTimestamp(s.time?.updated || s.time?.created),
          }
    } catch (err: any) {
      log('error', `Fork failed: ${err?.message}`)
      return null
    }
  })

  ipcMain.handle('session:export', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const session = await client.session.get({ path: { id: sessionId } })
      const s = session.data as any
      const messagesResult = await client.session.messages({ throwOnError: true, path: { id: sessionId } })
      const messages = messagesResult.data as any[]
      if (!messages) return null

      let md = `# ${s?.title || 'Thread'}\n\n`
      md += `_Exported from Open Cowork_\n\n---\n\n`
      for (const msg of messages) {
        let text = ''
        const parts = msg.parts || []
        for (const part of parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text || isInternalCoworkMessage(text)) continue
        if (msg.role === 'user') {
          md += `## User\n\n${text}\n\n`
        } else {
          md += `## Assistant\n\n${text}\n\n`
        }
      }
      return md
    } catch (err) {
      logHandlerError(`session:export ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  ipcMain.handle('session:share', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.share({ path: { id: sessionId } })
      const data = result.data as any
      // Response may be the session object with a share.url field, or a string URL
      const url = data?.share?.url || data?.url || (typeof data === 'string' ? data : null)
      log('session', `Shared ${shortSessionId(sessionId)} hasUrl=${!!url}`)
      return url
    } catch (err: any) {
      log('error', `Share failed: ${err?.message}`)
      return null
    }
  })

  ipcMain.handle('session:unshare', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.unshare({ path: { id: sessionId } })
      log('session', `Unshared ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:unshare ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:summarize', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      // Get the first user message and first assistant response as preview
      const result = await client.session.messages({ path: { id: sessionId } })
      const messages = (result.data as any[]) || []
      let userMsg = ''
      let assistantMsg = ''
      for (const msg of messages) {
        const info = msg.info || msg
        const parts = msg.parts || []
        let text = ''
        for (const part of parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text) continue
        if (info.role === 'user' && !userMsg) userMsg = text.slice(0, 100)
        if (info.role === 'assistant' && !assistantMsg) { assistantMsg = text.slice(0, 200); break }
      }
      return assistantMsg || userMsg || null
    } catch (err) {
      logHandlerError(`session:summarize ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  ipcMain.handle('session:revert', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.revert({ path: { id: sessionId } })
      log('session', `Reverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:revert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:unrevert', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.unrevert({ path: { id: sessionId } })
      log('session', `Unreverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:unrevert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:children', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.children({ path: { id: sessionId } })
      return result.data || []
    } catch (err) {
      logHandlerError(`session:children ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  ipcMain.handle('session:diff', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.diff({ path: { id: sessionId } })
      return result.data || []
    } catch (err) {
      logHandlerError(`session:diff ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  ipcMain.handle('tool:list', async (_event, options?: ToolListOptions) => {
    return listRuntimeTools(options)
  })

  ipcMain.handle('command:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.command.list()
      return (result.data as any[]) || []
    } catch (err) {
      logHandlerError('command:list', err)
      return []
    }
  })

  ipcMain.handle('command:run', async (_event, sessionId: string, commandName: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      trackParentSession(sessionId)
      await client.session.command({ path: { id: sessionId }, body: { name: commandName } as any })
      touchSessionRecord(sessionId)
      return true
    } catch (err) {
      logHandlerError(`command:run ${shortSessionId(sessionId)}:${commandName}`, err)
      return false
    }
  })

  ipcMain.handle('session:rename', async (_event, sessionId: string, title: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.update({ path: { id: sessionId }, body: { title } })
      log('session', `Renamed ${shortSessionId(sessionId)}`)
      updateSessionRecord(sessionId, { title, updatedAt: new Date().toISOString() })
      return true
    } catch (err) {
      logHandlerError(`session:rename ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:delete', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.delete({ path: { id: sessionId } })
      clearPermissionsForSession(sessionId)
      removeParentSession(sessionId)
      removeSessionRecord(sessionId)
      sessionEngine.removeSession(sessionId)
      log('session', `Deleted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:delete ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('permission:respond', async (_event, permissionId: string, allowed: boolean) => {
    const sessionId = permissionSessionMap.get(permissionId)
    if (!sessionId) throw new Error(`No session for permission ${permissionId}`)
    const { client } = await getSessionV2Client(sessionId)

    log('permission', `${allowed ? 'Approved' : 'Denied'} ${permissionId}`)
    await client.permission.reply({
      requestID: permissionId,
      reply: allowed ? 'once' : 'reject',
    }, {
      throwOnError: true,
    })
    permissionSessionMap.delete(permissionId)
    const resolvedSessionId = sessionEngine.resolveApproval(permissionId)
    const win = getMainWindow()
    if (resolvedSessionId && win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'approval_resolved',
        sessionId: resolvedSessionId,
        data: { type: 'approval_resolved', id: permissionId },
      })
    }
  })

  ipcMain.handle('question:reply', async (_event, sessionId: string, requestId: string, answers: string[][]) => {
    const { client } = await getSessionV2Client(sessionId)
    await replyToQuestion(client, requestId, answers)
    startSessionStatusReconciliation(sessionId, {
      getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  ipcMain.handle('question:reject', async (_event, sessionId: string, requestId: string) => {
    const { client } = await getSessionV2Client(sessionId)
    await rejectQuestion(client, requestId)
    startSessionStatusReconciliation(sessionId, {
      getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  // MCP auth — triggers browser-based OAuth flow
  ipcMain.handle('mcp:auth', async (_event, mcpName: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')

    log('mcp', `Triggering OAuth for ${mcpName}`)
    try {
      await client.mcp.auth.authenticate({
        path: { name: mcpName },
      })
      log('mcp', `OAuth complete for ${mcpName}`)
      return true
    } catch (err: any) {
      log('error', `MCP auth failed for ${mcpName}: ${err?.message}`)
      return false
    }
  })

  // MCP connect/disconnect — live toggle without restart
  ipcMain.handle('mcp:connect', async (_event, name: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')
    try {
      await client.mcp.connect({ path: { name } })
      log('mcp', `Connected: ${name}`)
      return true
    } catch (err: any) {
      log('error', `MCP connect failed for ${name}: ${err?.message}`)
      return false
    }
  })

  ipcMain.handle('mcp:disconnect', async (_event, name: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')
    try {
      await client.mcp.disconnect({ path: { name } })
      log('mcp', `Disconnected: ${name}`)
      return true
    } catch (err: any) {
      log('error', `MCP disconnect failed for ${name}: ${err?.message}`)
      return false
    }
  })

  ipcMain.handle('app:builtin-agents', async () => {
    return listBuiltInAgentDetails()
  })

  ipcMain.handle('agents:catalog', async (_event, options?: RuntimeContextOptions) => {
    const context = {
      ...options,
      directory: resolveContextDirectory(options),
    }
    return await getCustomAgentCatalog(context)
  })

  ipcMain.handle('agents:list', async (_event, options?: RuntimeContextOptions) => {
    const context = {
      ...options,
      directory: resolveContextDirectory(options),
    }
    return await getCustomAgentSummaries(context)
  })

  ipcMain.handle('agents:create', async (_event, agent: CustomAgentConfig) => {
    const normalized = normalizeCustomAgent(agent)
    const context = {
      directory: agent.scope === 'project' ? resolveScopedTarget(agent).directory : null,
    }
    const catalog = await getCustomAgentCatalog(context)
    const siblingNames = listCustomAgents(context).map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom agent')
    }

    saveCustomAgent(normalized, await buildCustomAgentPermission(normalized, context))
    log('agent', `Added custom agent: ${normalized.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('agents:update', async (_event, target: ScopedArtifactRef, agent: CustomAgentConfig) => {
    const normalized = normalizeCustomAgent(agent)
    const resolvedTarget = resolveScopedTarget(target)
    const context = {
      directory: normalized.scope === 'project' ? resolveScopedTarget(normalized).directory : resolvedTarget.directory,
    }
    const catalog = await getCustomAgentCatalog(context)
    const siblingNames = listCustomAgents(context)
      .filter((entry) => !(entry.name === resolvedTarget.name && entry.scope === resolvedTarget.scope && (entry.directory || null) === (resolvedTarget.directory || null)))
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom agent')
    }

    removeCustomAgent(resolvedTarget)
    saveCustomAgent(normalized, await buildCustomAgentPermission(normalized, context))
    log('agent', `Updated custom agent: ${resolvedTarget.name} -> ${normalized.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('agents:remove', async (_event, target: ScopedArtifactRef) => {
    const resolvedTarget = resolveScopedTarget(target)
    removeCustomAgent(resolvedTarget)
    log('agent', `Removed custom agent: ${resolvedTarget.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  // Session todos
  ipcMain.handle('session:todo', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.todo({ path: { id: sessionId } })
      return result.data || []
    } catch (err) {
      logHandlerError(`session:todo ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  ipcMain.handle('capabilities:tools', async (_event, options?: ToolListOptions) => {
    const runtimeTools = await listRuntimeTools(options)
    const context = {
      sessionId: options?.sessionId,
      directory: resolveContextDirectory(options),
    }
    return withDiscoveredBuiltInTools(listCapabilityTools(context), runtimeTools, context)
  })

  ipcMain.handle('capabilities:tool', async (_event, id: string, options?: ToolListOptions) => {
    const runtimeTools = await listRuntimeTools(options)
    const context = {
      sessionId: options?.sessionId,
      directory: resolveContextDirectory(options),
    }
    return (await withDiscoveredBuiltInTools(listCapabilityTools(context), runtimeTools, context)).find((tool) => tool.id === id)
      || getCapabilityTool(id, context)
  })

  ipcMain.handle('capabilities:skills', async (_event, options?: RuntimeContextOptions) => {
    const context = {
      ...options,
      directory: resolveContextDirectory(options),
    }
    return await listCapabilitySkills(context)
  })

  ipcMain.handle('capabilities:skill-bundle', async (_event, skillName: string, options?: RuntimeContextOptions) => {
    const context = {
      ...options,
      directory: resolveContextDirectory(options),
    }
    return await getCapabilitySkillBundle(skillName, context)
  })

  // ─── Input validation ───

  const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
  const MAX_SKILL_CONTENT = 100 * 1024 // 100KB

  function validateName(name: string, type: string): void {
    if (!name || !VALID_NAME.test(name)) {
      throw new Error(`Invalid ${type} name: "${name}". Use alphanumeric characters, hyphens, and underscores only (max 64 chars).`)
    }
  }

  // ─── Custom MCPs ───

  ipcMain.handle('custom:list-mcps', async (_event, options?: RuntimeContextOptions) => {
    const context = {
      ...options,
      directory: resolveContextDirectory(options),
    }
    return listCustomMcps(context)
  })

  ipcMain.handle('custom:test-mcp', async (_event, mcp: CustomMcpConfig): Promise<CustomMcpTestResult> => {
    try {
      const entry = resolveCustomMcpRuntimeEntry(mcp)
      if (!entry) {
        return {
          ok: false,
          methods: [],
          error: 'This MCP is missing the connection details needed to test it.',
        }
      }

      const methods = await listToolsFromMcpEntry(entry)
      return {
        ok: true,
        methods,
        error: null,
      }
    } catch (err) {
      const authRequired = mcp.type === 'http' && !mcp.headers && isLikelyMcpAuthError(err)
      const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Could not connect to this MCP.'
      logHandlerError(`custom:test-mcp ${mcp.name}`, err)
      return {
        ok: false,
        methods: [],
        authRequired,
        error: authRequired
          ? 'This MCP appears to require OAuth. Save it and Open Cowork will start the OpenCode browser auth flow.'
          : message,
      }
    }
  })

  ipcMain.handle('custom:add-mcp', async (_event, mcp: CustomMcpConfig) => {
    validateName(mcp.name, 'MCP')
    saveCustomMcp(resolveScopedTarget(mcp) as CustomMcpConfig)
    log('custom', `Added MCP: ${mcp.name} (${mcp.type})`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    if (mcp.type === 'http' && (!mcp.headers || Object.keys(mcp.headers).length === 0)) {
      await authenticateNewRemoteMcpIfNeeded(mcp.name)
    }
    return true
  })

  ipcMain.handle('custom:remove-mcp', async (_event, target: ScopedArtifactRef) => {
    const resolvedTarget = resolveScopedTarget(target)
    removeCustomMcp(resolvedTarget)
    log('custom', `Removed MCP: ${resolvedTarget.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  // ─── Custom Skills ───

  ipcMain.handle('custom:list-skills', async (_event, options?: RuntimeContextOptions) => {
    const context = {
      ...options,
      directory: resolveContextDirectory(options),
    }
    return listCustomSkills(context)
  })

  ipcMain.handle('custom:add-skill', async (_event, skill: CustomSkillConfig) => {
    validateName(skill.name, 'skill')
    if (skill.content && skill.content.length > MAX_SKILL_CONTENT) {
      throw new Error(`Skill content too large (${(skill.content.length / 1024).toFixed(0)}KB). Max is ${MAX_SKILL_CONTENT / 1024}KB.`)
    }
    saveCustomSkill(resolveScopedTarget(skill) as CustomSkillConfig)
    log('custom', `Added skill: ${skill.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('custom:import-skill-directory', async (_event, directory: string, target: ScopedArtifactRef) => {
    const resolvedTarget = resolveScopedTarget(target)
    const imported = readSkillBundleDirectory(directory, resolvedTarget)
    validateName(imported.name, 'skill')
    if ((imported.content || '').length > MAX_SKILL_CONTENT) {
      throw new Error(`Skill content too large (${(imported.content.length / 1024).toFixed(0)}KB). Max is ${MAX_SKILL_CONTENT / 1024}KB.`)
    }
    const existing = listCustomSkills({ directory: imported.directory || null })
    if (existing.some((skill) => skill.name === imported.name && skill.scope === imported.scope)) {
      throw new Error(`A custom skill bundle named "${imported.name}" already exists.`)
    }
    saveCustomSkill(imported)
    log('custom', `Imported skill directory: ${imported.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return imported
  })

  ipcMain.handle('custom:remove-skill', async (_event, target: ScopedArtifactRef) => {
    const resolvedTarget = resolveScopedTarget(target)
    removeCustomSkill(resolvedTarget)
    log('custom', `Removed skill: ${resolvedTarget.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })
}

const permissionSessionMap = new Map<string, string>()

export function trackPermission(permissionId: string, sessionId: string) {
  permissionSessionMap.set(permissionId, sessionId)
}

export function clearPermissionsForSession(sessionId: string) {
  for (const [permissionId, mappedSessionId] of permissionSessionMap.entries()) {
    if (mappedSessionId === sessionId) {
      permissionSessionMap.delete(permissionId)
    }
  }
}
