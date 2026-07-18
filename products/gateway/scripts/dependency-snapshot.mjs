#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const args = new Set(process.argv.slice(2))
const includeTests = args.has('--include-tests')
const asJson = args.has('--json')
const root = process.cwd()
const sourceRoot = path.join(root, 'src')

if (!fs.existsSync(sourceRoot)) {
  console.error('dependency-snapshot: expected src/ at the current working directory')
  process.exit(1)
}

const toPosix = (file) => file.split(path.sep).join('/')
const relativeId = (file) => toPosix(path.relative(root, file))

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

const files = listTypeScriptFiles(sourceRoot)
  .filter((file) => includeTests || !file.includes(`${path.sep}__tests__${path.sep}`))
  .sort((a, b) => relativeId(a).localeCompare(relativeId(b)))

const moduleSet = new Set(files.map(relativeId))
const graph = new Map(files.map((file) => [relativeId(file), new Set()]))
const unresolved = []

for (const file of files) {
  const id = relativeId(file)
  const text = fs.readFileSync(file, 'utf8')
  for (const specifier of relativeSpecifiers(text)) {
    const resolved = resolveRelativeImport(file, specifier)
    if (resolved && moduleSet.has(resolved)) graph.get(id).add(resolved)
    else if (specifier.startsWith('.')) unresolved.push({ from: id, specifier })
  }
}

const incoming = new Map([...graph.keys()].map((id) => [id, 0]))
let edgeCount = 0
for (const dependencies of graph.values()) {
  for (const dependency of dependencies) {
    edgeCount += 1
    incoming.set(dependency, (incoming.get(dependency) || 0) + 1)
  }
}

const cycles = stronglyConnectedComponents(graph)
  .filter((component) => component.length > 1 || [...(graph.get(component[0]) || [])].includes(component[0]))
  .map((component) => component.sort())
  .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))

const modules = [...graph.keys()]
const highFanOut = modules
  .map((id) => ({ id, count: graph.get(id).size }))
  .filter((entry) => entry.count > 0)
  .sort(sortByCountThenId)
  .slice(0, 12)
const highFanIn = modules
  .map((id) => ({ id, count: incoming.get(id) || 0 }))
  .filter((entry) => entry.count > 0)
  .sort(sortByCountThenId)
  .slice(0, 12)
const isolatedModules = modules
  .filter((id) => graph.get(id).size === 0 && (incoming.get(id) || 0) === 0)
  .sort()

const snapshot = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceRoot: 'src',
  includeTests,
  moduleCount: modules.length,
  edgeCount,
  cycleBudget: {
    status: cycles.length === 0 ? 'acyclic' : 'cycles_present',
    stronglyConnectedComponentCount: cycles.length,
    maxComponentSize: cycles[0]?.length || 0,
  },
  cycles,
  highFanOut,
  highFanIn,
  isolatedModules,
  unresolvedRelativeImports: unresolved.sort((a, b) => `${a.from}:${a.specifier}`.localeCompare(`${b.from}:${b.specifier}`)),
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
} else {
  console.log(`Dependency snapshot: ${snapshot.moduleCount} module(s), ${snapshot.edgeCount} edge(s)`)
  console.log(`Cycle budget: ${snapshot.cycleBudget.status} (${snapshot.cycleBudget.stronglyConnectedComponentCount} component(s))`)
  console.log(`High fan-out: ${snapshot.highFanOut.map((entry) => `${entry.id}:${entry.count}`).join(', ') || 'none'}`)
  console.log(`High fan-in: ${snapshot.highFanIn.map((entry) => `${entry.id}:${entry.count}`).join(', ') || 'none'}`)
  if (snapshot.unresolvedRelativeImports.length) console.log(`Unresolved relative imports: ${snapshot.unresolvedRelativeImports.length}`)
}

function relativeSpecifiers(text) {
  const specifiers = new Set()
  const sourceFile = ts.createSourceFile('dependency-snapshot.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  visit(sourceFile)
  return [...specifiers]

  function addModuleSpecifier(node) {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith('.')) specifiers.add(node.text)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addModuleSpecifier(node.moduleSpecifier)
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

function sortByCountThenId(a, b) {
  return b.count - a.count || a.id.localeCompare(b.id)
}
