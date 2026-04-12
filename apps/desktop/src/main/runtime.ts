import { createOpencode, createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { app } from 'electron'
import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { getAppConfig, getAppDataDir, getProviderDescriptor, resolveCustomProviderConfig } from './config-loader'
import { getEffectiveSettings, getIntegrationCredentialValue, getProviderCredentialValue } from './settings'
import { log } from './logger'
import { refreshAccessToken } from './auth'
import { getEnabledBundleSkillNames, getEnabledIntegrationBundles } from './plugin-manager'
import { buildOpenCoworkAgentConfig } from './agent-config'
import { getRuntimeCustomAgents } from './custom-agents'
import { normalizeProviderListResponse } from './provider-utils'
import { applyShellEnvironment } from './shell-env'

let client: OpencodeClient | null = null
let serverUrl: string | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null
let startRuntimePromise: Promise<OpencodeClient> | null = null
const directoryClients = new Map<string, OpencodeClient>()
const MAX_DIRECTORY_CLIENTS = 50

// Cached model info from SDK (populated after runtime starts)
let cachedModelInfo: { pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }>; contextLimits: Record<string, number> } | null = null

function getSandboxDir() {
  return getAppDataDir()
}

export function getRuntimeHomeDir() {
  return join(getSandboxDir(), 'runtime-home')
}

function getRuntimeEnvPaths() {
  const home = getRuntimeHomeDir()
  return {
    home,
    configHome: join(home, '.config'),
    dataHome: join(home, '.local', 'share'),
    cacheHome: join(home, '.cache'),
    stateHome: join(home, '.local', 'state'),
  }
}

function normalizeDirectory(directory?: string | null) {
  if (!directory) return null
  return resolve(directory)
}

function ensureSandboxDirs() {
  const base = getSandboxDir()
  const runtimePaths = getRuntimeEnvPaths()
  const dirs = [
    base,
    runtimePaths.home,
    runtimePaths.configHome,
    runtimePaths.dataHome,
    runtimePaths.cacheHome,
    runtimePaths.stateHome,
    join(runtimePaths.configHome, 'opencode'),
    join(runtimePaths.dataHome, 'opencode'),
    join(runtimePaths.cacheHome, 'opencode'),
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}

async function withRuntimeEnvironment<T>(fn: () => Promise<T>) {
  const runtimePaths = getRuntimeEnvPaths()
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  }

  process.env.HOME = runtimePaths.home
  process.env.XDG_CONFIG_HOME = runtimePaths.configHome
  process.env.XDG_DATA_HOME = runtimePaths.dataHome
  process.env.XDG_CACHE_HOME = runtimePaths.cacheHome
  process.env.XDG_STATE_HOME = runtimePaths.stateHome

  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

// In packaged app: extraResources are at process.resourcesPath
// In dev: they're relative to the app path
function resourcePath(...segments: string[]): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, ...segments)
  }
  return resolve(app.getAppPath(), '..', '..', ...segments)
}

function mcpPath(name: string): string {
  return resourcePath('mcps', name, 'dist', 'index.js')
}

