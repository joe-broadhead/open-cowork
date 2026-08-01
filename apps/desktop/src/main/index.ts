// Wire the Electron-backed injection hosts (app paths, safeStorage, desktop shell)
// before any other main-process module resolves config or reads credentials. This
// is the desktop's single Electron-host wiring point; the cloud server never loads
// it and uses the Electron-free fallbacks. (Hosts are read lazily, so placement
// here at the entry is in time for every consumer.)
import { telemetry } from '@open-cowork/runtime-host/telemetry'
import { adoptionTelemetry } from '@open-cowork/runtime-host/adoption-telemetry'
import { primeShellEnvironment } from '@open-cowork/runtime-host/shell-env'
import { applySettingsSideEffects, isSetupComplete, loadSettings } from '@open-cowork/runtime-host/settings'
import { flushSessionRegistryWrites } from '@open-cowork/runtime-host/session-registry'
import { publishNotification } from '@open-cowork/runtime-host/session-event-dispatcher'
import { getActiveProjectOverlayDirectory, getRuntimeHomeDir, setDirectoryClientLifecycleHandlers, startRuntime, stopRuntime } from '@open-cowork/runtime-host/runtime'
import { setRuntimeError, setRuntimeReady } from '@open-cowork/runtime-host/runtime-status'
import { syncReadableSkillMirror } from '@open-cowork/runtime-host/runtime-skill-catalog'
import { projectHasOverlayContent } from '@open-cowork/runtime-host/runtime-project-overlay'
import { isSandboxWorkspaceDir } from '@open-cowork/runtime-host/runtime-paths'
import { setManagedOpencodeSupervisorForker } from '@open-cowork/runtime-host/runtime-managed-server'
import { configureAgentToolBridge } from '@open-cowork/runtime-host/agent-tool-bridge'
import { registerRuntimeDirectoryEnsurer } from '@open-cowork/runtime-host/runtime-context'
import { configureCoordinationService } from '@open-cowork/runtime-host/coordination/coordination-service'
import { invalidateCustomAgentCatalogCache } from '@open-cowork/runtime-host/custom-agents'
import { getRuntimeCatalogSnapshot } from '@open-cowork/runtime-host/runtime-catalog-snapshot'
import { resolveAppIconFile, appendE2ERemoteDebuggingSwitches, e2eWindowReadyProbeEnabled } from '@open-cowork/runtime-host'
import './desktop-electron-hosts.ts'
import { app, ipcMain, Menu, nativeImage, Notification, session as electronSession, utilityProcess } from 'electron'
import { join, resolve } from 'path'
import { setupIpcHandlers } from './ipc-handlers.ts'
import { createApplicationMenuTemplate } from './app-menu.ts'
import { subscribeToEvents } from './events.ts'
import { assertConfigValid, getAppConfig, getBranding } from '@open-cowork/runtime-host/config'
import { createPromiseChain, createSingleFlight } from './promise-chain.ts'
import { configureWorkflowService, runWorkflowSchedulerTick, startWorkflowService, stopWorkflowService } from './workflow/workflow-service.ts'
import {
  configureRuntimeInitialization,
  getRuntimeInitializationStatus,
  resolveRuntimeInitializationError,
  resolveRuntimeInitializationReady,
  setRuntimeInitializationPhase,
} from './runtime-initialization.ts'
import { pruneOldUnreferencedSandboxStorage } from './sandbox-storage.ts'
import { attachContentSecurityPolicy } from './content-security-policy.ts'
import { effectiveRendererDevServerUrl } from './main-window-lifecycle.ts'
import {
  createRuntimeEventSubscriptionManager,
} from './event-subscriptions.ts'
import { restartRuntimeMcpStatusPolling } from './runtime-mcp-status-polling.ts'
import { shouldScheduleRuntimeReconnect } from './runtime-reconnect-policy.ts'
import { registerAppProtocolSchemes } from './app-protocol-schemes.ts'
import { registerBrandingAssetProtocol } from './branding-protocol.ts'
import type { ManagedOpencodeSupervisorProcess } from '@open-cowork/runtime-host'
import { isDesktopFeatureEnabled } from '@open-cowork/shared'
import { resolveDevelopmentSetupConnectionValidator } from './setup/connection-validation.ts'
import { canStartDesktopRuntime, type DesktopRuntimeStartIntent } from './runtime-start-policy.ts'

