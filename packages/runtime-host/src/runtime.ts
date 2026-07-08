import { buildModelInfoSnapshot } from './model-info-utils.js'
import { asRecord, readString } from '@open-cowork/shared'
import {
  createOpencodeClient,
  type Auth as OpencodeAuth,
  type OpencodeClient as V2OpencodeClient,
  type OpencodeClientConfig,
} from '@opencode-ai/sdk/v2'
import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  getAppConfig,
  getAppDataDir,
  getConfiguredModelFallbacks,
} from './config-loader-core.js'
import { log } from '@open-cowork/shared/node'
import { ensureAgentToolBridge, stopAgentToolBridge } from './agent-tool-bridge.js'
import { ensureWorkflowToolBridge, stopWorkflowToolBridge } from './workflow/workflow-tool-bridge.js'
import { ensureKnowledgeToolBridge, stopKnowledgeToolBridge } from './knowledge/knowledge-tool-bridge.js'
import { ensureSemanticUiBridge, stopSemanticUiBridge } from './semantic-ui-bridge.js'
import { normalizeProviderListResponse } from './provider-utils.js'
import { prepareShellEnvironment } from './shell-env.js'
import {
  getRuntimeEnvPaths,
  getRuntimeEnvPathsForSource,
  getRuntimeHomeDir,
  getRuntimeWorkingDirectoryForSource,
  type RuntimeConfigSource,
} from './runtime-paths.js'
import { getAdcPathIfAvailable, getAuthState } from './auth.js'
import { getEffectiveSettings, getProviderCredentialValue } from './settings.js'
import {
  applyBundledOpencodeCliEnvironment,
  getBundledOpencodeSdkVersion,
  readBundledOpencodeCliVersion,
} from './runtime-opencode-cli.js'
import { clearProjectOverlayCopies } from './runtime-project-overlay.js'
import { buildRuntimeConfigForRuntime } from './runtime-config-builder.js'
import { preflightConfiguredCapabilityBundlesForRuntime } from './capability-bundle-runtime-preflight.js'
import { recordCurrentRuntimeComponentVerification } from './runtime-component-manifest.js'
import { copySkillsAndAgents } from './runtime-content.js'
import { getOrCreateDirectoryClient } from './runtime-client-cache.js'
import { syncRuntimeHomeToolingBridge } from './runtime-home-bridge.js'
import { verifyRuntimeSkillCatalog } from './runtime-skill-verifier.js'
import {
  createManagedOpencodeServer,
  createManagedOpencodeServerAuth,
  type ManagedOpencodeServerAuth,
  type ManagedOpencodeServerLogLevel,
  type ManagedOpencodeServerUnexpectedExit,
} from './runtime-managed-server.js'
import { buildManagedRuntimeEnvironment } from './runtime-environment.js'
import {
  cleanupOrphanedManagedOpencodeProcesses,
  registerTrackedManagedRuntimePid,
  resolveListeningPid,
  terminateManagedRuntimePid,
} from './runtime-process-cleanup.js'
import { MAX_DIRECTORY_CLIENTS, runtimeState } from './runtime-state.js'
import { sdkErrorMessage } from './sdk-error.js'
export { getRuntimeHomeDir } from './runtime-paths.js'
export { buildManagedRuntimeEnvironment } from './runtime-environment.js'
export {
  buildManagedOpencodeServerEnvironment,
  createManagedOpencodeServer,
  drainManagedOpencodeProcessOutput,
  parseManagedOpencodeServerStdoutChunk,
  resolveManagedOpencodeCommand,
  resolveManagedOpencodeSpawn,
  type ManagedOpencodeServerStdoutParseResult,
  type ManagedProcessOutputStreams,
} from './runtime-managed-server.js'

// RuntimeState owns the mutable singleton lifecycle fields for the managed
// OpenCode server, directory-scoped SDK clients, and model-info cache.

type RuntimeStartupPlan = {
  settings: ReturnType<typeof getEffectiveSettings>
  runtimeConfigSource: RuntimeConfigSource
  useMachineOpenCodeConfig: boolean
  shouldRefreshAccessToken: boolean
}

type CreateOpencodeOptions = OpencodeServerOptions & {
  timeout?: number
  logLevel?: ManagedOpencodeServerLogLevel
}

type StartRuntimeOptions = {
  onUnexpectedExit?: ((event: ManagedOpencodeServerUnexpectedExit) => void) | null
}

type AppInfoCapableClient = {
  app?: {
    info?: () => Promise<{ data?: unknown }>
  }
}