function buildRuntimeConfig(): Record<string, unknown> {
  const settings = getEffectiveSettings()
  const configModel = settings.effectiveModel || getAppConfig().providers.defaultModel || ''
  const providerId = settings.effectiveProviderId || getAppConfig().providers.defaultProvider || 'anthropic'
  const providerDescriptor = getProviderDescriptor(providerId)
  const fallbackSmallModel = providerDescriptor?.models?.find((model) => model.id !== configModel)?.id || configModel
  const modelStr = configModel ? `${providerId}/${configModel}` : `${providerId}`
  const smallModelStr = fallbackSmallModel ? `${providerId}/${fallbackSmallModel}` : modelStr

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'manual',
    model: modelStr,
    small_model: smallModelStr,
    compaction: {
      auto: true,
      prune: true,
      reserved: 10_000,
    },
    mcp: {
      'charts': { type: 'local', command: ['node', mcpPath('charts')] },
    },
  }

  const customProviders = getAppConfig().providers.custom || {}
  if (Object.keys(customProviders).length > 0) {
    config.provider = Object.fromEntries(
      Object.entries(customProviders).map(([id, provider]) => [
        id,
        {
          npm: provider.npm,
          name: provider.name,
          options: provider.options || {},
          models: provider.models,
        },
      ]),
    )
  }

  const mcpConfig = config.mcp as Record<string, unknown>
  for (const bundle of getEnabledIntegrationBundles()) {
    for (const builtin of bundle.mcps) {
      if (builtin.type === 'local') {
        const entry: Record<string, unknown> = {
          type: 'local',
          command: builtin.command || ['node', mcpPath(builtin.packageName || builtin.name)],
        }
        const env: Record<string, string> = {}
        let missingCredential = false

        for (const envSetting of builtin.envSettings || []) {
          const value = getIntegrationCredentialValue(settings, bundle.id, envSetting.key)
          if (!value) {
            missingCredential = true
            break
          }
          env[envSetting.env] = value
        }

        if (missingCredential) {
          log('runtime', `Skipping MCP ${builtin.name}: missing required credentials`)
          continue
        }

        if (Object.keys(env).length > 0) entry.env = env
        mcpConfig[builtin.name] = entry
        continue
      }

      if (builtin.url) {
        const headers: Record<string, string> = { ...(builtin.headers || {}) }
        let missingCredential = false

        for (const headerSetting of builtin.headerSettings || []) {
          const value = getIntegrationCredentialValue(settings, bundle.id, headerSetting.key)
          if (!value) {
            missingCredential = true
            break
          }
          headers[headerSetting.header] = `${headerSetting.prefix || ''}${value}`
        }

        if (missingCredential) {
          log('runtime', `Skipping MCP ${builtin.name}: missing required credentials`)
          continue
        }

        const entry: Record<string, unknown> = {
          type: 'remote',
          url: builtin.url,
        }
        if (Object.keys(headers).length > 0) entry.headers = headers
        mcpConfig[builtin.name] = entry
      }
    }
  }

  // Inject custom MCPs from settings
  for (const custom of settings.customMcps || []) {
    if (!custom.name) continue
    if (custom.type === 'stdio' && custom.command) {
      const entry: Record<string, unknown> = {
        type: 'local',
        command: [custom.command, ...(custom.args || [])],
      }
      if (custom.env && Object.keys(custom.env).length > 0) {
        entry.env = custom.env
      }
      mcpConfig[custom.name] = entry
    } else if (custom.type === 'http' && custom.url) {
      const entry: Record<string, unknown> = {
        type: 'remote',
        url: custom.url,
      }
      if (custom.headers && Object.keys(custom.headers).length > 0) {
        entry.headers = custom.headers
      }
      mcpConfig[custom.name] = entry
    }
  }

  // Generate tool ACLs from installed plugins
  const enabledBundles = getEnabledIntegrationBundles()
  const allowedPatterns = Array.from(new Set(enabledBundles.flatMap((bundle) => (
    bundle.agentAccess?.readToolPatterns?.length
      ? bundle.agentAccess.readToolPatterns
      : bundle.allowedTools
  ))))
  const askPatterns = Array.from(new Set(enabledBundles.flatMap((bundle) => bundle.agentAccess?.writeToolPatterns || [])))
  const deniedPatterns = Array.from(new Set(enabledBundles.flatMap((bundle) => bundle.deniedTools)))
  const allToolPatterns = Array.from(new Set([...allowedPatterns, ...askPatterns, ...deniedPatterns]))
  const permission: Record<string, string> = {
    skill: 'allow',
    question: 'deny',
    task: 'deny',
    todowrite: 'allow',
    codesearch: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  }
  for (const tool of deniedPatterns) {
    permission[tool] = 'deny'
  }
  for (const tool of askPatterns) {
    permission[tool] = 'ask'
  }
  for (const tool of allowedPatterns) {
    permission[tool] = 'allow'
  }
  if (settings.enableBash) {
    permission['bash'] = 'allow'
  } else {
    permission['bash'] = 'deny'
  }
  if (settings.enableFileWrite) {
    permission['edit'] = 'allow'
    permission['write'] = 'allow'
    permission['apply_patch'] = 'allow'
  } else {
    permission['edit'] = 'deny'
    permission['write'] = 'deny'
    permission['apply_patch'] = 'deny'
  }
  permission['read'] = 'allow'
  permission['grep'] = 'allow'
  permission['glob'] = 'allow'
  permission['list'] = 'allow'

  config.permission = permission
  config.agent = buildOpenCoworkAgentConfig({
    allToolPatterns,
    allowBash: settings.enableBash,
    allowEdits: settings.enableFileWrite,
    customAgents: getRuntimeCustomAgents(settings),
  })

  log('runtime', `Config built: provider=${providerId} model=${modelStr}`)

  return config
}

function copySkillsAndAgents() {
  const runtimeHome = getRuntimeHomeDir()
  const runtimeConfigSrc = app.isPackaged
    ? join(process.resourcesPath, 'runtime-config')
    : join(app.getAppPath(), 'runtime-config')

  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'))
  }

  const skillsDst = join(runtimeHome, '.opencode', 'skills')
  rmSync(skillsDst, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })

  const skillSourceRoots = [join(runtimeConfigSrc, 'skills')]
  for (const skillName of getEnabledBundleSkillNames()) {
    const destination = join(skillsDst, skillName)
    const source = skillSourceRoots
      .map((root) => join(root, skillName))
      .find((candidate) => existsSync(candidate))

    if (!source) {
      log('runtime', `Bundled skill not found: ${skillName}`)
      continue
    }

    cpSync(source, destination, { recursive: true })
  }

  const settings = getEffectiveSettings()
  for (const skill of settings.customSkills || []) {
    if (!skill.name || !skill.content) continue
    const skillDir = join(skillsDst, skill.name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skill.content)
  }
}