// Inject Electron's utilityProcess as the managed OpenCode server's supervisor
// forker (desktop-only; the cloud forks via node:child_process instead). Set at
// module load, before any session starts a managed server.
setManagedOpencodeSupervisorForker((modulePath) =>
  utilityProcess.fork(modulePath, [], {
    serviceName: 'opencode-managed-server',
    stdio: 'pipe',
  }) as ManagedOpencodeSupervisorProcess,
)

// Inject the desktop's runtime reboot into the agent tool bridge (substrate-side);
// the cloud leaves it unset and a refresh request there is a no-op.
configureAgentToolBridge({ scheduleRuntimeRefresh: () => { void rebootRuntime() } })
import { registerChartFrameAssetProtocol } from './chart-frame-assets.ts'
import {
  attachPermissionGuards,
  attachWebContentsSecurityGuards,
  openExternalNavigation,
} from './main-window-security.ts'
import { createMainWindowController } from './main-window-controller.ts'

import { log, getLogFilePath, closeLogger } from '@open-cowork/shared/node'
registerAppProtocolSchemes()
appendE2ERemoteDebuggingSwitches(app)

let runtimeStarted = false
let reconnectTimer: NodeJS.Timeout | null = null
let startupCleanupDone = false
let appCleanupStarted = false
let appCleanupFinished = false
let appCleanupPromise: Promise<void> | null = null
let runtimeProjectDirectory: string | null = null
let appIsQuitting = false
const branding = getBranding()
// Resolved once at startup; reused for the window + dock icon. Null when unset/invalid,
// so the window controller and dock fall back to the bundled default icon.
const appIconPath = resolveAppIconFile(branding.appIcon)

