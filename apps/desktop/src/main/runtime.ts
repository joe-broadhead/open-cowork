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
  // Resolve the built MCP server from the workspace
  const mcpDist = resolve(app.getAppPath(), '..', '..', 'mcps', 'google-workspace', 'dist', 'index.js')
  return mcpDist
}

function writeRuntimeConfig() {
  const settings = getEffectiveSettings()
  const configDir = join(getSandboxDir(), 'runtime-config')

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    // Default model — use google-vertex provider (uses ADC from gcloud auth)
    model: 'google-vertex/gemini-2.5-pro',
    small_model: 'google-vertex/gemini-2.5-flash',
    mcp: {
      nova: {
        type: 'remote',
        url: 'https://nova-auth-gateway-aupbaemtcq-ew.a.run.app/mcp',
      },
      'google-workspace': {
        type: 'local',
        command: ['node', findGwsMcpPath()],
      },
    },
  }

  // Set GCP project and location for google-vertex provider (uses ADC)
  if (settings.gcpProjectId) {
    process.env.GOOGLE_VERTEX_PROJECT = settings.gcpProjectId
    process.env.GOOGLE_VERTEX_LOCATION = settings.gcpRegion
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
  // Default deny for dangerous built-in tools unless a plugin explicitly allows them
  const dangerousDefaults = ['bash', 'edit', 'write', 'read', 'grep', 'glob', 'list', 'apply_patch', 'webfetch', 'websearch']
  for (const tool of dangerousDefaults) {
    if (!(tool in permission)) {
      permission[tool] = 'deny'
    }
  }
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
    gcpProject: settings.gcpProjectId || '(not set)',
    gcpRegion: settings.gcpRegion,
    vertexModel: settings.vertexModel,
    hasVertexProvider: !!settings.gcpProjectId,
  })
}

export async function startRuntime(): Promise<OpencodeClient> {
  if (client) return client

  ensureSandboxDirs()

  // Pass access token to gws CLI via env var
  const token = getAccessToken()
  if (token) {
    process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
  }

  // Refresh token periodically (every 45 min)
  tokenRefreshTimer = setInterval(async () => {
    const t = await refreshAccessToken()
    if (t) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = t
  }, 45 * 60 * 1000)

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
