import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const rootDir = process.cwd()
const outputPath = join(rootDir, 'THIRD_PARTY_NOTICES.md')
const licenseOutputDir = join(rootDir, 'THIRD_PARTY_LICENSES')
const lockfilePath = join(rootDir, 'pnpm-lock.yaml')
const skipLicenseOutput = process.argv.includes('--skip-license-output')
const noticeFileNames = ['NOTICE', 'NOTICE.md', 'NOTICE.txt']
const licenseFileNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'license.txt']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalizeLicense(value) {
  if (!value) return 'UNKNOWN'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(normalizeLicense).join(', ')
  if (typeof value === 'object' && typeof value.type === 'string') return value.type
  return String(value)
}

function normalizeRepository(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && typeof value.url === 'string') return value.url
  return ''
}

function detectLicenseFromFiles(packagePath) {
  for (const licenseFileName of licenseFileNames) {
    const licensePath = join(packagePath, licenseFileName)
    if (!existsSync(licensePath)) continue
    const text = readFileSync(licensePath, 'utf8').slice(0, 2048)
    if (/MIT License/i.test(text)) return 'MIT'
    if (/Apache License/i.test(text)) return 'Apache-2.0'
    if (/BSD 3-Clause/i.test(text)) return 'BSD-3-Clause'
    if (/ISC License/i.test(text)) return 'ISC'
    if (/Mozilla Public License/i.test(text)) return 'MPL-2.0'
  }
  return 'UNKNOWN'
}

function escapeTableCell(value) {
  return String(value || '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function packageLicenseDirName(name, version) {
  return `${name.replaceAll('/', '__')}@${version}`
}

function collectTextFiles(packagePath, fileNames) {
  const files = []
  const seen = new Set()
  for (const fileName of fileNames) {
    const filePath = join(packagePath, fileName)
    if (!existsSync(filePath) || seen.has(fileName.toLowerCase())) continue
    seen.add(fileName.toLowerCase())
    const text = readFileSync(filePath, 'utf8')
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim()
    files.push({ file: fileName, text })
  }
  return files
}

function collectExistingGeneratedLicenseFiles(name, version) {
  const dir = join(licenseOutputDir, packageLicenseDirName(name, version))
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = join(dir, entry.name)
      const text = readFileSync(filePath, 'utf8').trim()
      return { file: entry.name, text }
    })
    .filter((entry) => entry.text.length > 0)
}

// First-party @open-cowork/* workspace packages are linked into the dependency
// graph via link:/file:/workspace: specs and resolve to source directories inside
// this repository. They are part of Open Cowork itself, not redistributed
// third-party code, so they must not be attributed in THIRD_PARTY_NOTICES.md.
function isWorkspaceLink(spec, packagePath) {
  if (typeof spec === 'string' && /^(?:link:|file:|workspace:)/.test(spec)) return true
  if (typeof packagePath === 'string' && packagePath.length > 0) {
    const resolved = resolve(packagePath)
    const insideRoot = resolved === rootDir || resolved.startsWith(rootDir + sep)
    const insideNodeModules = resolved.split(sep).includes('node_modules')
    if (insideRoot && !insideNodeModules) return true
  }
  return false
}

// opencode-ai ships its native runtime as companion packages named
// opencode-<os>-<arch>(-...). Those companions carry no per-package manifest
// license field and no LICENSE file of their own — they are published as part of
// opencode-ai and inherit its terms. We resolve their attribution from the parent
// opencode-ai manifest/LICENSE rather than a hardcoded string.
function isOpencodeCompanion(name) {
  return name.startsWith('opencode-') && name !== 'opencode-ai'
}

// esbuild ships per-platform optional packages (@esbuild/<os>-<arch>). Only the
// host platform is fully extracted in node_modules; other platforms still appear
// in `pnpm list` with incomplete metadata. Attribute them from the parent
// `esbuild` package so notices generation is platform-stable for CI.
function isEsbuildCompanion(name) {
  return name.startsWith('@esbuild/')
}

function isRegistryResolvedUrl(value) {
  return /registry\.npmjs\.org|npm\.pkg\.github\.com|\.tgz(\?|$)/i.test(String(value || ''))
}

function detectLicenseFromLicenseFiles(licenseFiles) {
  for (const file of licenseFiles) {
    const text = String(file?.text || '').slice(0, 2048)
    if (/MIT License/i.test(text)) return 'MIT'
    if (/Apache License/i.test(text)) return 'Apache-2.0'
    if (/BSD 3-Clause/i.test(text)) return 'BSD-3-Clause'
    if (/ISC License/i.test(text)) return 'ISC'
    if (/Mozilla Public License/i.test(text)) return 'MPL-2.0'
  }
  return 'UNKNOWN'
}