async function getAuthStateLazy() {
  const { getAuthState } = await import('@open-cowork/runtime-host/auth')
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

const {
  closeLoadingWindow,
  createLoadingWindow,
  createWindow,
  expectedRendererEntryPath,
  getLoadingWindow,
  getMainWindow,
  getPackagedResourcePath,
  showOrCreateMainWindow,
} = createMainWindowController({
  app,
  appDirname: __dirname,
  branding,
  appIconPath,
  canOpenMainWindowFromLoading: () => getRuntimeInitializationStatus().phase === 'error',
  getAppIsQuitting: () => appIsQuitting,
  log,
})
configureRuntimeInitialization({
  getLoadingWindow,
  getStatusWindows: () => [getMainWindow()],
})

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

// OpenCode scopes `/api/event` to the directory carried by the SDK
// client. Keep one subscription per live directory client so project sessions
// receive their own text, tool, interaction, and terminal events.
setDirectoryClientLifecycleHandlers({
  onCreate: (directory, client) => {
    eventSubscriptions.ensure(directory, client)
  },
  onEvict: (directory) => {
    eventSubscriptions.stop(directory)
  },
})

async function runtimePrerequisitesSatisfied() {
  return (await getAuthStateLazy()).authenticated && isSetupComplete()
}

function openMainWindowAfterRuntimeInitialization() {
  const loadingWindow = getLoadingWindow()
  if (!loadingWindow || loadingWindow.isDestroyed()) return

  const existingMain = getMainWindow()
  if (existingMain && !existingMain.isDestroyed()) {
    closeLoadingWindow()
    return
  }

  const mainWindow = createWindow('runtime-ready')
  mainWindow.webContents.once('did-finish-load', () => {
    closeLoadingWindow()
  })
}

let mcpInterval: NodeJS.Timeout | null = null

// Singleton for rebootRuntime: without it, concurrent ensureRuntimeForDirectory
// calls for a new project directory each kick off their own stopRuntime +
// bootRuntime pair, spawning disjoint OpenCode server instances. A session
// created on one of those intermediate servers then becomes unreachable from
// the client pointing at the final server, and the UI hangs waiting for
// events that can never arrive.
const runRebootOnce = createSingleFlight()
const runRuntimeTransitionSerially = createPromiseChain()
let runtimeSuspensionEpoch = 0

async function deactivateDesktopRuntime() {
  if (mcpInterval) { clearInterval(mcpInterval); mcpInterval = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  runtimeStarted = false
  setRuntimeReady(false, null)
  // Directory-scoped SSE subscriptions still point at the OpenCode server
  // we are about to shut down; reset them so onCreate fires fresh against
  // the new server once scoped clients are recreated.
  eventSubscriptions.reset()
  // Clear cached runtime tool lists whenever the active server is removed.
  const { invalidateRuntimeToolCache } = await import('@open-cowork/runtime-host/runtime-tool-cache')
  invalidateRuntimeToolCache()
  invalidateCustomAgentCatalogCache()
  await stopRuntime()
}

async function rebootRuntimeWithIntent(intent: DesktopRuntimeStartIntent): Promise<void> {
  const requestedSuspensionEpoch = runtimeSuspensionEpoch
  return runRebootOnce(async () => {
    return runRuntimeTransitionSerially(async () => {
      await deactivateDesktopRuntime()
      // A settings save may invalidate setup while this transition is in
      // flight. In that case, the suspension wins and no stale runtime is
      // brought back after the settings IPC has returned.
      if (
        requestedSuspensionEpoch !== runtimeSuspensionEpoch
        || !canStartDesktopRuntime(isSetupComplete(), intent)
      ) return
      try {
        await bootRuntimeInsideTransition(runtimeProjectDirectory, intent, requestedSuspensionEpoch)
      } catch (err: unknown) {
        log('error', `Runtime reboot failed: ${err instanceof Error ? err.message : String(err)}`)
        if (intent === 'validated') scheduleReconnect()
      }
      if (
        requestedSuspensionEpoch !== runtimeSuspensionEpoch
        || !canStartDesktopRuntime(isSetupComplete(), intent)
      ) {
        await deactivateDesktopRuntime()
      }
    })
  })
}

export async function rebootRuntime(): Promise<void> {
  if (!isSetupComplete()) {
    await suspendRuntimeForSetup()
    return
  }
  return rebootRuntimeWithIntent('validated')
}

export async function rebootRuntimeForSetupValidation(): Promise<void> {
  return rebootRuntimeWithIntent('setup_connection_validation')
}

export async function suspendRuntimeForSetup(): Promise<void> {
  runtimeSuspensionEpoch += 1
  return runRuntimeTransitionSerially(deactivateDesktopRuntime)
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
    if (!isSetupComplete()) {
      await suspendRuntimeForSetup()
      throw new Error('Complete and test setup before starting a cowork session.')
    }
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
const runBootOnce = createSingleFlight()

async function bootRuntimeInsideTransition(
  projectDirectory: string | null | undefined,
  intent: DesktopRuntimeStartIntent,
  requestedSuspensionEpoch: number,
): Promise<void> {
  if (
    runtimeStarted
    || requestedSuspensionEpoch !== runtimeSuspensionEpoch
    || !canStartDesktopRuntime(isSetupComplete(), intent)
  ) return
  return runBootOnce(async () => {
    if (
      runtimeStarted
      || requestedSuspensionEpoch !== runtimeSuspensionEpoch
      || !canStartDesktopRuntime(isSetupComplete(), intent)
    ) return
    await runBootRuntime(projectDirectory, intent, requestedSuspensionEpoch)
  })
}

export async function bootRuntime(projectDirectory?: string | null): Promise<void> {
  const requestedSuspensionEpoch = runtimeSuspensionEpoch
  return runRuntimeTransitionSerially(async () => {
    await bootRuntimeInsideTransition(projectDirectory, 'validated', requestedSuspensionEpoch)
    if (
      requestedSuspensionEpoch !== runtimeSuspensionEpoch
      || !isSetupComplete()
    ) await deactivateDesktopRuntime()
  })
}

async function runBootRuntime(
  projectDirectory: string | null | undefined,
  intent: DesktopRuntimeStartIntent,
  requestedSuspensionEpoch: number,
) {
  if (runtimeStarted) return
  setRuntimeInitializationPhase('starting', 'Starting OpenCode runtime...')
  setRuntimeReady(false, null)
  try {
    if (!startupCleanupDone) {
      startupCleanupDone = true
      const cleanup = pruneOldUnreferencedSandboxStorage()
      if (cleanup.removedWorkspaces > 0) {
        log('artifact', `Pruned ${cleanup.removedWorkspaces} stale sandbox workspace(s), freed ${cleanup.removedBytes} bytes`)
      }
    }
    setRuntimeInitializationPhase('config', 'Validating app configuration...')
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
        const { refreshAccessToken } = await import('@open-cowork/runtime-host/auth')
        await refreshAccessToken()
      } catch (err) {
        log('auth', `Pre-boot Google token refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setRuntimeInitializationPhase('managed-server', 'Starting managed OpenCode server...')
    const client = await startRuntime(projectDirectory, {
      onUnexpectedExit: () => {
        scheduleReconnect()
      },
    })
    if (
      requestedSuspensionEpoch !== runtimeSuspensionEpoch
      || !canStartDesktopRuntime(isSetupComplete(), intent)
    ) {
      await stopRuntime()
      setRuntimeReady(false, null)
      return
    }
    runtimeStarted = true
    runtimeProjectDirectory = normalizeRuntimeProjectDirectory(projectDirectory)
    setRuntimeInitializationPhase('connecting-events', 'Connecting event stream...')
    setRuntimeReady(true)
    if (intent === 'validated') void runWorkflowSchedulerTick()
    log('main', 'OpenCode runtime started')
    if (intent === 'validated') telemetry.appLaunched()
    // Opt-in, content-free adoption signal (default off). Only coarse
    // platform + version facts are ever sent, and only when a downstream
    // has enabled `telemetry.adoption`. See docs/privacy.md.
    if (intent === 'validated') {
      adoptionTelemetry.appLaunched({ platform: process.platform, appVersion: app.getVersion() })
    }
    log('main', `Log file: ${getLogFilePath()}`)

    // Tell renderer the runtime is ready so it can load sessions
    const win = getMainWindow()
    if (intent === 'validated' && win && !win.isDestroyed()) {
      win.webContents.send('runtime:ready')
    }

    if (intent === 'validated') {
      eventSubscriptions.ensure(getRuntimeHomeDir(), client)
      void getRuntimeCatalogSnapshot(runtimeProjectDirectory ? { directory: runtimeProjectDirectory } : undefined).catch((err) => {
        log('main', `Runtime catalog warmup skipped: ${err instanceof Error ? err.message : String(err)}`)
      })

      setRuntimeInitializationPhase('mcp', 'Checking tools and MCP status...')
      mcpInterval = restartRuntimeMcpStatusPolling({
        client,
        runtimeProjectDirectory,
        currentInterval: mcpInterval,
        getMainWindow,
        scheduleReconnect,
      })
    }
    resolveRuntimeInitializationReady('OpenCode runtime is ready.')
    openMainWindowAfterRuntimeInitialization()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to start runtime'
    log('error', `Failed to start runtime: ${message}`)
    setRuntimeError(message)
    resolveRuntimeInitializationError(message)
    if (message.includes('Invalid app config')) {
      return
    }
    scheduleReconnect()
  }
}

let reconnectDelay = 3000
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY = 60000
const MAX_RECONNECT_ATTEMPTS = 10

function scheduleReconnect() {
  if (!isSetupComplete()) return
  if (!shouldScheduleRuntimeReconnect({
    appCleanupStarted,
    appIsQuitting,
    reconnectTimerActive: Boolean(reconnectTimer),
  })) return
  // Circuit breaker: a persistently-crashing runtime (bad config, corrupt state, missing
  // binary) would otherwise reconnect-loop forever. Stop after a window of failures and
  // surface a terminal error; a manual restart resets the counter.
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log('error', `Runtime failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts; giving up until restart.`)
    const stalledWin = getMainWindow()
    if (stalledWin && !stalledWin.isDestroyed()) {
      publishNotification(stalledWin, {
        type: 'error',
        sessionId: null,
        message: 'The runtime could not reconnect. Restart Open Cowork to try again.',
      })
    }
    return
  }
  log('main', `Runtime disconnected — reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`)
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
    await rebootRuntime()
    if (runtimeStarted) {
      reconnectDelay = 3000 // Reset on success
      reconnectAttempts = 0
    } else {
      reconnectAttempts += 1
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
      stopWorkflowService()
      appCleanupFinished = true
      await closeLogger()
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

function refreshApplicationMenu(voicePttShortcut = loadSettings().voicePttShortcut) {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(createApplicationMenuTemplate({
      brandName: branding.name,
      helpUrl: branding.helpUrl,
      isPackaged: app.isPackaged,
      getMainWindow,
      openExternalNavigation,
      voiceEnabled: isDesktopFeatureEnabled(getAppConfig().features, 'voice'),
      voicePttShortcut,
    })))
  } catch (error) {
    log('error', `Failed to refresh application menu: ${error instanceof Error ? error.message : String(error)}`)
  }
}

void app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  app.name = branding.name
  applySettingsSideEffects()

  // In development we set the dock icon explicitly so branding changes show up immediately.
  // In packaged builds the app bundle icon should be authoritative.
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    const iconPath = appIconPath || getPackagedResourcePath('icon-128.png')
    try {
      const icon = nativeImage.createFromPath(iconPath)
      log('main', `[icon] Loading ${iconPath}, isEmpty: ${icon.isEmpty()}, size: ${icon.getSize().width}x${icon.getSize().height}`)
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    } catch (err: unknown) {
      log('main', `[icon] Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  refreshApplicationMenu()

  const rendererDevServerUrl = effectiveRendererDevServerUrl(process.env.VITE_DEV_SERVER_URL, app.isPackaged)

  setupIpcHandlers(ipcMain, getMainWindow, {
    devServerUrl: rendererDevServerUrl,
    refreshApplicationMenu,
    restartRuntime: rebootRuntime,
    restartRuntimeForSetupValidation: rebootRuntimeForSetupValidation,
    suspendRuntimeForSetup,
    validateSetupConnection: resolveDevelopmentSetupConnectionValidator({ isPackaged: app.isPackaged }),
  })
  configureCoordinationService({
    getMainWindow,
    watchDeliveryAdapter: {
      createChannelDelivery(delivery) {
        const payload = delivery.payload || {}
        const message = typeof payload.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : typeof payload.title === 'string' && payload.title.trim()
            ? payload.title.trim()
            : `Watch event: ${delivery.eventType}`
        publishNotification(getMainWindow(), {
          type: delivery.eventType === 'needs_input' ? 'error' : 'done',
          workspaceId: delivery.workspaceId,
          synthetic: false,
          message,
        })
        return { deliveryId: delivery.deliveryId, status: 'sent' }
      },
    },
  })
  configureWorkflowService({
    getMainWindow,
    showDesktopNotification(notification) {
      if (!Notification.isSupported()) return
      new Notification(notification).show()
    },
  })
  startWorkflowService()
  registerBrandingAssetProtocol()
  registerChartFrameAssetProtocol()
  attachContentSecurityPolicy(electronSession.defaultSession, {
    devServerUrl: rendererDevServerUrl,
  })
  attachPermissionGuards()
  app.on('child-process-gone', (_event, details) => {
    if (details.serviceName !== 'opencode-managed-server') return
    log('runtime', `opencode-managed-server child-process-gone: reason=${details.reason} exitCode=${details.exitCode} type=${details.type} name=${details.name || 'unknown'}`)
  })
  app.on('web-contents-created', (_event, contents) => {
    attachWebContentsSecurityGuards(contents, expectedRendererEntryPath(), rendererDevServerUrl)
  })
  primeShellEnvironment()
  if (await runtimePrerequisitesSatisfied()) {
    log('main', 'Runtime prerequisites satisfied, starting runtime before opening main window')
    if (e2eWindowReadyProbeEnabled()) {
      createWindow('e2e-runtime-probe')
    } else {
      createLoadingWindow()
    }
    void bootRuntime().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log('error', `Runtime startup failed from loading window: ${message}`)
      resolveRuntimeInitializationError(message)
    })
  } else {
    log('main', 'Waiting for setup or authentication before starting runtime')
    createWindow('setup')
  }

  app.on('activate', () => {
    showOrCreateMainWindow('activate')
  })
}).catch((err: unknown) => {
  // The whole startup body ran unguarded (audit P2-14): a throw here became an unhandled rejection
  // that escalated a recoverable hiccup to a full process exit. Log it so the app can stay up and
  // surface the failure through the normal runtime-initialization-error path instead.
  const message = err instanceof Error ? err.message : String(err)
  log('error', `App startup failed: ${message}`)
  resolveRuntimeInitializationError(message)
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
