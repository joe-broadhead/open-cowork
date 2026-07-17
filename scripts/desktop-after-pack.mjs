import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const virtualStoreDir = join(repoRoot, 'node_modules', '.pnpm')
export const updateInstallCapabilityResourceName = 'open-cowork-update-capability.json'
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

  // The OpenCode native binary is `opencode` on macOS/Linux and
  // `opencode.exe` on Windows; accept either so the Windows target
  // bundles the same runtime as the other platforms.
  const binaryNames = platformName === 'win32' ? ['opencode.exe', 'opencode'] : ['opencode']
  const packagesByName = new Map()
  for (const entry of readdirSync(storeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const packageName = getPackageName(entry.name)
    const packageVersion = getPackageVersion(entry.name)
    if (expectedVersion && packageVersion !== expectedVersion) continue
    if (!packageTargetsArch(packageName, archName)) continue

    const sourceDir = join(storeDir, entry.name, 'node_modules', packageName)
    if (!binaryNames.some((binaryName) => existsSync(join(sourceDir, 'bin', binaryName)))) continue
    packagesByName.set(packageName, { name: packageName, version: packageVersion, sourceDir })
  }

  return Array.from(packagesByName.values())
}

function isTruthyEnv(value) {
  return value === '1' || value === 'true'
}

function safeReleaseSourceKind(value) {
  return ['github-releases', 'generic-http', 'gcs'].includes(value) ? value : 'github-releases'
}

function safeUpdateChannel(value) {
  const channel = typeof value === 'string' && value.trim() ? value.trim() : 'latest'
  return /^[A-Za-z0-9._-]{1,80}$/.test(channel) ? channel : 'latest'
}

export function buildUpdateInstallCapabilityResource(context, env = process.env) {
  // Signed in-app installs are wired for macOS and Windows (NSIS). Linux
  // stays on the verified manual-download path, so no marker is written
  // there — see docs/verifying-releases.md.
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'win32') return null
  const signedInstallEligible = isTruthyEnv(env.OPEN_COWORK_SIGNED_UPDATE_INSTALL_ELIGIBLE)
  const feedConfigured = isTruthyEnv(env.OPEN_COWORK_UPDATE_FEED_CONFIGURED)
  if (!signedInstallEligible && !feedConfigured) return null
  return {
    schemaVersion: 2,
    signedInstallEligible,
    feedConfigured,
    releaseSourceKind: safeReleaseSourceKind(env.OPEN_COWORK_UPDATE_RELEASE_SOURCE_KIND),
    channel: safeUpdateChannel(env.OPEN_COWORK_UPDATE_CHANNEL),
  }
}

export function writeUpdateInstallCapabilityResource(context, resourcesDir, env = process.env) {
  const marker = buildUpdateInstallCapabilityResource(context, env)
  if (!marker) return false
  writeFileSync(join(resourcesDir, updateInstallCapabilityResourceName), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 })
  return true
}

export const runtimeComponentManifestResourceName = 'runtime-components.manifest.json'

function platformPackageName(electronPlatformName) {
  if (electronPlatformName === 'win32') return 'windows'
  return electronPlatformName
}

function opencodeBinaryName(electronPlatformName) {
  return electronPlatformName === 'win32' ? 'opencode.exe' : 'opencode'
}

/**
 * Resolve the packaged OpenCode CLI binary under app.asar.unpacked after native
 * packages have been copied. Prefers the arch-native package, then the x64
 * baseline variant used on some Intel builds.
 */
