import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectSmokeTestFiles,
  parseSmokeRunnerArgs,
  runSmokeTests,
} from '../scripts/run-desktop-smoke-tests.mjs'

test('collectSmokeTestFiles sorts smoke files deterministically', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-smoke-runner-'))
  try {
    mkdirSync(join(tempRoot, 'tests'))
    writeFileSync(join(tempRoot, 'tests', 'zeta.smoke.test.ts'), '')
    writeFileSync(join(tempRoot, 'tests', 'alpha.smoke.test.ts'), '')
    writeFileSync(join(tempRoot, 'tests', 'ignore.test.ts'), '')

    assert.deepEqual(
      collectSmokeTestFiles('tests/*.smoke.test.ts', tempRoot),
      [
        'tests/alpha.smoke.test.ts',
        'tests/zeta.smoke.test.ts',
      ],
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('parseSmokeRunnerArgs reads pattern, timeout, retries, and reporter', () => {
  assert.deepEqual(
    parseSmokeRunnerArgs([
      '--pattern=tests/*.smoke.test.ts',
      '--timeout=123',
      '--retries=2',
      '--reporter=tap',
    ]),
    {
      pattern: 'tests/*.smoke.test.ts',
      timeoutMs: 123,
      retries: 2,
      reporter: 'tap',
    },
  )
})

test('parseSmokeRunnerArgs rejects shell-expanded pattern values', () => {
  assert.throws(
    () => parseSmokeRunnerArgs([
      '--pattern=tests/alpha.smoke.test.ts',
      '--pattern=tests/zeta.smoke.test.ts',
    ]),
    /Quote the glob/,
  )
})

test('runSmokeTests retries a failed file once and reports a flaky pass', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-smoke-runner-'))
  try {
    mkdirSync(join(tempRoot, 'tests'))
    writeFileSync(join(tempRoot, 'tests', 'alpha.smoke.test.ts'), '')

    const attempts: string[] = []
    const result = runSmokeTests({
      pattern: 'tests/*.smoke.test.ts',
      cwd: tempRoot,
      timeoutMs: 120_000,
      retries: 1,
      reporter: 'spec',
    }, (file, options) => {
      attempts.push(`${file}:${options.attempt}`)
      return options.attempt === 1 ? 1 : 0
    })

    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.flaky, ['tests/alpha.smoke.test.ts'])
    assert.deepEqual(result.failed, [])
    assert.deepEqual(attempts, [
      'tests/alpha.smoke.test.ts:1',
      'tests/alpha.smoke.test.ts:2',
    ])
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('runSmokeTests fails after the retry budget is exhausted', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-smoke-runner-'))
  try {
    mkdirSync(join(tempRoot, 'tests'))
    writeFileSync(join(tempRoot, 'tests', 'alpha.smoke.test.ts'), '')

    const result = runSmokeTests({
      pattern: 'tests/*.smoke.test.ts',
      cwd: tempRoot,
      timeoutMs: 120_000,
      retries: 1,
      reporter: 'spec',
    }, () => 1)

    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.flaky, [])
    assert.deepEqual(result.failed, ['tests/alpha.smoke.test.ts'])
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
