import electron from 'electron'
import { rmSync } from 'fs'
import { getAppDataDir } from './config-loader.ts'
import { getSandboxRootDir } from './runtime-paths.ts'
import { log } from './logger.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app

// Full app-state wipe. Called behind a destructive-confirmation
// token so a prompt-injected renderer can't trigger it. Removes:
//
//   1. User-data dir: settings.enc, session-registry.json, logs,
//      chart-artifacts, custom agent/skill/mcp overlays.
//   2. Sandbox workspaces: per-thread working directories under
//      ~/Open Cowork Sandbox/ (or the downstream-rebranded name).
//
// Credentials encrypted via safeStorage live in the user-data dir,
// so step 1 takes care of those too. Keychain entries that safeStorage
// uses as its encryption key stay — they're keyed to the app's bundle
// id, not the data, and will be silently re-created next launch.
//
// After deletion we relaunch the app so the user lands in the
// first-run flow with a fresh state. Relaunch + quit is the standard
// Electron recipe; the main process exits, a new one starts.
export function resetAppData(): { removedPaths: string[] } {
  const removedPaths: string[] = []

  const appDataDir = getAppDataDir()
  const sandboxRoot = getSandboxRootDir()

  const targets = [
    { label: 'user-data', path: appDataDir },
    { label: 'sandbox', path: sandboxRoot },
  ]

  for (const target of targets) {
    try {
      rmSync(target.path, { recursive: true, force: true })
      removedPaths.push(target.path)
      log('app', `Reset wiped ${target.label}: ${target.path}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', `Reset failed to remove ${target.label} at ${target.path}: ${message}`)
      // Continue with the remaining targets — partial reset is better
      // than no reset when one path is locked (e.g. a stale logfile
      // handle on Windows).
    }
  }

  // Schedule relaunch then quit so the process exits after the renderer
  // has a moment to show the confirmation.
  if (electronApp) {
    setTimeout(() => {
      try {
        electronApp.relaunch()
      } catch {
        /* dev-mode main may not support relaunch; quit anyway */
      }
      electronApp.exit(0)
    }, 200)
  }

  return { removedPaths }
}
