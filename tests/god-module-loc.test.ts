import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  countLogicalLines,
  discoverProductionModules,
  evaluateLocBudget,
  runLocBudgetCheck,
} from '../scripts/check-god-module-loc.mjs'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const checker = fileURLToPath(new URL('../scripts/check-god-module-loc.mjs', import.meta.url))

function registryEntry(path: string, maxLines: number) {
  return {
    path,
    maxLines,
    ratchetTargetLines: Math.min(maxLines, 2),
    owner: 'test-owner',
    reason: 'Deterministic LOC checker fixture.',
  }
}

function fixtureBudget(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    description: 'test',
    discovery: {
      workspaceManifest: 'pnpm-workspace.yaml',
      sourceDirectory: 'src',
      extensions: ['.ts', '.tsx'],
      excludedDirectoryNames: [
        '.generated',
        '__fixtures__',
        '__tests__',
        'generated',
        'node_modules',
        'test',
        'tests',
      ],
      excludedFileSuffixes: [
        '.d.ts',
        '.spec.ts',
        '.spec.tsx',
        '.test.ts',
        '.test.tsx',
      ],
    },
    softTargetLines: 3,
    hardCapLines: 10,
    exceptions: [],
    ratchets: [],
    ...overrides,
  }
}

test('logical LOC does not count a terminal newline as an extra line', () => {
  assert.equal(countLogicalLines(''), 0)
  assert.equal(countLogicalLines('one'), 1)
  assert.equal(countLogicalLines('one\n'), 1)
  assert.equal(countLogicalLines('one\r\ntwo\r\n'), 2)
})

