import { loadSettings } from '@open-cowork/runtime-host/settings'
import { listReadyGoogleAuthLocalMcpNames } from '@open-cowork/runtime-host/runtime-mcp'
import { listCustomMcps } from '@open-cowork/runtime-host/native-customizations'
import { getConfiguredMcpsFromConfig } from './config-loader.ts'
import { log } from './logger.ts'

type RuntimeMcpClient = {
  mcp: {
    connect(input: { name: string }): Promise<unknown>
  }
}

export type RuntimeMcpStatus = {
  name: string
  connected: boolean
  rawStatus?: string
}

const MAX_STARTUP_MCP_RECOVERY_ATTEMPTS = 3

function defaultRecoverableLocalMcpNames() {
  return new Set([
    'charts',
    ...getConfiguredMcpsFromConfig()
      .filter((mcp) => mcp.type === 'local')
      .map((mcp) => mcp.name),
  ])
}

function defaultGoogleAuthLocalMcpNames(runtimeProjectDirectory: string | null) {
  return new Set(listReadyGoogleAuthLocalMcpNames({
    builtinMcps: getConfiguredMcpsFromConfig(),
    customMcps: listCustomMcps({ directory: runtimeProjectDirectory }),
    settings: loadSettings(),
  }))
}

async function defaultRefreshGoogleAuth() {
  try {
    const { refreshAccessToken, getAdcPathIfAvailable } = await import('@open-cowork/runtime-host/auth')
    const token = await refreshAccessToken()
    return Boolean(token || getAdcPathIfAvailable())
  } catch (err) {
    log('auth', `Google-auth MCP refresh skipped: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

export function createStartupMcpRecovery(options: {
  client: RuntimeMcpClient
  runtimeProjectDirectory: string | null
  recoverableLocalNames?: Iterable<string>
  googleAuthLocalNames?: Iterable<string>
  refreshGoogleAuth?: () => Promise<boolean>
}) {
  const startupRecoveryAttempts = new Map<string, number>()
  const recoverableLocals = new Set(options.recoverableLocalNames || defaultRecoverableLocalMcpNames())
  const googleAuthLocals = new Set(options.googleAuthLocalNames || defaultGoogleAuthLocalMcpNames(options.runtimeProjectDirectory))
  const refreshGoogleAuth = options.refreshGoogleAuth || defaultRefreshGoogleAuth

  const recoverFailedLocalMcps = async (statuses: RuntimeMcpStatus[]) => {
    const failedLocalMcps = statuses.filter((entry) =>
      recoverableLocals.has(entry.name)
      && !googleAuthLocals.has(entry.name)
      && !entry.connected
      && entry.rawStatus === 'failed')

    for (const entry of failedLocalMcps) {
      const attempts = startupRecoveryAttempts.get(entry.name) || 0
      if (attempts >= MAX_STARTUP_MCP_RECOVERY_ATTEMPTS) continue
      startupRecoveryAttempts.set(entry.name, attempts + 1)
      try {
        log('mcp', `Retrying local MCP startup for ${entry.name} (${attempts + 1}/${MAX_STARTUP_MCP_RECOVERY_ATTEMPTS})`)
        await options.client.mcp.connect({ name: entry.name })
      } catch (err: unknown) {
        log('error', `Local MCP recovery failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const recoverDisconnectedGoogleAuthMcps = async (statuses: RuntimeMcpStatus[]) => {
    const disconnected = statuses.filter((entry) => googleAuthLocals.has(entry.name) && !entry.connected)
    if (disconnected.length === 0) return
    if (!(await refreshGoogleAuth())) return

    for (const entry of disconnected) {
      try {
        log('mcp', `Refreshing Google-auth MCP ${entry.name}`)
        await options.client.mcp.connect({ name: entry.name })
      } catch (err: unknown) {
        log('error', `Google-auth MCP recovery failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return {
    recoverDisconnectedGoogleAuthMcps,
    recoverFailedLocalMcps,
  }
}
