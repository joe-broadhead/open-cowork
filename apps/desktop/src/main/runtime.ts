import {
  createOpencode,
  createOpencodeClient as createV2OpencodeClient,
  type OpencodeClient as V2OpencodeClient,
} from '@opencode-ai/sdk/v2'
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'
import {
  getAppConfig,
  getAppDataDir,
  getConfiguredModelFallbacks,
  getProviderDescriptor,
  resolveCustomProviderConfig,
} from './config-loader.ts'
import { getEffectiveSettings, getProviderCredentialValue } from './settings.ts'
import { log } from './logger.ts'
import { normalizeProviderListResponse } from './provider-utils.ts'
import { readRecord } from './opencode-adapter.ts'
import { applyShellEnvironment } from './shell-env.ts'
import { getRuntimeEnvPaths, getRuntimeHomeDir } from './runtime-paths.ts'
import { applyBundledOpencodeCliEnvironment } from './runtime-opencode-cli.ts'
import { clearProjectOverlayCopies } from './runtime-project-overlay.ts'
import { buildRuntimeConfig } from './runtime-config-builder.ts'
import { copySkillsAndAgents } from './runtime-content.ts'
import { getOrCreateDirectoryClient } from './runtime-client-cache.ts'
import { refreshAccessTokenIntoEnvironment } from './runtime-token-refresh.ts'

export { getRuntimeHomeDir } from './runtime-paths.ts'

let client: V2OpencodeClient | null = null
let serverUrl: string | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null
let startRuntimePromise: Promise<V2OpencodeClient> | null = null
const directoryClients = new Map<string, V2OpencodeClient>()
const MAX_DIRECTORY_CLIENTS = 50
let activeProjectOverlayDirectory: string | null = null

// Cached model info from SDK (populated after runtime starts)
let cachedModelInfo: { pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }>; contextLimits: Record<string, number> } | null = null

async function refreshAccessTokenLazy() {
  const { refreshAccessToken } = await import('./auth.ts')
  return refreshAccessToken()
}

function normalizeDirectory(directory?: string | null) {
  if (!directory) return null
  return resolve(directory)
}

function ensureSandboxDirs() {
  const base = getAppDataDir()
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

async function fetchModelInfo(c: V2OpencodeClient) {
  const configuredFallbacks = getConfiguredModelFallbacks()
  try {
    const result = await c.provider.list()
    const providers = normalizeProviderListResponse(result.data)
    if (!providers.length) {
      cachedModelInfo = configuredFallbacks
      return
    }

    const pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }> = {
      ...configuredFallbacks.pricing,
    }
    const contextLimits: Record<string, number> = {
      ...configuredFallbacks.contextLimits,
    }

    for (const provider of providers) {
      const models = provider.models || {}
      for (const [modelId, rawInfo] of Object.entries(models)) {
        const info = readRecord(rawInfo)
        const cost = readRecord(info.cost)
        const limit = readRecord(info.limit)
        if (Object.keys(cost).length > 0) {
          const inputPer1M = typeof cost.input === 'number' ? cost.input : 0
          const outputPer1M = typeof cost.output === 'number' ? cost.output : 0
          const cachePer1M = typeof cost.cache_read === 'number' ? cost.cache_read : undefined
          if (inputPer1M > 0 || outputPer1M > 0 || (cachePer1M || 0) > 0) {
            pricing[modelId] = {
              inputPer1M,
              outputPer1M,
              ...(cachePer1M ? { cachePer1M } : {}),
            }
          }
        }
        if (typeof limit.context === 'number') {
          contextLimits[modelId] = limit.context
        }
      }
    }

    cachedModelInfo = { pricing, contextLimits }
    log('runtime', `Loaded model info: ${Object.keys(pricing).length} models with pricing, ${Object.keys(contextLimits).length} with context limits`)
  } catch (err) {
    cachedModelInfo = configuredFallbacks
    log('runtime', `Could not fetch model info: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function getModelInfo() {
  return cachedModelInfo || getConfiguredModelFallbacks()
}

export async function startRuntime(projectDirectory?: string | null): Promise<V2OpencodeClient> {
  if (client) return client
  if (startRuntimePromise) return startRuntimePromise

  startRuntimePromise = (async () => {
    ensureSandboxDirs()
    applyShellEnvironment()
    applyBundledOpencodeCliEnvironment()

    await refreshAccessTokenIntoEnvironment({
      refreshAccessToken: refreshAccessTokenLazy,
      logError: (message) => log('error', message),
    })

    const currentSettings = getEffectiveSettings()
    const providerDescriptor = getProviderDescriptor(currentSettings.effectiveProviderId)
    for (const credential of providerDescriptor?.credentials || []) {
      if (!credential.env) continue
      const value = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, credential.key)
      if (value) process.env[credential.env] = value
    }

    if (currentSettings.effectiveProviderId === 'google-vertex' || currentSettings.effectiveProviderId === 'vertex') {
      const projectId = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, 'projectId')
      const location = getProviderCredentialValue(currentSettings, currentSettings.effectiveProviderId, 'location')
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
      await refreshAccessTokenIntoEnvironment({
        refreshAccessToken: refreshAccessTokenLazy,
        logError: (message) => log('error', message),
      })
    }, 30 * 60 * 1000)

    // Copy AGENTS.md and skills to runtime home (discovered from CWD)
    activeProjectOverlayDirectory = copySkillsAndAgents(projectDirectory)

    // Build config in memory — SDK passes it via OPENCODE_CONFIG_CONTENT env var
    const config = buildRuntimeConfig(projectDirectory)

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
      activeProjectOverlayDirectory = null
      throw err
    }
  })()

  try {
    return await startRuntimePromise
  } finally {
    startRuntimePromise = null
  }
}

export function getClient(): V2OpencodeClient | null {
  return client
}

export function getClientForDirectory(directory?: string | null): V2OpencodeClient | null {
  const normalized = normalizeDirectory(directory)
  return getOrCreateDirectoryClient({
    baseClient: client,
    serverUrl,
    directory: normalized,
    runtimeHomeDir: normalizeDirectory(getRuntimeHomeDir()),
    cache: directoryClients,
    maxEntries: MAX_DIRECTORY_CLIENTS,
    createClient: (baseUrl, scopedDirectory) =>
      createV2OpencodeClient({
        baseUrl,
        directory: scopedDirectory,
      }),
  })
}

export function getV2ClientForDirectory(directory?: string | null): V2OpencodeClient | null {
  return getClientForDirectory(directory)
}

export function getServerUrl() {
  return serverUrl
}

export function getActiveProjectOverlayDirectory() {
  return activeProjectOverlayDirectory
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
  clearProjectOverlayCopies()
  client = null
  serverUrl = null
  cachedModelInfo = null
  activeProjectOverlayDirectory = null
}