test('all-workspace discovery includes production TS/TSX and excludes tests and generated source', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'open-cowork-loc-discovery-'))
  try {
    writeFileSync(
      join(fixtureRoot, 'pnpm-workspace.yaml'),
      'packages:\n  # production workspaces\n  - apps/*\n',
    )
    const workspaceRoot = join(fixtureRoot, 'apps', 'fixture')
    mkdirSync(join(workspaceRoot, 'src', 'generated'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"fixture","private":true}\n')
    writeFileSync(join(workspaceRoot, 'src', 'below.ts'), 'one\ntwo\n')
    writeFileSync(join(workspaceRoot, 'src', 'at.ts'), 'one\ntwo\nthree\n')
    writeFileSync(join(workspaceRoot, 'src', 'above.tsx'), 'one\ntwo\nthree\nfour\n')
    writeFileSync(join(workspaceRoot, 'src', 'ignored.test.ts'), 'ignored\n'.repeat(20))
    writeFileSync(join(workspaceRoot, 'src', 'generated', 'ignored.ts'), 'ignored\n'.repeat(20))

    const discovery = discoverProductionModules(fixtureRoot, fixtureBudget())
    assert.equal(discovery.workspaceCount, 1)
    assert.deepEqual(discovery.modules, [
      { path: 'apps/fixture/src/above.tsx', lines: 4 },
      { path: 'apps/fixture/src/at.ts', lines: 3 },
      { path: 'apps/fixture/src/below.ts', lines: 2 },
    ])
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('soft-target boundary is explicit at threshold minus one, threshold, and threshold plus one', () => {
  const path = 'packages/example/src/module.ts'

  const below = evaluateLocBudget([{ path, lines: 2 }], fixtureBudget())
  assert.deepEqual(below.failures, [])

  const at = evaluateLocBudget([{ path, lines: 3 }], fixtureBudget())
  assert.ok(at.failures.some((failure) => /requires an oversized-module exception at 3 lines/.test(failure)))

  const above = evaluateLocBudget([{ path, lines: 4 }], fixtureBudget())
  assert.ok(above.failures.some((failure) => /requires an oversized-module exception at 3 lines/.test(failure)))

  const registered = evaluateLocBudget(
    [
      { path: 'packages/example/src/at.ts', lines: 3 },
      { path: 'packages/example/src/above.ts', lines: 4 },
    ],
    fixtureBudget({
      exceptions: [
        registryEntry('packages/example/src/at.ts', 3),
        registryEntry('packages/example/src/above.ts', 4),
      ],
    }),
  )
  assert.deepEqual(registered.failures, [])
})

test('missing and stale oversized exceptions fail closed', () => {
  const missing = evaluateLocBudget(
    [{ path: 'packages/example/src/oversized.ts', lines: 3 }],
    fixtureBudget(),
  )
  assert.ok(missing.failures.some((failure) => /requires an oversized-module exception/.test(failure)))

  const shrunk = evaluateLocBudget(
    [{ path: 'packages/example/src/shrunk.ts', lines: 2 }],
    fixtureBudget({
      exceptions: [registryEntry('packages/example/src/shrunk.ts', 3)],
    }),
  )
  assert.ok(shrunk.failures.some((failure) => /exception is stale at 2 lines/.test(failure)))

  const deleted = evaluateLocBudget(
    [],
    fixtureBudget({
      exceptions: [registryEntry('packages/example/src/deleted.ts', 3)],
    }),
  )
  assert.ok(deleted.failures.some((failure) => /exception is stale because it is not a discovered production module/.test(failure)))
})

test('CLI mutation fixture rejects a discovered unregistered oversized module', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'open-cowork-loc-mutation-'))
  try {
    writeFileSync(join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    const workspaceRoot = join(fixtureRoot, 'packages', 'fixture')
    mkdirSync(join(workspaceRoot, 'src'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'package.json'), '{"name":"fixture","private":true}\n')
    writeFileSync(join(workspaceRoot, 'src', 'oversized.ts'), 'one\ntwo\nthree\n')
    writeFileSync(join(fixtureRoot, 'budget.json'), `${JSON.stringify(fixtureBudget(), null, 2)}\n`)

    const result = spawnSync(
      process.execPath,
      [checker, '--root', fixtureRoot, '--budget', 'budget.json', '--json'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'fail')
    assert.equal(report.oversized[0]?.path, 'packages/fixture/src/oversized.ts')
    assert.ok(report.failures.some((failure: string) => /requires an oversized-module exception/.test(failure)))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('registry entries require owner, reason, and a downward ratchet', () => {
  const result = evaluateLocBudget(
    [{ path: 'packages/example/src/module.ts', lines: 3 }],
    fixtureBudget({
      exceptions: [{
        path: 'packages/example/src/module.ts',
        maxLines: 3,
        ratchetTargetLines: 4,
        owner: '',
        reason: '',
      }],
    }),
  )
  assert.ok(result.failures.some((failure) => /ratchetTargetLines must not exceed maxLines/.test(failure)))
  assert.ok(result.failures.some((failure) => /\.owner is required/.test(failure)))
  assert.ok(result.failures.some((failure) => /\.reason is required/.test(failure)))
})

test('the repository hard cap and file ratchets are blocking', () => {
  const hardCap = evaluateLocBudget(
    [{ path: 'packages/example/src/module.ts', lines: 11 }],
    fixtureBudget({
      exceptions: [registryEntry('packages/example/src/module.ts', 10)],
    }),
  )
  assert.ok(hardCap.failures.some((failure) => /exceeds the repository hard cap 10/.test(failure)))

  const ratchet = evaluateLocBudget(
    [{ path: 'packages/example/src/facade.ts', lines: 3 }],
    fixtureBudget({
      exceptions: [registryEntry('packages/example/src/facade.ts', 3)],
      ratchets: [registryEntry('packages/example/src/deleted-ratchet.ts', 2)],
    }),
  )
  assert.ok(ratchet.failures.some((failure) => /ratchet is stale because it is not a discovered production module/.test(failure)))

  const overRatchet = evaluateLocBudget(
    [{ path: 'packages/example/src/facade.ts', lines: 2 }],
    fixtureBudget({
      ratchets: [registryEntry('packages/example/src/facade.ts', 1)],
    }),
  )
  assert.ok(overRatchet.failures.some((failure) => /ratchet max 1/.test(failure)))
})

test('committed production LOC registry covers the live workspace inventory', () => {
  const result = runLocBudgetCheck(root, 'docs/development/god-module-loc-budgets.json')
  assert.deepEqual(result.failures, [])
  assert.equal(result.report?.status, 'pass')
  assert.ok((result.report?.workspaceCount || 0) > 20)
  assert.ok((result.report?.moduleCount || 0) > 1_000)
  assert.equal(
    result.report?.oversized.length,
    result.report?.tracked.filter((entry) => entry.type === 'exception').length,
  )
})
