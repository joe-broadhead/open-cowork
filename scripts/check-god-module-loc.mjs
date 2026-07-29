#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = resolve(dirname(scriptPath), '..')

function repoPath(value) {
  return value.replaceAll('\\', '/')
}

export function countLogicalLines(source) {
  if (source.length === 0) return 0
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = normalized.split('\n').length
  return normalized.endsWith('\n') ? lines - 1 : lines
}

function readWorkspacePatterns(workspaceManifest) {
  const patterns = []
  let readingPackages = false

  for (const line of workspaceManifest.split(/\r?\n/)) {
    if (/^packages:\s*(?:#.*)?$/.test(line)) {
      readingPackages = true
      continue
    }
    if (!readingPackages) continue
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break

    const match = line.match(/^\s+-\s+(.+?)\s*$/)
    if (!match) continue
    let value = match[1].replace(/\s+#.*$/, '').trim()
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    if (value) patterns.push(value)
  }

  return patterns
}

function expandWorkspacePattern(root, pattern) {
  const segments = repoPath(pattern).split('/').filter(Boolean)
  if (
    pattern.startsWith('/')
    || segments.includes('..')
    || segments.some((segment) => segment !== '*' && /[*?[\]{}]/.test(segment))
  ) {
    throw new Error(`unsupported workspace pattern: ${pattern}`)
  }

  let candidates = [root]
  for (const segment of segments) {
    const next = []
    for (const candidate of candidates) {
      if (segment !== '*') {
        const child = join(candidate, segment)
        if (existsSync(child)) next.push(child)
        continue
      }
      for (const entry of readdirSync(candidate, { withFileTypes: true })) {
        if (entry.isDirectory()) next.push(join(candidate, entry.name))
      }
    }
    candidates = next
  }
  return candidates.filter((candidate) => existsSync(join(candidate, 'package.json')))
}

function collectProductionSourceFiles(directory, discovery, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (discovery.excludedDirectoryNames.includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      collectProductionSourceFiles(path, discovery, output)
      continue
    }
    if (!entry.isFile() || !discovery.extensions.includes(extname(entry.name))) continue
    if (discovery.excludedFileSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue
    output.push(path)
  }
}

export function discoverProductionModules(root, budget) {
  const workspaceManifestPath = resolve(root, budget.discovery.workspaceManifest)
  if (!existsSync(workspaceManifestPath)) {
    throw new Error(`workspace manifest does not exist: ${repoPath(relative(root, workspaceManifestPath))}`)
  }

  const patterns = readWorkspacePatterns(readFileSync(workspaceManifestPath, 'utf8'))
  if (patterns.length === 0) {
    throw new Error(`workspace manifest has no package patterns: ${budget.discovery.workspaceManifest}`)
  }

  const workspaceDirectories = new Set()
  for (const pattern of patterns) {
    const matches = expandWorkspacePattern(root, pattern)
    if (matches.length === 0) {
      throw new Error(`workspace pattern matched no package directories: ${pattern}`)
    }
    for (const match of matches) workspaceDirectories.add(resolve(match))
  }

  const sourceFiles = []
  for (const workspaceDirectory of workspaceDirectories) {
    const sourceDirectory = join(workspaceDirectory, budget.discovery.sourceDirectory)
    if (existsSync(sourceDirectory)) {
      collectProductionSourceFiles(sourceDirectory, budget.discovery, sourceFiles)
    }
  }

  const modules = sourceFiles
    .map((path) => ({
      lines: countLogicalLines(readFileSync(path, 'utf8')),
      path: repoPath(relative(root, path)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))

  return {
    modules,
    workspaceCount: workspaceDirectories.size,
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function validateMetadataEntries(entries, field, budget, failures, registeredPaths) {
  if (!Array.isArray(entries)) {
    failures.push(`${field} must be an array`)
    return []
  }

  const validEntries = []
  for (const [index, entry] of entries.entries()) {
    const prefix = `${field}[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`${prefix} must be an object`)
      continue
    }

    const rawPath = typeof entry.path === 'string' ? entry.path.trim() : ''
    const path = repoPath(rawPath)
    if (
      !path
      || path.startsWith('/')
      || path.split('/').includes('..')
      || rawPath.includes('\\')
    ) {
      failures.push(`${prefix}.path must be a normalized repository-relative path`)
    } else if (registeredPaths.has(path)) {
      failures.push(`duplicate LOC registry path: ${path}`)
    } else {
      registeredPaths.add(path)
    }

    if (!positiveInteger(entry.maxLines)) {
      failures.push(`${prefix}.maxLines must be a positive integer`)
    } else if (entry.maxLines > budget.hardCapLines) {
      failures.push(`${prefix}.maxLines exceeds the repository hard cap ${budget.hardCapLines}`)
    }
    if (field === 'exceptions' && positiveInteger(entry.maxLines) && entry.maxLines < budget.softTargetLines) {
      failures.push(`${prefix}.maxLines must be at least the soft target ${budget.softTargetLines}`)
    }
    if (!positiveInteger(entry.ratchetTargetLines)) {
      failures.push(`${prefix}.ratchetTargetLines must be a positive integer`)
    } else if (positiveInteger(entry.maxLines) && entry.ratchetTargetLines > entry.maxLines) {
      failures.push(`${prefix}.ratchetTargetLines must not exceed maxLines`)
    }
    if (typeof entry.owner !== 'string' || entry.owner.trim().length === 0) {
      failures.push(`${prefix}.owner is required`)
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      failures.push(`${prefix}.reason is required`)
    }

    if (path) validEntries.push({ ...entry, path })
  }
  return validEntries
}

export function evaluateLocBudget(modules, budget) {
  const failures = []
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    return { failures: ['budget must be an object'], oversized: [], tracked: [] }
  }
  if (budget.schemaVersion !== 2) failures.push('schemaVersion must be 2')
  if (!positiveInteger(budget.softTargetLines)) failures.push('softTargetLines must be a positive integer')
  if (!positiveInteger(budget.hardCapLines)) failures.push('hardCapLines must be a positive integer')
  if (
    positiveInteger(budget.softTargetLines)
    && positiveInteger(budget.hardCapLines)
    && budget.softTargetLines >= budget.hardCapLines
  ) {
    failures.push('softTargetLines must be lower than hardCapLines')
  }

  const registeredPaths = new Set()
  const exceptions = validateMetadataEntries(
    budget.exceptions,
    'exceptions',
    budget,
    failures,
    registeredPaths,
  )
  const ratchets = validateMetadataEntries(
    budget.ratchets,
    'ratchets',
    budget,
    failures,
    registeredPaths,
  )
  const exceptionByPath = new Map(exceptions.map((entry) => [entry.path, entry]))
  const ratchetByPath = new Map(ratchets.map((entry) => [entry.path, entry]))
  const moduleByPath = new Map()

  for (const module of modules) {
    const path = repoPath(String(module.path || ''))
    if (moduleByPath.has(path)) {
      failures.push(`production module discovered more than once: ${path}`)
      continue
    }
    moduleByPath.set(path, { ...module, path })
  }

  const oversized = []
  for (const module of moduleByPath.values()) {
    if (module.lines > budget.hardCapLines) {
      failures.push(`${module.path} has ${module.lines} lines and exceeds the repository hard cap ${budget.hardCapLines}`)
    }

    const exception = exceptionByPath.get(module.path)
    if (module.lines >= budget.softTargetLines) {
      oversized.push({
        path: module.path,
        lines: module.lines,
        maxLines: exception?.maxLines ?? null,
      })
      if (!exception) {
        failures.push(`${module.path} has ${module.lines} lines and requires an oversized-module exception at ${budget.softTargetLines} lines`)
      } else if (module.lines > exception.maxLines) {
        failures.push(`${module.path} has ${module.lines} lines (exception max ${exception.maxLines})`)
      }
    } else if (exception) {
      failures.push(`${module.path} exception is stale at ${module.lines} lines (soft target ${budget.softTargetLines})`)
    }

    const ratchet = ratchetByPath.get(module.path)
    if (ratchet && module.lines > ratchet.maxLines) {
      failures.push(`${module.path} has ${module.lines} lines (ratchet max ${ratchet.maxLines})`)
    } else if (ratchet && module.lines < ratchet.maxLines) {
      failures.push(
        `${module.path} ratchet is stale at ${module.lines} lines `
        + `(max ${ratchet.maxLines}); lower maxLines to preserve the improvement`,
      )
    }
  }

  for (const entry of exceptions) {
    if (!moduleByPath.has(entry.path)) {
      failures.push(`${entry.path} exception is stale because it is not a discovered production module`)
    }
  }
  for (const entry of ratchets) {
    if (!moduleByPath.has(entry.path)) {
      failures.push(`${entry.path} ratchet is stale because it is not a discovered production module`)
    }
  }

  const tracked = [...exceptions, ...ratchets]
    .map((entry) => ({
      path: entry.path,
      lines: moduleByPath.get(entry.path)?.lines ?? null,
      maxLines: entry.maxLines,
      owner: entry.owner,
      ratchetTargetLines: entry.ratchetTargetLines,
      type: exceptionByPath.has(entry.path) ? 'exception' : 'ratchet',
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))

  oversized.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return { failures, oversized, tracked }
}

function validateDiscoveryConfig(budget) {
  const failures = []
  const discovery = budget?.discovery
  if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)) {
    return ['discovery must be an object']
  }
  if (typeof discovery.workspaceManifest !== 'string' || !discovery.workspaceManifest.trim()) {
    failures.push('discovery.workspaceManifest is required')
  } else if (
    discovery.workspaceManifest.startsWith('/')
    || repoPath(discovery.workspaceManifest).split('/').includes('..')
  ) {
    failures.push('discovery.workspaceManifest must be repository-relative')
  }
  if (discovery.sourceDirectory !== 'src') {
    failures.push('discovery.sourceDirectory must be src')
  }
  for (const field of ['extensions', 'excludedDirectoryNames', 'excludedFileSuffixes']) {
    if (
      !Array.isArray(discovery[field])
      || discovery[field].length === 0
      || discovery[field].some((value) => typeof value !== 'string' || value.length === 0)
    ) {
      failures.push(`discovery.${field} must be a non-empty string array`)
    }
  }
  if (
    Array.isArray(discovery.extensions)
    && (!discovery.extensions.includes('.ts') || !discovery.extensions.includes('.tsx'))
  ) {
    failures.push('discovery.extensions must include .ts and .tsx')
  }
  return failures
}

function parseArgs(args) {
  const options = {
    budget: 'docs/development/god-module-loc-budgets.json',
    json: false,
    root: defaultRoot,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--budget' || argument === '--root') {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      options[argument.slice(2)] = value
      index += 1
    } else {
      throw new Error(`unsupported argument: ${argument}`)
    }
  }
  options.root = resolve(options.root)
  return options
}

export function runLocBudgetCheck(root, budgetPath) {
  const resolvedBudgetPath = resolve(root, budgetPath)
  if (!existsSync(resolvedBudgetPath)) {
    return {
      failures: [`budget does not exist: ${repoPath(relative(root, resolvedBudgetPath))}`],
      report: null,
    }
  }

  let budget
  try {
    budget = JSON.parse(readFileSync(resolvedBudgetPath, 'utf8'))
  } catch (error) {
    return {
      failures: [`budget is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      report: null,
    }
  }
  const discoveryFailures = validateDiscoveryConfig(budget)
  let discovery = { modules: [], workspaceCount: 0 }
  if (discoveryFailures.length === 0) {
    try {
      discovery = discoverProductionModules(root, budget)
    } catch (error) {
      discoveryFailures.push(error instanceof Error ? error.message : String(error))
    }
  }
  const evaluation = evaluateLocBudget(discovery.modules, budget)
  const failures = [...discoveryFailures, ...evaluation.failures]
  return {
    failures,
    report: {
      schemaVersion: 1,
      status: failures.length === 0 ? 'pass' : 'fail',
      budget: repoPath(relative(root, resolvedBudgetPath)),
      workspaceCount: discovery.workspaceCount,
      moduleCount: discovery.modules.length,
      softTargetLines: budget.softTargetLines,
      hardCapLines: budget.hardCapLines,
      oversized: evaluation.oversized,
      tracked: evaluation.tracked,
      failures,
    },
  }
}

function main(args) {
  let options
  try {
    options = parseArgs(args)
  } catch (error) {
    console.error(`Production LOC check failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const { failures, report } = runLocBudgetCheck(options.root, options.budget)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report || {
      schemaVersion: 1,
      status: 'fail',
      failures,
    }, null, 2)}\n`)
  } else if (report) {
    for (const entry of report.tracked) {
      process.stdout.write(`${entry.path}: ${entry.lines ?? 'missing'}/${entry.maxLines} (${entry.type})\n`)
    }
    if (failures.length === 0) {
      process.stdout.write(
        `Production LOC budgets OK: ${report.moduleCount} modules across ${report.workspaceCount} workspaces; `
        + `${report.oversized.length} oversized exception(s).\n`,
      )
    }
  }

  if (failures.length > 0 && !options.json) {
    console.error(`Production LOC budget failed:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`)
  }
  return failures.length === 0 ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main(process.argv.slice(2))
}
