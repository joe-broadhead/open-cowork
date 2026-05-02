import { app, BrowserWindow, ipcMain, Menu, shell, nativeImage, session as electronSession } from 'electron'
import type { WebContents } from 'electron'
import {
  AGENTS_SHORTCUT,
  CAPABILITIES_SHORTCUT,
  COMMAND_PALETTE_SHORTCUT,
  NEW_THREAD_SHORTCUT,
  SEARCH_THREADS_SHORTCUT,
  SETTINGS_SHORTCUT,
} from '@open-cowork/shared'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { setupIpcHandlers } from './ipc-handlers.ts'
import {
  getActiveProjectOverlayDirectory,
  getRuntimeHomeDir,
  setDirectoryClientLifecycleHandlers,
  startRuntime,
  stopRuntime,
} from './runtime.ts'
import { isSandboxWorkspaceDir } from './runtime-paths.ts'
import { subscribeToEvents, getMcpStatus } from './events.ts'
import { flushSessionRegistryWrites } from './session-registry.ts'
import { assertConfigValid, getAppConfig, getBranding, getConfiguredMcpsFromConfig } from './config-loader.ts'
import { applySettingsSideEffects, isSetupComplete, loadSettings } from './settings.ts'
import { publishNotification } from './session-event-dispatcher.ts'
import { createPromiseChain } from './promise-chain.ts'
import { createWindowState } from './window-state.ts'
import { configureAutomationService, startAutomationService, stopAutomationService } from './automation-service.ts'
import { setRuntimeError, setRuntimeReady } from './runtime-status.ts'
import { registerRuntimeDirectoryEnsurer } from './runtime-context.ts'
import { pruneOldUnreferencedSandboxStorage } from './sandbox-storage.ts'
import { projectHasOverlayContent } from './runtime-project-overlay.ts'
import { syncReadableSkillMirror } from './runtime-skill-catalog.ts'
import { attachContentSecurityPolicy } from './content-security-policy.ts'
import { listCustomMcps } from './native-customizations.ts'
import {
  isExpectedPackagedRendererFile,
  needsMainWindowRecovery,
  pickRecoverableMainWindow,
  rendererUrlLooksWrong,
  shouldRecoverMainWindowFromDidFailLoad,
} from './main-window-lifecycle.ts'
import {
  createRuntimeEventSubscriptionManager,
} from './event-subscriptions.ts'
import { primeShellEnvironment } from './shell-env.ts'
import { listReadyGoogleAuthLocalMcpNames } from './runtime-mcp.ts'
import { shouldScheduleRuntimeReconnect } from './runtime-reconnect-policy.ts'
import { registerBrandingAssetProtocol, registerBrandingAssetScheme } from './branding-assets.ts'

import { log, getLogFilePath, closeLogger } from './logger.ts'
import { telemetry } from './telemetry.ts'

registerBrandingAssetScheme()

let mainWindow: BrowserWindow | null = null
let runtimeStarted = false
let reconnectTimer: NodeJS.Timeout | null = null
let startupCleanupDone = false
let appCleanupStarted = false
let appCleanupFinished = false
let appCleanupPromise: Promise<void> | null = null
let runtimeProjectDirectory: string | null = null
let mainWindowRecoveryTimer: NodeJS.Timeout | null = null
let appIsQuitting = false
const branding = getBranding()

async function getAuthStateLazy() {
  const { getAuthState } = await import('./auth.ts')
  return getAuthState()
}

app.name = branding.name
try {
  const explicitUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR?.trim()
  app.setPath('userData', explicitUserDataDir ? resolve(explicitUserDataDir) : join(app.getPath('appData'), branding.name))
} catch {
  // Fall back to Electron's default userData path when branding override is unavailable.
}

const hasSingleInstanceLock = process.env.OPEN_COWORK_E2E === '1'
  ? true
  : app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

function getMainWindow() {
  return mainWindow
}

const guardedWebContents = new WeakSet<WebContents>()

function openExternalNavigation(url: string) {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      log('security', `Blocked external navigation to unsupported protocol: ${parsed.protocol}`)
      return
    }
  } catch {
    log('security', 'Blocked malformed external navigation target')
    return
  }

  void shell.openExternal(url).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    log('error', `Failed to open external URL: ${message}`)
  })
}

