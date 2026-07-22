#!/usr/bin/env node
/**
 * JOE-963: Fail closed if public docs claim multi-AZ / multi-replica Durable
 * Gateway HA while the proving registry status is not "ready".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const scriptLog = (...args) => { process.stdout.write(args.map(String).join(' ') + String.fromCharCode(10)) }

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registry = JSON.parse(
  readFileSync(resolve(root, 'docs/development/distributed-ownership-proving-registry.json'), 'utf8'),
)

const FORBIDDEN = (registry.marketingForbiddenClaims || []).map((s) => s.toLowerCase())
// Patterns that imply production HA for Durable Gateway (case-insensitive).
const FORBIDDEN_RES = [
  /\bmulti[- ]?az\b.*\b(ha|high availability|gateway)\b/i,
  /\b(ha|high availability)\b.*\bmulti[- ]?az\b/i,
  /\bactive[- ]active\b.*\b(daemon|gateway|replica)/i,
  /\bproduction multi[- ]replica\b.*\bgateway\b/i,
  /\bhorizontally scaled\b.*\b(durable\s+)?gateway\b/i,
]

const SCAN_ROOTS = ['docs', 'products/gateway/docs', 'helm/open-cowork-gateway']
const SKIP = new Set(['node_modules', 'dist', '.git', 'evidence'])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(abs, out)
    else if (/\.(md|yml|yaml)$/i.test(name)) out.push(abs)
  }
  return out
}

// Allow explicit "do not claim X" / "not multi-AZ" / inventory language.
function isNegatedOrInventory(line) {
  // Strip markdown emphasis so "**Does not** mean" still matches.
  const l = line.toLowerCase().replace(/[*_`]/g, '')
  if (l.includes('do not claim') || l.includes('must not claim') || l.includes('no multi-az')) return true
  if (l.includes('does not mean') || l.includes('should not support') || l.includes('must not')) return true
  if (l.includes('not multi-az') || l.includes('not yet') || l.includes('until')) return true
  if (l.includes('forbidden') || l.includes('non-claims') || l.includes('unsafe')) return true
  if (l.includes('fail closed') || l.includes('replicacount > 1 is unsafe')) return true
  if (l.includes('experimental') && (l.includes('lab') || l.includes('not multi'))) return true
  if (l.includes('single-writer') || l.includes('single writer')) return true
  if (l.includes('implying multi-az') || l.includes('without completing')) return true
  if (l.includes('document that active-active')) return true
  if (/^\s*-\s*no\b/.test(l)) return true // bullet non-claims list
  return false
}

const failures = []
const files = SCAN_ROOTS.flatMap((rel) => walk(resolve(root, rel)))

if (registry.status === 'ready') {
  scriptLog('Distributed ownership proving registry status=ready; claim scan is advisory only')
} else {
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (isNegatedOrInventory(line)) return
      for (const re of FORBIDDEN_RES) {
        if (re.test(line)) {
          failures.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`)
        }
      }
      for (const phrase of FORBIDDEN) {
        if (line.toLowerCase().includes(phrase) && !isNegatedOrInventory(line)) {
          failures.push(`${relative(root, file)}:${index + 1}: forbidden phrase "${phrase}"`)
        }
      }
    })
  }
}

// Always enforce Helm defaults regardless of registry status.
const values = readFileSync(resolve(root, 'helm/open-cowork-gateway/values.yaml'), 'utf8')
if (!/experimentalDistributedOwnership:\s*false/.test(values)) {
  failures.push('helm/open-cowork-gateway/values.yaml must default experimentalDistributedOwnership: false')
}
if (!/replicaCount:\s*1/.test(values)) {
  failures.push('helm/open-cowork-gateway/values.yaml must default replicaCount: 1')
}

if (failures.length) {
  console.error(
    'Distributed ownership claim gate failed (JOE-963):\n' +
      failures.slice(0, 40).map((f) => `  - ${f}`).join('\n') +
      (failures.length > 40 ? `\n  … ${failures.length - 40} more` : ''),
  )
  process.exit(1)
}

scriptLog(
  `Distributed ownership claims OK (registry status=${registry.status}, scanned ${files.length} files)`,
)
