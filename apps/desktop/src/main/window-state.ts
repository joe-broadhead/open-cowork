import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getAppDataDir } from './config-loader.ts'
import { log } from './logger.ts'

type StoredWindowState = {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
}

function getWindowStatePath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'window-state.json')
}

function normalizeWindowState(state: Partial<StoredWindowState>, defaultWidth: number, defaultHeight: number): StoredWindowState {
  return {
    x: typeof state.x === 'number' ? state.x : undefined,
    y: typeof state.y === 'number' ? state.y : undefined,
    width: typeof state.width === 'number' && state.width >= 800 ? state.width : defaultWidth,
    height: typeof state.height === 'number' && state.height >= 600 ? state.height : defaultHeight,
    isMaximized: state.isMaximized === true,
  }
}

export function loadWindowState(defaultWidth = 1200, defaultHeight = 800) {
  const path = getWindowStatePath()
  if (!existsSync(path)) {
    return normalizeWindowState({}, defaultWidth, defaultHeight)
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredWindowState>
    return normalizeWindowState(parsed, defaultWidth, defaultHeight)
  } catch (err: any) {
    log('main', `Window state load failed: ${err?.message}`)
    return normalizeWindowState({}, defaultWidth, defaultHeight)
  }
}

function persistWindowState(window: BrowserWindow) {
  const path = getWindowStatePath()
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds()
    const nextState: StoredWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: window.isMaximized(),
    }
    writeFileSync(path, JSON.stringify(nextState, null, 2))
  } catch (err: any) {
    log('main', `Window state save failed: ${err?.message}`)
  }
}

export function createWindowState(defaultWidth = 1200, defaultHeight = 800) {
  const state = loadWindowState(defaultWidth, defaultHeight)

  return {
    bounds: {
      x: state.x,
      y: state.y,
      width: state.width,
      height: state.height,
    } satisfies Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height'>,
    isMaximized: state.isMaximized === true,
    manage(window: BrowserWindow) {
      let saveTimer: NodeJS.Timeout | null = null
      const scheduleSave = () => {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
          saveTimer = null
          persistWindowState(window)
        }, 200)
      }

      window.on('resize', scheduleSave)
      window.on('move', scheduleSave)
      window.on('close', () => {
        if (saveTimer) {
          clearTimeout(saveTimer)
          saveTimer = null
        }
        persistWindowState(window)
      })

      if (state.isMaximized) {
        window.maximize()
      }
    },
  }
}
