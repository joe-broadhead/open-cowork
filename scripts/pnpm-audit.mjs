import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
  return `${idText} ${moduleName} ${severity}${title ? ` - ${title}` : ''}`
}

function stripJsonFlag(args) {
  return args.filter((arg) => arg !== '--json')
}

function runAudit(args) {
  const auditArgs = ['audit', '--json', ...stripJsonFlag(args)]
  const command = process.env.OPEN_COWORK_PNPM_AUDIT_BIN || 'pnpm'
  return spawnSync(command, auditArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/pnpm-audit.mjs [pnpm audit flags]\n\nRuns pnpm audit as JSON and applies package.json#pnpm.auditConfig ignoreCves/ignoreGhsas.\n')
    return
  }

  const auditLevel = auditLevelFromArgs(args)
  const result = runAudit(args)
  if (result.error) throw result.error

  let report
  try {
    report = JSON.parse(result.stdout || '{}')
  } catch (error) {
    process.stderr.write(result.stderr || '')
    process.stderr.write(`Failed to parse pnpm audit JSON output: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(result.status || 1)
  }

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
  process.stdout.write(result.stdout || '')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
