import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NODE_SOURCE_INVENTORY = {
  minimumPercent: 90,
  roots: [
    { path: 'apps/desktop/src/main', extensions: ['.ts', '.tsx'] },
    { path: 'apps/desktop/src/lib', extensions: ['.ts', '.tsx'] },
    { path: 'packages/shared/dist', extensions: ['.js', '.mjs'] },
    // The two most security-critical server packages (auth resolvers, secret adapter,
    // permission config, runtime boundary). node:test lcov only lists loaded files, so
    // a new untested module in either would otherwise be invisible to every ratchet.
    // runtime-host is consumed as built dist; cloud-server is loaded from src via
    // --experimental-strip-types. The remaining gap is type-only control-plane
    // record/input/enum/schema modules that carry no executable coverage.
    { path: 'packages/runtime-host/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/cloud-server/src', extensions: ['.ts', '.tsx'] },
  ],
}

const SHARED_SOURCE_INVENTORY = {
  minimumPercent: 90,
  roots: [
    { path: 'packages/shared/dist', extensions: ['.js', '.mjs'] },
  ],
}

const WORKSPACE_SOURCE_INVENTORY = {
  minimumPercent: 90,
  roots: [
    { path: 'apps/gateway/dist', extensions: ['.js', '.mjs'] },
    // Keep library modules in the ratchet; exclude the executable entrypoint
    // and type-only output that cannot be meaningfully imported in Node tests.
    { path: 'apps/standalone-gateway/dist', extensions: ['.js', '.mjs'], excludeFileNames: ['main.js', 'types.js'] },
    { path: 'mcps/agents/dist', extensions: ['.js', '.mjs'] },
    { path: 'mcps/charts/dist', extensions: ['.js', '.mjs'] },
    { path: 'mcps/clock/dist', extensions: ['.js', '.mjs'] },
    { path: 'mcps/knowledge/dist', extensions: ['.js', '.mjs'] },
    { path: 'mcps/semantic-ui/dist', extensions: ['.js', '.mjs'] },
    { path: 'mcps/skills/dist', extensions: ['.js', '.mjs'] },
    { path: 'mcps/workflows/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-channel/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-cli/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-discord/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-email/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-signal/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-slack/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-telegram/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-webhook/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-provider-whatsapp/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/gateway-testing/dist', extensions: ['.js', '.mjs'] },
    { path: 'packages/cloud-client/src', extensions: ['.ts'] },
  ],
}

