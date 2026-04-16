import { app, BrowserWindow, ipcMain, Menu, shell, nativeImage, session as electronSession } from 'electron'
import {
  AGENTS_SHORTCUT,
  CAPABILITIES_SHORTCUT,
  COMMAND_PALETTE_SHORTCUT,
  NEW_THREAD_SHORTCUT,
  SEARCH_THREADS_SHORTCUT,
  SETTINGS_SHORTCUT,
} from '@open-cowork/shared'
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
import { assertConfigValid, getBranding, getConfiguredMcpsFromConfig } from './config-loader.ts'
import { isSetupComplete } from './settings.ts'
import { publishNotification } from './session-event-dispatcher.ts'
import { createWindowState } from './window-state.ts'
import { setRuntimeError, setRuntimeReady } from './runtime-status.ts'
import { registerRuntimeDirectoryEnsurer } from './runtime-context.ts'
import { pruneOldUnreferencedSandboxStorage } from './sandbox-storage.ts'
import { attachContentSecurityPolicy } from './content-security-policy.ts'
import {
  needsMainWindowRecovery,
  pickRecoverableMainWindow,
  rendererUrlLooksWrong,
} from './main-window-lifecycle.ts'
import {
  createRuntimeEventSubscriptionManager,
} from './event-subscriptions.ts'
import { primeShellEnvironment } from './shell-env.ts'

import { log, getLogFilePath, closeLogger } from './logger.ts'
import { telemetry } from './telemetry.ts'

let mainWindow: BrowserWindow | null = null
let runtimeStarted = false
let reconnectTimer: NodeJS.Timeout | null = null
let cleanupDone = false
let runtimeProjectDirectory: string | null = null
let mainWindowRecoveryTimer: NodeJS.Timeout | null = null
const branding = getBranding()

async function getAuthStateLazy() {
  const { getAuthState } = await import('./auth.ts')
  return getAuthState()
}

app.name = branding.name
try {
  app.setPath('userData', join(app.getPath('appData'), branding.name))
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
    void bootRuntime().catch((err: any) => {
      log('error', `Deferred runtime startup failed: ${err?.message || String(err)}`)
    })
  } else {
    log('main', 'Waiting for setup or authentication before starting runtime')
  }
}

function expectedRendererEntryPath() {
  return join(__dirname, '../index.html')
}