async function fetchModelInfo(c: OpencodeClient) {
  try {
    const result = await c.provider.list()
    const raw = result.data as any
    const providers = normalizeProviderListResponse(raw)
    if (!providers.length) return

    const pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }> = {}
    const contextLimits: Record<string, number> = {}

    for (const provider of providers) {
      const models = provider.models || {}
      for (const [modelId, info] of Object.entries(models) as [string, any][]) {
        if (info.cost) {
          pricing[modelId] = {
            inputPer1M: (info.cost.input || 0) * 1_000_000,
            outputPer1M: (info.cost.output || 0) * 1_000_000,
            ...(info.cost.cache_read ? { cachePer1M: info.cost.cache_read * 1_000_000 } : {}),
          }
        }
        if (info.limit?.context) {
          contextLimits[modelId] = info.limit.context
        }
      }
    }

    cachedModelInfo = { pricing, contextLimits }
    log('runtime', `Loaded model info: ${Object.keys(pricing).length} models with pricing, ${Object.keys(contextLimits).length} with context limits`)
  } catch (err: any) {
    log('runtime', `Could not fetch model info: ${err?.message}`)
  }
}

export function getModelInfo() {
  return cachedModelInfo
}

export async function startRuntime(): Promise<OpencodeClient> {
  if (client) return client
  if (startRuntimePromise) return startRuntimePromise

  startRuntimePromise = (async () => {
    ensureSandboxDirs()
    applyShellEnvironment()

    const token = await refreshAccessToken()
    if (token) {
      process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
    }

    const currentSettings = getEffectiveSettings()
    const providerDescriptor = getProviderDescriptor(currentSettings.effectiveProviderId)
    for (const credential of providerDescriptor?.credentials || []) {
      if (!credential.env) continue
      const value = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, credential.key)
      if (value) process.env[credential.env] = value
    }

    if (currentSettings.effectiveProviderId === 'google-vertex') {
      const projectId = getProviderCredentialValue(currentSettings, 'google-vertex', 'projectId')
      const location = getProviderCredentialValue(currentSettings, 'google-vertex', 'location')
      if (projectId) process.env.GOOGLE_VERTEX_PROJECT = projectId
      if (location) process.env.GOOGLE_VERTEX_LOCATION = location
    }

    const customProvider = currentSettings.effectiveProviderId
      ? resolveCustomProviderConfig(currentSettings.effectiveProviderId)
      : null
    for (const credential of customProvider?.credentials || []) {
      if (!credential.env || !currentSettings.effectiveProviderId) continue
      const value = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, credential.key)
      if (value) process.env[credential.env] = value
    }

    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
    }

    // Refresh token periodically (every 30 min)
    tokenRefreshTimer = setInterval(async () => {
      try {
        const t = await refreshAccessToken()
        if (t) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = t
      } catch (err: any) {
        log('error', `Access token refresh failed: ${err?.message}`)
      }
    }, 30 * 60 * 1000)

    // Copy AGENTS.md and skills to runtime home (discovered from CWD)
    copySkillsAndAgents()

    // Build config in memory — SDK passes it via OPENCODE_CONFIG_CONTENT env var
    const config = buildRuntimeConfig()

    // Set CWD to sandbox runtime home so OpenCode discovers AGENTS.md and skills there.
    // Session-specific project routing is handled by directory-scoped SDK clients.
    process.chdir(getRuntimeHomeDir())

    try {
      const result = await withRuntimeEnvironment(() =>
        createOpencode({
          hostname: '127.0.0.1',
          port: 0,
          config: config as any,
        }),
      )

      client = result.client
      serverUrl = result.server.url
      serverClose = result.server.close
      directoryClients.clear()

      // Fetch model pricing and context limits from SDK
      await fetchModelInfo(client)

      log('runtime', `OpenCode server started at ${result.server.url}`)
      return client
    } catch (err) {
      if (tokenRefreshTimer) {
        clearInterval(tokenRefreshTimer)
        tokenRefreshTimer = null
      }
      cachedModelInfo = null
      client = null
      serverUrl = null
      serverClose = null
      directoryClients.clear()
      throw err
    }
  })()

  try {
    return await startRuntimePromise
  } finally {
    startRuntimePromise = null
  }
}

export function getClient(): OpencodeClient | null {
  return client
}

export function getClientForDirectory(directory?: string | null): OpencodeClient | null {
  if (!client) return null

  const normalized = normalizeDirectory(directory)
  if (!normalized || normalized === normalizeDirectory(getRuntimeHomeDir())) {
    return client
  }

  const existing = directoryClients.get(normalized)
  if (existing) {
    directoryClients.delete(normalized)
    directoryClients.set(normalized, existing)
    return existing
  }
  if (!serverUrl) return client

  const scoped = createOpencodeClient({
    baseUrl: serverUrl,
    directory: normalized,
  })
  if (directoryClients.size >= MAX_DIRECTORY_CLIENTS) {
    const oldestKey = directoryClients.keys().next().value
    if (oldestKey) directoryClients.delete(oldestKey)
  }
  directoryClients.set(normalized, scoped)
  return scoped
}

export function getServerUrl() {
  return serverUrl
}

export async function stopRuntime() {
  startRuntimePromise = null
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer)
    tokenRefreshTimer = null
  }
  if (serverClose) {
    serverClose()
    serverClose = null
  }
  directoryClients.clear()
  client = null
  serverUrl = null
  cachedModelInfo = null
}
