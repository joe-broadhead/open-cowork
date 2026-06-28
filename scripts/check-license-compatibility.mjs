// License compatibility gate (LIC-02).
//
// Open Cowork is MIT-licensed and redistributes its production dependency graph
// inside the desktop app and the cloud/gateway container images. Strong-copyleft
// dependencies (GPL/AGPL/LGPL/SSPL/CPAL/EUPL families) are incompatible with that
// MIT grant, so this gate hard-fails if any production dependency declares one.
//
// The production dependency set is derived from the same `pnpm list --prod`
// traversal used by scripts/generate-third-party-notices.mjs. First-party
// @open-cowork/* workspace packages (link:/file:/workspace: specs or paths inside
// this repository) are skipped because they are part of Open Cowork itself.
//
// A reviewed exception can be cleared by adding an entry to COPYLEFT_ALLOWLIST
// below — keyed by "name" or "name@version", valued with the human reason it is
// acceptable (e.g. build-time only and not redistributed). Keep it EMPTY unless a
// dependency has been explicitly reviewed.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = process.cwd()

// Documented allowlist of reviewed strong-copyleft exceptions.
// Example: 'some-build-tool@1.2.3': 'Reviewed 2026-06-28: dev/build-time only, never shipped.'
const COPYLEFT_ALLOWLIST = {}

// SPDX license id families that impose strong/network copyleft obligations.
const COPYLEFT_LICENSE_FAMILIES = ['GPL', 'AGPL', 'LGPL', 'SSPL', 'CPAL', 'EUPL']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalizeLicense(value) {
  if (!value) return 'UNKNOWN'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(normalizeLicense).join(' OR ')
  if (typeof value === 'object' && typeof value.type === 'string') return value.type
  return String(value)
}

// First-party workspace packages are not redistributed third-party code.
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

export function isCopyleftLicenseId(id) {
  const normalized = id.trim().toUpperCase().replace(/\+$/, '')
  return COPYLEFT_LICENSE_FAMILIES.some(
    (family) => normalized === family || normalized.startsWith(`${family}-`),
  )
}

// "Apache-2.0 WITH LLVM-exception" -> base license id for family matching.
// (GPL-*-with-*-exception ids have no spaces and stay copyleft via the base id.)
function stripException(term) {
  const withIndex = term.toUpperCase().indexOf(' WITH ')
  return withIndex === -1 ? term.trim() : term.slice(0, withIndex).trim()
}

function stripOuterParens(expr) {
  let current = expr.trim()
  while (current.startsWith('(') && current.endsWith(')')) {
    let depth = 0
    let encloses = true
    for (let index = 0; index < current.length; index += 1) {
      const char = current[index]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0 && index < current.length - 1) {
          encloses = false
          break
        }
      }
    }
    if (!encloses) break
    current = current.slice(1, -1).trim()
  }
  return current
}

