import type { App } from 'electron'
import { BrowserWindow } from 'electron'
import { join } from 'path'

import { attachWebContentsSecurityGuards } from './main-window-security.ts'
import {
  needsMainWindowRecovery,
  pickRecoverableMainWindow,
  rendererUrlLooksWrong,
  shouldRecoverMainWindowFromDidFailLoad,
} from './main-window-lifecycle.ts'
import { loadSettings } from './settings.ts'
import { resolveStartupSplashTemplatePath, writeStartupSplashFile } from './startup-splash.ts'
import { createWindowState } from './window-state.ts'

export function createMainWindowController(options: {
  app: App
  appDirname: string
  brandName: string
  getAppIsQuitting: () => boolean
  log: (category: string, message: string) => void
}) {
  let mainWindow: BrowserWindow | null = null
  let mainWindowRecoveryTimer: NodeJS.Timeout | null = null

  function getMainWindow() {
    return mainWindow
  }

  function clearMainWindowRecoveryTimer() {
    if (!mainWindowRecoveryTimer) return
    clearTimeout(mainWindowRecoveryTimer)
    mainWindowRecoveryTimer = null
  }

  function getPackagedResourcePath(...segments: string[]) {
    if (options.app.isPackaged) {
      return join(process.resourcesPath, ...segments)
    }
    return join(options.appDirname, '../../resources', ...segments)
  }

  function expectedRendererEntryPath() {
    return join(options.appDirname, '../index.html')
  }

  function startupSplashPath() {
    const templatePath = resolveStartupSplashTemplatePath(options.appDirname)
    try {
      return writeStartupSplashFile({
        templatePath,
        outputDir: join(options.app.getPath('userData'), 'startup'),
        brandName: options.brandName,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.log('main', `Falling back to packaged startup splash: ${message}`)
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
    options.log('main', `Renderer loaded unexpected URL, restoring shell: ${currentUrl || '(empty)'}`)
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
    options.app.focus({ steal: true })
    window.focus()

    if (!window.isFocused()) {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      window.moveTop()
      options.app.focus({ steal: true })
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
    options.log('main', `Recreating main window due to ${reason}`)
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
        options.log('main', `Deferring window recovery while renderer is still booting (${reason})`)
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
        preload: join(options.appDirname, '../preload/index.js'),
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
      options.log('main', `Revealing main window (${source}) x=${bounds.x} y=${bounds.y} w=${bounds.width} h=${bounds.height} visible=${String(window.isVisible())} minimized=${String(window.isMinimized())}`)
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
      options.log('renderer', 'Renderer did-finish-load')
      revealCurrentWindow('did-finish-load')
    })
    window.once('ready-to-show', () => {
      revealCurrentWindow('ready-to-show')
    })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      options.log('error', `Renderer did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL} mainFrame=${String(isMainFrame)}`)
      if (!shouldRecoverMainWindowFromDidFailLoad({ isMainFrame, validatedURL })) {
        return
      }
      scheduleMainWindowRecovery('did-fail-load', 300)
    })
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      options.log('renderer', `console[${level}] ${sourceId}:${line} ${message}`)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      options.log('error', `Renderer process gone: reason=${details.reason} exitCode=${String(details.exitCode)}`)
      scheduleMainWindowRecovery('render-process-gone', 100)
    })

    void window.loadFile(startupSplashPath())
    if (process.env.VITE_DEV_SERVER_URL) {
      options.log('main', 'Opening DevTools because VITE_DEV_SERVER_URL is set for a development renderer.')
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
      if (options.getAppIsQuitting()) return
      const settings = loadSettings()
      if (!settings.automationRunInBackground) return
      event.preventDefault()
      window.hide()
    })

    attachWebContentsSecurityGuards(window.webContents, expectedRendererEntryPath())

    return window
  }

  return {
    createWindow,
    expectedRendererEntryPath,
    getMainWindow,
    getPackagedResourcePath,
    showOrCreateMainWindow,
  }
}