// Resolve a named production package's license / LICENSE files / repository from
// the installed dependency tree (used for companion package inheritance).
function resolveNamedParent(nodes, parentName) {
  let parent = null
  const walk = (node) => {
    if (parent) return
    for (const dependencies of [node?.dependencies, node?.optionalDependencies]) {
      if (!dependencies) continue
      for (const [dependencyName, dependency] of Object.entries(dependencies)) {
        if (parent) return
        const name = dependency?.name || dependency?.from || dependencyName
        if (name === parentName && dependency?.path) {
          const manifestPath = join(dependency.path, 'package.json')
          const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}
          const manifestLicense = normalizeLicense(manifest.license || manifest.licenses)
          parent = {
            license: manifestLicense === 'UNKNOWN'
              ? detectLicenseFromFiles(dependency.path)
              : manifestLicense,
            licenseFiles: collectTextFiles(dependency.path, licenseFileNames),
            repository: normalizeRepository(manifest.repository) || manifest.homepage || dependency.resolved || '',
          }
          return
        }
        walk(dependency)
      }
    }
  }
  for (const node of nodes) walk(node)
  return parent
}

// Prefer previously committed non-registry Source URLs when the live install only
// exposes a registry tarball (common for optional native deps on non-host OS).
function loadCommittedSourceIndex() {
  if (!existsSync(outputPath)) return new Map()
  const index = new Map()
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Package') || line.startsWith('| ---')) continue
    const cells = line.slice(2, -2).split(' | ').map((cell) => cell.trim())
    if (cells.length < 5) continue
    const [name, version, , , source] = cells
    if (!name || !version || !source || isRegistryResolvedUrl(source)) continue
    index.set(`${name}@${version}`, source)
  }
  return index
}

function collectDependencyNodes(node, packages) {
  const dependencySets = [node?.dependencies, node?.optionalDependencies]
  for (const dependencies of dependencySets) {
    if (!dependencies) continue
    for (const [dependencyName, dependency] of Object.entries(dependencies)) {
      const name = dependency?.name || dependency?.from || dependencyName
      if (!name || !dependency?.version || !dependency?.path) continue
      if (isWorkspaceLink(dependency.version, dependency.path)) {
        // Skip the first-party package itself, but still recurse so its
        // transitive third-party dependencies remain attributed.
        collectDependencyNodes(dependency, packages)
        continue
      }
      const key = `${name}@${dependency.version}`
      if (!packages.has(key)) {
        const manifestPath = join(dependency.path, 'package.json')
        const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}
        const notices = collectTextFiles(dependency.path, noticeFileNames)
        let licenseFiles = collectTextFiles(dependency.path, licenseFileNames)
        const manifestLicense = normalizeLicense(manifest.license || manifest.licenses)
        let license = manifestLicense === 'UNKNOWN'
          ? detectLicenseFromFiles(dependency.path)
          : manifestLicense
        if (isOpencodeCompanion(name)) {
          if (license === 'UNKNOWN') {
            // Inherit the resolved parent opencode-ai license. The fallback below
            // is only reached if the parent manifest itself lacks license info.
            license = opencodeAiParent?.license && opencodeAiParent.license !== 'UNKNOWN'
              ? opencodeAiParent.license
              : 'MIT (opencode-ai companion package; parent manifest license unavailable)'
          }
          if (licenseFiles.length === 0 && opencodeAiParent?.licenseFiles?.length) {
            // Copy opencode-ai's LICENSE into the companion's notices entry so the
            // shipped native binary carries the same bundled attribution file.
            licenseFiles = opencodeAiParent.licenseFiles.map((file) => ({ ...file }))
          }
        }
        let repository = normalizeRepository(manifest.repository) || manifest.homepage || dependency.resolved || ''
        if (isEsbuildCompanion(name) && esbuildParent) {
          if (license === 'UNKNOWN' && esbuildParent.license && esbuildParent.license !== 'UNKNOWN') {
            license = esbuildParent.license
          }
          if ((!repository || isRegistryResolvedUrl(repository)) && esbuildParent.repository) {
            repository = esbuildParent.repository
          }
          if (licenseFiles.length === 0 && esbuildParent.licenseFiles?.length) {
            licenseFiles = esbuildParent.licenseFiles.map((file) => ({ ...file }))
          }
        }
        packages.set(key, {
          name,
          version: dependency.version,
          license,
          repository,
          notices,
          licenseFiles,
        })
      }
      collectDependencyNodes(dependency, packages)
    }
  }
}

