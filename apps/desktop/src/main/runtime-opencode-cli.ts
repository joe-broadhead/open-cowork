import electron from 'electron'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { delimiter, dirname, join, resolve } from 'path'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)

function unpackedResourcePath(value: string) {
  if (!electronApp?.isPackaged) return value
  return value.replace(`${resolve(process.resourcesPath, 'app.asar')}`, resolve(process.resourcesPath, 'app.asar.unpacked'))
}

function resolveBundledNodeModuleDir(moduleName: string): string | null {
  try {
    return dirname(require.resolve(`${moduleName}/package.json`))
  } catch {
    if (!electronApp?.isPackaged) return null
  }

  const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', moduleName)
  return existsSync(join(unpacked, 'package.json')) ? unpacked : null
}

function resolveBundledNodeModuleFile(moduleName: string, relativePath: string): string | null {
  const moduleDir = resolveBundledNodeModuleDir(moduleName)
  if (!moduleDir) return null

  const candidate = join(moduleDir, relativePath)
  const unpacked = unpackedResourcePath(candidate)
  if (existsSync(unpacked)) return unpacked
  if (existsSync(candidate)) return candidate
  return null
}

function resolveBundledPackageJsonPath(moduleName: string): string | null {
  const moduleDir = resolveBundledNodeModuleDir(moduleName)
  return moduleDir ? join(moduleDir, 'package.json') : null
}

function resolveBundledOpencodeWrapperPath(): string | null {
  return resolveBundledNodeModuleFile('opencode-ai', join('bin', 'opencode'))
}

function resolveBundledOpencodeBinaryPath(): string | null {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' || process.arch === 'arm64' || process.arch === 'arm' ? process.arch : process.arch
  const binary = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const moduleNames = [arch === 'x64' ? `opencode-${platform}-${arch}-baseline` : '', `opencode-${platform}-${arch}`].filter(Boolean)

  for (const moduleName of moduleNames) {
    const resolved = resolveBundledNodeModuleFile(moduleName, join('bin', binary))
    if (resolved) return resolved
  }
  return null
}

export function getBundledOpencodeVersion(): string | null {
  const packageJsonPath = resolveBundledPackageJsonPath('opencode-ai')
  if (!packageJsonPath) return null

  try {
    const packageJson = require(packageJsonPath) as { version?: unknown }
    return typeof packageJson.version === 'string' && packageJson.version.length > 0
      ? packageJson.version
      : null
  } catch {
    return null
  }
}

export function applyBundledOpencodeCliEnvironment() {
  const wrapper = resolveBundledOpencodeWrapperPath()
  const binary = resolveBundledOpencodeBinaryPath()

  // The wrapper is mandatory. Without it there's nothing on PATH for the
  // SDK's createOpencode() to spawn, and the app cannot start.
  if (!wrapper) {
    if (electronApp?.isPackaged) {
      throw new Error('Bundled OpenCode CLI is missing from the packaged app')
    }
    return
  }

  const currentPath = process.env.PATH || ''
  const wrapperDir = dirname(wrapper)
  const pathEntries = currentPath.split(delimiter).filter(Boolean)
  if (!pathEntries.includes(wrapperDir)) {
    process.env.PATH = [wrapperDir, ...pathEntries].join(delimiter)
  }

  // The platform-specific binary package (e.g. `opencode-darwin-arm64`) is
  // the wrapper's fast path and is required for packaged builds — the
  // bundled asar layout flattens pnpm's nested node_modules, so the wrapper
  // can't always find the binary on its own. In dev under pnpm workspaces
  // the optional platform package lives one directory deeper inside
  // opencode-ai's own node_modules, which the top-level require.resolve
  // doesn't reach — but the wrapper itself can still resolve it at runtime
  // via its own relative-path walk, so we skip the env override rather
  // than bail entirely.
  if (binary) {
    process.env.OPENCODE_BIN_PATH = binary
  } else if (electronApp?.isPackaged) {
    throw new Error('Bundled OpenCode CLI is missing from the packaged app')
  }
}
