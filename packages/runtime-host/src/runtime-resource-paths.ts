import { getAppPathHost } from '@open-cowork/shared/node'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function resolveRuntimeResourcePath(...segments: string[]) {
  if (getAppPathHost()?.isPackaged) {
    return join(((process as { resourcesPath?: string }).resourcesPath ?? process.cwd()), ...segments)
  }
  const appPath = getAppPathHost()?.getAppPath?.() || process.cwd()
  return resolve(appPath, '..', '..', ...segments)
}

export function resolveBundledMcpScriptPath(name: string) {
  const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
  if (downstreamRoot) {
    const downstreamMcp = join(downstreamRoot, 'mcps', name, 'dist', 'index.js')
    if (existsSync(downstreamMcp)) return downstreamMcp
  }
  return resolveRuntimeResourcePath('mcps', name, 'dist', 'index.js')
}
