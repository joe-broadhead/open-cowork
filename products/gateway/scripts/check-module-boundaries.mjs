#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const options = parseArgs(process.argv.slice(2))
const root = process.cwd()
const budgetPath = path.resolve(root, options.budget || 'docs/development/module-boundary-budget.json')
const asJson = options.json

if (!fs.existsSync(budgetPath)) {
  console.error(`module boundary check failed: budget not found at ${path.relative(root, budgetPath) || budgetPath}`)
  process.exit(1)
}

const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf-8'))
const sourceRootName = String(budget.sourceRoot || 'src')
const sourceRoot = path.join(root, sourceRootName)
const failures = []

function fail(message) {
  failures.push(message)
}

if (budget.schemaVersion !== 1) fail('schemaVersion must be 1')
if (typeof budget.claimBoundary !== 'string' || !/no release-claim expansion/i.test(budget.claimBoundary)) {
  fail('claimBoundary must state no release-claim expansion')
}
if (!fs.existsSync(sourceRoot)) fail(`sourceRoot does not exist: ${sourceRootName}`)

const dependencyBudget = budget.dependencyBudget || {}
const includeTests = dependencyBudget.includeTests === true
const files = fs.existsSync(sourceRoot)
  ? listTypeScriptFiles(sourceRoot)
    .filter((file) => includeTests || !file.includes(`${path.sep}__tests__${path.sep}`))
    .sort((a, b) => relativeId(a).localeCompare(relativeId(b)))
  : []
const moduleSet = new Set(files.map(relativeId))
const graph = new Map(files.map((file) => [relativeId(file), new Set()]))
const unresolvedRelativeImports = []

for (const file of files) {
  const id = relativeId(file)
  const text = fs.readFileSync(file, 'utf-8')
  for (const specifier of relativeSpecifiers(text)) {
    const resolved = resolveRelativeImport(file, specifier)
    if (resolved && moduleSet.has(resolved)) graph.get(id).add(resolved)
    else unresolvedRelativeImports.push({ from: id, specifier })
  }
}
for (const unresolved of unresolvedRelativeImports) {
  fail(`unresolved relative import: ${unresolved.from} -> ${unresolved.specifier}`)
}

const incoming = new Map([...graph.keys()].map((id) => [id, 0]))
let edgeCount = 0
const edges = []
for (const [from, dependencies] of graph.entries()) {
  for (const to of dependencies) {
    edgeCount += 1
    incoming.set(to, (incoming.get(to) || 0) + 1)
    edges.push({ from, to })
  }
}

const cycles = stronglyConnectedComponents(graph)
  .filter((component) => component.length > 1 || [...(graph.get(component[0]) || [])].includes(component[0]))
  .map((component) => component.sort())
  .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))

if (Number.isFinite(dependencyBudget.maxModuleCount) && files.length > dependencyBudget.maxModuleCount) {
  fail(`module count ${files.length} exceeds budget ${dependencyBudget.maxModuleCount}`)
}
if (Number.isFinite(dependencyBudget.maxEdgeCount) && edgeCount > dependencyBudget.maxEdgeCount) {
  fail(`edge count ${edgeCount} exceeds budget ${dependencyBudget.maxEdgeCount}`)
}
if (Number.isFinite(dependencyBudget.maxCycleComponents) && cycles.length > dependencyBudget.maxCycleComponents) {
  fail(`cycle component count ${cycles.length} exceeds budget ${dependencyBudget.maxCycleComponents}`)
}
const maxCycleSize = cycles[0]?.length || 0
if (Number.isFinite(dependencyBudget.maxCycleComponentSize) && maxCycleSize > dependencyBudget.maxCycleComponentSize) {
  fail(`max cycle component size ${maxCycleSize} exceeds budget ${dependencyBudget.maxCycleComponentSize}`)
}

const knownCycles = Array.isArray(dependencyBudget.knownCycles)
  ? dependencyBudget.knownCycles.map((cycle) => cycleKey(cycle))
  : []
