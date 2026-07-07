// Import-cycle gate for the renderer (and the shared UI kit).
//
// Statically scans first-party *relative* imports inside the configured roots
// and fails if any circular import chain exists. Circular module graphs are a
// top source of fragile initialization order, hard-to-tree-shake bundles, and
// "cannot access X before initialization" runtime crashes, so we keep the count
// pinned at zero.
//
// Scope / ratchet-up plan:
//   - Roots are listed in SCAN_ROOTS below. They are enforced at zero cycles.
//   - Only value imports are considered; `import type` / `export type` are
//     erased by the compiler and cannot form a runtime cycle, so they are
//     ignored to avoid false positives.
//   - Cross-package imports (`@open-cowork/*`, bare npm specifiers) are ignored;
//     this gate is about *intra-package* cycles. Package layering is enforced
//     separately by the cloud/gateway boundary tests.
//   - To widen coverage, add a directory to SCAN_ROOTS once it is already clean.
//
// No external dependency: this is a small regex-based module resolver. It is
// intentionally conservative — if a specifier cannot be resolved to a file on
// disk it is skipped rather than guessed, which keeps false positives out.
//
// Usage: `node scripts/check-import-cycles.mjs` (wired into `pnpm lint`).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.cwd()

export const SCAN_ROOTS = [
  'packages/app/src',
  'packages/ui/src',
]

const SOURCE_EXTENSIONS = ['.ts', '.tsx']
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'dist-browser', 'coverage'])

function isSourceFile(path) {
  if (path.endsWith('.d.ts')) return false
  if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) return false
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))
}

function collectSourceFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, out)
      continue
    }
    if (entry.isFile() && isSourceFile(fullPath)) out.push(fullPath)
  }
  return out
}

// Matches `... from '<spec>'` (import/export) and dynamic `import('<spec>')`.
// The leading `type` on `import type` / `export type` is captured so those
// statements can be skipped.
const FROM_PATTERN = /(?:import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function extractRelativeSpecifiers(source) {
  const specifiers = []
  for (const match of source.matchAll(FROM_PATTERN)) {
    if (match[1]) continue // `import type` / `export type`: erased, no runtime edge
    specifiers.push(match[2])
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT_PATTERN)) {
    specifiers.push(match[1])
  }
  return specifiers.filter((spec) => spec.startsWith('.'))
}

function fileExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function dirExists(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// Resolve a relative specifier from `fromFile` to a concrete source file on disk,
// mirroring the bundler moduleResolution used by the renderer. Returns null when
// the target is not a first-party source file we track (e.g. an asset or a `.js`
// with no matching `.ts`).
function resolveSpecifier(fromFile, spec) {
  // Drop a trailing extension so `foo.js` / `foo.ts` both map to the source file.
  const base = resolve(dirname(fromFile), spec)
  const withoutExt = base.replace(/\.(ts|tsx|js|jsx)$/, '')

  if (isSourceFile(base) && fileExists(base)) return base
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${withoutExt}${ext}`
    if (isSourceFile(candidate) && fileExists(candidate)) return candidate
  }
  if (dirExists(withoutExt)) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = join(withoutExt, `index${ext}`)
      if (isSourceFile(candidate) && fileExists(candidate)) return candidate
    }
  }
  return null
}

export function buildGraph() {
  const files = []
  for (const scanRoot of SCAN_ROOTS) {
    const absRoot = join(root, scanRoot)
    if (dirExists(absRoot)) collectSourceFiles(absRoot, files)
  }
  const inGraph = new Set(files)
  const graph = new Map()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const edges = new Set()
    for (const spec of extractRelativeSpecifiers(source)) {
      const target = resolveSpecifier(file, spec)
      if (target && inGraph.has(target) && target !== file) edges.add(target)
    }
    graph.set(file, edges)
  }
  return graph
}

// Tarjan's strongly-connected-components: any SCC with more than one node (or a
// self-loop) contains at least one cycle.
export function findCyclicComponents(graph) {
  let index = 0
  const indices = new Map()
  const lowlink = new Map()
  const onStack = new Set()
  const stack = []
  const components = []

  const nodes = [...graph.keys()]
  const stronglyConnect = (start) => {
    // Iterative DFS to avoid stack overflow on large graphs.
    const work = [{ node: start, edgeIndex: 0 }]
    indices.set(start, index)
    lowlink.set(start, index)
    index += 1
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      const successors = [...graph.get(frame.node)]
      if (frame.edgeIndex < successors.length) {
        const next = successors[frame.edgeIndex]
        frame.edgeIndex += 1
        if (!indices.has(next)) {
          indices.set(next, index)
          lowlink.set(next, index)
          index += 1
          stack.push(next)
          onStack.add(next)
          work.push({ node: next, edgeIndex: 0 })
        } else if (onStack.has(next)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node), indices.get(next)))
        }
        continue
      }
      if (lowlink.get(frame.node) === indices.get(frame.node)) {
        const component = []
        let member
        do {
          member = stack.pop()
          onStack.delete(member)
          component.push(member)
        } while (member !== frame.node)
        if (component.length > 1 || graph.get(frame.node).has(frame.node)) {
          components.push(component)
        }
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].node
        lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(frame.node)))
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) stronglyConnect(node)
  }
  return components
}

// Reconstruct a concrete cycle path within a strongly-connected component so the
// error message is actionable (A -> B -> C -> A).
export function extractCyclePath(component, graph) {
  const members = new Set(component)
  const start = component[0]
  const parent = new Map()
  const stack = [start]
  const visited = new Set([start])
  while (stack.length > 0) {
    const node = stack.pop()
    for (const next of graph.get(node)) {
      if (!members.has(next)) continue
      if (next === start) {
        const path = [node]
        let cursor = node
        while (cursor !== start) {
          cursor = parent.get(cursor)
          path.push(cursor)
        }
        path.reverse()
        path.push(start)
        return path
      }
      if (!visited.has(next)) {
        visited.add(next)
        parent.set(next, node)
        stack.push(next)
      }
    }
  }
  // Fallback: component members with an implied closing edge.
  return [...component, component[0]]
}

export function runCheck() {
  const graph = buildGraph()
  const components = findCyclicComponents(graph)

  if (components.length > 0) {
    const details = components
      .map((component, i) => {
        const path = extractCyclePath(component, graph).map((file) => relative(root, file))
        return `  Cycle ${i + 1} (${component.length} modules):\n    ${path.join('\n      -> ')}`
      })
      .join('\n\n')
    console.error(
      `Import-cycle check failed: ${components.length} circular import chain(s) found `
      + `in ${SCAN_ROOTS.join(', ')}.\n\n${details}\n\n`
      + 'Break the cycle by extracting the shared code into a lower-level module '
      + 'or by using `import type` where only types are needed.',
    )
    return 1
  }

  process.stdout.write(`Import-cycle check passed: 0 cycles across ${graph.size} modules in ${SCAN_ROOTS.join(', ')}\n`)
  return 0
}

// Only run the check when invoked directly, so tests can import the pure
// graph-analysis helpers without triggering a filesystem scan or process.exit.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCheck())
}
