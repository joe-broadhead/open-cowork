import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runScenarioSuite,
  sanitizeEvidenceText,
  validateScenarioSuite,
} from '../scripts/live-scenario-evidence.mjs'

function scenario(overrides = {}) {
  return {
    id: 'redaction-smoke',
    title: 'Redaction smoke',
    productModes: ['desktop-local'],
    authority: 'Desktop Local',
    productSurface: 'diagnostics',
    contract: 'evidence redaction',
    owner: 'release',
    stability: 'release-blocking',
    prerequisites: ['node available'],
    steps: ['emit a private-looking value'],
    expectedOutcomes: ['private-looking value is redacted'],
    evidence: ['live-scenario-evidence.json'],
    command: ['node', '-e', "process.stdout.write('/Users/joe/private ' + 'sk-' + '123456789012345678901234567890123456')"],
    ...overrides,
  }
}

function suite(scenarios = [scenario(), scenario({ id: 'two' }), scenario({ id: 'three' }), scenario({ id: 'four' }), scenario({ id: 'five' })]) {
  return {
    schemaVersion: 1,
    purpose: 'test-suite',
    name: 'Test Suite',
    scenarios,
  }
}

test('live scenario suite validation requires five fully-described scenarios', () => {
  assert.throws(() => validateScenarioSuite(suite([scenario()])), /at least five/)
  assert.doesNotThrow(() => validateScenarioSuite(suite()))
  assert.throws(() => validateScenarioSuite(suite([scenario(), scenario(), scenario({ id: 'three' }), scenario({ id: 'four' }), scenario({ id: 'five' })])), /Duplicate/)
})

test('live scenario evidence runner writes redacted structured reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-live-scenarios-'))
  try {
    const suitePath = join(root, 'suite.json')
    const outputDir = join(root, 'evidence')
    mkdirSync(outputDir, { recursive: true })
    writeFileSync(suitePath, JSON.stringify(suite(), null, 2))

    const { report, jsonPath, markdownPath } = runScenarioSuite({
      suite: suitePath,
      outputDir,
      execute: true,
    })

    assert.equal(report.ok, true)
    assert.equal(report.counts.pass, 5)
    assert.equal(report.results[0]?.failureTaxonomy.productSurface, 'diagnostics')
    assert.equal(report.results[0]?.failureTaxonomy.authority, 'Desktop Local')
    assert.equal(report.results[0]?.failureTaxonomy.contract, 'evidence redaction')
    assert.equal(report.results[0]?.failureTaxonomy.likelyOwner, 'release')
    assert.equal(report.artifacts?.some((artifact) => artifact.kind === 'json'), true)
    const json = readFileSync(jsonPath, 'utf8')
    assert.match(json, /\[REDACTED_TOKEN\]/)
    assert.match(json, /\/Users\/\[REDACTED_HOME\]/)
    assert.doesNotMatch(json, /sk-123456/)
    assert.match(readFileSync(markdownPath, 'utf8'), /Open Cowork Live Scenario Evidence/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live scenario evidence runner records sanitized failing scenario details', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-live-scenarios-'))
  try {
    const suitePath = join(root, 'suite.json')
    const outputDir = join(root, 'evidence')
    const failingSecret = 'sk-' + '123456789012345678901234567890123456'
    writeFileSync(suitePath, JSON.stringify(suite([
      scenario({
        id: 'failing-scenario',
        command: ['node', '-e', `process.stderr.write('/Users/joe/private ${failingSecret}'); process.exit(7)`],
      }),
      scenario({ id: 'two' }),
      scenario({ id: 'three' }),
      scenario({ id: 'four' }),
      scenario({ id: 'five' }),
    ]), null, 2))

    const { report, jsonPath } = runScenarioSuite({
      suite: suitePath,
      outputDir,
      execute: true,
    })

    assert.equal(report.ok, false)
    assert.equal(report.counts.fail, 1)
    assert.deepEqual(report.failures?.map((failure) => ({
      id: failure.id,
      exitCode: failure.exitCode,
    })), [{ id: 'failing-scenario', exitCode: 7 }])
    assert.match(report.failures?.[0]?.failureReason || '', /\[REDACTED_TOKEN\]/)
    assert.match(report.failures?.[0]?.failureReason || '', /\/Users\/\[REDACTED_HOME\]/)
    assert.doesNotMatch(readFileSync(jsonPath, 'utf8'), /sk-123456/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('live scenario redaction handles common evidence leaks', () => {
  const sanitized = sanitizeEvidenceText('Authorization: Bearer abcdef /home/alice/project ' + 'github_pat_' + 'abcdefghijklmnopqrstuvwxyz')
  assert.equal(sanitized.includes('Authorization: Bearer abcdef'), false)
  assert.equal(sanitized.includes('/home/alice/project'), false)
  assert.match(sanitized, /\[REDACTED_TOKEN\]/)
  assert.match(sanitized, /\/home\/\[REDACTED_HOME\]/)
})
