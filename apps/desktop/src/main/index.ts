import { app, BrowserWindow, ipcMain, Menu, shell, nativeImage } from 'electron'
import { join } from 'path'
import { setupIpcHandlers } from './ipc-handlers'
import { startRuntime, stopRuntime } from './runtime'
import { subscribeToEvents, getMcpStatus } from './events'
import { getAuthState } from './auth'
import { flushSessionRegistryWrites } from './session-registry'
import { getEnabledBuiltInMcps } from './plugin-manager'

import { log, getLogFilePath, closeLogger } from './logger'
import { telemetry } from './telemetry'

let mainWindow: BrowserWindow | null = null
let runtimeStarted = false
let reconnectTimer: NodeJS.Timeout | null = null

function getMainWindow() {
  return mainWindow
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: join(__dirname, '../../resources/icon.png'),
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

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../index.html'))
  }

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
    ...getEnabledBuiltInMcps()
      .filter((mcp) => mcp.type === 'local')
      .map((mcp) => mcp.name),
  ])
}

export async function rebootRuntime() {
  if (mcpInterval) { clearInterval(mcpInterval); mcpInterval = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  runtimeStarted = false
  await stopRuntime()
  try {
    await bootRuntime()
  } catch (err: any) {
    log('error', `Runtime reboot failed: ${err?.message}`)
    scheduleReconnect()
  }
}

async function bootRuntime() {
  if (runtimeStarted) return
  try {
    log('main', 'Starting OpenCode runtime...')
    const client = await startRuntime()
    runtimeStarted = true
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
          await client.mcp.connect({ path: { name: entry.name } })
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
    log('error', `Failed to start runtime: ${err?.message}`)
    scheduleReconnect()
  }
}

let reconnectDelay = 3000
const MAX_RECONNECT_DELAY = 60000

function scheduleReconnect() {
  if (reconnectTimer) return
  log('main', `Runtime disconnected — reconnecting in ${reconnectDelay / 1000}s...`)
  runtimeStarted = false
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('stream:event', {
      type: 'error', sessionId: '', data: { type: 'error', message: `Runtime disconnected. Reconnecting in ${reconnectDelay / 1000}s...` },
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

// Set app name before anything else
app.name = 'Cowork'

app.whenReady().then(async () => {
  // Set dock icon — use 128px PNG for correct dock sizing
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = join(__dirname, '../../resources/icon-128.png')
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
      label: 'Cowork',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('navigate', 'settings') },
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
        { label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('action', 'new-thread') },
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
        { label: 'Search Threads', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('action', 'search') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => mainWindow?.webContents.send('action', 'toggle-sidebar') },
        { label: 'Agents', accelerator: 'CmdOrCtrl+Shift+A', click: () => mainWindow?.webContents.send('navigate', 'agents') },
        { label: 'Plugins', accelerator: 'CmdOrCtrl+Shift+P', click: () => mainWindow?.webContents.send('navigate', 'plugins') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
        { label: 'Cowork Documentation', click: () => shell.openExternal('https://github.com/joe-broadhead/cowork') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  setupIpcHandlers(ipcMain, getMainWindow)
  createWindow()

  // Start runtime immediately if already authenticated, otherwise wait for login
  if (getAuthState().authenticated) {
    log('main', 'ADC found, starting runtime')
    await bootRuntime()
  } else {
    log('main', 'No ADC found, waiting for login')
    // Listen for successful login to boot runtime
    ipcMain.once('auth:boot-runtime', async () => {
      await bootRuntime()
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  flushSessionRegistryWrites()
  await stopRuntime()
  closeLogger()
})

export { bootRuntime }