function rendererNavigationIsAllowed(contents: WebContents, url: string) {
  if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) return true
  const currentUrl = contents.getURL()
  if (currentUrl && url === currentUrl) return true
  if (isExpectedPackagedRendererFile(url, expectedRendererEntryPath())) return true
  return false
}

function attachWebContentsSecurityGuards(contents: WebContents) {
  if (guardedWebContents.has(contents)) return
  guardedWebContents.add(contents)

  contents.on('will-navigate', (event, url) => {
    if (rendererNavigationIsAllowed(contents, url)) return
    event.preventDefault()
    openExternalNavigation(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternalNavigation(url)
    return { action: 'deny' }
  })
}

function attachPermissionGuards() {
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log('security', `Denied renderer permission request: ${permission}`)
    callback(false)
  })
  electronSession.defaultSession.setPermissionCheckHandler(() => false)
}

// Convert a repo URL like `https://github.com/joe-broadhead/open-cowork`
// into its issues URL. Returns null for non-GitHub hosts so the caller
// falls back to the raw helpUrl; downstream forks on GitLab or an
// internal instance set helpUrl directly to their support surface.
function toGithubIssuesUrl(helpUrl: string): string | null {
  try {
    const parsed = new URL(helpUrl)
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length < 2) return null
    const [owner, repoRaw] = segments
    const repo = repoRaw.replace(/\.git$/, '')
    return `https://github.com/${owner}/${repo}/issues/new/choose`
  } catch {
    return null
  }
}

const eventSubscriptions = createRuntimeEventSubscriptionManager({
  getMainWindow,
  subscribe: subscribeToEvents,
  onError: (error, directory) => {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `Event subscription error${directory ? ` (${directory})` : ''}: ${message}`)
    if (directory && directory !== getRuntimeHomeDir()) {
      return 'retry-subscription'
    }
    scheduleReconnect()
    return 'restart-runtime'
  },
})

setDirectoryClientLifecycleHandlers({
  onCreate: (directory, client) => {
    eventSubscriptions.ensure(directory, client)
  },
  onEvict: (directory) => {
    eventSubscriptions.stop(directory)
  },
})

function clearMainWindowRecoveryTimer() {
  if (!mainWindowRecoveryTimer) return
  clearTimeout(mainWindowRecoveryTimer)
  mainWindowRecoveryTimer = null
}

function getPackagedResourcePath(...segments: string[]) {
  if (app.isPackaged) {
    return join(process.resourcesPath, ...segments)
  }
  return join(__dirname, '../../resources', ...segments)
}

