import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk'
import { app } from 'electron'
import { mkdirSync, writeFileSync, cpSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { getEffectiveSettings } from './settings'
import { getAccessToken, refreshAccessToken } from './auth'
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
    smallModelStr = `databricks/${settings.defaultModel}`
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
    },
  }

  // Add Databricks provider config if selected
  if (useDatabricks) {
    config.provider = {
      databricks: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Databricks',
        options: {
          baseURL: `${settings.databricksHost.replace(/\/$/, '')}/serving-endpoints`,
          apiKey: settings.databricksToken,
        },
        models: {
          'databricks-claude-opus-4-6': { name: 'Claude Opus 4.6' },
          'databricks-claude-sonnet-4-6': { name: 'Claude Sonnet 4.6' },
          'databricks-gpt-oss-120b': { name: 'GPT OSS 120B' },
        },
      },
    }
  }

  // Generate tool ACLs from installed plugins
  const acls = getPluginToolACLs()
  const permission: Record<string, string> = {
    skill: 'allow',
    question: 'allow',
    task: 'allow',
  }
  // Allow tools from installed plugins
  for (const tool of acls.allowed) {
    permission[tool] = 'allow'
  }
  // Deny tools from installed plugins' deny lists
  for (const tool of acls.denied) {
    // Only deny if not explicitly allowed by another plugin
    if (!acls.allowed.includes(tool)) {
      permission[tool] = 'deny'
    }
  }
  // Default deny for write/execute tools unless a plugin explicitly allows them
  const dangerousDefaults = ['bash', 'edit', 'write', 'apply_patch', 'webfetch', 'websearch']
  for (const tool of dangerousDefaults) {
    if (!(tool in permission)) {
      permission[tool] = 'deny'
    }
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
