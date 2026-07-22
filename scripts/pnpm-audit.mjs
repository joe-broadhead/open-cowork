import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

// CI / release supply-chain gate. Prefer real upgrades and pnpm.overrides over
// permanent ignores. If you must add pnpm.auditConfig.ignoreGhsas / ignoreCves:
//   1. Document justification + blast radius in the PR.
//   2. Name an owner and expiry date (re-review on monthly-maintenance).
//   3. File a tracking issue; remove the ignore when a fixed release lands.
// Monthly maintenance runs audit:full and alerts if this gate goes red (JOE-957).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const auditEndpointPath = '-/npm/v1/security/advisories/bulk'
const severityRank = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
])

export function auditLevelFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--audit-level') return normalizeSeverity(args[index + 1])
    if (arg.startsWith('--audit-level=')) return normalizeSeverity(arg.slice('--audit-level='.length))
  }
  return 'low'
}

export function loadAuditPolicy(packageJsonPath = resolve(repoRoot, 'package.json')) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const auditConfig = pkg.pnpm?.auditConfig || {}
  return {
    ignoreCves: normalizeIdentifierSet(auditConfig.ignoreCves),
    ignoreGhsas: normalizeIdentifierSet(auditConfig.ignoreGhsas),
  }
}

export function summarizeAuditReport(report, policy, options = {}) {
  const auditLevel = normalizeSeverity(options.auditLevel || 'low')
  const advisories = Object.values(report?.advisories || {})
    .filter((advisory) => severityRank.get(normalizeSeverity(advisory.severity || 'low')) >= severityRank.get(auditLevel))
  const ignored = []
  const failures = []
  for (const advisory of advisories) {
    const ids = advisoryIdentifiers(advisory)
    if (isIgnored(ids, policy)) {
      ignored.push({ advisory, ids })
    } else {
      failures.push({ advisory, ids })
    }
  }
  return { ignored, failures }
}

function normalizeSeverity(value) {
  const normalized = String(value || '').toLowerCase()
  if (!severityRank.has(normalized)) return 'low'
  return normalized
}

function normalizeIdentifierSet(value) {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean))
}

function advisoryIdentifiers(advisory) {
  const ids = new Set()
  addIdentifier(ids, advisory.id)
  addIdentifier(ids, advisory.cve)
  addIdentifier(ids, advisory.github_advisory_id)
  addIdentifier(ids, advisory.githubAdvisoryId)
  addIdentifier(ids, advisory.source)
  addIdentifier(ids, extractGhsaFromUrl(advisory.url))
  for (const cve of Array.isArray(advisory.cves) ? advisory.cves : []) addIdentifier(ids, cve)
  for (const ghsa of Array.isArray(advisory.ghsas) ? advisory.ghsas : []) addIdentifier(ids, ghsa)
  return ids
}

function addIdentifier(ids, value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (/^CVE-\d{4}-\d{4,}$/u.test(normalized) || /^GHSA-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u.test(normalized)) {
    ids.add(normalized)
  }
}

function isIgnored(ids, policy) {
  for (const id of ids) {
    if (id.startsWith('CVE-') && policy.ignoreCves.has(id)) return true
    if (id.startsWith('GHSA-') && policy.ignoreGhsas.has(id)) return true
  }
  return false
}

function formatFailure({ advisory, ids }) {
  const idText = [...ids].join(', ') || String(advisory.id || 'unknown-advisory')
  const moduleName = advisory.module_name || advisory.moduleName || advisory.name || 'unknown-module'
  const severity = advisory.severity || 'unknown-severity'
  const title = advisory.title || advisory.overview || ''
  const versions = advisory.findings?.flatMap((finding) => finding.versions || []) || []
  const versionText = versions.length > 0 ? ` installed=${[...new Set(versions)].join(',')}` : ''
  return `${idText} ${moduleName} ${severity}${versionText}${title ? ` - ${title}` : ''}`
}

function stripJsonFlag(args) {
  return args.filter((arg) => arg !== '--json')
}

function prodOnlyFromArgs(args) {
  return args.includes('--prod') || args.includes('--production') || args.includes('--only=prod') || args.includes('--only=production')
}

function runPnpmList(args) {
  const listArgs = ['list', '--json', '--depth', 'Infinity', '-r']
  if (prodOnlyFromArgs(args)) listArgs.push('--prod')
  const result = spawnSync('pnpm', listArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    throw new Error(`pnpm ${listArgs.join(' ')} failed with exit code ${result.status || 1}`)
  }
  return JSON.parse(result.stdout || '[]')
}

export function collectInstalledPackages(roots) {
  const packages = new Map()
  const visitedPaths = new Set()
  const visitDependency = (fallbackName, dependency) => {
    if (!dependency || typeof dependency !== 'object') return
    const path = typeof dependency.path === 'string' ? dependency.path : ''
    if (path) {
      if (visitedPaths.has(path)) return
      visitedPaths.add(path)
    }
    const version = normalizePackageVersion(dependency.version)
    const name = packageNameFromDependency(fallbackName, dependency)
    if (name && version && !isWorkspaceDependency(dependency)) {
      const versions = packages.get(name) || new Set()
      versions.add(version)
      packages.set(name, versions)
    }
    for (const dependencies of dependencyGroups(dependency)) {
      for (const [childName, child] of Object.entries(dependencies)) {
        visitDependency(childName, child)
      }
    }
  }

  for (const root of Array.isArray(roots) ? roots : []) {
    for (const dependencies of dependencyGroups(root)) {
      for (const [name, dependency] of Object.entries(dependencies)) {
        visitDependency(name, dependency)
      }
    }
  }
  return packages
}