const knownCycleSet = new Set(knownCycles)
for (const cycle of cycles) {
  const key = cycleKey(cycle)
  if (!knownCycleSet.has(key)) fail(`new unregistered dependency cycle: ${cycle.join(' -> ')}`)
}

validateDomains(budget.domains)
const ownerSummary = buildOwnerSummary(budget.domains)
const growthPolicy = validateGrowthPolicy(budget.growthPolicy, budget.domains, budget.forbiddenImports, dependencyBudget)
const forbiddenImportViolations = validateForbiddenImports(budget.forbiddenImports, edges)
for (const violation of forbiddenImportViolations) {
  fail(`${violation.ruleId}: ${violation.from} imports ${violation.to}`)
}

// Per-file LOC budgets for god-module façades (audit 2026-07-21 P1-4).
const fileLocBudgets = Array.isArray(budget.fileLocBudgets) ? budget.fileLocBudgets : []
const fileLocResults = []
for (const entry of fileLocBudgets) {
  const rel = String(entry.path || '')
  const maxLines = Number(entry.maxLines)
  if (!rel || !Number.isFinite(maxLines)) {
    fail(`fileLocBudgets entry invalid: ${JSON.stringify(entry)}`)
    continue
  }
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) {
    fail(`fileLocBudgets path missing: ${rel}`)
    continue
  }
  const lineCount = fs.readFileSync(abs, 'utf-8').split(/\r?\n/).length
  fileLocResults.push({ path: rel, lineCount, maxLines, owner: entry.owner || null })
  if (lineCount > maxLines) {
    fail(`file LOC budget exceeded: ${rel} has ${lineCount} lines (max ${maxLines})`)
  }
}

const report = {
  schemaVersion: 1,
  status: failures.length === 0 ? 'pass' : 'fail',
  checkedAt: new Date().toISOString(),
  budget: relativeId(budgetPath),
  sourceRoot: sourceRootName,
  includeTests,
  moduleCount: files.length,
  edgeCount,
  cycleBudget: {
    status: cycles.length === 0 ? 'acyclic' : 'cycles_present',
    stronglyConnectedComponentCount: cycles.length,
    maxComponentSize: maxCycleSize,
    knownCycleCount: knownCycleSet.size,
  },
  cycles,
  ownerSummary,
  growthPolicy,
  forbiddenImportViolations,
  fileLocBudgets: fileLocResults,
  unresolvedRelativeImports,
  failures,
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else if (failures.length === 0) {
  console.log(`module boundary check passed: ${files.length} module(s), ${edgeCount} edge(s), ${cycles.length} registered cycle component(s)`)
} else {
  for (const failure of failures) console.error(`module boundary check failed: ${failure}`)
}

process.exit(failures.length === 0 ? 0 : 1)

function parseArgs(args) {
  const parsed = { json: false, budget: undefined }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--json') parsed.json = true
    else if (arg === '--budget') {
      parsed.budget = args[i + 1]
      i += 1
    } else {
      console.error(`module boundary check failed: unsupported argument ${arg}`)
      process.exit(1)
    }
  }
  return parsed
}