export const NODE_COVERAGE_INPUT = {
  name: 'Node',
  path: 'coverage/node/lcov.info',
  sourceInventory: NODE_SOURCE_INVENTORY,
  thresholds: { lines: 80, functions: 74, branches: 68 },
}
export const SHARED_COVERAGE_INPUT = {
  name: 'Shared Package',
  path: 'coverage/node/lcov.info',
  includePathPrefixes: ['packages/shared/'],
  sourceInventory: SHARED_SOURCE_INVENTORY,
  // Adjusted down after code was redistributed INTO @open-cowork/shared (vega-spec,
  // chart-spec-safety, shared SDK-payload reader helpers). That code is exercised
  // by the renderer/desktop suites, but this metric measures only the NODE lcov, so
  // its functions read as uncovered here. Follow-up: backfill node-side unit tests.
  thresholds: { lines: 88, functions: 84, branches: 75 },
}
export const WORKSPACE_NODE_COVERAGE_INPUT = {
  name: 'Workspace Node',
  path: 'coverage/workspace/lcov.info',
  includePathPrefixes: [
    'apps/gateway/dist/',
    'apps/standalone-gateway/dist/',
    'mcps/agents/dist/',
    'mcps/charts/dist/',
    'mcps/clock/dist/',
    'mcps/knowledge/dist/',
    'mcps/semantic-ui/dist/',
    'mcps/skills/dist/',
    'mcps/workflows/dist/',
    'packages/gateway-channel/dist/',
    'packages/gateway-provider-cli/dist/',
    'packages/gateway-provider-discord/dist/',
    'packages/gateway-provider-email/dist/',
    'packages/gateway-provider-signal/dist/',
    'packages/gateway-provider-slack/dist/',
    'packages/gateway-provider-telegram/dist/',
    'packages/gateway-provider-webhook/dist/',
    'packages/gateway-provider-whatsapp/dist/',
    'packages/gateway-testing/dist/',
    'packages/cloud-client/src/',
  ],
  sourceInventory: WORKSPACE_SOURCE_INVENTORY,
  // This is a COMBINED floor across every shipped workspace package. Subprocess
  // V8 coverage is merged into this LCOV for the standalone-gateway CLI and MCP
  // handlers before this summary runs, but the bundled MCP dist files are still
  // large enough to dominate the aggregate. The package-specific ratchets below
  // are the authoritative floors for those shipped surfaces.
  thresholds: { lines: 38, functions: 27, branches: 67 },
}
// Dedicated ratchet for the internet-facing gateway delivery path (webhook ingress auth,
// SMTP client, delivery retry/dedupe, dispatcher fairness). The combined workspace floor
// above cannot enforce this path on its own, so pin it directly just under measured
// coverage so a regression in the gateway relay trips the gate.
export const GATEWAY_COVERAGE_INPUT = {
  name: 'Gateway',
  path: 'coverage/workspace/lcov.info',
  includePathPrefixes: ['apps/gateway/dist/'],
  thresholds: { lines: 90, functions: 88, branches: 72 },
}
export const STANDALONE_GATEWAY_COVERAGE_INPUT = {
  name: 'Standalone Gateway',
  path: 'coverage/workspace/lcov.info',
  includePathPrefixes: ['apps/standalone-gateway/dist/'],
  sourceInventory: {
    minimumPercent: 95,
    roots: [
      { path: 'apps/standalone-gateway/dist', extensions: ['.js', '.mjs'], excludeFileNames: ['main.js', 'types.js'] },
    ],
  },
  thresholds: { lines: 82, functions: 80, branches: 78 },
}
// KNOWN LIMITATION (test-infra follow-up required): these thresholds run over
// mcps/*/dist, NOT mcps/*/src, and are near-meaningless as a regression signal for
// handler code. Each MCP is a stdio server: `mcps/*/tests/contract.test.ts` spawns
// the built `dist/index.js` as a subprocess (StdioClientTransport) rather than
// importing handlers in-process, and coverage is collected via NODE_V8_COVERAGE over
// that subprocess (see scripts/run-workspace-node-tests.mjs +
// scripts/subprocess-v8-coverage.mjs). `mcps/build.mjs` bundles with esbuild
// `bundle: true` and NO sourcemap, so every dist/index.js is a single ~31k-line file
// with @modelcontextprotocol/sdk + zod inlined (e.g. knowledge: 81 src lines ->
// 31,099 dist lines). The V8 merge maps offsets straight onto those dist lines with
// no source map, so the SDK/vendor code dominates the denominator and a handler's
// actual src (~70-1500 lines) barely moves the ratio: untested new handler code
// cannot trip a lines:35/functions:25 floor. The sourceInventory below only proves
// each bundle is loaded at least once, not that any handler branch is exercised.
// Measuring src coverage is NOT feasible without a larger test-infra change -- either
// (a) emit esbuild sourcemaps AND teach mergeSubprocessV8Coverage to remap dist
// offsets back to src files, or (b) refactor the contract suites to import handler
// modules from src in-process (strip-types) instead of spawning the bundle. Until one
// of those lands, do NOT trust these numbers; keep the dist thresholds only as a
// "did the server boot" smoke floor.
export const MCP_HANDLER_COVERAGE_INPUT = {
  name: 'MCP Handlers',
  path: 'coverage/workspace/lcov.info',
  includePathPrefixes: [
    'mcps/agents/dist/',
    'mcps/charts/dist/',
    'mcps/clock/dist/',
    'mcps/knowledge/dist/',
    'mcps/semantic-ui/dist/',
    'mcps/skills/dist/',
    'mcps/workflows/dist/',
  ],
  sourceInventory: {
    minimumPercent: 100,
    roots: [
      { path: 'mcps/agents/dist', extensions: ['.js', '.mjs'] },
      { path: 'mcps/charts/dist', extensions: ['.js', '.mjs'] },
      { path: 'mcps/clock/dist', extensions: ['.js', '.mjs'] },
      { path: 'mcps/knowledge/dist', extensions: ['.js', '.mjs'] },
      { path: 'mcps/semantic-ui/dist', extensions: ['.js', '.mjs'] },
      { path: 'mcps/skills/dist', extensions: ['.js', '.mjs'] },
      { path: 'mcps/workflows/dist', extensions: ['.js', '.mjs'] },
    ],
  },
  // Dist-bundle thresholds: a boot/smoke floor only. See the KNOWN LIMITATION note
  // above -- these do not enforce handler src coverage.
  thresholds: { lines: 35, functions: 25, branches: 67 },
}
export const GATEWAY_PROVIDER_COVERAGE_INPUT = {
  name: 'Gateway Providers',
  path: 'coverage/workspace/lcov.info',
  includePathPrefixes: [
    'packages/gateway-channel/dist/',
    'packages/gateway-provider-cli/dist/',
    'packages/gateway-provider-discord/dist/',
    'packages/gateway-provider-email/dist/',
    'packages/gateway-provider-signal/dist/',
    'packages/gateway-provider-slack/dist/',
    'packages/gateway-provider-telegram/dist/',
    'packages/gateway-provider-webhook/dist/',
    'packages/gateway-provider-whatsapp/dist/',
    'packages/gateway-testing/dist/',
  ],
  sourceInventory: {
    minimumPercent: 95,
    roots: [
      { path: 'packages/gateway-channel/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-cli/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-discord/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-email/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-signal/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-slack/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-telegram/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-webhook/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-provider-whatsapp/dist', extensions: ['.js', '.mjs'] },
      { path: 'packages/gateway-testing/dist', extensions: ['.js', '.mjs'] },
    ],
  },
  thresholds: { lines: 85, functions: 87, branches: 69 },
}
export const CLOUD_CLIENT_COVERAGE_INPUT = {
  name: 'Cloud Client',
  path: 'coverage/workspace/lcov.info',
  includePathPrefixes: ['packages/cloud-client/src/'],
  sourceInventory: {
    minimumPercent: 100,
    roots: [
      // `index.ts` is a pure barrel and `contracts.ts` is intentionally
      // type-only: neither emits meaningful runtime coverage, so keep the
      // executable cloud-client surface at 100% inventory instead.
      { path: 'packages/cloud-client/src', extensions: ['.ts'], excludeFileNames: ['contracts.ts', 'index.ts'] },
    ],
  },
  thresholds: { lines: 70, functions: 32, branches: 72 }, // JOE-867 ratchet
}
export const RENDERER_COVERAGE_INPUT = { name: 'Renderer', path: 'coverage/renderer/lcov.info', thresholds: { lines: 65, functions: 62, branches: 58 } }
export const NODE_ONLY_INPUTS = [
  NODE_COVERAGE_INPUT,
  SHARED_COVERAGE_INPUT,
  WORKSPACE_NODE_COVERAGE_INPUT,
  GATEWAY_COVERAGE_INPUT,
  STANDALONE_GATEWAY_COVERAGE_INPUT,
  MCP_HANDLER_COVERAGE_INPUT,
  GATEWAY_PROVIDER_COVERAGE_INPUT,
  CLOUD_CLIENT_COVERAGE_INPUT,
]
export const DEFAULT_INPUTS = [
  ...NODE_ONLY_INPUTS,
  RENDERER_COVERAGE_INPUT,
]

