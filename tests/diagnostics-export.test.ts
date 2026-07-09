import { recordRuntimeComponentVerification, resetRuntimeStatus, setRuntimeError } from '@open-cowork/runtime-host/runtime-status'
import { verifyRuntimeComponentManifest } from '@open-cowork/runtime-host/runtime-component-manifest'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDiagnosticsBundle, tailLogFile } from '../apps/desktop/src/main/diagnostics-export.ts'
import { RUNTIME_COMPONENT_MANIFEST_FORMAT } from '../packages/shared/src/runtime.ts'
import { assertNoSecretFixtureLeaks, redactionFixtureCorpus } from './fixtures/secret-redaction-fixtures.ts'

function testTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('tailLogFile returns the requested tail lines without reading from the start', () => {
  const root = testTempDir('open-cowork-diagnostics-tail-')
  try {
    const logPath = join(root, 'app.log')
    writeFileSync(logPath, Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join('\n'))

    assert.equal(tailLogFile(logPath, 3, 1024), 'line-8\nline-9\nline-10')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tailLogFile drops the partial first line when the byte cap starts mid-file', () => {
  const root = testTempDir('open-cowork-diagnostics-cap-')
  try {
    const logPath = join(root, 'app.log')
    writeFileSync(logPath, 'first-line\nsecond-line\nthird-line\nfourth-line\n')

    assert.equal(tailLogFile(logPath, 10, 25), 'third-line\nfourth-line\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tailLogFile handles missing paths and directories without throwing', () => {
  const root = testTempDir('open-cowork-diagnostics-errors-')
  try {
    mkdirSync(join(root, 'logs'))
    assert.match(tailLogFile(join(root, 'missing.log'), 5, 1024), /^\(could not read log:/)
    assert.equal(tailLogFile(join(root, 'logs'), 5, 1024), '(log path is not a file)')
    assert.equal(tailLogFile('', 5, 1024), '(no log file configured)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('diagnostics bundle includes redacted runtime component verification', () => {
  resetRuntimeStatus()
  const report = verifyRuntimeComponentManifest({
    manifest: {
      format: RUNTIME_COMPONENT_MANIFEST_FORMAT,
      generatedAt: '2026-06-02T00:00:00.000Z',
      components: [{
        id: 'semantic-ui-mcp',
        kind: 'semantic-ui-mcp',
        version: '1.0.0',
        path: '/Users/alice/acme-private/mcps/semantic-ui',
        sha256: `sha256:${'a'.repeat(64)}`,
        observedSha256: `${'a'.repeat(64)}`,
        sourcePolicy: 'bundled',
        compatibilityStatus: 'supported',
      }],
    },
  })
  recordRuntimeComponentVerification(report)

  const bundle = buildDiagnosticsBundle()

  assert.match(bundle, /Runtime Doctor JSON/)
  assert.match(bundle, /semantic-ui-mcp/)
  assert.doesNotMatch(bundle, /alice/)
  assert.doesNotMatch(bundle, /acme-private/)
  assert.match(bundle, /\/Users\/\[REDACTED_HOME\]/)
})

test('diagnostics bundle redacts the provider token fixture matrix', () => {
  resetRuntimeStatus()
  setRuntimeError(`provider failed with ${redactionFixtureCorpus()} at /Users/alice/acme-private`)

  const bundle = buildDiagnosticsBundle()

  assertNoSecretFixtureLeaks(bundle)
  assert.doesNotMatch(bundle, /alice/)
  assert.doesNotMatch(bundle, /acme-private/)
  assert.match(bundle, /\[REDACTED_TOKEN\]/)
  assert.match(bundle, /\/Users\/\[REDACTED_HOME\]/)
})
