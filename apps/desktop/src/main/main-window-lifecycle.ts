type WindowLike = {
  isDestroyed(): boolean
  isVisible(): boolean
}

export function rendererUrlLooksWrong(url: string, devServerUrl?: string | null) {
  if (!url) return true
  if (devServerUrl) {
    return !url.startsWith(devServerUrl)
  }
  return url.endsWith('.js') || url.includes('/assets/') || !url.endsWith('/index.html')
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
