import { shell, session as electronSession } from 'electron'
import type { WebContents } from 'electron'

import {
  isExpectedPackagedRendererFile,
  rendererUrlMatchesDevServer,
} from './main-window-lifecycle.ts'
import { log } from './logger.ts'

const guardedWebContents = new WeakSet<WebContents>()

export function openExternalNavigation(url: string) {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      log('security', `Blocked external navigation to unsupported protocol: ${parsed.protocol}`)
      return
    }
  } catch {
    log('security', 'Blocked malformed external navigation target')
    return
  }

  void shell.openExternal(url).catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    log('error', `Failed to open external URL: ${message}`)
  })
}

function rendererNavigationIsAllowed(
  contents: WebContents,
  url: string,
  expectedRendererEntryPath: string,
) {
  if (process.env.VITE_DEV_SERVER_URL && rendererUrlMatchesDevServer(url, process.env.VITE_DEV_SERVER_URL)) return true
  const currentUrl = contents.getURL()
  if (currentUrl && url === currentUrl) return true
  if (isExpectedPackagedRendererFile(url, expectedRendererEntryPath)) return true
  return false
}

export function attachWebContentsSecurityGuards(contents: WebContents, expectedRendererEntryPath: string) {
  if (guardedWebContents.has(contents)) return
  guardedWebContents.add(contents)

  contents.on('will-navigate', (event, url) => {
    if (rendererNavigationIsAllowed(contents, url, expectedRendererEntryPath)) return
    event.preventDefault()
    openExternalNavigation(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternalNavigation(url)
    return { action: 'deny' }
  })
}

export function attachPermissionGuards() {
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    log('security', `Denied renderer permission request: ${permission}`)
    callback(false)
  })
  electronSession.defaultSession.setPermissionCheckHandler(() => false)
}