function normalizeCoveragePath(path, includePathPrefixes = []) {
  const normalized = path.replace(/\\/g, '/')
  const cwdPrefix = `${process.cwd().replace(/\\/g, '/')}/`
  const repoRelative = normalized.startsWith(cwdPrefix)
    ? normalized.slice(cwdPrefix.length)
    : normalized
  for (const prefix of includePathPrefixes) {
    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '')
    if (repoRelative.startsWith(normalizedPrefix)) return repoRelative
    const prefixIndex = repoRelative.indexOf(`/${normalizedPrefix}`)
    if (prefixIndex >= 0) return repoRelative.slice(prefixIndex + 1)
  }
  return repoRelative
}

export function parseLcovInfo(content, options = {}) {
  const files = new Map()
  const includePathPrefixes = options.includePathPrefixes || []

  function shouldIncludeFile(path) {
    return includePathPrefixes.length === 0 || includePathPrefixes.some((prefix) => path.startsWith(prefix))
  }

  function currentFile(path) {
    if (!files.has(path)) {
      files.set(path, {
        lines: new Map(),
        functions: new Map(),
        branches: new Map(),
      })
    }
    return files.get(path)
  }

  let file = null
  let recordFunctionKeysByName = new Map()
  let recordFunctionHitIndexByName = new Map()
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine) continue
    const separator = rawLine.indexOf(':')
    if (separator < 0) continue
    const key = rawLine.slice(0, separator)
    const value = rawLine.slice(separator + 1)

    if (key === 'SF') {
      const sourcePath = normalizeCoveragePath(value, includePathPrefixes)
      if (!shouldIncludeFile(sourcePath)) {
        file = null
        recordFunctionKeysByName = new Map()
        recordFunctionHitIndexByName = new Map()
        continue
      }
      file = currentFile(sourcePath)
      recordFunctionKeysByName = new Map()
      recordFunctionHitIndexByName = new Map()
      continue
    }
    if (!file) continue

    if (key === 'DA') {
      const [line, hits] = value.split(',')
      const lineNumber = Number(line)
      const hitCount = Number(hits)
      if (Number.isFinite(lineNumber) && Number.isFinite(hitCount)) {
        file.lines.set(lineNumber, Math.max(file.lines.get(lineNumber) || 0, hitCount))
      }
      continue
    }

    if (key === 'FN') {
      const [line, ...nameParts] = value.split(',')
      const name = nameParts.join(',')
      const functionKey = `${line}:${name}`
      if (name) {
        file.functions.set(functionKey, file.functions.get(functionKey) || 0)
        if (!recordFunctionKeysByName.has(name)) recordFunctionKeysByName.set(name, [])
        recordFunctionKeysByName.get(name).push(functionKey)
      }
      continue
    }

    if (key === 'FNDA') {
      const [hits, ...nameParts] = value.split(',')
      const name = nameParts.join(',')
      const hitCount = Number(hits)
      const functionKeys = recordFunctionKeysByName.get(name) || []
      const hitIndex = recordFunctionHitIndexByName.get(name) || 0
      const matchingKey = functionKeys[hitIndex] || name
      if (name && Number.isFinite(hitCount)) {
        file.functions.set(matchingKey, Math.max(file.functions.get(matchingKey) || 0, hitCount))
        recordFunctionHitIndexByName.set(name, hitIndex + 1)
      }
      continue
    }

    if (key === 'BRDA') {
      const [line, block, branch, hits] = value.split(',')
      const branchKey = `${line}:${block}:${branch}`
      const hitCount = hits === '-' ? 0 : Number(hits)
      if (Number.isFinite(hitCount)) {
        file.branches.set(branchKey, Math.max(file.branches.get(branchKey) || 0, hitCount))
      }
    }
  }

  const totals = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    files: files.size,
  }

  for (const fileCoverage of files.values()) {
    totals.lines.total += fileCoverage.lines.size
    totals.functions.total += fileCoverage.functions.size
    totals.branches.total += fileCoverage.branches.size
    for (const hits of fileCoverage.lines.values()) {
      if (hits > 0) totals.lines.covered += 1
    }
    for (const hits of fileCoverage.functions.values()) {
      if (hits > 0) totals.functions.covered += 1
    }
    for (const hits of fileCoverage.branches.values()) {
      if (hits > 0) totals.branches.covered += 1
    }
  }

  return totals
}

