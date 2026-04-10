import { app, BrowserWindow, ipcMain } from 'electron'
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
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0a0a0a',
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

function scheduleReconnect() {
  if (!runtimeStarted) return
  log('main', 'Runtime disconnected — reconnecting in 3s...')
  runtimeStarted = false
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('stream:event', {
      type: 'error', sessionId: '', data: { type: 'error', message: 'Runtime disconnected. Reconnecting...' },
    })
  }
  setTimeout(async () => {
    await stopRuntime()
    await bootRuntime()
  }, 3000)
}

app.whenReady().then(async () => {
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