export function resolvePackagedOpencodeCliPath(resourcesDir, electronPlatformName, archName) {
  const platform = platformPackageName(electronPlatformName)
  const binary = opencodeBinaryName(electronPlatformName)
  const moduleNames = [
    archName === 'x64' ? `opencode-${platform}-${archName}-baseline` : null,
    `opencode-${platform}-${archName}`,
  ].filter(Boolean)

  for (const moduleName of moduleNames) {
    const candidate = join(resourcesDir, 'app.asar.unpacked', 'node_modules', moduleName, 'bin', binary)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Build the component path map for the trusted runtime-components.manifest.json
 * that packaged apps verify at launch (see docs/verifying-releases.md).
 *
 * The OpenCode SDK package.json is hashed from the packaged app.asar (not the
 * workspace node_modules copy). electron-builder rewrites package metadata when
 * packing, so the on-disk install and the asar entry can differ.
 */
export function resolvePackagedRuntimeComponentPaths(resourcesDir, options = {}) {
  const electronPlatformName = options.electronPlatformName || process.platform
  const archName = getTargetArchName(options.arch) || process.arch
  const opencodeCli = options.componentPaths?.['opencode-cli']
    || resolvePackagedOpencodeCliPath(resourcesDir, electronPlatformName, archName)
  const opencodeSdk = options.componentPaths?.['opencode-sdk']
    || options.sdkPackageJsonPath
    || extractPackagedOpencodeSdkPackageJson(resourcesDir, options)
  const agentToolMcp = options.componentPaths?.['agent-tool-mcp']
    || join(resourcesDir, 'mcps', 'agents', 'dist', 'index.js')
  const workflowMcp = options.componentPaths?.['workflow-mcp']
    || join(resourcesDir, 'mcps', 'workflows', 'dist', 'index.js')
  const semanticUiMcp = options.componentPaths?.['semantic-ui-mcp']
    || join(resourcesDir, 'mcps', 'semantic-ui', 'dist', 'index.js')

  return {
    'opencode-cli': opencodeCli,
    'opencode-sdk': opencodeSdk,
    'agent-tool-mcp': agentToolMcp,
    'workflow-mcp': workflowMcp,
    'semantic-ui-mcp': semanticUiMcp,
  }
}

function readPackageVersionFromFile(packageJsonPath) {
  try {
    const data = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    return typeof data.version === 'string' && data.version.length > 0 ? data.version : null
  } catch {
    return null
  }
}

function readCliVersionFromBinary(binaryPath) {
  if (!binaryPath || !existsSync(binaryPath)) return null
  try {
    const text = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    })
    return text
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || null
  } catch {
    return null
  }
}

/**
 * Extract `@opencode-ai/sdk/package.json` from the packaged app.asar so the
 * trusted manifest pins the same bytes the runtime will re-hash at launch.
 */