export function parseLcovFilePaths(content, options = {}) {
  const files = new Set()
  const includePathPrefixes = options.includePathPrefixes || []

  function shouldIncludeFile(path) {
    return includePathPrefixes.length === 0 || includePathPrefixes.some((prefix) => path.startsWith(prefix))
  }

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.startsWith('SF:')) continue
    const sourcePath = normalizeCoveragePath(rawLine.slice(3), includePathPrefixes)
    if (shouldIncludeFile(sourcePath)) files.add(sourcePath)
  }
  return files
}

function collectInventoryFiles(inventory, suiteName) {
  const files = new Set()
  for (const root of inventory.roots || []) {
    const rootPath = root.path
    const extensions = root.extensions || ['.ts', '.tsx', '.js', '.mjs']
    const excludeFileNames = new Set(root.excludeFileNames || [])
    let rootStats
    try {
      rootStats = statSync(rootPath)
    } catch {
      throw new Error(`${suiteName} coverage inventory root is missing: ${rootPath}`)
    }
    if (!rootStats.isDirectory()) {
      throw new Error(`${suiteName} coverage inventory root is not a directory: ${rootPath}`)
    }
    collectInventoryDirectory(rootPath, extensions, files, excludeFileNames)
  }
  return files
}

function collectInventoryDirectory(directory, extensions, files, excludeFileNames = new Set()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name).replace(/\\/g, '/')
    if (excludeFileNames.has(entry.name)) continue
    if (entry.isDirectory()) {
      if (['node_modules', 'coverage', 'test', 'tests', '__tests__'].includes(entry.name)) continue
      collectInventoryDirectory(path, extensions, files, excludeFileNames)
      continue
    }
    if (!entry.isFile()) continue
    if (!extensions.some((extension) => entry.name.endsWith(extension))) continue
    if (entry.name.endsWith('.d.ts') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue
    files.add(path)
  }
}

function summarizeInventory(input, coveredFiles) {
  if (!input.sourceInventory) return null
  const inventoryFiles = collectInventoryFiles(input.sourceInventory, input.name)
  if (inventoryFiles.size === 0) {
    throw new Error(`${input.name} coverage inventory matched no source files.`)
  }
  let covered = 0
  for (const file of inventoryFiles) {
    if (coveredFiles.has(file)) covered += 1
  }
  const inventoryPercent = percent(covered, inventoryFiles.size)
  const minimumPercent = input.sourceInventory.minimumPercent
  return {
    covered,
    total: inventoryFiles.size,
    percent: inventoryPercent,
    threshold: minimumPercent,
    status: status(inventoryPercent, minimumPercent),
  }
}