function validateDomains(domains) {
  if (!Array.isArray(domains) || domains.length < 8) {
    fail('domains must include at least 8 owner domains')
    return
  }
  const ids = new Set()
  for (const [index, domain] of domains.entries()) {
    const prefix = `domains[${index}]`
    if (!domain || typeof domain !== 'object' || Array.isArray(domain)) {
      fail(`${prefix} must be an object`)
      continue
    }
    if (typeof domain.id !== 'string' || domain.id.length === 0) fail(`${prefix}.id is required`)
    else if (ids.has(domain.id)) fail(`duplicate domain id: ${domain.id}`)
    else ids.add(domain.id)
    if (typeof domain.owner !== 'string' || domain.owner.length === 0) fail(`${prefix}.owner is required`)
    if (typeof domain.category !== 'string' || domain.category.length === 0) fail(`${prefix}.category is required`)
    if (typeof domain.changeRule !== 'string' || domain.changeRule.length === 0) fail(`${prefix}.changeRule is required`)
    for (const field of ['ownerModules', 'edgeAdapters', 'primaryTests']) {
      if (!Array.isArray(domain[field]) || domain[field].length === 0) {
        fail(`${prefix}.${field} must be a non-empty array`)
        continue
      }
      for (const item of domain[field]) {
        if (typeof item !== 'string' || item.length === 0) {
          fail(`${prefix}.${field} contains a non-string path`)
          continue
        }
        if (!fs.existsSync(path.join(root, item))) fail(`${prefix}.${field} path does not exist: ${item}`)
      }
    }
  }
}

function buildOwnerSummary(domains) {
  const safeDomains = Array.isArray(domains) ? domains : []
  const byCategory = new Map()
  for (const domain of safeDomains) {
    const category = typeof domain?.category === 'string' && domain.category ? domain.category : 'uncategorized'
    const existing = byCategory.get(category) || {
      category,
      domainCount: 0,
      domains: [],
      ownerModuleCount: 0,
      edgeAdapterCount: 0,
      primaryTestCount: 0,
    }
    existing.domainCount += 1
    if (typeof domain?.id === 'string') existing.domains.push(domain.id)
    existing.ownerModuleCount += Array.isArray(domain?.ownerModules) ? domain.ownerModules.length : 0
    existing.edgeAdapterCount += Array.isArray(domain?.edgeAdapters) ? domain.edgeAdapters.length : 0
    existing.primaryTestCount += Array.isArray(domain?.primaryTests) ? domain.primaryTests.length : 0
    byCategory.set(category, existing)
  }
  return [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category))
}

