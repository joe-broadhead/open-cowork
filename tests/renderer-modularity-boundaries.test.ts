import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  SCAN_ROOTS,
  buildGraph,
  findCyclicComponents,
  extractCyclePath,
} from '../scripts/check-import-cycles.mjs'

const root = process.cwd()
const appRoot = join(root, 'packages/app/src')
const frontendDoc = readFileSync(join(root, 'docs/frontend-architecture.md'), 'utf8')

// General per-file budget for the renderer. Files above this are decomposition
// backlogs and MUST carry an explicit, documented budget below so they cannot
// silently keep growing. Lower a budget (never raise it) whenever a file shrinks.
const GENERAL_LINE_BUDGET = 900
const documentedLargeFileBudgets = new Map([
  // browser/cowork-api.ts — the browser cloud API facade. Backlog: split by
  // domain (sessions/threads/artifacts/workflows) to mirror cloud-client domains.
  ['packages/app/src/browser/cowork-api.ts', 1_446],
  // components/HomePage.tsx — the launchpad shell. Backlog: extract feed,
  // quick-actions, and hero sections into feature components.
  // Backlog: HomeComposer still lives inline here. #920 extracted the shared composer menu/dismiss
  // hooks (lowering this below the pre-#918 budget); further extraction of the inline HomeComposer
  // will lower it more. See docs/frontend-architecture.md.
  ['packages/app/src/components/HomePage.tsx', 1_190],
  // components/layout/Sidebar.tsx — the primary nav shell. Backlog: extract the
  // per-section nav groups into dedicated components. Grew by the RBAC-gated Admin
  // control-plane nav entry (#896); still a decomposition backlog.
  ['packages/app/src/components/layout/Sidebar.tsx', 960],
])

function productionSourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'dist' || entry === 'dist-browser' || entry === 'node_modules' || entry === 'coverage') continue
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...productionSourceFiles(path))
    } else if (
      (path.endsWith('.ts') || path.endsWith('.tsx'))
      && !path.endsWith('.d.ts')
      && !path.endsWith('.test.ts')
      && !path.endsWith('.test.tsx')
    ) {
      files.push(path)
    }
  }
  return files
}

test('renderer source files stay within their documented size budgets', () => {
  for (const file of productionSourceFiles(appRoot)) {
    const relativePath = relative(root, file)
    const lineCount = readFileSync(file, 'utf8').split('\n').length
    const budget = documentedLargeFileBudgets.get(relativePath) ?? GENERAL_LINE_BUDGET
    assert.ok(
      lineCount <= budget,
      `${relativePath} has ${lineCount} lines and exceeds its budget of ${budget}. `
      + 'Decompose it, or (only for a documented backlog) raise its entry in '
      + 'tests/renderer-modularity-boundaries.test.ts and note it in docs/frontend-architecture.md.',
    )
  }
})

test('renderer large-file exceptions are documented in the architecture doc', () => {
  for (const relativePath of documentedLargeFileBudgets.keys()) {
    const fileName = relativePath.split('/').at(-1)!
    assert.match(
      frontendDoc,
      new RegExp(fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${relativePath} is a documented large-file exception but is not referenced in docs/frontend-architecture.md`,
    )
  }
})

test('renderer and UI kit have no circular import chains', () => {
  const graph = buildGraph()
  const components = findCyclicComponents(graph)
  const rendered = components.map((component) => extractCyclePath(component, graph).map((f) => relative(root, f)).join(' -> '))
  assert.deepEqual(
    rendered,
    [],
    `Circular import chains found in ${SCAN_ROOTS.join(', ')}. Run \`node scripts/check-import-cycles.mjs\` for details.`,
  )
})

test('import-cycle detector actually catches a cycle (self-check)', () => {
  // A -> B -> C -> A plus an acyclic branch D -> A. Guards against a gate that
  // silently passes because its detection is broken.
  const graph = new Map<string, Set<string>>([
    ['A', new Set(['B'])],
    ['B', new Set(['C'])],
    ['C', new Set(['A'])],
    ['D', new Set(['A'])],
  ])
  const components = findCyclicComponents(graph)
  assert.equal(components.length, 1, 'exactly one strongly connected cyclic component expected')
  assert.deepEqual([...components[0]!].sort(), ['A', 'B', 'C'])

  const path = extractCyclePath(components[0]!, graph)
  assert.equal(path[0], path.at(-1), 'reported cycle path must be closed (start === end)')
  assert.equal(path.length, 4, 'A -> B -> C -> A')

  // A self-loop is also a cycle.
  const selfLoop = new Map<string, Set<string>>([['X', new Set(['X'])]])
  assert.equal(findCyclicComponents(selfLoop).length, 1)

  // A purely acyclic graph reports nothing.
  const acyclic = new Map<string, Set<string>>([
    ['A', new Set(['B'])],
    ['B', new Set(['C'])],
    ['C', new Set<string>()],
  ])
  assert.deepEqual(findCyclicComponents(acyclic), [])
})
