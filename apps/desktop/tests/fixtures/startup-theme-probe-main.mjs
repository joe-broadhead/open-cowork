import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

const states = JSON.parse(process.env.OPEN_COWORK_STARTUP_PROBE_STATES || '[]')
const splashPaths = JSON.parse(process.env.OPEN_COWORK_STARTUP_PROBE_SPLASH_PATHS || '[]')
const loadingPath = fileURLToPath(new URL('../../dist/loading.html', import.meta.url))
const preloadPath = fileURLToPath(new URL('./startup-theme-probe-preload.cjs', import.meta.url))

// Electron closes BrowserWindows once their JavaScript wrappers are collected.
// Keep every probe window alive until Playwright closes the application.
const windows = []

void app.whenReady().then(async () => {
  async function createProbeWindow(state, index, load) {
    const window = new BrowserWindow({
      width: 520,
      height: 360,
      x: 80 + index * 32,
      y: 80 + index * 32,
      show: false,
      resizable: false,
      titleBarStyle: 'hiddenInset',
      backgroundColor: state.tokens.base,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    window.once('ready-to-show', () => window.show())
    await load(window)
    windows.push(window)
  }

  for (const [index, state] of states.entries()) {
    await createProbeWindow(state, index, (window) => window.loadFile(loadingPath, {
      query: { 'startup-state': JSON.stringify(state) },
    }))
  }
  for (const [index, splashPath] of splashPaths.entries()) {
    await createProbeWindow(states[index], states.length + index, (window) => window.loadFile(splashPath))
  }
})