function validateGrowthPolicy(policy, domains, forbiddenImports, dependencyBudget) {
  const failureCountBefore = failures.length
  const report = {
    status: 'pass',
    ownerCategories: [],
    budgetIncreases: [],
    budgetIncreaseSummary: {
      evidenceOnly: { moduleDelta: 0, edgeDelta: 0 },
      runtimeRisk: { moduleDelta: 0, edgeDelta: 0 },
      docsOrValidation: { moduleDelta: 0, edgeDelta: 0 },
    },
    directionalImportPilots: [],
  }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    fail('growthPolicy is required')
    report.status = 'fail'
    return report
  }
  if (policy.schemaVersion !== 1) fail('growthPolicy.schemaVersion must be 1')

  const categories = Array.isArray(policy.ownerCategories) ? policy.ownerCategories : []
  if (categories.length === 0) fail('growthPolicy.ownerCategories must be a non-empty array')
  const categoryById = new Map()
  for (const [index, category] of categories.entries()) {
    const prefix = `growthPolicy.ownerCategories[${index}]`
    if (!category || typeof category !== 'object' || Array.isArray(category)) {
      fail(`${prefix} must be an object`)
      continue
    }
    if (typeof category.id !== 'string' || category.id.length === 0) fail(`${prefix}.id is required`)
    if (!['runtime', 'evidence_only', 'docs', 'validation'].includes(category.risk)) {
      fail(`${prefix}.risk must be runtime, evidence_only, docs, or validation`)
    }
    if (typeof category.description !== 'string' || category.description.length === 0) fail(`${prefix}.description is required`)
    if (category.id) categoryById.set(category.id, category)
  }
  report.ownerCategories = categories.map((category) => ({
    id: category.id,
    risk: category.risk,
    description: category.description,
  }))

  for (const [index, domain] of (Array.isArray(domains) ? domains : []).entries()) {
    if (!domain?.category || !categoryById.has(domain.category)) {
      fail(`domains[${index}].category must reference growthPolicy.ownerCategories`)
    }
  }

  for (const [field, label] of [
    ['allowedWhen', 'allowed conditions'],
    ['consolidateWhen', 'consolidation conditions'],
    ['failWhen', 'failure conditions'],
  ]) {
    const values = policy.evidenceOnlyGrowthPolicy?.[field]
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value.length === 0)) {
      fail(`growthPolicy.evidenceOnlyGrowthPolicy.${field} must list ${label}`)
    }
  }

  const increases = Array.isArray(policy.budgetIncreases) ? policy.budgetIncreases : []
  if (increases.length === 0) fail('growthPolicy.budgetIncreases must be a non-empty array')
  const latestBudgetByMetric = new Map()
  for (const [index, increase] of increases.entries()) {
    const prefix = `growthPolicy.budgetIncreases[${index}]`
    if (!increase || typeof increase !== 'object' || Array.isArray(increase)) {
      fail(`${prefix} must be an object`)
      continue
    }
    for (const field of ['id', 'issue', 'metric', 'ownerCategory', 'growthKind', 'rationale', 'consolidationPath']) {
      if (typeof increase[field] !== 'string' || increase[field].trim().length === 0) fail(`${prefix}.${field} is required`)
    }
    if (!['module_count', 'edge_count'].includes(increase.metric)) fail(`${prefix}.metric must be module_count or edge_count`)
    if (!['evidence_only', 'runtime', 'docs', 'validation'].includes(increase.growthKind)) {
      fail(`${prefix}.growthKind must be evidence_only, runtime, docs, or validation`)
    }
    if (!categoryById.has(increase.ownerCategory)) fail(`${prefix}.ownerCategory must reference growthPolicy.ownerCategories`)
    for (const field of ['previous', 'current', 'delta']) {
      if (!Number.isFinite(increase[field])) fail(`${prefix}.${field} must be a number`)
    }
    if (Number.isFinite(increase.previous) && Number.isFinite(increase.current) && Number.isFinite(increase.delta)) {
      if (increase.current - increase.previous !== increase.delta) fail(`${prefix}.delta must equal current - previous`)
      if (increase.delta <= 0) fail(`${prefix}.delta must record a positive budget increase`)
      latestBudgetByMetric.set(
        increase.metric,
        Math.max(latestBudgetByMetric.get(increase.metric) ?? Number.NEGATIVE_INFINITY, increase.current),
      )
      addGrowthDelta(report.budgetIncreaseSummary, increase)
    }
    report.budgetIncreases.push({
      id: increase.id,
      issue: increase.issue,
      metric: increase.metric,
      previous: increase.previous,
      current: increase.current,
      delta: increase.delta,
      ownerCategory: increase.ownerCategory,
      growthKind: increase.growthKind,
      rationale: increase.rationale,
      consolidationPath: increase.consolidationPath,
    })
  }
  if (latestBudgetByMetric.has('module_count') && latestBudgetByMetric.get('module_count') !== dependencyBudget.maxModuleCount) {
    fail('growthPolicy.budgetIncreases latest module_count current must match dependencyBudget.maxModuleCount')
  }
  if (latestBudgetByMetric.has('edge_count') && latestBudgetByMetric.get('edge_count') !== dependencyBudget.maxEdgeCount) {
    fail('growthPolicy.budgetIncreases latest edge_count current must match dependencyBudget.maxEdgeCount')
  }

  const forbiddenById = new Map((Array.isArray(forbiddenImports) ? forbiddenImports : []).map((rule) => [rule?.id, rule]))
  const domainCategoryById = new Map((Array.isArray(domains) ? domains : []).map((domain) => [domain?.id, domain?.category]))
  const pilots = Array.isArray(policy.directionalImportPilots) ? policy.directionalImportPilots : []
  if (pilots.length === 0) fail('growthPolicy.directionalImportPilots must be a non-empty array')
  for (const [index, pilot] of pilots.entries()) {
    const prefix = `growthPolicy.directionalImportPilots[${index}]`
    if (!pilot || typeof pilot !== 'object' || Array.isArray(pilot)) {
      fail(`${prefix} must be an object`)
      continue
    }
    for (const field of ['id', 'ownerCategory', 'ruleId', 'rationale']) {
      if (typeof pilot[field] !== 'string' || pilot[field].trim().length === 0) fail(`${prefix}.${field} is required`)
    }
    if (!categoryById.has(pilot.ownerCategory)) fail(`${prefix}.ownerCategory must reference growthPolicy.ownerCategories`)
    if (!Array.isArray(pilot.blockedOwnerCategories) || pilot.blockedOwnerCategories.length === 0) {
      fail(`${prefix}.blockedOwnerCategories must be a non-empty array`)
    } else {
      for (const blockedCategory of pilot.blockedOwnerCategories) {
        if (!categoryById.has(blockedCategory)) fail(`${prefix}.blockedOwnerCategories contains unknown category ${blockedCategory}`)
      }
    }
    const rule = forbiddenById.get(pilot.ruleId)
    if (!rule) fail(`${prefix}.ruleId must reference a forbiddenImports rule`)
    else if (domainCategoryById.get(rule.owner) !== pilot.ownerCategory) {
      fail(`${prefix}.ownerCategory must match forbiddenImports rule owner category`)
    }
    report.directionalImportPilots.push({
      id: pilot.id,
      ownerCategory: pilot.ownerCategory,
      ruleId: pilot.ruleId,
      blockedOwnerCategories: Array.isArray(pilot.blockedOwnerCategories) ? [...pilot.blockedOwnerCategories] : [],
    })
  }

  report.status = failures.length === failureCountBefore ? 'pass' : 'fail'
  return report
}

