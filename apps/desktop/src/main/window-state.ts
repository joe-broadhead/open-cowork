import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from 'electron'
import { screen } from 'electron'
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

function clampToDisplay(state: StoredWindowState): StoredWindowState {
  const displays = screen.getAllDisplays()
  const fallbackDisplay = screen.getPrimaryDisplay()
  const targetDisplay = typeof state.x === 'number' && typeof state.y === 'number'
    ? screen.getDisplayNearestPoint({ x: state.x, y: state.y })
    : fallbackDisplay
  const workArea: Rectangle = (displays.find((display) => display.id === targetDisplay.id) || fallbackDisplay).workArea

  const width = Math.max(800, Math.min(state.width, workArea.width))
  const height = Math.max(600, Math.min(state.height, workArea.height))

  if (typeof state.x !== 'number' || typeof state.y !== 'number') {
    return {
      ...state,
      width,
      height,
      x: undefined,
      y: undefined,
    }
  }

  const maxX = workArea.x + Math.max(0, workArea.width - width)
  const maxY = workArea.y + Math.max(0, workArea.height - height)

  return {
    ...state,
    width,
    height,
    x: Math.min(Math.max(state.x, workArea.x), maxX),
    y: Math.min(Math.max(state.y, workArea.y), maxY),
  }
}

export function loadWindowState(defaultWidth = 1200, defaultHeight = 800) {
  const path = getWindowStatePath()
  if (!existsSync(path)) {
    return normalizeWindowState({}, defaultWidth, defaultHeight)
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredWindowState>
    return clampToDisplay(normalizeWindowState(parsed, defaultWidth, defaultHeight))
  } catch (err: unknown) {
    log('main', `Window state load failed: ${err instanceof Error ? err.message : String(err)}`)
    return clampToDisplay(normalizeWindowState({}, defaultWidth, defaultHeight))
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
  } catch (err: unknown) {
    log('main', `Window state save failed: ${err instanceof Error ? err.message : String(err)}`)
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

    },
  }
}
