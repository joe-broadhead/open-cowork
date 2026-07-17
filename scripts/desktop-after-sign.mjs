/**
 * electron-builder signs (often deeply) after afterPack. That mutates the
 * bundled OpenCode binary on macOS ad-hoc/Developer ID runs, so the integrity
 * hashes written in afterPack no longer match. Rewrite the runtime component
 * manifest against the post-sign bytes, then re-sign only the outer .app so we
 * do not re-hash the nested CLI again.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  getResourcesDir,
  writePackagedRuntimeComponentManifest,
} from './desktop-after-pack.mjs'

function findMacAppBundle(appOutDir) {
  return readdirSync(appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
}

export function createDesktopAfterSign(options = {}) {
  return async function afterSign(context) {
    if (context.electronPlatformName !== 'darwin') {
      // Non-mac packaging does not re-hash nested Mach-O payloads the way
      // codesign does; afterPack hashes remain valid.
      return
    }

    const resourcesDir = getResourcesDir(context)
    const targetArch = context.arch
    await writePackagedRuntimeComponentManifest(resourcesDir, {
      ...options,
      electronPlatformName: context.electronPlatformName,
      arch: typeof targetArch === 'number'
        ? ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }[targetArch] || String(targetArch))
        : targetArch,
    })

    const appBundle = findMacAppBundle(context.appOutDir)
    if (!appBundle) return
    const appPath = join(context.appOutDir, appBundle.name)
    if (!existsSync(appPath)) return

    // Outer-only ad-hoc resign: rewriting Resources invalidates the outer
    // signature. Avoid --deep so the nested opencode CLI hash stays stable.
    try {
      execFileSync('codesign', ['--force', '--sign', '-', appPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      process.stdout.write(`[desktop-after-sign] rewrote runtime component manifest and re-signed outer app ${appBundle.name}\n`)
    } catch (error) {
      process.stdout.write(
        `[desktop-after-sign] rewrote runtime component manifest; outer re-sign skipped: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
}

export default createDesktopAfterSign()