function addGrowthDelta(summary, increase) {
  const bucket = increase.growthKind === 'runtime'
    ? summary.runtimeRisk
    : ['docs', 'validation'].includes(increase.growthKind)
      ? summary.docsOrValidation
      : summary.evidenceOnly
  if (increase.metric === 'module_count') bucket.moduleDelta += increase.delta
  if (increase.metric === 'edge_count') bucket.edgeDelta += increase.delta
}

function validateForbiddenImports(rules, edges) {
  if (!Array.isArray(rules) || rules.length === 0) {
    fail('forbiddenImports must be a non-empty array')
    return []
  }
  const violations = []
  const modules = [...moduleSet]
  for (const [index, rule] of rules.entries()) {
    const prefix = `forbiddenImports[${index}]`
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      fail(`${prefix} must be an object`)
      continue
    }
    for (const field of ['id', 'owner', 'reason', 'reviewCondition']) {
      if (typeof rule[field] !== 'string' || rule[field].length === 0) fail(`${prefix}.${field} is required`)
    }
    const fromMatchers = compileMatchers(rule.from, `${prefix}.from`)
    const blockedMatchers = compileMatchers(rule.blocked, `${prefix}.blocked`)
    const exceptionMatchers = compileExceptions(rule.exceptions, `${prefix}.exceptions`)
    if (fromMatchers.length === 0 || blockedMatchers.length === 0) continue

    const matchedSources = modules.filter((id) => fromMatchers.some((matcher) => matcher(id)))
    if (matchedSources.length === 0) fail(`${prefix}.from does not match any source module`)

    for (const edge of edges) {
      if (!fromMatchers.some((matcher) => matcher(edge.from))) continue
      if (!blockedMatchers.some((matcher) => matcher(edge.to))) continue
      if (exceptionMatchers.some((matcher) => matcher(edge))) continue
      violations.push({ ruleId: rule.id || `${prefix}`, from: edge.from, to: edge.to, reason: rule.reason })
    }
  }
  return violations.sort((a, b) => `${a.ruleId}:${a.from}:${a.to}`.localeCompare(`${b.ruleId}:${b.from}:${b.to}`))
}

