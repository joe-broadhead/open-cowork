import electron from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { delimiter, dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'node:util'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const currentModulePath = typeof __filename === 'string' && __filename !== '[eval]'
  ? __filename
  : fileURLToPath(import.meta.url)
const currentModuleDir = dirname(currentModulePath)
const require = createRequire(currentModulePath)
const execFileAsync = promisify(execFile)

function unpackedResourcePath(value: string) {
  if (!electronApp?.isPackaged) return value
  return value.replace(`${resolve(process.resourcesPath, 'app.asar')}`, resolve(process.resourcesPath, 'app.asar.unpacked'))
}

function resolveBundledNodeModuleDir(moduleName: string): string | null {
  try {
    return dirname(require.resolve(`${moduleName}/package.json`))
  } catch {
    // pnpm can keep optional OpenCode platform packages under opencode-ai's
    // virtual-store node_modules, so fall through to explicit lookups.
  }

  if (electronApp?.isPackaged) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', moduleName)
    if (existsSync(join(unpacked, 'package.json'))) return unpacked
  }

  if (moduleName !== 'opencode-ai') {
    const opencodeModuleDir = resolveBundledNodeModuleDir('opencode-ai')
    const pnpmVirtualStoreNodeModules = opencodeModuleDir ? dirname(opencodeModuleDir) : null
    const nested = opencodeModuleDir ? join(opencodeModuleDir, 'node_modules', moduleName) : null
    const sibling = pnpmVirtualStoreNodeModules ? join(pnpmVirtualStoreNodeModules, moduleName) : null
    for (const candidate of [nested, sibling]) {
      if (candidate && existsSync(join(candidate, 'package.json'))) return candidate
    }
  }

  return null
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

function resolvePackageJsonFromEntry(moduleName: string): string | null {
  try {
    let dir = dirname(require.resolve(moduleName))
    while (true) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

function resolveDevelopmentPackageJsonPath(moduleName: string): string | null {
  if (electronApp?.isPackaged) return null
  const moduleParts = moduleName.split('/').filter(Boolean)
  const candidate = resolve(currentModuleDir, '..', '..', 'node_modules', ...moduleParts, 'package.json')
  return existsSync(candidate) ? candidate : null
}

export function resolveBundledOpencodeWrapperPath(): string | null {
  return resolveBundledNodeModuleFile('opencode-ai', join('bin', 'opencode'))
}

export function resolveBundledOpencodeBinaryPath(): string | null {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch
  const binary = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const moduleNames = [arch === 'x64' ? `opencode-${platform}-${arch}-baseline` : '', `opencode-${platform}-${arch}`].filter(Boolean)

  for (const moduleName of moduleNames) {
    const resolved = resolveBundledNodeModuleFile(moduleName, join('bin', binary))
    if (resolved) return resolved
  }
  return null
}

export function resolveBundledOpencodePackageJsonPath(): string | null {
  return resolveBundledPackageJsonPath('opencode-ai')
}

export function resolveBundledOpencodeSdkPackageJsonPath(): string | null {
  return resolveBundledPackageJsonPath('@opencode-ai/sdk')
    || resolvePackageJsonFromEntry('@opencode-ai/sdk')
    || resolveDevelopmentPackageJsonPath('@opencode-ai/sdk')
}

export function getBundledOpencodeVersion(): string | null {
  const packageJsonPath = resolveBundledOpencodePackageJsonPath()
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

export function getBundledOpencodeSdkVersion(): string | null {
  const packageJsonPath = resolveBundledOpencodeSdkPackageJsonPath()
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
  // The managed runtime launcher receives this resolved binary path directly;
  // in packaged desktop apps it must be a self-contained executable.
  // The wrapper is a Node script with `#!/usr/bin/env node`, and end-user
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
  return env
}

export async function readBundledOpencodeCliVersion(env: {
  opencodeBinPath?: string | null
  path?: string | null
} = {}): Promise<string | null> {
  const command = env.opencodeBinPath?.trim() || 'opencode'
  const nextEnv = {
    ...process.env,
    ...(env.path ? { PATH: env.path } : {}),
  }
  try {
    const result = await execFileAsync(command, ['--version'], {
      env: nextEnv,
      timeout: 5000,
      windowsHide: true,
    })
    const text = `${result.stdout || ''}\n${result.stderr || ''}`
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    return text || null
  } catch {
    return getBundledOpencodeVersion()
  }
}
