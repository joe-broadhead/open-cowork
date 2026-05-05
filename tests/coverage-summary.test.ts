import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLcovInfo, renderCoverageMarkdown } from '../scripts/coverage-summary.mjs'

test('coverage summary parses lcov totals and renders a PR-safe table', () => {
  const totals = parseLcovInfo([
    'TN:',
    'SF:src/example.ts',
    'FNF:4',
    'FNH:3',
    'BRF:10',
    'BRH:7',
    'LF:20',
    'LH:18',
    'end_of_record',
  ].join('\n'))

  assert.deepEqual(totals, {
    files: 1,
    lines: { covered: 18, total: 20 },
    functions: { covered: 3, total: 4 },
    branches: { covered: 7, total: 10 },
  })

  const markdown = renderCoverageMarkdown([{
    name: 'Node',
    path: 'coverage/node/lcov.info',
    files: 1,
    metrics: {
      lines: { covered: 18, total: 20, percent: 90, threshold: 80, status: 'pass' },
      functions: { covered: 3, total: 4, percent: 75, threshold: 74, status: 'pass' },
      branches: { covered: 7, total: 10, percent: 70, threshold: 68, status: 'pass' },
    },
  }])

  assert.match(markdown, /open-cowork-coverage-summary/)
  assert.match(markdown, /\| Node \| 1 \| 90\.0% \/ 80\.0% \| 75\.0% \/ 74\.0% \| 70\.0% \/ 68\.0% \|/)
})
