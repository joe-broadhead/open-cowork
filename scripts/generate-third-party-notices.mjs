import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const outputPath = join(rootDir, 'THIRD_PARTY_NOTICES.md')
const licenseOutputDir = join(rootDir, 'THIRD_PARTY_LICENSES')
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

function detectLicenseFromFiles(packagePath, packageName) {
  if (packageName.startsWith('opencode-')) {
    return 'MIT (opencode-ai companion package)'
  }
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

function collectDependencyNodes(node, packages) {
  const dependencySets = [node?.dependencies, node?.optionalDependencies]
  for (const dependencies of dependencySets) {
    if (!dependencies) continue
    for (const [dependencyName, dependency] of Object.entries(dependencies)) {
      const name = dependency?.name || dependency?.from || dependencyName
      if (!name || !dependency?.version || !dependency?.path) continue
      const key = `${name}@${dependency.version}`
      if (!packages.has(key)) {
        const manifestPath = join(dependency.path, 'package.json')
        const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}
        const notices = collectTextFiles(dependency.path, noticeFileNames)
        const licenseFiles = collectTextFiles(dependency.path, licenseFileNames)
        const manifestLicense = normalizeLicense(manifest.license || manifest.licenses)
        packages.set(key, {
          name,
          version: dependency.version,
          license: manifestLicense === 'UNKNOWN'
            ? detectLicenseFromFiles(dependency.path, name)
            : manifestLicense,
          repository: normalizeRepository(manifest.repository) || manifest.homepage || dependency.resolved || '',
          notices,
          licenseFiles,
        })
      }
      collectDependencyNodes(dependency, packages)
    }
  }
}

const listJson = execFileSync(
  'pnpm',
  ['list', '--prod', '--recursive', '--json', '--depth', 'Infinity'],
  { cwd: rootDir, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
)
const workspaceNodes = JSON.parse(listJson)
const packages = new Map()
for (const workspaceNode of workspaceNodes) {
  collectDependencyNodes(workspaceNode, packages)
}

const sortedPackages = [...packages.values()].sort((a, b) => {
  const nameCompare = a.name.localeCompare(b.name)
  return nameCompare || a.version.localeCompare(b.version)
})

const lines = [
  '# Third-Party Notices',
  '',
  'Open Cowork includes third-party open source packages in its production dependency graph. This file is generated from `pnpm list --prod --recursive` and the installed package manifests.',
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

writeFileSync(outputPath, `${lines.join('\n')}\n`)
