import { getAppPathHost } from '@open-cowork/shared/node'
import { join } from 'node:path'

// Root directories where bundled skill packages may live, in priority
// order. Kept independent from skill copying and catalog construction so
// both consumers can resolve the same paths without importing each other.
export function getBundledSkillRoots(): string[] {
  const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
  const roots: string[] = []
  // The app-path host is unset outside Electron (cloud / node:test), so fall
  // back to cwd-relative roots so tests can still resolve the repo's bundles.
  if (getAppPathHost()?.isPackaged) {
    roots.push(join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), 'runtime-config', 'skills'))
    roots.push(join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), 'skills'))
  } else if (getAppPathHost()?.getAppPath) {
    const appPath = getAppPathHost()!.getAppPath!()
    roots.push(join(appPath, 'runtime-config', 'skills'))
    roots.push(join(appPath, '..', '..', 'skills'))
  } else {
    roots.push(join(process.cwd(), 'runtime-config', 'skills'))
    roots.push(join(process.cwd(), 'skills'))
  }
  if (downstreamRoot) {
    roots.unshift(join(downstreamRoot, 'skills'))
  }
  return roots
}
