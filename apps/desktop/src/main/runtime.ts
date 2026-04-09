import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { getEffectiveSettings, getVertexBaseUrl } from './settings'
import { getAccessToken, startTokenRefresh } from './vertex-auth'

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
  const mcpDist = resolve(__dirname, '..', '..', '..', '..', 'mcps', 'google-workspace', 'dist', 'index.js')
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

  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify(config, null, 2))

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

  // Start Vertex AI token refresh — sets GOOGLE_ACCESS_TOKEN env var with Bearer prefix
  const token = getAccessToken()
  if (token) {
    process.env.GOOGLE_ACCESS_TOKEN = `Bearer ${token}`
  }
  tokenRefreshTimer = startTokenRefresh()

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