async function refreshAccessTokenLazy() {
  const { refreshAccessToken } = await import('./auth.js')
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
  runtimeState.stopTokenRefreshTimer()
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

function computeRuntimeStartupPlan(settings = getEffectiveSettings()): RuntimeStartupPlan {
  const runtimeConfigSource: RuntimeConfigSource = settings.runtimeConfigSource === 'machine' ? 'machine' : 'app'
  return {
    settings,
    runtimeConfigSource,
    useMachineOpenCodeConfig: runtimeConfigSource === 'machine',
    shouldRefreshAccessToken: shouldRefreshAccessTokenOnStartup(),
  }
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

export function getRuntimeOpencodeAuthPath() {
  return join(getRuntimeEnvPaths().dataHome, 'opencode', 'auth.json')
}

// Provider auth is always app-owned: the managed runtime writes provider
// auth under Cowork's runtime data directory, never into the user's real
// OpenCode auth store. The symlink removal below clears any leftover
// native-store bridge link created by older builds so the runtime auth
// path is a regular app-owned file again (audit #869).
export function ensureIsolatedProviderAuthStore() {
  const runtimeAuthPath = getRuntimeOpencodeAuthPath()
  mkdirSync(dirname(runtimeAuthPath), { recursive: true })

  try {
    if (lstatSync(runtimeAuthPath).isSymbolicLink()) {
      rmSync(runtimeAuthPath, { force: true })
    }
  } catch {
    // No runtime auth path exists yet.
  }
}

async function syncProviderApiAuth(c: V2OpencodeClient) {
  const settings = getEffectiveSettings()
  const descriptors = getAppConfig().providers.descriptors || {}
  await Promise.all(Object.entries(descriptors).map(async ([providerID, descriptor]) => {
    if (descriptor.runtime !== 'builtin') return
    const apiKeyCredential = descriptor.credentials.find((credential) => (
      credential.runtimeKey === 'apiKey' || credential.key === 'apiKey'
    ))
    if (!apiKeyCredential) return
    const key = getProviderCredentialValue(settings, providerID, apiKeyCredential.key)
    if (!key) return
    try {
      const auth: OpencodeAuth = {
        type: 'api',
        key,
        metadata: { source: 'open-cowork' },
      }
      await c.auth.set({ providerID, auth }, { throwOnError: true })
      log('provider', `Synced OpenCode API auth for ${providerID}`)
    } catch (err) {
      log('provider', `Could not sync OpenCode API auth for ${providerID}: ${sdkErrorMessage(err)}`)
    }
  }))
}

// Scope the spawned `opencode` binary to our runtime-home so it cannot
// read from or write app config to the user's on-machine OpenCode install.
// Provider auth is also app-owned; there is no setting that shares
// OpenCode's native auth store with the managed runtime. We care about
// this isolation for two reasons:
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
//     SDKs both honor XDG, so skills, provider auth, chat history, and
//     derived state all land in our sandbox.
//   - GOOGLE_APPLICATION_CREDENTIALS: our app-scoped ADC path so the
//     subprocess uses the app's OAuth session, not any ADC that might
//     be sitting in the user's real home.
//   - Bundled OpenCode binary / PATH: `applyBundledOpencodeCliEnvironment()`
//     resolves the bundled native binary and prepends its directory to PATH.
//     The managed server launcher receives that app-owned binary path as a
//     separate argument when available, avoiding a user-installed PATH hit.
//
// What we redirect:
//   - HOME: OpenCode still performs home-relative compatibility
//     discovery (notably `.agents/skills`). Point HOME at `runtime-home`
//     so the SDK only ever sees Cowork-owned state. This keeps the product
//     self-contained and prevents unmanaged machine-local skills from
//     leaking into the runtime catalog. Before launch we bridge a small,
//     curated set of developer-tool config paths into that sandbox so
//     git / ssh / npm keep behaving like the user's normal shell.
//
// The SDK's server helper currently launches `opencode` with
// `{ ...process.env }` and does not expose an env option. Keep OpenCode
// itself as the runtime and keep SDK v2 as the API boundary, but own this
// small spawn adapter so the child receives an explicit curated env. This
// avoids both broad secret forwarding and any temporary mutation of the
// Electron main process environment.
async function createManagedOpencode(
  options: OpencodeServerOptions & { logLevel?: ManagedOpencodeServerLogLevel },
  opencodeBinPath?: string | null,
  runtimeConfigSource: RuntimeConfigSource = 'app',
  onUnexpectedExit?: ((event: ManagedOpencodeServerUnexpectedExit) => void) | null,
) {
  const runtimePaths = getRuntimeEnvPathsForSource(runtimeConfigSource)
  // Forward the app-level Google OAuth session as ADC to the OpenCode
  // subprocess. Any in-process provider that uses `google-auth-library`
  // (notably `@ai-sdk/google-vertex`) auto-discovers this env var and
  // gets a working service-user token without the user exporting
  // anything to their shell. No-op when the user hasn't completed
  // Google sign-in, or when `auth.mode` isn't `google-oauth`.
  const adcPath = getAdcPathIfAvailable()
  const auth = createManagedOpencodeServerAuth()
  const env = buildManagedRuntimeEnvironment({
    currentEnv: process.env,
    runtimePaths,
    adcPath,
    enableNativeWebSearch: shouldEnableNativeWebSearch(),
    serverAuth: auth,
  })
  const server = await createManagedOpencodeServer({
    ...options,
    cwd: getRuntimeWorkingDirectoryForSource(runtimeConfigSource),
    env,
    onUnexpectedExit: (event) => {
      log('runtime', `Managed OpenCode server exited unexpectedly: code=${event.code ?? 'null'} signal=${event.signal ?? 'null'}`)
      onUnexpectedExit?.(event)
    },
    opencodeBinPath,
  })
  const managedClient = createOpencodeClient(buildManagedOpencodeClientConfig(server.url, auth))
  return {
    client: managedClient,
    server,
    auth,
  }
}

export function buildManagedOpencodeClientConfig(
  baseUrl: string,
  auth: ManagedOpencodeServerAuth,
  directory?: string | null,
): OpencodeClientConfig & { directory?: string } {
  return {
    baseUrl,
    headers: {
      Authorization: auth.authorizationHeader,
    },
    ...(directory ? { directory } : {}),
  }
}

export function shouldEnableNativeWebSearch() {
  const permissions = getAppConfig().permissions
  return permissions.web !== 'deny' && permissions.webSearch !== false
}

async function fetchModelInfo(c: V2OpencodeClient) {
  const configuredFallbacks = getConfiguredModelFallbacks()
  try {
    const result = await c.provider.list()
    const providers = normalizeProviderListResponse(result.data)
    const modelInfo = buildModelInfoSnapshot(providers, configuredFallbacks)
    runtimeState.setCachedModelInfo(modelInfo)
    log('runtime', `Loaded model info: ${Object.keys(modelInfo.pricing).length} models with pricing, ${Object.keys(modelInfo.contextLimits).length} with context limits`)
  } catch (err) {
    runtimeState.setCachedModelInfo(configuredFallbacks)
    log('runtime', `Could not fetch model info: ${sdkErrorMessage(err)}`)
  }
}

async function readSdkAppInfoVersion(client: V2OpencodeClient) {
  const appInfo = (client as unknown as AppInfoCapableClient).app?.info
  if (!appInfo) return null
  try {
    const result = await appInfo()
    const data = asRecord(result.data)
    const info = asRecord(data.info)
    return readString(data.version) || readString(info.version)
  } catch {
    return null
  }
}

async function logRuntimeVersions(
  client: V2OpencodeClient,
  bundledOpencodeEnv: ReturnType<typeof applyBundledOpencodeCliEnvironment>,
) {
  const sdkVersion = getBundledOpencodeSdkVersion() || 'unknown'
  const appInfoVersion = await readSdkAppInfoVersion(client)
  const cliVersion = appInfoVersion || await readBundledOpencodeCliVersion(bundledOpencodeEnv)
  const source = appInfoVersion ? 'sdk app.info' : 'cli --version'
  log('runtime', `OpenCode runtime versions: sdk=${sdkVersion} cli=${cliVersion || 'unknown'} source=${source}`)
}

async function prepareRuntimeSandbox(plan: RuntimeStartupPlan) {
  ensureSandboxDirs()
  ensureIsolatedProviderAuthStore()
  await prepareShellEnvironment()
  syncRuntimeHomeToolingBridge({
    enabled: !plan.useMachineOpenCodeConfig && plan.settings.runtimeToolingBridgeEnabled,
  })
}

async function cleanupRuntimeOrphansOnce() {
  if (runtimeState.isOrphanCleanupComplete()) return
  await cleanupOrphanedManagedOpencodeProcesses().catch((error) => {
    log('runtime', `Orphaned runtime cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  runtimeState.markOrphanCleanupComplete()
}

async function configureRuntimeTokenRefresh(plan: RuntimeStartupPlan) {
  if (plan.shouldRefreshAccessToken) {
    await refreshAccessTokenSafely()
  }

  runtimeState.stopTokenRefreshTimer()

  if (plan.shouldRefreshAccessToken) {
    // Refresh token periodically (every 30 min)
    runtimeState.setTokenRefreshTimer(setInterval(async () => {
      await refreshAccessTokenSafely()
    }, 30 * 60 * 1000))
  }
}

async function buildRuntimeConfigForStartup(
  plan: RuntimeStartupPlan,
  projectDirectory?: string | null,
) {
  // App mode composes a deterministic OpenCode config and skill catalog.
  // Machine mode is an explicit advanced escape hatch: OpenCode reads the
  // user's native config/auth/skills/agents from their real HOME/XDG roots,
  // and Cowork does not inject app-owned agents, MCPs, or provider auth.
  runtimeState.setActiveProjectOverlayDirectory(
    plan.useMachineOpenCodeConfig ? null : copySkillsAndAgents(projectDirectory),
  )

  if (plan.useMachineOpenCodeConfig) return undefined
  await ensureAgentToolBridge()
  await ensureWorkflowToolBridge()
  await ensureKnowledgeToolBridge()
  await ensureSemanticUiBridge()
  return buildRuntimeConfigForRuntime(projectDirectory)
}

function buildManagedServerOptions(config: Awaited<ReturnType<typeof buildRuntimeConfigForStartup>>): CreateOpencodeOptions {
  return {
    hostname: '127.0.0.1',
    port: 0,
    config,
    // Cowork projects runtime state through SDK events and its own bounded
    // logs. Keep OpenCode's managed-server logs quiet, but avoid WARN:
    // OpenCode 1.15.x suppresses the startup "server listening" line at WARN,
    // and the supervisor needs that line to learn the ephemeral port.
    logLevel: 'ERROR',
    // SDK defaults this to 5000ms, which is too aggressive on
    // directory-switch reboots — the opencode binary is cold-loading
    // MCPs + doing filesystem scans, and commonly takes 8-15s. When
    // the timeout fires, the SDK tries to kill the child, but the
    // child often survives the signal and becomes a zombie holding
    // ~50MB RSS + MCP subprocesses. After several failed reboots
    // the zombies can accumulate to multi-GB. Give it real room.
    timeout: 30_000,
  }
}

function setRuntimeModelInfoFetch(client: V2OpencodeClient) {
  // Load model pricing and context limits in the background.
  // The renderer can boot immediately using configured fallbacks, and
  // any IPC read via `getModelInfoAsync()` will await this promise so
  // it returns real data as soon as the fetch completes.
  runtimeState.setModelInfoPromise(fetchModelInfo(client).finally(() => {
    runtimeState.setModelInfoPromise(null)
  }))
}

async function registerStartedRuntime(
  result: Awaited<ReturnType<typeof createManagedOpencode>>,
  plan: RuntimeStartupPlan,
) {
  runtimeState.setClient(result.client)
  runtimeState.setServerUrl(result.server.url)
  runtimeState.setServerAuth(result.auth)
  runtimeState.setServerClose(result.server.close)
  if (!plan.useMachineOpenCodeConfig) {
    await syncProviderApiAuth(result.client)
    void verifyRuntimeSkillCatalog(result.client, getRuntimeHomeDir())
  }
  const runtimePid = resolveListeningPid(new URL(result.server.url).port ? Number.parseInt(new URL(result.server.url).port, 10) : 0)
  if (runtimePid) {
    runtimeState.setCurrentRuntimePid(runtimePid)
    registerTrackedManagedRuntimePid(runtimePid)
  }
  runtimeState.clearDirectoryClients()
  setRuntimeModelInfoFetch(result.client)
}

async function cleanupFailedRuntimeStart() {
  runtimeState.stopTokenRefreshTimer()
  const failedServerClose = runtimeState.takeServerClose()
  if (failedServerClose) failedServerClose()
  const failedRuntimePid = runtimeState.takeCurrentRuntimePid()
  if (failedRuntimePid) await terminateManagedRuntimePid(failedRuntimePid)
  runtimeState.resetRuntimeSessionState()
}

export function getModelInfo() {
  return runtimeState.getCachedModelInfo() || getConfiguredModelFallbacks()
}

// Awaits any in-flight background fetch so callers get the real catalog
// instead of a fallback snapshot. Used by `model:info` IPC so the home page's
// first-paint read returns accurate context limits.
export async function getModelInfoAsync() {
  const modelInfoPromise = runtimeState.getModelInfoPromise()
  if (modelInfoPromise) {
    try { await modelInfoPromise } catch { /* fallback handled in fetchModelInfo */ }
  }
  return getModelInfo()
}

export async function startRuntime(
  projectDirectory?: string | null,
  options: StartRuntimeOptions = {},
): Promise<V2OpencodeClient> {
  const existingClient = runtimeState.getClient()
  if (existingClient) return existingClient
  const existingStart = runtimeState.getStartRuntimePromise()
  if (existingStart) return existingStart

  const startRuntimePromise = (async () => {
    const plan = computeRuntimeStartupPlan()
    await prepareRuntimeSandbox(plan)
    const bundledOpencodeEnv = applyBundledOpencodeCliEnvironment()
    await recordCurrentRuntimeComponentVerification({ bundledOpencodeEnv })
    await cleanupRuntimeOrphansOnce()
    await configureRuntimeTokenRefresh(plan)

    if (!plan.useMachineOpenCodeConfig) {
      preflightConfiguredCapabilityBundlesForRuntime({ productMode: 'desktop-local' })
    }

    const config = await buildRuntimeConfigForStartup(plan, projectDirectory)

    try {
      const result = await createManagedOpencode(
        buildManagedServerOptions(config),
        bundledOpencodeEnv.opencodeBinPath,
        plan.runtimeConfigSource,
        options.onUnexpectedExit,
      )

      await registerStartedRuntime(result, plan)
      await logRuntimeVersions(result.client, bundledOpencodeEnv)
      log('runtime', `OpenCode server started at ${result.server.url}`)
      return result.client
    } catch (err) {
      await cleanupFailedRuntimeStart()
      throw err
    }
  })()
  runtimeState.setStartRuntimePromise(startRuntimePromise)

  try {
    return await startRuntimePromise
  } finally {
    runtimeState.clearStartRuntimePromise()
  }
}

export function getClient(): V2OpencodeClient | null {
  return runtimeState.getClient()
}

export function getClientForDirectory(directory?: string | null): V2OpencodeClient | null {
  const normalized = normalizeDirectory(directory)
  const serverUrl = runtimeState.getServerUrl()
  const serverAuth = runtimeState.getServerAuth()
  return getOrCreateDirectoryClient({
    baseClient: runtimeState.getClient(),
    serverUrl,
    directory: normalized,
    runtimeHomeDir: normalizeDirectory(getRuntimeHomeDir()),
    cache: runtimeState.getDirectoryClientCacheForRuntime(),
    maxEntries: MAX_DIRECTORY_CLIENTS,
    createClient: (baseUrl, scopedDirectory) =>
      createOpencodeClient(serverAuth
        ? buildManagedOpencodeClientConfig(baseUrl, serverAuth, scopedDirectory)
        : { baseUrl, directory: scopedDirectory }),
    onCreate: (scopedClient, scopedDirectory) => {
      runtimeState.getDirectoryClientCreatedHandler()?.(scopedDirectory, scopedClient)
    },
    onEvict: (scopedClient, scopedDirectory) => {
      log('runtime', `Evicting directory-scoped OpenCode client for ${scopedDirectory}`)
      runtimeState.getDirectoryClientEvictedHandler()?.(scopedDirectory, scopedClient)
    },
  })
}

export function getV2ClientForDirectory(directory?: string | null): V2OpencodeClient | null {
  return getClientForDirectory(directory)
}

export function getServerUrl() {
  return runtimeState.getServerUrl()
}

export function getActiveProjectOverlayDirectory() {
  return runtimeState.getActiveProjectOverlayDirectory()
}

export function setDirectoryClientLifecycleHandlers(handlers: {
  onCreate?: ((directory: string, client: V2OpencodeClient) => void) | null
  onEvict?: ((directory: string, client: V2OpencodeClient) => void) | null
}) {
  runtimeState.setDirectoryClientLifecycleHandlers(handlers)
}

export async function stopRuntime() {
  runtimeState.clearStartRuntimePromise()
  runtimeState.stopTokenRefreshTimer()
  stopAgentToolBridge()
  stopWorkflowToolBridge()
  stopKnowledgeToolBridge()
  stopSemanticUiBridge()
  const serverClose = runtimeState.takeServerClose()
  if (serverClose) serverClose()
  const currentRuntimePid = runtimeState.takeCurrentRuntimePid()
  if (currentRuntimePid) await terminateManagedRuntimePid(currentRuntimePid)
  clearProjectOverlayCopies()
  runtimeState.resetAfterStop()
}
