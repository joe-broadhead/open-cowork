import { readFileSync, writeFileSync } from 'node:fs'

export const NODE_COVERAGE_INPUT = { name: 'Node', path: 'coverage/node/lcov.info', thresholds: { lines: 80, functions: 74, branches: 68 } }
export const SHARED_COVERAGE_INPUT = {
  name: 'Shared Package',
  path: 'coverage/node/lcov.info',
  includePathPrefixes: ['packages/shared/'],
  thresholds: { lines: 90, functions: 90, branches: 75 },
}
export const RENDERER_COVERAGE_INPUT = { name: 'Renderer', path: 'coverage/renderer/lcov.info', thresholds: { lines: 65, functions: 62, branches: 58 } }
export const DEFAULT_INPUTS = [NODE_COVERAGE_INPUT, SHARED_COVERAGE_INPUT, RENDERER_COVERAGE_INPUT]

function normalizeCoveragePath(path, includePathPrefixes = []) {
  const normalized = path.replace(/\\/g, '/')
  for (const prefix of includePathPrefixes) {
    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '')
    if (normalized.startsWith(normalizedPrefix)) return normalized
    const prefixIndex = normalized.indexOf(`/${normalizedPrefix}`)
    if (prefixIndex >= 0) return normalized.slice(prefixIndex + 1)
  }
  return normalized
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
    const totals = parseLcovInfo(readFileSync(input.path, 'utf8'), input)
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
  return lines.join('\n')
}

function inputsFromArgs(args) {
  if (args.includes('--node-only')) return [NODE_COVERAGE_INPUT, SHARED_COVERAGE_INPUT]
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
