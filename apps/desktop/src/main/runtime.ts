import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk'
import { app } from 'electron'
import { mkdirSync, writeFileSync, cpSync, existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { getEffectiveSettings } from './settings'
import { log } from './logger'
import { getCachedAccessToken, refreshAccessToken } from './auth'
import { getPluginToolACLs } from './plugin-manager'

let client: OpencodeClient | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null

// Cached model info from SDK (populated after runtime starts)
let cachedModelInfo: { pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }>; contextLimits: Record<string, number> } | null = null

function getSandboxDir() {
  return join(app.getPath('userData'), 'cowork')
}

function ensureSandboxDirs() {
  const base = getSandboxDir()
  const dirs = [
    base,
    join(base, 'runtime-home'),
    join(base, 'runtime-home', '.config', 'opencode'),
    join(base, 'runtime-home', '.local', 'share', 'opencode'),
    join(base, 'runtime-home', '.cache', 'opencode'),
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
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
    mcp: {
      nova: {
        type: 'remote',
        url: 'https://nova-auth-gateway-aupbaemtcq-ew.a.run.app/mcp',
      },
      'google-sheets': { type: 'local', command: ['node', mcpPath('google-sheets')] },
      'google-docs': { type: 'local', command: ['node', mcpPath('google-docs')] },
      'google-slides': { type: 'local', command: ['node', mcpPath('google-slides')] },
      'google-chat': { type: 'local', command: ['node', mcpPath('google-chat')] },
      'google-gmail': { type: 'local', command: ['node', mcpPath('google-gmail')] },
      'google-people': { type: 'local', command: ['node', mcpPath('google-people')] },
      'google-calendar': { type: 'local', command: ['node', mcpPath('google-calendar')] },
      'google-drive': { type: 'local', command: ['node', mcpPath('google-drive')] },
      'google-forms': { type: 'local', command: ['node', mcpPath('google-forms')] },
      'google-tasks': { type: 'local', command: ['node', mcpPath('google-tasks')] },
      'google-appscript': { type: 'local', command: ['node', mcpPath('google-appscript')] },
    },
  }

  // Inject custom MCPs from settings
  const mcpConfig = config.mcp as Record<string, unknown>
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
  const permission: Record<string, string> = {
    skill: 'allow',
    question: 'deny',
    task: 'allow',
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

  log('runtime', `Config built: provider=${settings.provider} model=${modelStr}`)

  return config
}

function copySkillsAndAgents() {
  const runtimeHome = join(getSandboxDir(), 'runtime-home')
  const runtimeConfigSrc = app.isPackaged
    ? join(process.resourcesPath, 'runtime-config')
    : join(app.getAppPath(), 'runtime-config')

  // Copy AGENTS.md to runtime home root
  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), readFileSync(agentsSrc, 'utf-8'))
  }

  // Copy skills into .opencode/skills/ in runtime home
  const skillsDst = join(runtimeHome, '.opencode', 'skills')
  mkdirSync(skillsDst, { recursive: true })

  const builtinSkillsSrc = resourcePath('skills')
  if (existsSync(builtinSkillsSrc)) {
    cpSync(builtinSkillsSrc, skillsDst, { recursive: true })
  }

  const runtimeSkillsSrc = join(runtimeConfigSrc, 'skills')
  if (existsSync(runtimeSkillsSrc)) {
    cpSync(runtimeSkillsSrc, skillsDst, { recursive: true })
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
    const providers = result.data as any[]
    if (!providers) return

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
    join(process.env.HOME || '', '.opencode', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(process.env.HOME || '', '.cargo', 'bin'),
  ]
  const pathParts = (process.env.PATH || '').split(':')
  for (const p of extraPaths) {
    if (!pathParts.includes(p)) pathParts.unshift(p)
  }
  process.env.PATH = pathParts.join(':')

  // Set CWD to runtime home — OpenCode discovers skills from <cwd>/.opencode/skills/
  const runtimeHomePath = join(getSandboxDir(), 'runtime-home')
  process.chdir(runtimeHomePath)

  const result = await createOpencode({
    hostname: '127.0.0.1',
    port: 0,
    config: config as any,
  })

  client = result.client
  serverClose = result.server.close

  // Fetch model pricing and context limits from SDK
  await fetchModelInfo(client)

  log('runtime', `OpenCode server started at ${result.server.url}`)
  return client
}

export function getClient(): OpencodeClient | null {
  return client
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
  client = null
  cachedModelInfo = null
}
