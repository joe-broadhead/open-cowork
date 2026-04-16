import electron from 'electron'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { delimiter, dirname, join, resolve } from 'path'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const require = createRequire(import.meta.url)

function unpackedResourcePath(value: string) {
  if (!electronApp?.isPackaged) return value
  return value.replace(`${resolve(process.resourcesPath, 'app.asar')}`, resolve(process.resourcesPath, 'app.asar.unpacked'))
}

function resolveBundledNodeModuleFile(moduleName: string, relativePath: string): string | null {
  try {
    const packageJson = require.resolve(`${moduleName}/package.json`)
    const candidate = join(dirname(packageJson), relativePath)
    const unpacked = unpackedResourcePath(candidate)
    if (existsSync(unpacked)) return unpacked
    if (existsSync(candidate)) return candidate
  } catch {
    return null
  }
  return null
}

function resolveBundledPackageJsonPath(moduleName: string): string | null {
  try {
    return require.resolve(`${moduleName}/package.json`)
  } catch {
    return null
  }
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

  if (!wrapper || !binary) {
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
  process.env.OPENCODE_BIN_PATH = binary
}