async function maybeStartRuntimeOnLaunch() {
  if (runtimeStarted) return
  if ((await getAuthStateLazy()).authenticated && isSetupComplete()) {
    log('main', 'Runtime prerequisites satisfied, starting runtime')
    void bootRuntime().catch((err: unknown) => {
      log('error', `Deferred runtime startup failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  } else {
    log('main', 'Waiting for setup or authentication before starting runtime')
  }
}

function expectedRendererEntryPath() {
  return join(__dirname, '../index.html')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function startupSplashTemplatePath() {
  const builtSplash = join(__dirname, '../startup-splash.html')
  if (existsSync(builtSplash)) return builtSplash
  return join(__dirname, '../../public/startup-splash.html')
}

function startupSplashPath() {
  const templatePath = startupSplashTemplatePath()
  try {
    const brandName = escapeHtml(branding.name)
    const html = readFileSync(templatePath, 'utf8').replaceAll('Open Cowork', () => brandName)
    const outputDir = join(app.getPath('userData'), 'startup')
    mkdirSync(outputDir, { recursive: true })
    const outputPath = join(outputDir, 'startup-splash.html')
    writeFileSync(outputPath, html)
    return outputPath
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('main', `Falling back to packaged startup splash: ${message}`)
    return templatePath
  }
}

function adoptExistingMainWindow() {
  const candidate = pickRecoverableMainWindow(mainWindow, BrowserWindow.getAllWindows())
  if (candidate !== mainWindow) {
    mainWindow = candidate
  }
  return candidate
}

function ensureMainWindowRenderer(window = adoptExistingMainWindow()) {
  if (!window || window.isDestroyed()) return
  const currentUrl = window.webContents.getURL()
  if (!rendererUrlLooksWrong(currentUrl, process.env.VITE_DEV_SERVER_URL)) return
  log('main', `Renderer loaded unexpected URL, restoring shell: ${currentUrl || '(empty)'}`)
  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(expectedRendererEntryPath())
  }
}

function revealMainWindow(window: BrowserWindow, reason: string) {
  if (window.isDestroyed()) return
  ensureMainWindowRenderer(window)
  if (window.isMinimized()) {
    window.restore()
  }
  if (!window.isVisible()) {
    window.show()
  }
  window.moveTop()
  app.focus({ steal: true })
  window.focus()

  if (!window.isFocused()) {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.moveTop()
    app.focus({ steal: true })
    window.focus()
    setTimeout(() => {
      if (window.isDestroyed()) return
      window.setVisibleOnAllWorkspaces(false)
    }, 400)
  }

  if (needsMainWindowRecovery(window)) {
    scheduleMainWindowRecovery(reason, 800)
    return
  }
  clearMainWindowRecoveryTimer()
}

function recreateMainWindow(reason: string) {
  log('main', `Recreating main window due to ${reason}`)
  clearMainWindowRecoveryTimer()
  const existing = mainWindow
  mainWindow = null
  if (existing && !existing.isDestroyed()) {
    existing.destroy()
  }
  createWindow(reason)
}

function windowIsStillBooting(window: BrowserWindow) {
  if (window.isDestroyed()) return false
  const currentUrl = window.webContents.getURL()
  return window.webContents.isLoadingMainFrame() || currentUrl.length === 0
}

function scheduleMainWindowRecovery(reason: string, delayMs = 1200) {
  clearMainWindowRecoveryTimer()
  mainWindowRecoveryTimer = setTimeout(() => {
    mainWindowRecoveryTimer = null
    const window = adoptExistingMainWindow()
    if (!window) {
      recreateMainWindow(`missing window after ${reason}`)
      return
    }
    if (windowIsStillBooting(window)) {
      log('main', `Deferring window recovery while renderer is still booting (${reason})`)
      scheduleMainWindowRecovery(`${reason} (booting)`, delayMs)
      return
    }
    if (!needsMainWindowRecovery(window)) return
    revealMainWindow(window, `${reason} recovery`)
    if (!needsMainWindowRecovery(window)) return
    recreateMainWindow(`window recovery after ${reason}`)
  }, delayMs)
}

function showOrCreateMainWindow(reason = 'activate') {
  const window = adoptExistingMainWindow()
  if (!window) {
    createWindow(reason)
    return
  }
  revealMainWindow(window, reason)
}

function createWindow(reason = 'startup') {
  clearMainWindowRecoveryTimer()
  const mainWindowState = createWindowState(1200, 800)

  const window = new BrowserWindow({
    x: mainWindowState.bounds.x,
    y: mainWindowState.bounds.y,
    width: mainWindowState.bounds.width,
    height: mainWindowState.bounds.height,
    minWidth: 800,
    minHeight: 600,
    show: true,
    icon: getPackagedResourcePath('icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: '#00000000',
    transparent: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  mainWindowState.manage(window)

  const revealCurrentWindow = (source: string) => {
    if (mainWindow !== window || window.isDestroyed()) return
    const bounds = window.getBounds()
    log('main', `Revealing main window (${source}) x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height} visible=${String(window.isVisible())} minimized=${String(window.isMinimized())}`)
    if (mainWindowState.isMaximized) {
      window.maximize()
    }
    revealMainWindow(window, source)
  }

  window.webContents.setZoomFactor(1)
  window.webContents.on('zoom-changed', () => {
    window.webContents.setZoomFactor(1)
  })
  window.webContents.on('did-finish-load', () => {
    log('renderer', 'Renderer did-finish-load')
    revealCurrentWindow('did-finish-load')
  })
  window.once('ready-to-show', () => {
    revealCurrentWindow('ready-to-show')
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log('error', `Renderer did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${String(isMainFrame)}`)
    if (!shouldRecoverMainWindowFromDidFailLoad({ isMainFrame, validatedURL })) {
      return
    }
    scheduleMainWindowRecovery('did-fail-load', 300)
  })
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('renderer', `console[${level}] ${sourceId}:${line} ${message}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', `Renderer process gone: reason=${details.reason} exitCode=${String(details.exitCode)}`)
    scheduleMainWindowRecovery('render-process-gone', 100)
  })

  void window.loadFile(startupSplashPath())
  if (process.env.VITE_DEV_SERVER_URL) {
    log('main', 'Opening DevTools because VITE_DEV_SERVER_URL is set for a development renderer.')
    window.webContents.openDevTools({ mode: 'detach' })
  }

  scheduleMainWindowRecovery(reason, 4000)

  window.on('closed', () => {
    clearMainWindowRecoveryTimer()
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  window.on('close', (event) => {
    if (appIsQuitting) return
    const settings = loadSettings()
    if (!settings.automationRunInBackground) return
    event.preventDefault()
    window.hide()
  })

  attachWebContentsSecurityGuards(window.webContents)

  return window
}

let mcpInterval: NodeJS.Timeout | null = null
const MAX_STARTUP_MCP_RECOVERY_ATTEMPTS = 3

function recoverableLocalMcpNames() {
  return new Set([
    'charts',
    ...getConfiguredMcpsFromConfig()
      .filter((mcp) => mcp.type === 'local')
      .map((mcp) => mcp.name),
  ])
}

// Singleton for rebootRuntime: without it, concurrent ensureRuntimeForDirectory
// calls for a new project directory each kick off their own stopRuntime +
// bootRuntime pair, spawning disjoint OpenCode server instances. A session
// created on one of those intermediate servers then becomes unreachable from
// the client pointing at the final server, and the UI hangs waiting for
// events that can never arrive.
let rebootRuntimePromise: Promise<void> | null = null

export async function rebootRuntime(): Promise<void> {
  if (rebootRuntimePromise) return rebootRuntimePromise

  rebootRuntimePromise = (async () => {
    if (mcpInterval) { clearInterval(mcpInterval); mcpInterval = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    runtimeStarted = false
    setRuntimeReady(false, null)
    // Directory-scoped SSE subscriptions still point at the OpenCode server
    // we are about to shut down; reset them so onCreate fires fresh against
    // the new server once scoped clients are recreated.
    eventSubscriptions.reset()
    // Clear cached runtime tool lists — on reboot the MCP set, provider,
    // or model may have changed, and serving stale tool metadata from
    // the Capabilities UI would mislead the user.
    const { invalidateRuntimeToolCache } = await import('./runtime-tool-cache.ts')
    invalidateRuntimeToolCache()
    await stopRuntime()
    try {
      await bootRuntime(runtimeProjectDirectory)
    } catch (err: unknown) {
      log('error', `Runtime reboot failed: ${err instanceof Error ? err.message : String(err)}`)
      scheduleReconnect()
    }
  })().finally(() => {
    rebootRuntimePromise = null
  })
  return rebootRuntimePromise
}

function normalizeRuntimeProjectDirectory(directory?: string | null) {
  if (!directory) return null
  const normalized = resolve(directory)
  return normalized === getRuntimeHomeDir() || isSandboxWorkspaceDir(normalized) ? null : normalized
}

// Concurrent callers arriving with different target directories previously
// raced the `runtimeProjectDirectory` write + `rebootRuntime()` sequence:
// both would assign, then the first's reboot would run while the second's
// call to `rebootRuntime` coalesced into the singleton — leaving the
// requester of the first directory silently pointed at the second one.
// Serialize through a promise chain so each caller observes a stable
// runtime state before deciding to reboot (or no-op) against its own
// target. See `promise-chain.ts` for the primitive + tests.
const runEnsureSerially = createPromiseChain()

export async function ensureRuntimeForDirectory(directory?: string | null) {
  const desired = normalizeRuntimeProjectDirectory(directory)
  return runEnsureSerially(async () => {
    if (!runtimeStarted) {
      runtimeProjectDirectory = desired
      await bootRuntime(desired)
      return
    }
    const currentOverlay = getActiveProjectOverlayDirectory() || null
    if (currentOverlay === desired) {
      syncReadableSkillMirror(desired, { directory: desired })
      return
    }
    // Short-circuit the common thread-switch case: if neither the current
    // runtime nor the new target has any project-scoped skill / agent /
    // MCP, the server's config is identical whether we reboot or not. The
    // directory-scoped V2 clients already route per-request work to the
    // right project via the `directory` query param. Skipping the reboot
    // here saves 5–15s per switch and stops spawning zombie opencode
    // processes when the binary holds a signal longer than the timeout.
    const targetHasOverlay = desired ? projectHasOverlayContent(desired) : false
    if (!currentOverlay && !targetHasOverlay) {
      runtimeProjectDirectory = desired
      syncReadableSkillMirror(desired, { directory: desired })
      return
    }
    runtimeProjectDirectory = desired
    await rebootRuntime()
  })
}

registerRuntimeDirectoryEnsurer(ensureRuntimeForDirectory)

// Concurrent callers (multiple did-finish-load firings, recovery handlers,
// session handlers needing the runtime) would all pass the runtimeStarted
// guard before the first startRuntime() await completes, causing the
// post-await block to log "OpenCode runtime started" N times and re-run
// event subscription setup. Coalesce them into one in-flight boot.
let bootRuntimePromise: Promise<void> | null = null

async function bootRuntime(projectDirectory?: string | null): Promise<void> {
  if (runtimeStarted) return
  if (bootRuntimePromise) return bootRuntimePromise

  bootRuntimePromise = (async () => {
    await runBootRuntime(projectDirectory)
  })().finally(() => {
    bootRuntimePromise = null
  })
  return bootRuntimePromise
}

async function runBootRuntime(projectDirectory?: string | null) {
  if (runtimeStarted) return
  setRuntimeReady(false, null)
  try {
    if (!startupCleanupDone) {
      startupCleanupDone = true
      const cleanup = pruneOldUnreferencedSandboxStorage()
      if (cleanup.removedWorkspaces > 0) {
        log('artifact', `Pruned ${cleanup.removedWorkspaces} stale sandbox workspace(s), freed ${cleanup.removedBytes} bytes`)
      }
    }
    assertConfigValid()
    log('main', 'Starting OpenCode runtime...')
    // Refresh the Google access token before MCPs spawn. `googleAuth: true`
    // MCPs receive `GOOGLE_WORKSPACE_CLI_TOKEN` in their env — gws
    // doesn't honor ADC and would otherwise fall back to its own token
    // cache, which is empty on a fresh install. Failure is non-fatal:
    // `refreshAccessToken` returns null when the user hasn't signed in
    // or the refresh token is revoked, and `googleAuthEnv` handles
    // missing token gracefully.
    if (getAppConfig().auth.mode === 'google-oauth') {
      try {
        const { refreshAccessToken } = await import('./auth.ts')
        await refreshAccessToken()
      } catch (err) {
        log('auth', `Pre-boot Google token refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const client = await startRuntime(projectDirectory)
    runtimeStarted = true
    runtimeProjectDirectory = normalizeRuntimeProjectDirectory(projectDirectory)
    setRuntimeReady(true)
    log('main', 'OpenCode runtime started')
    telemetry.appLaunched()
    log('main', `Log file: ${getLogFilePath()}`)

    // Tell renderer the runtime is ready so it can load sessions
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('runtime:ready')
    }

    eventSubscriptions.ensure(getRuntimeHomeDir(), client)

    const startupRecoveryAttempts = new Map<string, number>()
    const recoverableLocals = recoverableLocalMcpNames()
    const googleAuthLocals = new Set(listReadyGoogleAuthLocalMcpNames({
      builtinMcps: getConfiguredMcpsFromConfig(),
      customMcps: listCustomMcps({ directory: runtimeProjectDirectory }),
      settings: loadSettings(),
    }))

    const recoverFailedLocalMcps = async (statuses: Array<{ name: string; connected: boolean; rawStatus?: string }>) => {
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
          await client.mcp.connect({ name: entry.name })
        } catch (err: unknown) {
          log('error', `Local MCP recovery failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const recoverDisconnectedGoogleAuthMcps = async (statuses: Array<{ name: string; connected: boolean; rawStatus?: string }>) => {
      const disconnected = statuses.filter((entry) => googleAuthLocals.has(entry.name) && !entry.connected)
      if (disconnected.length === 0) return

      try {
        const { refreshAccessToken, getAdcPathIfAvailable } = await import('./auth.ts')
        const token = await refreshAccessToken()
        if (!token && !getAdcPathIfAvailable()) return
      } catch (err) {
        log('auth', `Google-auth MCP refresh skipped: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      for (const entry of disconnected) {
        try {
          log('mcp', `Refreshing Google-auth MCP ${entry.name}`)
          await client.mcp.connect({ name: entry.name })
        } catch (err: unknown) {
          log('error', `Google-auth MCP recovery failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const pollMcp = async () => {
      try {
        const statuses = await getMcpStatus(client)
        await recoverDisconnectedGoogleAuthMcps(statuses)
        await recoverFailedLocalMcps(statuses)
        const currentWindow = getMainWindow()
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('mcp:status', statuses)
        }
      } catch (err: unknown) {
        log('error', `MCP status poll failed: ${err instanceof Error ? err.message : String(err)}`)
        // Runtime might have died — trigger reconnect
        scheduleReconnect()
      }
    }
    // Kick off the first MCP poll right away so the home page's MCP pill
    // populates on first paint instead of waiting for the recurring tick.
    void pollMcp()
    if (mcpInterval) clearInterval(mcpInterval)
    mcpInterval = setInterval(pollMcp, 10_000)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to start runtime'
    log('error', `Failed to start runtime: ${message}`)
    setRuntimeError(message)
    if (message.includes('Invalid app config')) {
      return
    }
    scheduleReconnect()
  }
}

let reconnectDelay = 3000
const MAX_RECONNECT_DELAY = 60000

function scheduleReconnect() {
  if (!shouldScheduleRuntimeReconnect({
    appCleanupStarted,
    appIsQuitting,
    reconnectTimerActive: Boolean(reconnectTimer),
  })) return
  log('main', `Runtime disconnected — reconnecting in ${reconnectDelay / 1000}s...`)
  runtimeStarted = false
  setRuntimeReady(false)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    publishNotification(win, {
      type: 'error',
      sessionId: null,
      message: `Runtime disconnected. Reconnecting in ${reconnectDelay / 1000}s...`,
    })
  }
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    await stopRuntime()
    await bootRuntime()
    if (runtimeStarted) {
      reconnectDelay = 3000 // Reset on success
    } else {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY) // Exponential backoff
    }
  }, reconnectDelay)
}

async function performCleanup() {
  if (appCleanupPromise) return appCleanupPromise
  appCleanupStarted = true

  appCleanupPromise = (async () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (mcpInterval) {
      clearInterval(mcpInterval)
      mcpInterval = null
    }

    flushSessionRegistryWrites()
    eventSubscriptions.reset()

    try {
      await stopRuntime()
    } catch (err: unknown) {
      log('error', `Runtime shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      stopAutomationService()
      appCleanupFinished = true
      closeLogger()
    }
  })()

  return appCleanupPromise
}

function exitAfterCleanup(exitCode: number) {
  appIsQuitting = true
  void performCleanup().finally(() => {
    appCleanupFinished = true
    app.exit(exitCode)
  })
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  app.name = branding.name
  applySettingsSideEffects()

  // In development we set the dock icon explicitly so branding changes show up immediately.
  // In packaged builds the app bundle icon should be authoritative.
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    const iconPath = getPackagedResourcePath('icon-128.png')
    try {
      const icon = nativeImage.createFromPath(iconPath)
      log('main', `[icon] Loading ${iconPath}, isEmpty: ${icon.isEmpty()}, size: ${icon.getSize().width}x${icon.getSize().height}`)
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    } catch (err: unknown) {
      log('main', `[icon] Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Native menu bar
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: branding.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings', accelerator: SETTINGS_SHORTCUT, click: () => mainWindow?.webContents.send('navigate', 'settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Thread', accelerator: NEW_THREAD_SHORTCUT, click: () => mainWindow?.webContents.send('action', 'new-thread') },
        { type: 'separator' },
        { label: 'Export Thread...', accelerator: 'CmdOrCtrl+Shift+E', click: () => mainWindow?.webContents.send('action', 'export') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Search Threads', accelerator: SEARCH_THREADS_SHORTCUT, click: () => mainWindow?.webContents.send('action', 'search') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => mainWindow?.webContents.send('action', 'toggle-sidebar') },
        { label: 'Command Palette…', accelerator: COMMAND_PALETTE_SHORTCUT, click: () => mainWindow?.webContents.send('action', 'command-palette') },
        { label: 'Automations', click: () => mainWindow?.webContents.send('navigate', 'automations') },
        { label: 'Agents', accelerator: AGENTS_SHORTCUT, click: () => mainWindow?.webContents.send('navigate', 'agents') },
        { label: 'Capabilities', accelerator: CAPABILITIES_SHORTCUT, click: () => mainWindow?.webContents.send('navigate', 'capabilities') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: `${branding.name} Documentation`, click: () => openExternalNavigation(branding.helpUrl) },
        {
          label: 'Report an Issue',
          click: () => {
            // Derive the issues URL from the configured helpUrl when
            // it's a GitHub repo; downstream forks on other hosts can
            // still customize helpUrl to point directly at their own
            // support surface.
            const issuesUrl = toGithubIssuesUrl(branding.helpUrl) || branding.helpUrl
            openExternalNavigation(issuesUrl)
          },
        },
        ...(!app.isPackaged
          ? [
              { type: 'separator' as const },
              { role: 'toggleDevTools' as const },
            ]
          : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  setupIpcHandlers(ipcMain, getMainWindow)
  configureAutomationService({ getMainWindow })
  startAutomationService()
  registerBrandingAssetProtocol()
  attachContentSecurityPolicy(electronSession.defaultSession, {
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  })
  attachPermissionGuards()
  app.on('web-contents-created', (_event, contents) => {
    attachWebContentsSecurityGuards(contents)
  })
  primeShellEnvironment()
  const initialWindow = createWindow()
  const maybeStartRuntimeAfterRendererLoad = () => {
    const url = initialWindow.webContents.getURL()
    if (rendererUrlLooksWrong(url, process.env.VITE_DEV_SERVER_URL)) {
      log('main', `Ignoring provisional renderer load before runtime startup: ${url || '(empty)'}`)
      return
    }
    initialWindow.webContents.off('did-finish-load', maybeStartRuntimeAfterRendererLoad)
    void maybeStartRuntimeOnLaunch()
  }
  initialWindow.webContents.on('did-finish-load', maybeStartRuntimeAfterRendererLoad)

  app.on('activate', () => {
    showOrCreateMainWindow('activate')
  })
})

app.on('second-instance', () => {
  if (app.isReady()) {
    showOrCreateMainWindow('second-instance')
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  appIsQuitting = true
  if (appCleanupFinished) return
  event.preventDefault()
  exitAfterCleanup(0)
})

app.on('will-quit', (event) => {
  appIsQuitting = true
  if (appCleanupFinished) return
  event.preventDefault()
  exitAfterCleanup(0)
})

process.on('SIGINT', () => {
  exitAfterCleanup(0)
})

process.on('SIGTERM', () => {
  exitAfterCleanup(0)
})

// Without these, an unhandled rejection in any background promise
// (catalog refresh, status reconciler, event handler) kills the Electron
// main process silently — no log line, no child-process cleanup, no
// user-visible error. We log with a stable category, run the same
// graceful shutdown path as SIGTERM, and exit non-zero so the OS / dev
// harness can distinguish a crash from a normal quit.
let fatalErrorHandled = false
function handleFatalError(kind: 'uncaughtException' | 'unhandledRejection', err: unknown) {
  if (fatalErrorHandled) return
  fatalErrorHandled = true
  appIsQuitting = true
  const message = err instanceof Error
    ? `${err.message}\n${err.stack || ''}`
    : typeof err === 'string'
      ? err
      : JSON.stringify(err)
  try {
    log('error', `${kind}: ${message}`)
  } catch {
    // Logger itself failed — last-resort write to stderr so the exit is
    // still diagnosable.
    process.stderr.write(`[open-cowork] ${kind}: ${message}\n`)
  }
  exitAfterCleanup(1)
}

process.on('uncaughtException', (err) => handleFatalError('uncaughtException', err))
process.on('unhandledRejection', (reason) => handleFatalError('unhandledRejection', reason))

export { bootRuntime }
