import { shell, session as electronSession } from 'electron'
import type { WebContents } from 'electron'

import {
  isExpectedPackagedRendererFile,
  rendererUrlMatchesDevServer,
} from './main-window-lifecycle.ts'
import { resolveRendererMediaPermission } from './voice-permission-policy.ts'
import { log } from '@open-cowork/shared/node'

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
  expectedRendererEntryPath: string | readonly string[],
  devServerUrl?: string | null,
) {
  if (devServerUrl && rendererUrlMatchesDevServer(url, devServerUrl)) return true
  const currentUrl = contents.getURL()
  if (currentUrl && url === currentUrl) return true
  if (isExpectedPackagedRendererFile(url, expectedRendererEntryPath)) return true
  return false
}

export function attachWebContentsSecurityGuards(
  contents: WebContents,
  expectedRendererEntryPath: string | readonly string[],
  devServerUrl?: string | null,
) {
  if (guardedWebContents.has(contents)) return
  guardedWebContents.add(contents)

  contents.on('will-navigate', (event, url) => {
    if (rendererNavigationIsAllowed(contents, url, expectedRendererEntryPath, devServerUrl)) return
    event.preventDefault()
    openExternalNavigation(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternalNavigation(url)
    return { action: 'deny' }
  })
}

/**
 * Fail-closed renderer permissions (JOE-1098).
 *
 * Private voice owns mic capture in the voice host by default, so Chromium
 * `media` / `microphone` for the Studio renderer stay denied unless a future
 * ADR opts into captureMode === 'renderer' with features.voice enabled.
 */
export function attachPermissionGuards(options: {
  features?: { voice?: boolean }
  captureMode?: 'voice_host' | 'renderer'
} = {}) {
  const features = options.features
  const captureMode = options.captureMode || 'voice_host'

  electronSession.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const decision = resolveRendererMediaPermission({
      features,
      captureMode,
      permission,
    })
    if (decision.allowed) {
      log('security', `Granted renderer permission request: ${permission} (${decision.reason})`)
      callback(true)
      return
    }
    log('security', `Denied renderer permission request: ${permission} (${decision.reason})`)
    callback(false)
  })

  electronSession.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const decision = resolveRendererMediaPermission({
      features,
      captureMode,
      permission: String(permission),
    })
    return decision.allowed
  })
}
