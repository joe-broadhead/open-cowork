import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const virtualStoreDir = join(repoRoot, 'node_modules', '.pnpm')
const platformPrefixes = {
  darwin: 'opencode-darwin-',
  linux: 'opencode-linux-',
  win32: 'opencode-windows-',
}
const archNames = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
}

export function getResourcesDir(context) {
  if (context.electronPlatformName !== 'darwin') {
    return join(context.appOutDir, 'resources')
  }

  const appBundle = readdirSync(context.appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (!appBundle) {
    throw new Error(`No macOS .app bundle found in ${context.appOutDir}`)
  }
  return join(context.appOutDir, appBundle.name, 'Contents', 'Resources')
}

export function getPackageName(storeEntryName) {
  const peerSeparator = storeEntryName.indexOf('_')
  const nameWithVersion = peerSeparator >= 0 ? storeEntryName.slice(0, peerSeparator) : storeEntryName
  const versionSeparator = nameWithVersion.lastIndexOf('@')
  return versionSeparator > 0 ? nameWithVersion.slice(0, versionSeparator) : nameWithVersion
}

export function getPackageVersion(storeEntryName) {
  const peerSeparator = storeEntryName.indexOf('_')
  const nameWithVersion = peerSeparator >= 0 ? storeEntryName.slice(0, peerSeparator) : storeEntryName
  const versionSeparator = nameWithVersion.lastIndexOf('@')
  if (versionSeparator <= 0) return null
  return nameWithVersion.slice(versionSeparator + 1) || null
}

export function resolveInstalledOpencodeVersion(options = {}) {
  const packageJsonPath = options.opencodePackageJsonPath || join(repoRoot, 'apps', 'desktop', 'node_modules', 'opencode-ai', 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Installed opencode-ai package metadata not found at ${packageJsonPath}. Run pnpm install before packaging.`)
  }
  const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error(`Installed opencode-ai package metadata at ${packageJsonPath} does not contain a valid version.`)
  }
  return metadata.version
}

export function getTargetArchName(rawArch) {
  if (typeof rawArch === 'string') return rawArch
  if (typeof rawArch === 'number') return archNames[rawArch] || null
  return null
}

export function packageTargetsArch(packageName, archName) {
  if (!archName || archName === 'universal') return true
  if (archName === 'armv7l') return packageName.includes('-arm')
  return packageName.includes(`-${archName}`)
}

export function listInstalledOpencodePackages(platformName, archName, options = {}) {
  const storeDir = options.virtualStoreDir || virtualStoreDir
  const expectedVersion = options.expectedVersion || null
  const prefix = platformPrefixes[platformName]
  if (!prefix) return []
  if (!existsSync(storeDir)) {
    throw new Error(
      `pnpm virtual store not found at ${storeDir}. Run pnpm install before packaging, and keep pnpm-workspace.yaml supportedArchitectures aligned with Electron Builder targets.`,
    )
  }

  const binaryName = platformName === 'win32' ? 'opencode.exe' : 'opencode'
  const packagesByName = new Map()
  for (const entry of readdirSync(storeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const packageName = getPackageName(entry.name)
    const packageVersion = getPackageVersion(entry.name)
    if (expectedVersion && packageVersion !== expectedVersion) continue
    if (!packageTargetsArch(packageName, archName)) continue

    const sourceDir = join(storeDir, entry.name, 'node_modules', packageName)
    if (!existsSync(join(sourceDir, 'bin', binaryName))) continue
    packagesByName.set(packageName, { name: packageName, version: packageVersion, sourceDir })
  }

  return Array.from(packagesByName.values())
}

export function createDesktopAfterPack(options = {}) {
  return async function afterPack(context) {
    const targetArch = getTargetArchName(context.arch)
    const expectedVersion = options.expectedVersion || resolveInstalledOpencodeVersion(options)
    const packages = listInstalledOpencodePackages(context.electronPlatformName, targetArch, {
      ...options,
      expectedVersion,
    })
    if (packages.length === 0) {
      throw new Error(
        `No installed OpenCode native binary package found for ${context.electronPlatformName}/${targetArch || 'unknown-arch'} matching opencode-ai ${expectedVersion}. Run pnpm install and confirm the matching opencode native optional package is present in node_modules/.pnpm.`,
      )
    }

    const targetModulesDir = join(getResourcesDir(context), 'app.asar.unpacked', 'node_modules')
    mkdirSync(targetModulesDir, { recursive: true })

    for (const entry of packages) {
      const targetPackageDir = join(targetModulesDir, entry.name)
      rmSync(targetPackageDir, { recursive: true, force: true })
      cpSync(entry.sourceDir, targetPackageDir, {
        recursive: true,
        force: true,
        dereference: true,
      })
    }

    process.stdout.write(`[desktop-after-pack] bundled OpenCode native packages: ${packages.map((entry) => basename(entry.name)).join(', ')}\n`)
  }
}

export default createDesktopAfterPack()