function dependencyGroups(node) {
  return [
    node?.dependencies || {},
    node?.devDependencies || {},
    node?.optionalDependencies || {},
  ]
}

export function buildBulkAdvisoryPayload(installedPackages) {
  return Object.fromEntries(
    [...installedPackages.entries()]
      .map(([name, versions]) => [name, [...versions].sort(semver.compare)])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function normalizeBulkAdvisoryReport(bulkReport, installedPackages) {
  const advisories = {}
  for (const [packageName, packageAdvisories] of Object.entries(bulkReport || {})) {
    const installedVersions = [...(installedPackages.get(packageName) || [])]
    for (const advisory of Array.isArray(packageAdvisories) ? packageAdvisories : []) {
      const matchingVersions = installedVersions.filter((version) => versionMatchesVulnerableRange(version, advisory.vulnerable_versions))
      if (matchingVersions.length === 0) continue
      const advisoryId = advisory.id || advisory.source || advisory.url || `${packageName}:${advisory.title || advisory.vulnerable_versions}`
      advisories[`${packageName}:${advisoryId}`] = {
        ...advisory,
        module_name: packageName,
        name: packageName,
        github_advisory_id: extractGhsaFromUrl(advisory.url),
        findings: [
          {
            version: matchingVersions[0],
            versions: matchingVersions,
          },
        ],
      }
    }
  }
  return { advisories }
}

function normalizePackageVersion(version) {
  if (typeof version !== 'string') return null
  return semver.valid(version.trim())
}

function packageNameFromDependency(fallbackName, dependency) {
  if (typeof dependency.name === 'string' && dependency.name.trim()) return dependency.name.trim()
  const pathName = packageNameFromNodeModulesPath(dependency.path)
  if (pathName) return pathName
  if (typeof dependency.from === 'string' && dependency.from.trim()) return dependency.from.trim()
  return typeof fallbackName === 'string' && fallbackName.trim() ? fallbackName.trim() : null
}

function packageNameFromNodeModulesPath(path) {
  if (typeof path !== 'string') return null
  const match = /\/node_modules\/(?:(@[^/]+)\/([^/]+)|([^/]+))$/u.exec(path)
  if (!match) return null
  return match[1] ? `${match[1]}/${match[2]}` : match[3]
}

function isWorkspaceDependency(dependency) {
  const path = typeof dependency.path === 'string' ? dependency.path : ''
  return Boolean(path && !path.includes('/node_modules/'))
}

function versionMatchesVulnerableRange(version, range) {
  if (!semver.valid(version)) return false
  if (typeof range !== 'string' || !range.trim()) return true
  try {
    return semver.satisfies(version, range, { includePrerelease: true })
  } catch {
    return true
  }
}

function extractGhsaFromUrl(url) {
  const match = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/iu.exec(String(url || ''))
  return match ? match[0].toUpperCase() : null
}

function registryFromEnvironment() {
  const configured = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
  if (configured) return configured
  const result = spawnSync('pnpm', ['config', 'get', 'registry'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status === 0 && result.stdout.trim() && result.stdout.trim() !== 'undefined') return result.stdout.trim()
  return 'https://registry.npmjs.org/'
}

function auditEndpointUrl(registry) {
  return new URL(auditEndpointPath, registry.endsWith('/') ? registry : `${registry}/`).toString()
}

async function fetchBulkAdvisories(payload, registry = registryFromEnvironment()) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(auditEndpointUrl(registry), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`npm Bulk Advisory endpoint responded with ${response.status}: ${text.slice(0, 500)}`)
    }
    return JSON.parse(text || '{}')
  } finally {
    clearTimeout(timeout)
  }
}

function vulnerabilityCounts(advisories) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
  for (const advisory of Object.values(advisories || {})) {
    counts[normalizeSeverity(advisory.severity || 'low')] += 1
  }
  return counts
}

function auditOutput(report, installedPackages) {
  return {
    advisories: report.advisories,
    metadata: {
      dependencies: [...installedPackages.values()].reduce((total, versions) => total + versions.size, 0),
      vulnerabilities: vulnerabilityCounts(report.advisories),
    },
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/pnpm-audit.mjs [--prod] [--audit-level <severity>]\n\nCollects the pnpm dependency graph, queries npm Bulk Advisory API, and applies package.json#pnpm.auditConfig ignoreCves/ignoreGhsas.\n')
    return
  }

  const auditLevel = auditLevelFromArgs(args)
  const installedPackages = collectInstalledPackages(runPnpmList(stripJsonFlag(args)))
  const report = normalizeBulkAdvisoryReport(
    await fetchBulkAdvisories(buildBulkAdvisoryPayload(installedPackages)),
    installedPackages,
  )

  const packageJsonPath = process.env.OPEN_COWORK_PNPM_AUDIT_PACKAGE_JSON || resolve(repoRoot, 'package.json')
  const summary = summarizeAuditReport(report, loadAuditPolicy(packageJsonPath), { auditLevel })
  if (summary.ignored.length > 0) {
    process.stderr.write(`[pnpm-audit] ignored ${summary.ignored.length} advisory/advisories from package.json#pnpm.auditConfig\n`)
  }
  if (summary.failures.length > 0) {
    for (const failure of summary.failures) {
      process.stderr.write(`[pnpm-audit] unignored advisory: ${formatFailure(failure)}\n`)
    }
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(auditOutput(report, installedPackages), null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[pnpm-audit] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
