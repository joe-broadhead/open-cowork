import {
  createOpencode,
  createOpencodeClient as createV2OpencodeClient,
  type OpencodeClient as V2OpencodeClient,
} from '@opencode-ai/sdk/v2'
import type { ModelInfoSnapshot } from '@open-cowork/shared'
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'
import {
  getAppConfig,
  getAppDataDir,
  getConfiguredModelFallbacks,
} from './config-loader.ts'
import { log } from './logger.ts'
import { normalizeProviderListResponse } from './provider-utils.ts'
import { buildModelInfoSnapshot } from './model-info-utils.ts'
import { prepareShellEnvironment } from './shell-env.ts'
import { getRuntimeEnvPaths, getRuntimeHomeDir } from './runtime-paths.ts'
import { getAdcPathIfAvailable, getAuthState } from './auth.ts'
import { applyBundledOpencodeCliEnvironment } from './runtime-opencode-cli.ts'
import { clearProjectOverlayCopies } from './runtime-project-overlay.ts'
import { buildRuntimeConfig } from './runtime-config-builder.ts'
import { copySkillsAndAgents } from './runtime-content.ts'
import { getOrCreateDirectoryClient } from './runtime-client-cache.ts'
import { syncRuntimeHomeToolingBridge } from './runtime-home-bridge.ts'
import {
  cleanupOrphanedManagedOpencodeProcesses,
  OPEN_COWORK_MANAGED_RUNTIME_ENV,
  OPEN_COWORK_MANAGED_RUNTIME_VALUE,
  registerTrackedManagedRuntimePid,
  resolveListeningPid,
  unregisterTrackedManagedRuntimePid,
} from './runtime-process-cleanup.ts'

export { getRuntimeHomeDir } from './runtime-paths.ts'

let client: V2OpencodeClient | null = null
let serverUrl: string | null = null
let serverClose: (() => void) | null = null
let tokenRefreshTimer: NodeJS.Timeout | null = null
let startRuntimePromise: Promise<V2OpencodeClient> | null = null
const directoryClients = new Map<string, V2OpencodeClient>()
const MAX_DIRECTORY_CLIENTS = 50
let activeProjectOverlayDirectory: string | null = null
let onDirectoryClientCreated: ((directory: string, client: V2OpencodeClient) => void) | null = null
let onDirectoryClientEvicted: ((directory: string, client: V2OpencodeClient) => void) | null = null
let orphanCleanupComplete = false
let currentRuntimePid: number | null = null

// Cached model info from SDK (populated after runtime starts)
let cachedModelInfo: ModelInfoSnapshot | null = null
// The in-flight promise for the background fetch, if any. `getModelInfoAsync`
// awaits it so the first UI read after boot returns real context limits
// instead of the fallback snapshot (which only covers configured models, not
// the full provider catalog).
let modelInfoPromise: Promise<void> | null = null

async function refreshAccessTokenLazy() {
  const { refreshAccessToken } = await import('./auth.ts')
  return refreshAccessToken()
}

async function refreshAccessTokenSafely() {
  try {
    return (await refreshAccessTokenLazy()) || null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `Access token refresh failed: ${message}`)
    return null
  }
}

// Stops the periodic token-refresh loop. Used by `logoutFromGoogle` so
// a logout call that occurs while the runtime is failing to reboot
// still silences the 30-min refresh spam ("no refresh_token" after the
// tokens file was deleted). `stopRuntime` also clears this; the
// duplicate call is idempotent.
export function stopTokenRefreshTimer() {
  if (tokenRefreshTimer) {
    clearInterval(tokenRefreshTimer)
    tokenRefreshTimer = null
  }
}

