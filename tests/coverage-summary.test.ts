import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_INPUTS, parseLcovInfo, renderCoverageMarkdown } from '../scripts/coverage-summary.mjs'

test('coverage summary parses lcov totals and renders a PR-safe table', () => {
  const totals = parseLcovInfo([
    'TN:',
    'SF:src/example.ts',
    'FN:1,first',
    'FN:2,second',
    'FN:3,third',
    'FN:4,fourth',
    'FNDA:1,first',
    'FNDA:2,second',
    'FNDA:3,third',
    'FNDA:0,fourth',
    'FNF:4',
    'FNH:3',
    'BRDA:1,0,0,1',
    'BRDA:2,0,0,1',
    'BRDA:3,0,0,1',
    'BRDA:4,0,0,1',
    'BRDA:5,0,0,1',
    'BRDA:6,0,0,1',
    'BRDA:7,0,0,1',
    'BRDA:8,0,0,0',
    'BRDA:9,0,0,0',
    'BRDA:10,0,0,0',
    'BRF:10',
    'BRH:7',
    ...Array.from({ length: 18 }, (_, index) => `DA:${index + 1},1`),
    'DA:19,0',
    'DA:20,0',
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

test('coverage summary merges duplicate source-file records', () => {
  const totals = parseLcovInfo([
    'TN:',
    'SF:src/reloaded.ts',
    'FN:1,load',
    'FNDA:0,load',
    'BRDA:1,0,0,0',
    'DA:1,0',
    'DA:2,1',
    'end_of_record',
    'SF:src/reloaded.ts',
    'FN:1,load',
    'FNDA:2,load',
    'BRDA:1,0,0,3',
    'DA:1,1',
    'DA:2,0',
    'end_of_record',
  ].join('\n'))

  assert.deepEqual(totals, {
    files: 1,
    lines: { covered: 2, total: 2 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 1 },
  })
})

test('coverage summary applies FNDA hit counts to duplicate function names in declaration order', () => {
  const totals = parseLcovInfo([
    'TN:',
    'SF:src/duplicate-helpers.ts',
    'FN:10,helper',
    'FN:20,helper',
    'FNDA:0,helper',
    'FNDA:5,helper',
    'DA:10,1',
    'DA:20,1',
    'end_of_record',
  ].join('\n'))

  assert.deepEqual(totals, {
    files: 1,
    lines: { covered: 2, total: 2 },
    functions: { covered: 1, total: 2 },
    branches: { covered: 0, total: 0 },
  })
})

test('coverage summary reports the enforced renderer ratchet', () => {
  const renderer = DEFAULT_INPUTS.find((input) => input.name === 'Renderer')

  assert.deepEqual(renderer?.thresholds, {
    lines: 65,
    functions: 62,
    branches: 51,
  })
})