function percent(covered, total) {
  if (total === 0) return 100
  return (covered / total) * 100
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`
}

function status(value, threshold) {
  return value + 0.0001 >= threshold ? 'pass' : 'fail'
}

export function summarizeCoverage(inputs = DEFAULT_INPUTS) {
  return inputs.map((input) => {
    const lcov = readFileSync(input.path, 'utf8')
    const totals = parseLcovInfo(lcov, input)
    const coveredFiles = parseLcovFilePaths(lcov, input)
    if (input.includePathPrefixes && input.includePathPrefixes.length > 0 && totals.files === 0) {
      throw new Error(`${input.name} coverage matched no files for prefixes: ${input.includePathPrefixes.join(', ')}`)
    }
    const lines = percent(totals.lines.covered, totals.lines.total)
    const functions = percent(totals.functions.covered, totals.functions.total)
    const branches = percent(totals.branches.covered, totals.branches.total)
    return {
      name: input.name,
      path: input.path,
      files: totals.files,
      inventory: summarizeInventory(input, coveredFiles),
      metrics: {
        lines: { ...totals.lines, percent: lines, threshold: input.thresholds.lines, status: status(lines, input.thresholds.lines) },
        functions: { ...totals.functions, percent: functions, threshold: input.thresholds.functions, status: status(functions, input.thresholds.functions) },
        branches: { ...totals.branches, percent: branches, threshold: input.thresholds.branches, status: status(branches, input.thresholds.branches) },
      },
    }
  })
}

export function renderCoverageMarkdown(summary) {
  const lines = [
    '<!-- open-cowork-coverage-summary -->',
    '### Coverage Summary',
    '',
    '| Suite | Files | Lines | Functions | Branches |',
    '| --- | ---: | ---: | ---: | ---: |',
  ]

  for (const suite of summary) {
    const metrics = suite.metrics
    lines.push([
      `| ${suite.name}`,
      String(suite.files),
      `${formatPercent(metrics.lines.percent)} / ${formatPercent(metrics.lines.threshold)}`,
      `${formatPercent(metrics.functions.percent)} / ${formatPercent(metrics.functions.threshold)}`,
      `${formatPercent(metrics.branches.percent)} / ${formatPercent(metrics.branches.threshold)} |`,
    ].join(' | '))
  }

  lines.push('', '_Coverage is reported from the CI lcov artifacts for this commit._')
  const inventoriedSuites = summary.filter((suite) => suite.inventory)
  if (inventoriedSuites.length > 0) {
    lines.push('', 'Source inventory ratchets:')
    for (const suite of inventoriedSuites) {
      lines.push(`- ${suite.name}: ${suite.inventory.covered}/${suite.inventory.total} files represented (${formatPercent(suite.inventory.percent)} / ${formatPercent(suite.inventory.threshold)})`)
    }
  }
  return lines.join('\n')
}

function inputsFromArgs(args) {
  if (args.includes('--node-only')) return NODE_ONLY_INPUTS
  if (args.includes('--renderer-only')) return [RENDERER_COVERAGE_INPUT]
  return DEFAULT_INPUTS
}

function failingMetrics(summary) {
  return summary.flatMap((suite) => {
    return Object.entries(suite.metrics)
      .filter(([, metric]) => metric.status === 'fail')
      .map(([metricName, metric]) => {
        return `${suite.name} ${metricName}: ${formatPercent(metric.percent)} < ${formatPercent(metric.threshold)}`
      })
      .concat(suite.inventory?.status === 'fail'
        ? [`${suite.name} source inventory: ${formatPercent(suite.inventory.percent)} < ${formatPercent(suite.inventory.threshold)} (${suite.inventory.covered}/${suite.inventory.total} files represented)`]
        : [])
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const summary = summarizeCoverage(inputsFromArgs(args))
  const markdown = renderCoverageMarkdown(summary)
  if (!args.includes('--no-write')) {
    writeFileSync('coverage/coverage-summary.json', `${JSON.stringify(summary, null, 2)}\n`)
    writeFileSync('coverage/coverage-summary.md', `${markdown}\n`)
  }
  process.stdout.write(`${markdown}\n`)
  if (args.includes('--check')) {
    const failures = failingMetrics(summary)
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`Coverage threshold failed: ${failure}`)
      }
      process.exit(1)
    }
  }
}
