import type { CoworkAPI } from '@open-cowork/shared'
import { createBrowserCoworkApi } from './cowork-api'

// Browser entry for the unified renderer. The Electron shell injects
// window.coworkApi over IPC; here we install a browser implementation that talks
// to the cloud HTTP+SSE backend, BEFORE the renderer boots, so the exact same
// renderer (apps/desktop/src/renderer) runs unchanged in a plain browser.

function readBootstrap(): Record<string, unknown> | undefined {
  const element = document.getElementById('cowork-bootstrap')
  const raw = element?.textContent?.trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

// Mark the browser runtime BEFORE installing the shim, so isDesktopRuntime()
// can tell the browser CoworkAPI shim apart from the real Electron IPC bridge
// (both populate window.coworkApi).
;(window as unknown as { __coworkBrowserRuntime: boolean }).__coworkBrowserRuntime = true
;(window as unknown as { coworkApi: CoworkAPI }).coworkApi = createBrowserCoworkApi(readBootstrap())

// Dynamic import so the window.coworkApi assignment above runs before any
// renderer module (which reads window.coworkApi) is evaluated.
void import('../index')
