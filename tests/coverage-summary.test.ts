import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOUD_CLIENT_COVERAGE_INPUT, DEFAULT_INPUTS, GATEWAY_COVERAGE_INPUT, GATEWAY_PROVIDER_COVERAGE_INPUT, MCP_HANDLER_COVERAGE_INPUT, NODE_COVERAGE_INPUT, NODE_ONLY_INPUTS, SHARED_COVERAGE_INPUT, STANDALONE_GATEWAY_COVERAGE_INPUT, WORKSPACE_NODE_COVERAGE_INPUT, parseLcovFilePaths, parseLcovInfo, renderCoverageMarkdown, summarizeCoverage } from '../scripts/coverage-summary.mjs'

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

test('coverage summary can enforce package-scoped coverage from shared lcov', () => {
  const totals = parseLcovInfo([
    'TN:',
    'SF:apps/desktop/src/main/runtime.ts',
    'FN:1,startRuntime',
    'FNDA:1,startRuntime',
    'DA:1,1',
    'end_of_record',
    'SF:packages/shared/src/index.ts',
    'FN:1,sharedContract',
    'FNDA:1,sharedContract',
    'BRDA:1,0,0,1',
    'DA:1,1',
    'DA:2,0',
    'end_of_record',
  ].join('\n'), { includePathPrefixes: ['packages/shared/'] })

  assert.deepEqual(totals, {
    files: 1,
    lines: { covered: 1, total: 2 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 1 },
  })
})

test('coverage summary normalizes absolute and platform-specific scoped paths', () => {
  const totals = parseLcovInfo([
    'TN:',
    'SF:/home/runner/work/open-cowork/open-cowork/packages/shared/src/index.ts',
    'FN:1,sharedContract',
    'FNDA:1,sharedContract',
    'DA:1,1',
    'end_of_record',
    String.raw`SF:C:\a\open-cowork\packages\shared\src\providers.ts`,
    'FN:2,providerContract',
    'FNDA:0,providerContract',
    'DA:2,0',
    'end_of_record',
  ].join('\n'), { includePathPrefixes: ['packages/shared/'] })

  assert.deepEqual(totals, {
    files: 2,
    lines: { covered: 1, total: 2 },
    functions: { covered: 1, total: 2 },
    branches: { covered: 0, total: 0 },
  })
})

test('coverage summary normalizes lcov source file paths for inventory checks', () => {
  const paths = parseLcovFilePaths([
    'TN:',
    `SF:${join(process.cwd(), 'apps/desktop/src/main/runtime.ts')}`,
    'DA:1,1',
    'end_of_record',
    'SF:/home/runner/work/open-cowork/open-cowork/packages/shared/src/index.ts',
    'DA:1,1',
    'end_of_record',
    String.raw`SF:C:\a\open-cowork\packages\shared\src\providers.ts`,
    'DA:1,1',
    'end_of_record',
  ].join('\n'), { includePathPrefixes: ['packages/shared/'] })

  assert.deepEqual([...paths].sort(), [
    'packages/shared/src/index.ts',
    'packages/shared/src/providers.ts',
  ])

  assert.deepEqual([...parseLcovFilePaths([
    'TN:',
    `SF:${join(process.cwd(), 'apps/desktop/src/main/runtime.ts')}`,
    'DA:1,1',
    'end_of_record',
  ].join('\n'))], ['apps/desktop/src/main/runtime.ts'])
})

