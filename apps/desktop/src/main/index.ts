import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import { join } from 'path'
import { setupIpcHandlers } from './ipc-handlers'
import { startRuntime, stopRuntime } from './runtime'
import { subscribeToEvents, getMcpStatus } from './events'
import { getAuthState } from './auth'

import { log, getLogFilePath } from './logger'
import { telemetry } from './telemetry'

let mainWindow: BrowserWindow | null = null
let runtimeStarted = false

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
}

let mcpInterval: NodeJS.Timeout | null = null

async function bootRuntime() {
  if (runtimeStarted) return
  try {
    log('main', 'Starting OpenCode runtime...')
    const client = await startRuntime()
    runtimeStarted = true
    log('main', 'OpenCode runtime started')
    telemetry.appLaunched()
    log('main', `Log file: ${getLogFilePath()}`)

    subscribeToEvents(client, getMainWindow).catch((err) => {
      log('error', `Event subscription error: ${err?.message}`)
      // Auto-reconnect on stream failure
      scheduleReconnect()
    })

    const pollMcp = async () => {
      try {
        const statuses = await getMcpStatus(client)
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('mcp:status', statuses)
        }
      } catch {
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
  if (!runtimeStarted) return
  log('main', `Runtime disconnected — reconnecting in ${reconnectDelay / 1000}s...`)
  runtimeStarted = false
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('stream:event', {
      type: 'error', sessionId: '', data: { type: 'error', message: `Runtime disconnected. Reconnecting in ${reconnectDelay / 1000}s...` },
    })
  }
  setTimeout(async () => {
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
  // Set dock icon using .icns (has multiple sizes — macOS picks the right one)
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(join(__dirname, '../../resources/icon.icns')) } catch {}
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
    ipcMain.on('auth:boot-runtime', async () => {
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
  await stopRuntime()
})

export { bootRuntime }
