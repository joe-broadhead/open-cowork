import { app, BrowserWindow, ipcMain, Menu, shell, nativeImage } from 'electron'
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
import { getActiveProjectOverlayDirectory, getRuntimeHomeDir, startRuntime, stopRuntime } from './runtime.ts'
import { isSandboxWorkspaceDir } from './runtime-paths.ts'
import { subscribeToEvents, getMcpStatus } from './events.ts'
import { getAuthState } from './auth.ts'
import { flushSessionRegistryWrites } from './session-registry.ts'
import { assertConfigValid, getBranding, getConfiguredMcpsFromConfig } from './config-loader.ts'
import { isSetupComplete } from './settings.ts'
import { publishNotification } from './session-event-dispatcher.ts'
import { createWindowState } from './window-state.ts'
import { setRuntimeError, setRuntimeReady } from './runtime-status.ts'
import { registerRuntimeDirectoryEnsurer } from './runtime-context.ts'
import { pruneOldUnreferencedSandboxStorage } from './sandbox-storage.ts'

import { log, getLogFilePath, closeLogger } from './logger.ts'
import { telemetry } from './telemetry.ts'

let mainWindow: BrowserWindow | null = null
let runtimeStarted = false
let reconnectTimer: NodeJS.Timeout | null = null
let cleanupDone = false
let runtimeProjectDirectory: string | null = null
const branding = getBranding()

app.name = branding.name
try {
  app.setPath('userData', join(app.getPath('appData'), branding.name))
} catch {}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
}

function getMainWindow() {
  return mainWindow
}

function getPackagedResourcePath(...segments: string[]) {
  if (app.isPackaged) {
    return join(process.resourcesPath, ...segments)
  }
  return join(__dirname, '../../resources', ...segments)
}

function expectedRendererEntryPath() {
  return join(__dirname, '../index.html')
}

function rendererUrlLooksWrong(url: string) {
  if (!url) return true
  if (process.env.VITE_DEV_SERVER_URL) {
    return !url.startsWith(process.env.VITE_DEV_SERVER_URL)
  }
  return url.endsWith('.js') || url.includes('/assets/') || !url.endsWith('/index.html')
}

function ensureMainWindowRenderer() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const currentUrl = mainWindow.webContents.getURL()
  if (!rendererUrlLooksWrong(currentUrl)) return
  log('main', `Renderer loaded unexpected URL, restoring shell: ${currentUrl || '(empty)'}`)
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(expectedRendererEntryPath())
  }
}

function showOrCreateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show()
  }
  mainWindow.moveTop()
  app.focus({ steal: true })
  mainWindow.focus()
}

function createWindow() {
  const mainWindowState = createWindowState(1200, 800)

  mainWindow = new BrowserWindow({
    x: mainWindowState.bounds.x,
    y: mainWindowState.bounds.y,
    width: mainWindowState.bounds.width,
    height: mainWindowState.bounds.height,
    minWidth: 800,
    minHeight: 600,
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
  mainWindowState.manage(mainWindow)
  const forceWindowVisible = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const bounds = mainWindow.getBounds()
    log('main', `Ensuring main window visibility x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height} visible=${String(mainWindow.isVisible())} minimized=${String(mainWindow.isMinimized())}`)
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.center()
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setAlwaysOnTop(true, 'screen-saver')
    mainWindow.show()
    mainWindow.moveTop()
    app.focus({ steal: true })
    mainWindow.focus()
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.setAlwaysOnTop(false)
      mainWindow.setVisibleOnAllWorkspaces(false)
      mainWindow.moveTop()
      mainWindow.focus()
    }, 600)
  }
  mainWindow.webContents.setZoomFactor(1)
  mainWindow.webContents.on('zoom-changed', () => {
    mainWindow?.webContents.setZoomFactor(1)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    log('renderer', 'Renderer did-finish-load')
    if (!mainWindow || mainWindow.isDestroyed()) return
    ensureMainWindowRenderer()
    if (mainWindowState.isMaximized) {
      mainWindow.maximize()
    }
    forceWindowVisible()
  })
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindowState.isMaximized) {
      mainWindow.maximize()
    }
    forceWindowVisible()
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    log('error', `Renderer did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${String(isMainFrame)}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('renderer', `console[${level}] ${sourceId}:${line} ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('error', `Renderer process gone: reason=${details.reason} exitCode=${String(details.exitCode)}`)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(expectedRendererEntryPath())
  }

  setTimeout(() => {
    forceWindowVisible()
  }, 1200)

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Security: block navigation away from the app and deny new window creation
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Allow dev server reloads
    if (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL)) return
    e.preventDefault()
    shell.openExternal(url)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
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

export async function rebootRuntime() {
  if (mcpInterval) { clearInterval(mcpInterval); mcpInterval = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  runtimeStarted = false
  setRuntimeReady(false, null)
  await stopRuntime()
  try {
    await bootRuntime(runtimeProjectDirectory)
  } catch (err: any) {
    log('error', `Runtime reboot failed: ${err?.message}`)
    scheduleReconnect()
  }
}

function normalizeRuntimeProjectDirectory(directory?: string | null) {
  if (!directory) return null
  const normalized = resolve(directory)
  return normalized === getRuntimeHomeDir() || isSandboxWorkspaceDir(normalized) ? null : normalized
}

export async function ensureRuntimeForDirectory(directory?: string | null) {
  const desired = normalizeRuntimeProjectDirectory(directory)
  if (!runtimeStarted) {
    runtimeProjectDirectory = desired
    await bootRuntime(desired)
    return
  }
  if ((getActiveProjectOverlayDirectory() || null) === desired) return
  runtimeProjectDirectory = desired
  await rebootRuntime()
}

registerRuntimeDirectoryEnsurer(ensureRuntimeForDirectory)

async function bootRuntime(projectDirectory?: string | null) {
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

    subscribeToEvents(client, getMainWindow).catch((err) => {
      log('error', `Event subscription error: ${err?.message}`)
      // Auto-reconnect on stream failure
      scheduleReconnect()
    })

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
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('mcp:status', statuses)
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
  createWindow()

  if (getAuthState().authenticated && isSetupComplete()) {
    log('main', 'Runtime prerequisites satisfied, starting runtime')
    await bootRuntime()
  } else {
    log('main', 'Waiting for setup or authentication before starting runtime')
  }

  app.on('activate', () => {
    showOrCreateMainWindow()
  })
})

app.on('second-instance', () => {
  if (app.isReady()) {
    showOrCreateMainWindow()
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
