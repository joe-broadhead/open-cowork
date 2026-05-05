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

function prependPathEntry(entry: string, entries: string[]) {
  return [entry, ...entries.filter((candidate) => candidate !== entry)].join(delimiter)
}

export function resolveBundledOpencodeCliEnvironment(options: {
  binary: string | null
  currentPath?: string
  isPackaged: boolean
  wrapper: string | null
}): { opencodeBinPath?: string; path?: string } {
  const pathEntries = (options.currentPath || '').split(delimiter).filter(Boolean)

  // Prefer the platform-native binary package (for example
  // `opencode-darwin-arm64`) over the `opencode-ai/bin/opencode` wrapper.
  // The managed runtime launcher starts `opencode` from PATH; in packaged
  // desktop apps that must resolve to a self-contained executable. The
  // wrapper is a Node script with `#!/usr/bin/env node`, and end-user
  // machines cannot be expected to have a system `node` on PATH.
  if (options.binary) {
    const binaryDir = dirname(options.binary)
    return {
      opencodeBinPath: options.binary,
      path: prependPathEntry(binaryDir, pathEntries),
    }
  }

  if (options.isPackaged) {
    throw new Error('Bundled OpenCode native CLI is missing from the packaged app')
  }

  // Development fallback: pnpm may place the optional native package under
  // opencode-ai's nested dependencies where top-level resolution cannot see
  // it, but the wrapper can still walk relative node_modules and find it.
  if (options.wrapper) {
    const wrapperDir = dirname(options.wrapper)
    return {
      path: prependPathEntry(wrapperDir, pathEntries),
    }
  }

  return {}
}

export function applyBundledOpencodeCliEnvironment() {
  const wrapper = resolveBundledOpencodeWrapperPath()
  const binary = resolveBundledOpencodeBinaryPath()

  const currentPath = process.env.PATH || ''
  const env = resolveBundledOpencodeCliEnvironment({
    binary,
    currentPath,
    isPackaged: Boolean(electronApp?.isPackaged),
    wrapper,
  })

  if (env.path) process.env.PATH = env.path
  if (env.opencodeBinPath) process.env.OPENCODE_BIN_PATH = env.opencodeBinPath
}