function getStartupSplashHtml() {
  const brandName = branding.name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${brandName}</title>
        <style>
          :root {
            color-scheme: dark;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
          }
          body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: radial-gradient(circle at top, rgba(188, 151, 255, 0.14), transparent 36%), #1b1b26;
            color: #ece8ff;
          }
          .shell {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
          }
          .badge {
            width: 72px;
            height: 72px;
            border-radius: 22px;
            display: grid;
            place-items: center;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(203, 177, 255, 0.24);
            box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
            font-size: 34px;
            font-weight: 700;
            color: #d8bcff;
          }
          .title {
            font-size: 28px;
            font-weight: 600;
            letter-spacing: -0.02em;
          }
          .subtitle {
            font-size: 14px;
            color: rgba(236, 232, 255, 0.72);
          }
        </style>
      </head>
      <body>
        <div class="shell" aria-label="${brandName} is starting">
          <div class="badge">O</div>
          <div class="title">${brandName}</div>
          <div class="subtitle">Starting runtime and loading workspace…</div>
        </div>
      </body>
    </html>
  `
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
    scheduleMainWindowRecovery('did-fail-load', 300)
  })
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('renderer', `console[${level}] ${sourceId}:${line} ${message}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log('error', `Renderer process gone: reason=${details.reason} exitCode=${String(details.exitCode)}`)
    scheduleMainWindowRecovery('render-process-gone', 100)
  })

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getStartupSplashHtml())}`)
  if (process.env.VITE_DEV_SERVER_URL) {
    window.webContents.openDevTools({ mode: 'detach' })
  }

  scheduleMainWindowRecovery(reason, 4000)

  window.on('closed', () => {
    clearMainWindowRecoveryTimer()
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  // Security: block navigation away from the app and deny new window creation
  window.webContents.on('will-navigate', (e, url) => {
    // Allow dev server reloads
    if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) return
    e.preventDefault()
    shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

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
    await stopRuntime()
    try {
      await bootRuntime(runtimeProjectDirectory)
    } catch (err: any) {
      log('error', `Runtime reboot failed: ${err?.message}`)
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
// Serialize through a chained promise so each caller observes a stable
// runtime state before deciding to reboot (or no-op) against its own
// target.
let ensureRuntimeChain: Promise<void> = Promise.resolve()

export async function ensureRuntimeForDirectory(directory?: string | null) {
  const desired = normalizeRuntimeProjectDirectory(directory)
  const run = async () => {
    if (!runtimeStarted) {
      runtimeProjectDirectory = desired
      await bootRuntime(desired)
      return
    }
    if ((getActiveProjectOverlayDirectory() || null) === desired) return
    runtimeProjectDirectory = desired
    await rebootRuntime()
  }
  const next = ensureRuntimeChain.then(run, run)
  ensureRuntimeChain = next.catch(() => {})
  return next
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
    if (!cleanupDone) {
      cleanupDone = true
      const cleanup = pruneOldUnreferencedSandboxStorage()
      if (cleanup.removedWorkspaces > 0) {
        log('artifact', `Pruned ${cleanup.removedWorkspaces} stale sandbox workspace(s), freed ${cleanup.removedBytes} bytes`)
      }
    }
    assertConfigValid()
    log('main', 'Starting OpenCode runtime...')
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

    const recoverFailedLocalMcps = async (statuses: Array<{ name: string; connected: boolean; rawStatus?: string }>) => {
      const failedLocalMcps = statuses.filter((entry) =>
        recoverableLocals.has(entry.name) && !entry.connected && entry.rawStatus === 'failed')

      for (const entry of failedLocalMcps) {
        const attempts = startupRecoveryAttempts.get(entry.name) || 0
        if (attempts >= MAX_STARTUP_MCP_RECOVERY_ATTEMPTS) continue
        startupRecoveryAttempts.set(entry.name, attempts + 1)
        try {
          log('mcp', `Retrying local MCP startup for ${entry.name} (${attempts + 1}/${MAX_STARTUP_MCP_RECOVERY_ATTEMPTS})`)
          await client.mcp.connect({ name: entry.name })
        } catch (err: any) {
          log('error', `Local MCP recovery failed for ${entry.name}: ${err?.message}`)
        }
      }
    }

    const pollMcp = async () => {
      try {
        const statuses = await getMcpStatus(client)
        await recoverFailedLocalMcps(statuses)
        const currentWindow = getMainWindow()
        if (currentWindow && !currentWindow.isDestroyed()) {
          currentWindow.webContents.send('mcp:status', statuses)
        }
      } catch (err: any) {
        log('error', `MCP status poll failed: ${err?.message}`)
        // Runtime might have died — trigger reconnect
        scheduleReconnect()
      }
    }
    setTimeout(pollMcp, 3000)
    if (mcpInterval) clearInterval(mcpInterval)
    mcpInterval = setInterval(pollMcp, 10_000)
  } catch (err: any) {
    const message = err?.message || 'Failed to start runtime'
    log('error', `Failed to start runtime: ${message}`)
    setRuntimeError(message)
    if (message.includes('Invalid Open Cowork config')) {
      return
    }
    scheduleReconnect()
  }
}

let reconnectDelay = 3000
const MAX_RECONNECT_DELAY = 60000

function scheduleReconnect() {
  if (cleanupDone) return
  if (reconnectTimer) return
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
  if (cleanupDone) return
  cleanupDone = true

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
  } catch (err: any) {
    log('error', `Runtime shutdown failed: ${err?.message}`)
  } finally {
    closeLogger()
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  app.name = branding.name

  // In development we set the dock icon explicitly so branding changes show up immediately.
  // In packaged builds the app bundle icon should be authoritative.
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    const iconPath = getPackagedResourcePath('icon-128.png')
    try {
      const icon = nativeImage.createFromPath(iconPath)
      log('main', `[icon] Loading ${iconPath}, isEmpty: ${icon.isEmpty()}, size: ${icon.getSize().width}x${icon.getSize().height}`)
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    } catch (e: any) {
      log('main', `[icon] Failed: ${e.message}`)
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
        { label: `${branding.name} Documentation`, click: () => shell.openExternal(branding.helpUrl) },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  setupIpcHandlers(ipcMain, getMainWindow)
  attachContentSecurityPolicy(electronSession.defaultSession, {
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
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

app.on('before-quit', async () => {
  await performCleanup()
})

app.on('will-quit', async () => {
  await performCleanup()
})

process.on('SIGINT', () => {
  void performCleanup().finally(() => app.exit(0))
})

process.on('SIGTERM', () => {
  void performCleanup().finally(() => app.exit(0))
})

export { bootRuntime }
