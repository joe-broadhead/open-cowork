import { createOpencode, createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { app } from 'electron'
import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { getEffectiveSettings } from './settings'
import { log } from './logger'
import { getCachedAccessToken, refreshAccessToken } from './auth'
import { getEnabledBuiltInMcps, getEnabledBundleSkillNames, getPluginToolACLs } from './plugin-manager'
import { buildCoworkAgentConfig } from './agent-config'
import { getRuntimeCustomAgents } from './custom-agents'
import { normalizeProviderListResponse } from './provider-utils'

let client: OpencodeClient | null = null
let serverUrl: string | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null
const directoryClients = new Map<string, OpencodeClient>()

// Cached model info from SDK (populated after runtime starts)
let cachedModelInfo: { pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }>; contextLimits: Record<string, number> } | null = null

function getSandboxDir() {
  return join(app.getPath('userData'), 'cowork')
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

function getBundledSkillsRoot() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'skills')
  }
  return resolve(app.getAppPath(), '..', '..', '.opencode', 'skills')
}

function buildRuntimeConfig(): Record<string, unknown> {
  const settings = getEffectiveSettings()

  // Determine provider and model
  let modelStr: string
  let smallModelStr: string

  const useDatabricks = settings.provider === 'databricks' && settings.databricksHost && settings.databricksToken

  if (useDatabricks) {
    modelStr = `databricks/${settings.defaultModel}`
    smallModelStr = 'databricks/databricks-claude-sonnet-4'
  } else {
    const vertexModel = settings.provider === 'vertex' ? settings.defaultModel : 'gemini-2.5-pro'
    modelStr = `google-vertex/${vertexModel}`
    smallModelStr = 'google-vertex/gemini-2.5-flash'
    if (settings.gcpProjectId) {
      process.env.GOOGLE_VERTEX_PROJECT = settings.gcpProjectId
      process.env.GOOGLE_VERTEX_LOCATION = settings.gcpRegion
    }
  }

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

  const mcpConfig = config.mcp as Record<string, unknown>
  for (const builtin of getEnabledBuiltInMcps()) {
    if (builtin.type === 'local') {
      const entry: Record<string, unknown> = {
        type: 'local',
        command: builtin.command || ['node', mcpPath(builtin.packageName || builtin.name)],
      }
      const env: Record<string, string> = {}
      let missingCredential = false

      for (const envSetting of builtin.envSettings || []) {
        const rawValue = settings[envSetting.key as keyof typeof settings]
        const value = typeof rawValue === 'string' ? rawValue.trim() : ''
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

      if (Object.keys(env).length > 0) {
        entry.env = env
      }
      mcpConfig[builtin.name] = entry
      continue
    }

    if (builtin.url) {
      const headers: Record<string, string> = { ...(builtin.headers || {}) }
      let missingCredential = false

      for (const headerSetting of builtin.headerSettings || []) {
        const rawValue = settings[headerSetting.key as keyof typeof settings]
        const value = typeof rawValue === 'string' ? rawValue.trim() : ''
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
      if (Object.keys(headers).length > 0) {
        entry.headers = headers
      }
      mcpConfig[builtin.name] = entry
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

  // Add Databricks provider config if selected
  if (useDatabricks) {
    config.provider = {
      databricks: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Databricks',
        options: {
          baseURL: `${(settings.databricksHost || '').replace(/\/$/, '')}/serving-endpoints`,
          apiKey: '{env:DATABRICKS_TOKEN}',
        },
        models: {
          'databricks-claude-sonnet-4': {
            name: 'Claude Sonnet 4', attachment: true, reasoning: true, tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          'databricks-claude-opus-4-6': {
            name: 'Claude Opus 4.6', attachment: true, reasoning: true, tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          'databricks-claude-sonnet-4-6': {
            name: 'Claude Sonnet 4.6', attachment: true, reasoning: true, tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          'databricks-gpt-oss-120b': {
            name: 'GPT OSS 120B', attachment: true, tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    }
  }

  // Generate tool ACLs from installed plugins
  const acls = getPluginToolACLs()
  const allToolPatterns = Array.from(new Set([...acls.allowed, ...acls.denied]))
  const permission: Record<string, string> = {
    skill: 'allow',
    question: 'deny',
    task: 'deny',
    todowrite: 'allow',
    codesearch: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  }
  for (const tool of acls.allowed) {
    permission[tool] = 'allow'
  }
  for (const tool of acls.denied) {
    if (!acls.allowed.includes(tool)) {
      permission[tool] = 'deny'
    }
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
  config.agent = buildCoworkAgentConfig({
    allToolPatterns,
    allowBash: settings.enableBash,
    allowEdits: settings.enableFileWrite,
    customAgents: getRuntimeCustomAgents(settings),
  })

  log('runtime', `Config built: provider=${settings.provider} model=${modelStr}`)

  return config
}

function copySkillsAndAgents() {
  const runtimeHome = getRuntimeHomeDir()
  const runtimeConfigSrc = app.isPackaged
    ? join(process.resourcesPath, 'runtime-config')
    : join(app.getAppPath(), 'runtime-config')
  const bundledSkillsRoot = getBundledSkillsRoot()

  // Copy AGENTS.md to sandbox runtime home (not user's $HOME)
  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'))
  }

  // Copy skills to sandbox .opencode/skills/ (not user's $HOME)
  const skillsDst = join(runtimeHome, '.opencode', 'skills')
  rmSync(skillsDst, { recursive: true, force: true })
  mkdirSync(skillsDst, { recursive: true })

  const skillSourceRoots = [
    join(runtimeConfigSrc, 'skills'),
    bundledSkillsRoot,
  ]
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

  // Write custom skills from settings
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

  ensureSandboxDirs()
  const userHome = app.getPath('home') || process.env.HOME || ''

  // Get a fresh access token for gws CLI
  const token = await refreshAccessToken()
  if (token) {
    process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
  }

  // Pass Databricks token via env var
  const currentSettings = getEffectiveSettings()
  if (currentSettings.databricksToken) {
    process.env.DATABRICKS_TOKEN = currentSettings.databricksToken
  }

  // Refresh token periodically (every 30 min)
  tokenRefreshTimer = setInterval(async () => {
    const t = await refreshAccessToken()
    if (t) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = t
  }, 30 * 60 * 1000)

  // Copy AGENTS.md and skills to runtime home (discovered from CWD)
  copySkillsAndAgents()

  // Build config in memory — SDK passes it via OPENCODE_CONFIG_CONTENT env var
  const config = buildRuntimeConfig()

  // Ensure opencode binary is in PATH — macOS GUI apps don't inherit shell PATH
  const extraPaths = [
    join(userHome, '.opencode', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(userHome, '.cargo', 'bin'),
  ]
  const pathParts = (process.env.PATH || '').split(':')
  for (const p of extraPaths) {
    if (!pathParts.includes(p)) pathParts.unshift(p)
  }
  process.env.PATH = pathParts.join(':')

  // Set CWD to sandbox runtime home so OpenCode discovers AGENTS.md and skills there.
  // Session-specific project routing is handled by directory-scoped SDK clients.
  process.chdir(getRuntimeHomeDir())

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
  if (existing) return existing
  if (!serverUrl) return client

  const scoped = createOpencodeClient({
    baseUrl: serverUrl,
    directory: normalized,
  })
  directoryClients.set(normalized, scoped)
  return scoped
}

export function getServerUrl() {
  return serverUrl
}

export async function stopRuntime() {
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