function compileMatchers(patterns, field) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    fail(`${field} must be a non-empty array`)
    return []
  }
  return patterns
    .filter((pattern) => {
      const ok = typeof pattern === 'string' && pattern.length > 0
      if (!ok) fail(`${field} contains a non-string pattern`)
      return ok
    })
    .map((pattern) => {
      const regex = globToRegex(pattern)
      return (value) => regex.test(value)
    })
}

function compileExceptions(exceptions, field) {
  if (!Array.isArray(exceptions)) {
    fail(`${field} must be an array`)
    return []
  }
  return exceptions.map((exception, index) => {
    const prefix = `${field}[${index}]`
    if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
      fail(`${prefix} must be an object`)
      return () => false
    }
    if (typeof exception.owner !== 'string' || exception.owner.length === 0) fail(`${prefix}.owner is required`)
    if (typeof exception.reason !== 'string' || exception.reason.length === 0) fail(`${prefix}.reason is required`)
    if (typeof exception.reviewCondition !== 'string' || exception.reviewCondition.length === 0) fail(`${prefix}.reviewCondition is required`)
    const fromMatchers = compileMatchers(exception.from || ['**'], `${prefix}.from`)
    const toMatchers = compileMatchers(exception.to || ['**'], `${prefix}.to`)
    return (edge) => fromMatchers.some((matcher) => matcher(edge.from)) && toMatchers.some((matcher) => matcher(edge.to))
  })
}

function listTypeScriptFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(full))
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) files.push(full)
  }
  return files
}

function relativeSpecifiers(text) {
  const specifiers = new Set()
  const sourceFile = ts.createSourceFile('module-boundary.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  visit(sourceFile)
  return [...specifiers]

  function addModuleSpecifier(node) {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith('.')) specifiers.add(node.text)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      // Type-only imports (`import type ...`) are erased at compile time and create
      // no runtime edge, so they must not count as module-boundary graph edges.
      if (!node.importClause?.isTypeOnly) addModuleSpecifier(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node)) {
      // Likewise `export type { ... } from ...` re-exports carry no runtime coupling.
      if (!node.isTypeOnly) addModuleSpecifier(node.moduleSpecifier)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) addModuleSpecifier(node.arguments[0])
    ts.forEachChild(node, visit)
  }
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = []
  if (/\.(js|mjs|cjs)$/.test(base)) {
    candidates.push(base.replace(/\.(js|mjs|cjs)$/, '.ts'))
    candidates.push(base.replace(/\.(js|mjs|cjs)$/, '.tsx'))
  }
  candidates.push(base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx'))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return relativeId(candidate)
  }
  return undefined
}

function relativeId(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function cycleKey(cycle) {
  return [...cycle].sort().join('|')
}

function stronglyConnectedComponents(input) {
  let index = 0
  const stack = []
  const onStack = new Set()
  const indexes = new Map()
  const lowLinks = new Map()
  const components = []

  for (const id of input.keys()) {
    if (!indexes.has(id)) visit(id)
  }
  return components

  function visit(id) {
    indexes.set(id, index)
    lowLinks.set(id, index)
    index += 1
    stack.push(id)
    onStack.add(id)

    for (const dependency of input.get(id) || []) {
      if (!indexes.has(dependency)) {
        visit(dependency)
        lowLinks.set(id, Math.min(lowLinks.get(id), lowLinks.get(dependency)))
      } else if (onStack.has(dependency)) {
        lowLinks.set(id, Math.min(lowLinks.get(id), indexes.get(dependency)))
      }
    }

    if (lowLinks.get(id) === indexes.get(id)) {
      const component = []
      let current
      do {
        current = stack.pop()
        onStack.delete(current)
        component.push(current)
      } while (current !== id)
      components.push(component)
    }
  }
}

function globToRegex(pattern) {
  let output = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        output += '.*'
        i += 1
      } else {
        output += '[^/]*'
      }
    } else {
      output += escapeRegex(char)
    }
  }
  output += '$'
  return new RegExp(output)
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}
