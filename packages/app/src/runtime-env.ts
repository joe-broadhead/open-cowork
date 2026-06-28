import type { AppAPI } from '@open-cowork/shared'
import { createDesktopAppApi } from './app-api'

// The single runtime-detection leaf. The same renderer is wrapped two ways: the
// Electron shell injects `window.coworkApi` (the IPC bridge); the browser build
// installs a browser CoworkAPI shim as `window.coworkApi` AND sets
// `__coworkBrowserRuntime`. Both have window.coworkApi, so desktop is "coworkApi
// present AND not the browser shim". Every desktop-vs-cloud difference branches
// on this — mirroring OpenWork's runtime-env, so the delta stays auditable.
export function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as { coworkApi?: unknown; __coworkBrowserRuntime?: boolean }
  return w.coworkApi != null && w.__coworkBrowserRuntime !== true
}

let cachedAppApi: AppAPI | null = null

// Resolve the AppAPI for the AppApiProvider. The adapter wraps window.coworkApi,
// which is present in BOTH runtimes — the Electron IPC bridge on desktop, the
// browser CoworkAPI shim in the browser — so the same adapter works either way.
// Platform branching in components uses isDesktopRuntime(), not api.platform.
export function resolveAppApi(): AppAPI {
  if (cachedAppApi) return cachedAppApi
  cachedAppApi = createDesktopAppApi()
  return cachedAppApi
}
