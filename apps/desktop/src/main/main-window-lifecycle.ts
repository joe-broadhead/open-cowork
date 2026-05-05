import { resolve } from 'path'
import { fileURLToPath } from 'url'

type WindowLike = {
  isDestroyed(): boolean
  isVisible(): boolean
}

export function rendererUrlLooksWrong(url: string, devServerUrl?: string | null) {
  if (!url) return true
  if (devServerUrl) {
    return !rendererUrlMatchesDevServer(url, devServerUrl)
  }
  return url.endsWith('.js') || url.includes('/assets/') || !url.endsWith('/index.html')
}

export function isExpectedPackagedRendererFile(url: string, expectedRendererPath: string) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    return resolve(fileURLToPath(parsed)) === resolve(expectedRendererPath)
  } catch {
    return false
  }
}

export function rendererUrlMatchesDevServer(rawUrl: string, devServerUrl: string) {
  try {
    const parsed = new URL(rawUrl)
    const expected = new URL(devServerUrl)
    if (parsed.origin !== expected.origin) return false
    const expectedPath = expected.pathname.endsWith('/') ? expected.pathname : `${expected.pathname}/`
    return parsed.pathname === expected.pathname || parsed.pathname.startsWith(expectedPath)
  } catch {
    return false
  }
}

export function isTrustedRendererIpcUrl(options: {
  rawUrl: string
  devServerUrl?: string | null
  expectedRendererPath: string
}) {
  if (!options.rawUrl) return false
  if (options.devServerUrl && rendererUrlMatchesDevServer(options.rawUrl, options.devServerUrl)) return true
  return isExpectedPackagedRendererFile(options.rawUrl, options.expectedRendererPath)
}

export function pickRecoverableMainWindow<T extends WindowLike>(
  currentWindow: T | null,
  allWindows: readonly T[],
) {
  if (currentWindow && !currentWindow.isDestroyed()) {
    return currentWindow
  }
  return allWindows.find((window) => !window.isDestroyed()) || null
}

export function needsMainWindowRecovery<T extends WindowLike>(window: T | null) {
  return !window || window.isDestroyed() || !window.isVisible()
}

export function shouldRecoverMainWindowFromDidFailLoad(options: {
  isMainFrame: boolean
  validatedURL?: string | null
}) {
  if (!options.isMainFrame) return false
  return Boolean(options.validatedURL)
}