// Only attempt a refresh when the app is using Google OAuth AND the
// user has actually completed sign-in. The `mode !== 'none'` check
// alone fired the refresh timer even for signed-out users, producing a
// stream of "Token refresh failed: no refresh_token" errors every 30
// minutes that buried the real failures.
function shouldRefreshAccessTokenOnStartup() {
  if (getAppConfig().auth.mode !== 'google-oauth') return false
  return getAuthState().authenticated
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

// Scope the spawned `opencode` binary to our runtime-home so it cannot
// read from or write to the user's on-machine OpenCode install. We care
// about this for two reasons:
//   1. Non-technical users (our target audience) don't have on-machine
//      OpenCode — leaking their $HOME/.opencode content into our runtime
//      would be surprising, and in the other direction, writing our
//      skills into their real home would be a worse surprise for any
//      user who does have it installed alongside.
//   2. Deterministic behavior — isolation means the app works the same
//      on a fresh laptop as on one that's been hosting another OpenCode
//      install for months.
//
// What we redirect:
//   - XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME / XDG_STATE_HOME:
//     all four XDG base-dir env vars point at `runtime-home/.config`,
//     `.local/share`, `.cache`, `.local/state`. OpenCode and the Google
//     SDKs both honor XDG, so skills, auth tokens, chat history, and
//     all derived state land in our sandbox.
//   - GOOGLE_APPLICATION_CREDENTIALS: our app-scoped ADC path so the
//     subprocess uses the app's OAuth session, not any ADC that might
//     be sitting in the user's real home.
//   - PATH: the bundled `opencode` wrapper dir is prepended in
//     `applyBundledOpencodeCliEnvironment()` (runtime-opencode-cli.ts),
//     so the SDK's `cross-spawn('opencode')` binds to our copy, not a
//     user-installed one on PATH.
//
// What we redirect:
//   - HOME: OpenCode still performs home-relative compatibility
//     discovery (notably `.agents/skills`) in addition to the explicit
//     `skills.paths` we pass in config. Point HOME at `runtime-home` so
//     the SDK only ever sees Cowork-owned state. This keeps the product
//     self-contained and prevents unmanaged machine-local skills from
//     leaking into the runtime catalog. Before launch we bridge a small,
//     curated set of developer-tool config paths into that sandbox so
//     git / ssh / npm keep behaving like the user's normal shell.
//
// We already merge the user's login-shell PATH and environment before
// starting the server, so runtime subprocesses still inherit the shell
// toolchain they need. The thing we are intentionally severing is
// OpenCode's access to the real home directory as a discovery root.
async function withRuntimeEnvironment<T>(fn: () => Promise<T>) {
  const runtimePaths = getRuntimeEnvPaths()
  const previous = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    OPENCODE_DISABLE_CLAUDE_CODE: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT,
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS,
    [OPEN_COWORK_MANAGED_RUNTIME_ENV]: process.env[OPEN_COWORK_MANAGED_RUNTIME_ENV],
  }

  process.env.HOME = runtimePaths.home
  process.env.XDG_CONFIG_HOME = runtimePaths.configHome
  process.env.XDG_DATA_HOME = runtimePaths.dataHome
  process.env.XDG_CACHE_HOME = runtimePaths.cacheHome
  process.env.XDG_STATE_HOME = runtimePaths.stateHome
  // OpenCode's `skills.paths` is additive, not exclusive. Disable
  // Claude compatibility explicitly so the runtime cannot discover the
  // user's real `~/.claude` prompts or skills outside our sandbox.
  process.env.OPENCODE_DISABLE_CLAUDE_CODE = '1'
  process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
  process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1'
  process.env[OPEN_COWORK_MANAGED_RUNTIME_ENV] = OPEN_COWORK_MANAGED_RUNTIME_VALUE

  // Forward the app-level Google OAuth session as ADC to the OpenCode
  // subprocess. Any in-process provider that uses `google-auth-library`
  // (notably `@ai-sdk/google-vertex`) auto-discovers this env var and
  // gets a working service-user token without the user exporting
  // anything to their shell. No-op when the user hasn't completed
  // Google sign-in, or when `auth.mode` isn't `google-oauth`.
  const adcPath = getAdcPathIfAvailable()
  if (adcPath) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath
  }

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
    cachedModelInfo = buildModelInfoSnapshot(providers, configuredFallbacks)
    log('runtime', `Loaded model info: ${Object.keys(cachedModelInfo.pricing).length} models with pricing, ${Object.keys(cachedModelInfo.contextLimits).length} with context limits`)
  } catch (err) {
    cachedModelInfo = configuredFallbacks
    log('runtime', `Could not fetch model info: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function getModelInfo() {
  return cachedModelInfo || getConfiguredModelFallbacks()
}

// Awaits any in-flight background fetch so callers get the real catalog
// instead of a fallback snapshot. Used by `model:info` IPC so the home page's
// first-paint read returns accurate context limits.
export async function getModelInfoAsync() {
  if (modelInfoPromise) {
    try { await modelInfoPromise } catch { /* fallback handled in fetchModelInfo */ }
  }
  return getModelInfo()
}

export async function startRuntime(projectDirectory?: string | null): Promise<V2OpencodeClient> {
  if (client) return client
  if (startRuntimePromise) return startRuntimePromise

  startRuntimePromise = (async () => {
    ensureSandboxDirs()
    await prepareShellEnvironment()
    syncRuntimeHomeToolingBridge()
    applyBundledOpencodeCliEnvironment()

    if (!orphanCleanupComplete) {
      await cleanupOrphanedManagedOpencodeProcesses().catch((error) => {
        log('runtime', `Orphaned runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      orphanCleanupComplete = true
    }

    if (shouldRefreshAccessTokenOnStartup()) {
      await refreshAccessTokenSafely()
    }

    if (tokenRefreshTimer) {
      clearInterval(tokenRefreshTimer)
      tokenRefreshTimer = null
    }

    if (shouldRefreshAccessTokenOnStartup()) {
      // Refresh token periodically (every 30 min)
      tokenRefreshTimer = setInterval(async () => {
        await refreshAccessTokenSafely()
      }, 30 * 60 * 1000)
    }

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
          // SDK defaults this to 5000ms, which is too aggressive on
          // directory-switch reboots — the opencode binary is cold-loading
          // MCPs + doing filesystem scans, and commonly takes 8-15s. When
          // the timeout fires, the SDK tries to kill the child, but the
          // child often survives the signal and becomes a zombie holding
          // ~50MB RSS + MCP subprocesses. After several failed reboots
          // the zombies can accumulate to multi-GB. Give it real room.
          timeout: 30_000,
        } as Parameters<typeof createOpencode>[0] & { timeout?: number }),
      )

      client = result.client
      serverUrl = result.server.url
      serverClose = result.server.close
      const runtimePid = resolveListeningPid(new URL(result.server.url).port ? Number.parseInt(new URL(result.server.url).port, 10) : 0)
      if (runtimePid) {
        currentRuntimePid = runtimePid
        registerTrackedManagedRuntimePid(runtimePid)
      }
      directoryClients.clear()
      // Load model pricing and context limits in the background.
      // The renderer can boot immediately using configured fallbacks, and
      // any IPC read via `getModelInfoAsync()` will await this promise so
      // it returns real data as soon as the fetch completes.
      modelInfoPromise = fetchModelInfo(client).finally(() => {
        modelInfoPromise = null
      })

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
      currentRuntimePid = null
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
    onCreate: (scopedClient, scopedDirectory) => {
      onDirectoryClientCreated?.(scopedDirectory, scopedClient)
    },
    onEvict: (scopedClient, scopedDirectory) => {
      onDirectoryClientEvicted?.(scopedDirectory, scopedClient)
    },
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

export function setDirectoryClientLifecycleHandlers(handlers: {
  onCreate?: ((directory: string, client: V2OpencodeClient) => void) | null
  onEvict?: ((directory: string, client: V2OpencodeClient) => void) | null
}) {
  onDirectoryClientCreated = handlers.onCreate || null
  onDirectoryClientEvicted = handlers.onEvict || null
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
  if (currentRuntimePid) {
    unregisterTrackedManagedRuntimePid(currentRuntimePid)
    currentRuntimePid = null
  }
  directoryClients.clear()
  clearProjectOverlayCopies()
  client = null
  serverUrl = null
  cachedModelInfo = null
  activeProjectOverlayDirectory = null
}
