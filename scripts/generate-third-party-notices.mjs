import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const outputPath = join(rootDir, 'THIRD_PARTY_NOTICES.md')
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
        const notices = []
        for (const noticeFileName of noticeFileNames) {
          const noticePath = join(dependency.path, noticeFileName)
          if (existsSync(noticePath)) {
            notices.push({ file: noticeFileName, text: readFileSync(noticePath, 'utf8').trim() })
          }
        }
        const manifestLicense = normalizeLicense(manifest.license || manifest.licenses)
        packages.set(key, {
          name,
          version: dependency.version,
          license: manifestLicense === 'UNKNOWN'
            ? detectLicenseFromFiles(dependency.path, name)
            : manifestLicense,
          repository: normalizeRepository(manifest.repository) || manifest.homepage || dependency.resolved || '',
          notices,
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
  'Each package remains licensed under its own license terms. The table below is provided for attribution and review; package source repositories remain the authority for full license text and notices.',
  '',
  '| Package | Version | License | Source |',
  '| --- | --- | --- | --- |',
]

for (const item of sortedPackages) {
  lines.push(`| ${escapeTableCell(item.name)} | ${escapeTableCell(item.version)} | ${escapeTableCell(item.license)} | ${escapeTableCell(item.repository)} |`)
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

writeFileSync(outputPath, `${lines.join('\n')}\n`)