test('coverage summary reports source inventory representation ratchets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-coverage-inventory-'))
  const src = join(dir, 'src')
  const lcovPath = join(dir, 'lcov.info')
  try {
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'covered.ts'), 'export const covered = true\n')
    writeFileSync(join(src, 'missing.ts'), 'export const missing = true\n')
    writeFileSync(join(src, 'covered.test.ts'), 'test("ignored", () => {})\n')
    writeFileSync(join(src, 'types.d.ts'), 'export type Ignored = string\n')
    writeFileSync(lcovPath, [
      'TN:',
      `SF:${join(src, 'covered.ts')}`,
      'FN:1,covered',
      'FNDA:1,covered',
      'DA:1,1',
      'end_of_record',
    ].join('\n'))

    const [summary] = summarizeCoverage([{
      name: 'Inventory',
      path: lcovPath,
      sourceInventory: {
        minimumPercent: 75,
        roots: [{ path: src, extensions: ['.ts'] }],
      },
      thresholds: { lines: 1, functions: 1, branches: 1 },
    }])

    assert.deepEqual(summary.inventory, {
      covered: 1,
      total: 2,
      percent: 50,
      threshold: 75,
      status: 'fail',
    })
    assert.match(renderCoverageMarkdown([summary]), /Inventory: 1\/2 files represented \(50\.0% \/ 75\.0%\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('coverage summary refuses scoped input with zero matched files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'open-cowork-coverage-summary-'))
  const lcovPath = join(dir, 'lcov.info')
  try {
    writeFileSync(lcovPath, [
      'TN:',
      'SF:apps/desktop/src/main/runtime.ts',
      'DA:1,1',
      'end_of_record',
    ].join('\n'))

    assert.throws(() => summarizeCoverage([{
      name: 'Shared Package',
      path: lcovPath,
      includePathPrefixes: ['packages/shared/'],
      thresholds: { lines: 1, functions: 1, branches: 1 },
    }]), /matched no files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    branches: 58,
  })
})

test('coverage summary reports the enforced node source inventory ratchet', () => {
  assert.equal(NODE_COVERAGE_INPUT.sourceInventory.minimumPercent, 90)
  for (const expectedRoot of [
    'apps/desktop/src/main',
    'apps/desktop/src/lib',
    'packages/shared/dist',
    'packages/runtime-host/dist',
    'packages/cloud-server/src',
  ]) {
    assert.ok(
      NODE_COVERAGE_INPUT.sourceInventory.roots.some((root) => root.path === expectedRoot),
      `node coverage inventory includes ${expectedRoot}`,
    )
  }
})

test('coverage summary reports the enforced shared-package ratchet', () => {
  assert.deepEqual(SHARED_COVERAGE_INPUT.thresholds, {
    lines: 88,
    functions: 84,
    branches: 75,
  })
  assert.deepEqual(SHARED_COVERAGE_INPUT.includePathPrefixes, ['packages/shared/'])
  assert.equal(SHARED_COVERAGE_INPUT.sourceInventory.minimumPercent, 90)
  assert.deepEqual(SHARED_COVERAGE_INPUT.sourceInventory.roots.map((root) => root.path), ['packages/shared/dist'])
})

test('coverage summary enforces a dedicated high-bar ratchet for the gateway delivery path', () => {
  assert.ok(DEFAULT_INPUTS.includes(GATEWAY_COVERAGE_INPUT))
  assert.deepEqual(GATEWAY_COVERAGE_INPUT.includePathPrefixes, ['apps/gateway/dist/'])
  assert.equal(GATEWAY_COVERAGE_INPUT.path, 'coverage/workspace/lcov.info')
  // The internet-facing gateway relay must stay well-exercised even though the combined
  // workspace floor reads low (subprocess-tested MCPs + the standalone appliance).
  assert.deepEqual(GATEWAY_COVERAGE_INPUT.thresholds, {
    lines: 90,
    functions: 88,
    branches: 72,
  })
})

test('coverage summary reports the enforced shipped workspace ratchet', () => {
  assert.deepEqual(WORKSPACE_NODE_COVERAGE_INPUT.thresholds, {
    lines: 38,
    functions: 27,
    branches: 67,
  })
  assert.ok(DEFAULT_INPUTS.includes(WORKSPACE_NODE_COVERAGE_INPUT))
  assert.equal(WORKSPACE_NODE_COVERAGE_INPUT.sourceInventory.minimumPercent, 90)
  assert.deepEqual(
    WORKSPACE_NODE_COVERAGE_INPUT.sourceInventory.roots.find((root) => root.path === 'apps/standalone-gateway/dist')?.excludeFileNames,
    ['main.js', 'types.js'],
  )
  for (const expectedPrefix of [
    'apps/gateway/dist/',
    'apps/standalone-gateway/dist/',
    'mcps/workflows/dist/',
    'mcps/knowledge/dist/',
    'mcps/semantic-ui/dist/',
    'packages/gateway-channel/dist/',
    'packages/gateway-provider-slack/dist/',
  ]) {
    assert.ok(
      WORKSPACE_NODE_COVERAGE_INPUT.includePathPrefixes.includes(expectedPrefix),
      `workspace coverage includes ${expectedPrefix}`,
    )
  }
})

test('coverage summary enforces package ratchets for subprocess and shipped runtime packages', () => {
  for (const input of [
    STANDALONE_GATEWAY_COVERAGE_INPUT,
    MCP_HANDLER_COVERAGE_INPUT,
    GATEWAY_PROVIDER_COVERAGE_INPUT,
    CLOUD_CLIENT_COVERAGE_INPUT,
  ]) {
    assert.ok(DEFAULT_INPUTS.includes(input), `${input.name} is part of the default coverage gate`)
    assert.ok(input.sourceInventory?.minimumPercent >= 95, `${input.name} must have a source-inventory ratchet`)
    assert.ok(NODE_ONLY_INPUTS.includes(input), `${input.name} must run during test:coverage:node`)
  }

  assert.deepEqual(STANDALONE_GATEWAY_COVERAGE_INPUT.thresholds, {
    lines: 82,
    functions: 80,
    branches: 78,
  })
  assert.deepEqual(MCP_HANDLER_COVERAGE_INPUT.thresholds, {
    lines: 35,
    functions: 25,
    branches: 67,
  })
  assert.deepEqual(GATEWAY_PROVIDER_COVERAGE_INPUT.thresholds, {
    lines: 85,
    functions: 87,
    branches: 69,
  })
  assert.deepEqual(CLOUD_CLIENT_COVERAGE_INPUT.thresholds, {
    lines: 70,
    functions: 32, // JOE-867 ratchet
    branches: 72,
  })
  assert.ok(MCP_HANDLER_COVERAGE_INPUT.includePathPrefixes.includes('mcps/knowledge/dist/'))
  assert.ok(MCP_HANDLER_COVERAGE_INPUT.includePathPrefixes.includes('mcps/semantic-ui/dist/'))
})
