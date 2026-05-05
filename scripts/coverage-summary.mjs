import { readFileSync, writeFileSync } from 'node:fs'

const DEFAULT_INPUTS = [
  { name: 'Node', path: 'coverage/node/lcov.info', thresholds: { lines: 80, functions: 74, branches: 68 } },
  { name: 'Renderer', path: 'coverage/renderer/lcov.info', thresholds: { lines: 16, functions: 12, branches: 9 } },
]

export function parseLcovInfo(content) {
  const totals = {
    lines: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    files: 0,
  }

  for (const line of content.split(/\r?\n/)) {
    const [key, value] = line.split(':')
    const numericValue = Number(value)
    if (key === 'SF') totals.files += 1
    if (key === 'LF') totals.lines.total += numericValue
    if (key === 'LH') totals.lines.covered += numericValue
    if (key === 'FNF') totals.functions.total += numericValue
    if (key === 'FNH') totals.functions.covered += numericValue
    if (key === 'BRF') totals.branches.total += numericValue
    if (key === 'BRH') totals.branches.covered += numericValue
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
    const totals = parseLcovInfo(readFileSync(input.path, 'utf8'))
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = summarizeCoverage()
  const markdown = renderCoverageMarkdown(summary)
  writeFileSync('coverage/coverage-summary.json', `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync('coverage/coverage-summary.md', `${markdown}\n`)
  process.stdout.write(`${markdown}\n`)
}