export function extractPackagedOpencodeSdkPackageJson(resourcesDir, options = {}) {
  if (options.sdkPackageJsonPath && existsSync(options.sdkPackageJsonPath)) {
    return options.sdkPackageJsonPath
  }

  const asarPath = options.asarPath || join(resourcesDir, 'app.asar')
  if (!existsSync(asarPath)) {
    // Unpackaged test fixtures / unit tests may only supply a plain SDK path.
    const fallback = join(repoRoot, 'apps', 'desktop', 'node_modules', '@opencode-ai', 'sdk', 'package.json')
    return existsSync(fallback) ? fallback : null
  }

  const require = createRequire(import.meta.url)
  let asar
  try {
    asar = require('@electron/asar')
  } catch {
    asar = require(join(repoRoot, 'node_modules', '.pnpm', 'node_modules', '@electron', 'asar'))
  }

  const preferredEntries = [
    'node_modules/@opencode-ai/sdk/package.json',
    // pnpm / electron-builder may nest scoped packages under .pnpm virtual store
    // paths inside the asar on some platforms.
  ]
  let contents = null
  let usedEntry = null
  let lastError = null
  for (const entry of preferredEntries) {
    try {
      contents = asar.extractFile(asarPath, entry)
      usedEntry = entry
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!contents) {
    try {
      const listed = asar.listPackage(asarPath)
      const match = listed.find((entry) => (
        typeof entry === 'string'
        && entry.replace(/\\/g, '/').endsWith('@opencode-ai/sdk/package.json')
      ))
      if (match) {
        contents = asar.extractFile(asarPath, match)
        usedEntry = match
      }
    } catch (error) {
      lastError = error
    }
  }
  if (!contents) {
    // Fall back to the workspace install so packaging can still produce a
    // manifest when asar layout differs (seen on Windows pnpm packs).
    const fallback = join(repoRoot, 'apps', 'desktop', 'node_modules', '@opencode-ai', 'sdk', 'package.json')
    if (existsSync(fallback)) return fallback
    const err = new Error(
      `Cannot extract @opencode-ai/sdk/package.json from ${asarPath} for runtime component hashing: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
    if (lastError instanceof Error) err.cause = lastError
    throw err
  }

  const extractDir = options.sdkExtractDir || mkdtempSync(join(tmpdir(), 'open-cowork-sdk-pkg-'))
  mkdirSync(extractDir, { recursive: true })
  const extractedPath = join(extractDir, 'package.json')
  writeFileSync(extractedPath, contents)
  if (usedEntry && usedEntry !== preferredEntries[0]) {
    process.stdout.write(`[desktop-after-pack] resolved OpenCode SDK package.json via asar entry ${usedEntry}\n`)
  }
  return extractedPath
}

/**
 * Hash the packaged runtime components and write the trusted integrity
 * manifest into Resources. Packaged launches fail closed without this file.
 */
export async function writePackagedRuntimeComponentManifest(resourcesDir, options = {}) {
  const componentPaths = resolvePackagedRuntimeComponentPaths(resourcesDir, options)
  for (const [id, path] of Object.entries(componentPaths)) {
    if (!path || !existsSync(path)) {
      throw new Error(
        `Cannot write runtime component manifest: missing ${id} at ${path || '(unresolved)'}. Ensure extraResources include managed MCPs and after-pack has copied the OpenCode native binary.`,
      )
    }
  }

  const cliVersion = options.componentVersions?.['opencode-cli']
    || readCliVersionFromBinary(componentPaths['opencode-cli'])
    || readPackageVersionFromFile(join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'opencode-ai', 'package.json'))
  const sdkVersion = options.componentVersions?.['opencode-sdk']
    || readPackageVersionFromFile(componentPaths['opencode-sdk'])
  const componentVersions = {
    'opencode-cli': cliVersion,
    'opencode-sdk': sdkVersion,
    'agent-tool-mcp': options.componentVersions?.['agent-tool-mcp'] || readPackageVersionFromFile(join(resourcesDir, 'mcps', 'agents', 'package.json')),
    'workflow-mcp': options.componentVersions?.['workflow-mcp'] || readPackageVersionFromFile(join(resourcesDir, 'mcps', 'workflows', 'package.json')),
    'semantic-ui-mcp': options.componentVersions?.['semantic-ui-mcp'] || readPackageVersionFromFile(join(resourcesDir, 'mcps', 'semantic-ui', 'package.json')),
  }

  const writeManifest = options.writeRuntimeComponentManifest
    || (await import('../packages/runtime-host/dist/runtime-component-manifest.js')).writeRuntimeComponentManifest
  const manifestPath = join(resourcesDir, runtimeComponentManifestResourceName)
  const manifest = await writeManifest(manifestPath, {
    componentPaths,
    componentVersions,
    // Force version + hash from the packaged binary, not whatever `opencode` is on PATH.
    bundledOpencodeEnv: {
      opencodeBinPath: componentPaths['opencode-cli'],
    },
    isPackaged: true,
    resourcesPath: resourcesDir,
  })
  process.stdout.write(`[desktop-after-pack] wrote ${runtimeComponentManifestResourceName} (${manifest.components.length} components)\n`)
  return manifestPath
}

/**
 * Map electron-builder platform/arch → third_party/time-keep/platforms key.
 * Source binaries: https://github.com/joe-broadhead/time-keep releases.
 */
export function timeKeepPlatformKey(electronPlatformName, archName) {
  if (electronPlatformName === 'darwin') {
    return archName === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  if (electronPlatformName === 'linux') {
    return 'linux-x64'
  }
  if (electronPlatformName === 'win32') {
    return 'win32-x64'
  }
  return null
}

export function copyBundledTimeKeepBinary(resourcesDir, electronPlatformName, archName, options = {}) {
  const key = timeKeepPlatformKey(electronPlatformName, archName)
  if (!key) {
    throw new Error(`Cannot map ${electronPlatformName}/${archName} to a time-keep platform asset`)
  }
  const binaryName = key.startsWith('win32') ? 'time-keep.exe' : 'time-keep'
  const source = options.sourcePath
    || join(repoRoot, 'third_party', 'time-keep', 'platforms', key, binaryName)
  if (!existsSync(source)) {
    throw new Error(
      `Bundled time-keep binary missing at ${source}. Run \`pnpm binaries:time-keep\` before packaging.`,
    )
  }
  const destDir = join(resourcesDir, 'bin')
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, binaryName)
  cpSync(source, dest, { force: true })
  try {
    chmodSync(dest, 0o755)
  } catch {
    // best-effort when the host cannot chmod (rare)
  }
  process.stdout.write(`[desktop-after-pack] bundled time-keep MCP binary: ${dest}\n`)
  return dest
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

    const resourcesDir = getResourcesDir(context)
    writeUpdateInstallCapabilityResource(context, resourcesDir)
    copyBundledTimeKeepBinary(resourcesDir, context.electronPlatformName, targetArch, options)

    const targetModulesDir = join(resourcesDir, 'app.asar.unpacked', 'node_modules')
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

    await writePackagedRuntimeComponentManifest(resourcesDir, {
      ...options,
      electronPlatformName: context.electronPlatformName,
      arch: targetArch,
    })
  }
}

export default createDesktopAfterPack()