function resolvePnpmInvocation() {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /(?:^|[/\\])pnpm(?:\.cjs)?$/i.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath] }
  }
  return { command: 'pnpm', args: [] }
}

const pnpmInvocation = resolvePnpmInvocation()
const listJson = execFileSync(
  pnpmInvocation.command,
  [...pnpmInvocation.args, 'list', '--prod', '--recursive', '--json', '--depth', 'Infinity'],
  { cwd: rootDir, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
)
const workspaceNodes = JSON.parse(listJson)
const opencodeAiParent = resolveNamedParent(workspaceNodes, 'opencode-ai')
const esbuildParent = resolveNamedParent(workspaceNodes, 'esbuild')
const committedSources = loadCommittedSourceIndex()
const packages = new Map()
for (const workspaceNode of workspaceNodes) {
  collectDependencyNodes(workspaceNode, packages)
}

const sortedPackages = [...packages.values()].sort((a, b) => {
  const nameCompare = a.name.localeCompare(b.name)
  return nameCompare || a.version.localeCompare(b.version)
})

for (const item of sortedPackages) {
  if (item.licenseFiles.length === 0) {
    item.licenseFiles = collectExistingGeneratedLicenseFiles(item.name, item.version)
  }
  // Optional native packages often lack a full extract on non-host platforms.
  // Prefer license text already bundled under THIRD_PARTY_LICENSES/ when the live
  // install only reports UNKNOWN.
  if (item.license === 'UNKNOWN' && item.licenseFiles.length > 0) {
    const detected = detectLicenseFromLicenseFiles(item.licenseFiles)
    if (detected !== 'UNKNOWN') item.license = detected
  }
  // Keep Source stable across OS when the live graph only has a registry tarball
  // but a previous generation recorded a canonical repository URL.
  if (!item.repository || isRegistryResolvedUrl(item.repository)) {
    const committed = committedSources.get(`${item.name}@${item.version}`)
    if (committed) item.repository = committed
  }
}

const packagesWithLicenseFiles = sortedPackages.filter((item) => item.licenseFiles.length > 0)
const packagesWithoutLicenseFiles = sortedPackages.length - packagesWithLicenseFiles.length

const lines = [
  '# Third-Party Notices',
  '',
  'Open Cowork includes third-party open source packages in its production dependency graph. This file is generated from `pnpm list --prod --recursive` and the installed package manifests.',
  '',
  'Generation provenance:',
  `- pnpm lockfile SHA-256: \`${fileSha256(lockfilePath)}\``,
  `- Production package entries: ${sortedPackages.length}`,
  `- Bundled license directories: ${packagesWithLicenseFiles.length} (${packagesWithoutLicenseFiles} package entries have no standalone license file or are workspace links)`,
  '',
  'Each package remains licensed under its own license terms. The table below is provided for attribution and review; bundled license files are emitted under `THIRD_PARTY_LICENSES/`.',
  '',
  '| Package | Version | License | License files | Source |',
  '| --- | --- | --- | --- | --- |',
]

for (const item of sortedPackages) {
  const licenseDir = item.licenseFiles.length > 0
    ? `THIRD_PARTY_LICENSES/${packageLicenseDirName(item.name, item.version)}/`
    : ''
  lines.push(`| ${escapeTableCell(item.name)} | ${escapeTableCell(item.version)} | ${escapeTableCell(item.license)} | ${escapeTableCell(licenseDir)} | ${escapeTableCell(item.repository)} |`)
}

const packagesWithNotices = sortedPackages.filter((item) => item.notices.length > 0)
if (packagesWithNotices.length > 0) {
  lines.push('', '## Bundled Notice Files', '')
  for (const item of packagesWithNotices) {
    for (const notice of item.notices) {
      lines.push(`### ${item.name}@${item.version} - ${notice.file}`, '', '```text', notice.text, '```', '')
    }
  }
}

if (!skipLicenseOutput) {
  rmSync(licenseOutputDir, { recursive: true, force: true })
  mkdirSync(licenseOutputDir, { recursive: true })
  for (const item of sortedPackages) {
    if (item.licenseFiles.length === 0) continue
    const dir = join(licenseOutputDir, packageLicenseDirName(item.name, item.version))
    mkdirSync(dir, { recursive: true })
    for (const license of item.licenseFiles) {
      writeFileSync(join(dir, license.file), `${license.text}\n`)
    }
  }
}

writeFileSync(outputPath, `${lines.join('\n')}\n`)
