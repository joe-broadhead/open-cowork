import type { AppAPI } from '@open-cowork/shared'
import { createDesktopAppApi } from './app-api'

// The single runtime-detection leaf. The same renderer is wrapped two ways: the
// Electron shell injects `window.coworkApi` (the IPC bridge); a plain browser
// build does not. Every desktop-vs-cloud difference branches on this — mirroring
// OpenWork's `runtime-env.ts`, so the platform delta stays auditable in one grep.
export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && (window as { coworkApi?: unknown }).coworkApi != null
}

let cachedAppApi: AppAPI | null = null

// Resolve the AppAPI implementation for the current runtime. Today only the
// desktop (Electron/IPC) adapter is wired; the cloud/browser branch
// (`createCloudWebAppApi` against the HTTP backend) is added in a later phase,
// selected here by `!isDesktopRuntime()`. Components only ever call `useAppApi()`.
export function resolveAppApi(): AppAPI {
  if (cachedAppApi) return cachedAppApi
  if (!isDesktopRuntime()) {
    throw new Error('The cloud/browser AppAPI is not wired in this build yet.')
  }
  cachedAppApi = createDesktopAppApi()
  return cachedAppApi
}
