import { log } from './logger.ts'
import type { UpdateCheckResult } from '@open-cowork/shared'
import { resolveUpdateReleaseSource, UpdateReleaseSourceError } from './update-release-source.ts'
import { sanitizeLogMessage } from './log-sanitizer.ts'
export { compareVersions, parseGithubRepo } from './update-version.ts'

// Package.json's `version` is load-bearing for this check — it's what
// we compare against the remote `tag_name`. We read it lazily because
// the module can be imported from test contexts where `require` isn't
// available.
export async function getCurrentVersion(): Promise<string> {
  try {
    // package.json is bundled inside the asar; Electron exposes it
    // via `app.getVersion()`. Dynamic import keeps the module
    // importable from test contexts that don't load Electron.
    const electron = await import('electron')
    return electron.app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function checkForUpdates(options: Parameters<typeof resolveUpdateReleaseSource>[0] = {}): Promise<UpdateCheckResult> {
  const current = options?.currentVersion ?? await getCurrentVersion()
  try {
    const source = await resolveUpdateReleaseSource({ ...options, currentVersion: current })
    const result = await source.discoverLatest()
    if (result.status === 'ok') {
      log('app', `Update check: source=${source.descriptor.kind} current=${current} latest=${result.latestVersion} hasUpdate=${result.hasUpdate}`)
    }
    return result
  } catch (err) {
    if (err instanceof UpdateReleaseSourceError) {
      const disabledReasons = new Set(['source-disabled', 'source-misconfigured', 'auth-required', 'auth-expired'])
      return {
        status: disabledReasons.has(err.reason) ? 'disabled' : 'error',
        currentVersion: current,
        message: sanitizeLogMessage(err.message),
      }
    }
    const message = sanitizeLogMessage(err instanceof Error ? err.message : String(err))
    return { status: 'error', currentVersion: current, message }
  }
}
