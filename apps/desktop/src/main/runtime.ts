import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk'
import { app } from 'electron'
import { mkdirSync, writeFileSync, cpSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { getEffectiveSettings } from './settings'
import { getCachedAccessToken, refreshAccessToken } from './auth'
import { getPluginToolACLs } from './plugin-manager'

let client: OpencodeClient | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null

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
    join(base, 'runtime-config'),
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}

function findGwsMcpPath(): string {
  return resolve(app.getAppPath(), '..', '..', 'mcps', 'google-workspace', 'dist', 'index.js')
}

function mcpPath(name: string): string {
  return resolve(app.getAppPath(), '..', '..', 'mcps', name, 'dist', 'index.js')
}

function writeRuntimeConfig() {
  const settings = getEffectiveSettings()
  const configDir = join(getSandboxDir(), 'runtime-config')

  // Determine provider and model
  let modelStr: string
  let smallModelStr: string

  const useDatabricks = settings.provider === 'databricks' && settings.databricksHost && settings.databricksToken

  if (useDatabricks) {
    modelStr = `databricks/${settings.defaultModel}`
    // Always use a fast model for small tasks (title generation, etc.)
    smallModelStr = 'databricks/databricks-claude-sonnet-4-6'
  } else {
    // Fallback to Vertex AI
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
    share: 'disabled',
    model: modelStr,
    small_model: smallModelStr,
    mcp: {
      nova: {
        type: 'remote',
        url: 'https://nova-auth-gateway-aupbaemtcq-ew.a.run.app/mcp',
      },
      'google-workspace': { type: 'local', command: ['node', findGwsMcpPath()] },
      'google-sheets': { type: 'local', command: ['node', mcpPath('google-sheets')] },
      'google-docs': { type: 'local', command: ['node', mcpPath('google-docs')] },
      'google-slides': { type: 'local', command: ['node', mcpPath('google-slides')] },
      'google-chat': { type: 'local', command: ['node', mcpPath('google-chat')] },
      'google-gmail': { type: 'local', command: ['node', mcpPath('google-gmail')] },
      'google-people': { type: 'local', command: ['node', mcpPath('google-people')] },
      'google-calendar': { type: 'local', command: ['node', mcpPath('google-calendar')] },
      'google-drive': { type: 'local', command: ['node', mcpPath('google-drive')] },
      'google-forms': { type: 'local', command: ['node', mcpPath('google-forms')] },
      'google-keep': { type: 'local', command: ['node', mcpPath('google-keep')] },
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

  // Write custom skills to disk so OpenCode can discover them
  const customSkillsDir = join(app.getAppPath(), '..', '..', '.opencode', 'skills')
  for (const skill of settings.customSkills || []) {
    if (!skill.name || !skill.content) continue
    const skillDir = join(customSkillsDir, skill.name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), skill.content)
  }

  // Add Databricks provider config if selected
  if (useDatabricks) {
    config.provider = {
      databricks: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Databricks',
        options: {
          baseURL: `${settings.databricksHost.replace(/\/$/, '')}/serving-endpoints`,
          apiKey: '{env:DATABRICKS_TOKEN}',
        },
        models: {
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
    question: 'deny',  // Deny — blocks session in server mode (no terminal). Agent asks in text instead.
    task: 'allow',
    todowrite: 'allow',
    codesearch: 'allow',
    webfetch: 'allow',
    websearch: 'allow',
  }
  // Allow tools from installed plugins
  for (const tool of acls.allowed) {
    permission[tool] = 'allow'
  }
  // Deny tools from installed plugins' deny lists
  for (const tool of acls.denied) {
    if (!acls.allowed.includes(tool)) {
      permission[tool] = 'deny'
    }
  }
  // Developer tools — user-toggled in Settings
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
  // Read-only tools are always safe — override any denials so skill subagents work
  permission['read'] = 'allow'
  permission['grep'] = 'allow'
  permission['glob'] = 'allow'
  permission['list'] = 'allow'

  config.permission = permission

  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2))

  // Copy AGENTS.md and skills into the runtime home (where OpenCode looks for them)
  const runtimeHome = join(getSandboxDir(), 'runtime-home')
  // In dev: app.getAppPath() = apps/desktop, in prod: the asar root
  const runtimeConfigSrc = join(app.getAppPath(), 'runtime-config')

  // Copy AGENTS.md to runtime home root
  const agentsSrc = join(runtimeConfigSrc, 'AGENTS.md')
  if (existsSync(agentsSrc)) {
    writeFileSync(join(runtimeHome, 'AGENTS.md'), require('fs').readFileSync(agentsSrc, 'utf-8'))
  }

  // Copy skills into .opencode/skills/ in runtime home
  const skillsSrc = join(runtimeConfigSrc, 'skills')
  const skillsDst = join(runtimeHome, '.opencode', 'skills')
  if (existsSync(skillsSrc)) {
    mkdirSync(skillsDst, { recursive: true })
    cpSync(skillsSrc, skillsDst, { recursive: true })
  }

  console.log('[runtime] Config written:', {
    provider: settings.provider,
    model: modelStr,
    ...(settings.provider === 'databricks'
      ? { host: settings.databricksHost }
      : { gcpProject: settings.gcpProjectId, gcpRegion: settings.gcpRegion }),
  })
}

export async function startRuntime(): Promise<OpencodeClient> {
  if (client) return client

  ensureSandboxDirs()

  // Get a fresh access token for gws CLI (always refresh at startup)
  const token = await refreshAccessToken()
  if (token) {
    process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
  }

  // Pass Databricks token via env var (not written to disk config)
  if (settings.databricksToken) {
    process.env.DATABRICKS_TOKEN = settings.databricksToken
  }

  // Refresh token periodically (every 30 min)
  tokenRefreshTimer = setInterval(async () => {
    const t = await refreshAccessToken()
    if (t) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = t
  }, 30 * 60 * 1000)

  writeRuntimeConfig()

  const sandbox = getSandboxDir()

  // Point OpenCode at our config file
  const configFile = join(sandbox, 'runtime-config', 'opencode.json')
  process.env.OPENCODE_CONFIG = configFile

  const result = await createOpencode({
    hostname: '127.0.0.1',
    port: 0,
  })

  client = result.client
  serverClose = result.server.close

  console.log(`[runtime] OpenCode server started at ${result.server.url}`)
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
}
