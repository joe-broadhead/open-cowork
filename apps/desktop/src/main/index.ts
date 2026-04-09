import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { setupIpcHandlers } from './ipc-handlers'
import { startRuntime, stopRuntime } from './runtime'
import { subscribeToEvents, getMcpStatus } from './events'
import { log, getLogFilePath } from './logger'

let mainWindow: BrowserWindow | null = null

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
    backgroundColor: '#0d0d0d',
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

app.whenReady().then(async () => {
  // Set up IPC handlers before creating window
  setupIpcHandlers(ipcMain, getMainWindow)
  createWindow()

  // Start OpenCode runtime
  try {
    log('main', 'Starting OpenCode runtime...')
    const client = await startRuntime()
    log('main', 'OpenCode runtime started')
    log('main', `Log file: ${getLogFilePath()}`)

    // Subscribe to SSE events and forward to renderer
    subscribeToEvents(client, getMainWindow).catch((err) => {
      log('error', `Event subscription error: ${err?.message}`)
    })

    // Poll MCP status and push to renderer
    const pollMcp = async () => {
      const statuses = await getMcpStatus(client)
      log('mcp', `Status: ${statuses.map(s => `${s.name}=${s.connected ? 'up' : 'down'}`).join(', ')}`)
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('mcp:status', statuses)
      }
    }
    // Initial poll after a delay to let MCPs connect
    setTimeout(pollMcp, 3000)
    setInterval(pollMcp, 10_000)
  } catch (err: any) {
    log('error', `Failed to start runtime: ${err?.message}`)
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
