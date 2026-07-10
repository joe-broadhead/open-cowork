import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expectedReleaseArtifacts } from './verify-release-artifact-matrix.mjs'

const DEFAULT_RELEASE_DIR = 'apps/desktop/release'
const DEFAULT_PRODUCT_NAME = 'Open Cowork'

const ignoredExecutableNames = new Set([
  'chrome-sandbox.exe',
  'chrome_crashpad_handler.exe',
  'elevate.exe',
])

function readDesktopVersion(root) {
  const packageJson = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'))
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error('apps/desktop/package.json must contain a version for Windows signing target discovery.')
  }
  return packageJson.version.trim()
}

function assertNonEmptyFile(path, label) {
  if (!existsSync(path)) throw new Error(`Missing ${label}: ${path}`)
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${path}`)
  if (stat.size <= 0) throw new Error(`${label} is empty: ${path}`)
}

function listFiles(dir, predicate) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(predicate)
    .sort()
}

function listDirs(dir, predicate) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(predicate)
    .sort()
}

function expectedProductExecutableName(productName = DEFAULT_PRODUCT_NAME) {
  return `${productName.trim() || DEFAULT_PRODUCT_NAME}.exe`
}

export function listWindowsSigningTargets(input = {}) {
  const root = resolve(input.root || process.cwd())
  const releaseDir = resolve(root, input.releaseDir || DEFAULT_RELEASE_DIR)
  const version = input.version?.trim() || readDesktopVersion(root)
  const expectedInstallerNames = expectedReleaseArtifacts(version).windows
  const actualInstallerNames = listFiles(releaseDir, (name) => name.endsWith('-setup.exe'))
  const missingInstallers = expectedInstallerNames.filter((name) => !actualInstallerNames.includes(name))
  const extraInstallers = actualInstallerNames.filter((name) => !expectedInstallerNames.includes(name))
  if (missingInstallers.length > 0) throw new Error(`Missing Windows signing installers: ${missingInstallers.join(', ')}`)
  if (extraInstallers.length > 0) throw new Error(`Unexpected Windows signing installers: ${extraInstallers.join(', ')}`)

  const unpackedDirs = listDirs(releaseDir, (name) => /^win(?:-[a-z0-9]+)?-unpacked$/i.test(name))
  if (!unpackedDirs.includes('win-unpacked')) throw new Error(`Missing Windows unpacked release directory: ${join(releaseDir, 'win-unpacked')}`)
  const extraUnpackedDirs = unpackedDirs.filter((name) => name !== 'win-unpacked')
  if (extraUnpackedDirs.length > 0) throw new Error(`Unexpected Windows unpacked release directories: ${extraUnpackedDirs.join(', ')}`)

  const unpackedDir = join(releaseDir, 'win-unpacked')
  const expectedExe = expectedProductExecutableName(input.productName || process.env.APP_PRODUCT_NAME)
  const actualExeNames = listFiles(unpackedDir, (name) => (
    name.toLowerCase().endsWith('.exe') && !ignoredExecutableNames.has(name.toLowerCase())
  ))
  const missingExe = actualExeNames.includes(expectedExe) ? [] : [expectedExe]
  const extraExeNames = actualExeNames.filter((name) => name !== expectedExe)
  if (missingExe.length > 0) throw new Error(`Missing Windows packaged executable signing target: ${missingExe.join(', ')}`)
  if (extraExeNames.length > 0) throw new Error(`Unexpected Windows packaged executable signing targets: ${extraExeNames.join(', ')}`)

  const targets = [
    ...expectedInstallerNames.map((name) => ({
      kind: 'installer',
      name,
      path: join(releaseDir, name),
    })),
    {
      kind: 'packaged-executable',
      name: expectedExe,
      path: join(unpackedDir, expectedExe),
    },
  ]
  for (const target of targets) assertNonEmptyFile(target.path, `Windows signing target ${target.name}`)
  return targets
}

function readArgs(argv) {
  const input = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--root' && next) {
      input.root = next
      index += 1
    } else if (arg === '--release-dir' && next) {
      input.releaseDir = next
      index += 1
    } else if (arg === '--version' && next) {
      input.version = next
      index += 1
    } else if (arg === '--product-name' && next) {
      input.productName = next
      index += 1
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`)
    }
  }
  return input
}

export function main(argv = process.argv.slice(2)) {
  process.stdout.write(`${JSON.stringify(listWindowsSigningTargets(readArgs(argv)), null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[windows-signing-targets] ${message}`)
    process.exitCode = 1
  }
}
