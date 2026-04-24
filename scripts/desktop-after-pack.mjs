import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
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

function getResourcesDir(context) {
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

function getPackageName(storeEntryName) {
  const versionSeparator = storeEntryName.lastIndexOf('@')
  return versionSeparator > 0 ? storeEntryName.slice(0, versionSeparator) : storeEntryName
}

function getTargetArchName(rawArch) {
  if (typeof rawArch === 'string') return rawArch
  if (typeof rawArch === 'number') return archNames[rawArch] || null
  return null
}

function packageTargetsArch(packageName, archName) {
  if (!archName || archName === 'universal') return true
  if (archName === 'armv7l') return packageName.includes('-arm')
  return packageName.includes(`-${archName}`)
}

function listInstalledOpencodePackages(platformName, archName) {
  const prefix = platformPrefixes[platformName]
  if (!prefix) return []
  if (!existsSync(virtualStoreDir)) {
    throw new Error(`pnpm virtual store not found at ${virtualStoreDir}`)
  }

  const binaryName = platformName === 'win32' ? 'opencode.exe' : 'opencode'
  return readdirSync(virtualStoreDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const packageName = getPackageName(entry.name)
      return {
        name: packageName,
        sourceDir: join(virtualStoreDir, entry.name, 'node_modules', packageName),
      }
    })
    .filter((entry) => packageTargetsArch(entry.name, archName))
    .filter((entry) => existsSync(join(entry.sourceDir, 'bin', binaryName)))
}

export default async function afterPack(context) {
  const targetArch = getTargetArchName(context.arch)
  const packages = listInstalledOpencodePackages(context.electronPlatformName, targetArch)
  if (packages.length === 0) {
    throw new Error(`No installed OpenCode native binary package found for ${context.electronPlatformName}/${targetArch || 'unknown-arch'}`)
  }

  const targetModulesDir = join(getResourcesDir(context), 'app.asar.unpacked', 'node_modules')
  mkdirSync(targetModulesDir, { recursive: true })

  for (const entry of packages) {
    cpSync(entry.sourceDir, join(targetModulesDir, entry.name), {
      recursive: true,
      force: true,
      dereference: true,
    })
  }

  process.stdout.write(`[desktop-after-pack] bundled OpenCode native packages: ${packages.map((entry) => basename(entry.name)).join(', ')}\n`)
}
