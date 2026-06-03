import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { RuntimeCompatibilityReport } from '@open-cowork/shared'
import {
  checkOpencodeCompatibilityReport,
  getOpencodeCompatibilityReport,
  type OpencodeRuntimeContractFixture,
} from '../apps/desktop/src/main/opencode-compatibility.ts'

type CompatibilityFixture = {
  assumptionIds: string[]
  blockedPolicyIds: string[]
  requiredCategories: string[]
}

const fixture = JSON.parse(readFileSync(new URL('./fixtures/opencode-compatibility-registry.json', import.meta.url), 'utf8')) as CompatibilityFixture
const runtimeContractFixture = JSON.parse(readFileSync(new URL('./fixtures/opencode-runtime-contract.json', import.meta.url), 'utf8')) as OpencodeRuntimeContractFixture

test('OpenCode compatibility registry passes the release-grade drift check', () => {
  const report = getOpencodeCompatibilityReport()
  const result = checkOpencodeCompatibilityReport(report, { runtimeContractFixture })

  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2))
  assert.equal(result.runtimeContractCount, 10)
  assert.deepEqual(
    report.assumptions.map((entry) => entry.id).sort(),
    fixture.assumptionIds,
  )
  assert.deepEqual(result.checkedCategories, fixture.requiredCategories)
  assert.deepEqual(
    report.assumptions
      .filter((entry) => entry.status === 'blocked')
      .map((entry) => entry.id)
      .sort(),
    fixture.blockedPolicyIds,
  )
})

test('OpenCode compatibility checker fails closed on undocumented drift', () => {
  const report: RuntimeCompatibilityReport = {
    opencodeVersion: '1.2.3',
    assumptions: [
      {
        id: 'private-runtime-shape',
        category: 'event',
        status: 'private-assumption',
        owner: 'desktop-runtime',
        sourceVersion: '1.2.4',
        reason: 'Uses a private event shape.',
        tests: ['tests/does-not-exist.test.ts'],
        productModes: ['desktop-cloud'],
      },
      {
        id: 'unknown-plugin-state',
        category: 'plugin',
        status: 'unknown',
        owner: 'capabilities',
        sourceVersion: '1.2.3',
        reason: 'Plugin behavior has not been qualified.',
        tests: [],
        productModes: [],
      },
    ],
  }

  const result = checkOpencodeCompatibilityReport(report, {
    runtimeContractFixture: {
      ...runtimeContractFixture,
      opencodeVersion: '1.2.4',
      requiredAssumptionIds: ['private-runtime-shape', 'missing-assumption'],
      sdkEvents: [{
        ...runtimeContractFixture.sdkEvents[0]!,
        fixturePath: 'tests/fixtures/opencode-sdk-v2-events.json',
        events: ['not-a-real-event'],
      }],
    },
  })
  const codes = new Set(result.issues.map((issue) => issue.code))

  assert.equal(result.ok, false)
  assert.equal(codes.has('compatibility_private_assumption_blocked'), true)
  assert.equal(codes.has('compatibility_unknown_blocked'), true)
  assert.equal(codes.has('compatibility_source_version_drift'), true)
  assert.equal(codes.has('compatibility_test_missing'), true)
  assert.equal(codes.has('compatibility_tests_missing'), true)
  assert.equal(codes.has('compatibility_product_modes_missing'), true)
  assert.equal(codes.has('compatibility_category_missing'), true)
  assert.equal(codes.has('runtime_contract_version_drift'), true)
  assert.equal(codes.has('runtime_contract_assumption_unknown'), true)
  assert.equal(codes.has('runtime_contract_event_missing'), true)
})

test('OpenCode compatibility CLI exposes machine-readable release evidence', () => {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-strip-types',
    'scripts/check-opencode-compatibility.ts',
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const payload = JSON.parse(result.stdout) as { result: { ok: boolean }; report: RuntimeCompatibilityReport }
  assert.equal(payload.result.ok, true)
  assert.equal((payload.result as { runtimeContractCount?: number }).runtimeContractCount, 10)
  assert.deepEqual(
    payload.report.assumptions.map((entry) => entry.id).sort(),
    fixture.assumptionIds,
  )
})