// Split an SPDX-ish expression on top-level (paren-depth-0) operator tokens.
function splitTopLevel(expr, operators) {
  const ops = new Set(operators.map((operator) => operator.toUpperCase()))
  const tokens = expr
    .replaceAll('(', ' ( ')
    .replaceAll(')', ' ) ')
    .replaceAll(',', ' , ')
    .split(/\s+/)
    .filter(Boolean)
  const parts = []
  let depth = 0
  let current = []
  for (const token of tokens) {
    if (token === '(') { depth += 1; current.push(token); continue }
    if (token === ')') { depth -= 1; current.push(token); continue }
    if (depth === 0 && ops.has(token.toUpperCase())) {
      if (current.length) parts.push(current.join(' '))
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length) parts.push(current.join(' '))
  return parts.map((part) => part.trim()).filter(Boolean)
}

// An expression imposes copyleft only if EVERY OR-alternative does. Within an
// alternative, AND/WITH-joined terms all apply, so the alternative is copyleft if
// any of its terms is. Comma-separated lists are treated as OR alternatives.
export function imposesCopyleft(expression) {
  const expr = stripOuterParens(String(expression ?? '').trim())
  if (!expr) return false

  const orBranches = splitTopLevel(expr, ['OR', ','])
  if (orBranches.length > 1) {
    return orBranches.every((branch) => imposesCopyleft(branch))
  }

  const andTerms = splitTopLevel(expr, ['AND'])
  if (andTerms.length > 1) {
    return andTerms.some((term) => imposesCopyleft(term))
  }

  return isCopyleftLicenseId(stripException(expr))
}

function collectProductionPackages(node, packages) {
  for (const dependencies of [node?.dependencies, node?.optionalDependencies]) {
    if (!dependencies) continue
    for (const [dependencyName, dependency] of Object.entries(dependencies)) {
      const name = dependency?.name || dependency?.from || dependencyName
      if (!name || !dependency?.version || !dependency?.path) continue
      if (isWorkspaceLink(dependency.version, dependency.path)) {
        collectProductionPackages(dependency, packages)
        continue
      }
      const key = `${name}@${dependency.version}`
      if (!packages.has(key)) {
        const manifestPath = join(dependency.path, 'package.json')
        const manifest = existsSync(manifestPath) ? readJson(manifestPath) : {}
        packages.set(key, {
          name,
          version: dependency.version,
          license: normalizeLicense(manifest.license || manifest.licenses),
        })
      }
      collectProductionPackages(dependency, packages)
    }
  }
}

function runGate() {
  const listJson = execFileSync(
    'pnpm',
    ['list', '--prod', '--recursive', '--json', '--depth', 'Infinity'],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 },
  )
  const workspaceNodes = JSON.parse(listJson)
  const packages = new Map()
  for (const workspaceNode of workspaceNodes) {
    collectProductionPackages(workspaceNode, packages)
  }

  const sortedPackages = [...packages.values()].sort((a, b) => {
    return a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  })

  const violations = []
  const allowedExceptions = []
  for (const pkg of sortedPackages) {
    if (!imposesCopyleft(pkg.license)) continue
    const reason = COPYLEFT_ALLOWLIST[`${pkg.name}@${pkg.version}`] ?? COPYLEFT_ALLOWLIST[pkg.name]
    if (reason) {
      allowedExceptions.push({ ...pkg, reason })
      continue
    }
    violations.push(pkg)
  }

  for (const exception of allowedExceptions) {
    process.stdout.write(
      `license:check allowed exception — ${exception.name}@${exception.version} (${exception.license}): ${exception.reason}\n`,
    )
  }

  if (violations.length > 0) {
    console.error('license:check FAILED — strong-copyleft production dependencies detected:')
    for (const violation of violations) {
      console.error(`  - ${violation.name}@${violation.version}: ${violation.license}`)
    }
    console.error('')
    console.error(
      'Open Cowork is MIT-licensed and redistributes these dependencies in the desktop app',
    )
    console.error(
      'and the cloud/gateway images. Strong-copyleft (GPL/AGPL/LGPL/SSPL/CPAL/EUPL) terms are',
    )
    console.error('incompatible with that grant. Remove the dependency, or — if it has been reviewed')
    console.error('and cleared — add it to COPYLEFT_ALLOWLIST in scripts/check-license-compatibility.mjs.')
    process.exit(1)
  }

  process.stdout.write(
    `license:check passed — scanned ${sortedPackages.length} production dependencies; `
    + 'no disallowed strong-copyleft (GPL/AGPL/LGPL/SSPL/CPAL/EUPL) licenses found'
    + `${allowedExceptions.length > 0 ? ` (${allowedExceptions.length} reviewed exception(s) allowed)` : ''}.\n`,
  )
}

// Only run the pnpm-list-driven gate when invoked directly; importers (tests)
// get the pure license-classification helpers without the dependency scan.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGate()
}
