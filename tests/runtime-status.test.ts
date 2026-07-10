import { getRuntimeStatus, isRuntimeReady, reduceRuntimeStatus, recordRuntimeComponentVerification, recordRuntimeDoctorCheck, recordRuntimeReadinessPhase, resetRuntimeStatus, RuntimeStatusStore, setRuntimeError, setRuntimeReady, type RuntimeStatusState } from '@open-cowork/runtime-host/runtime-status'
import { verifyRuntimeComponentManifest } from '@open-cowork/runtime-host/runtime-component-manifest'
import test from 'node:test'
import assert from 'node:assert/strict'
import { RUNTIME_COMPONENT_MANIFEST_FORMAT } from '../packages/shared/src/runtime.ts'

test('runtime status reducer derives phase changes without mutating prior state', () => {
  const initial: RuntimeStatusState = {
    ready: false,
    error: null,
    phase: 'environment',
    updatedAt: '2026-06-03T10:00:00.000Z',
    timeline: [],
    checks: [],
    components: null,
  }

  const next = reduceRuntimeStatus(initial, {
    type: 'record-readiness-phase',
    phase: 'config-build',
    message: 'Config ready',
    timestamp: '2026-06-03T10:00:01.000Z',
  })

  assert.equal(initial.phase, 'environment')
  assert.equal(initial.timeline.length, 0)
  assert.equal(next.phase, 'config-build')
  assert.equal(next.updatedAt, '2026-06-03T10:00:01.000Z')
  assert.deepEqual(next.timeline.map((entry) => entry.code), ['runtime.config_build'])
})

test('runtime status store accepts an explicit clock dependency', () => {
  const timestamps = [
    '2026-06-03T10:00:00.000Z',
    '2026-06-03T10:00:01.000Z',
  ]
  const store = new RuntimeStatusStore(() => timestamps.shift() || '2026-06-03T10:00:02.000Z')

  store.recordReadinessPhase('event-stream', 'Connected')

  const status = store.getStatus()
  assert.equal(status.phase, 'event-stream')
  assert.equal(status.updatedAt, '2026-06-03T10:00:01.000Z')
  assert.equal(status.timeline?.at(-1)?.timestamp, '2026-06-03T10:00:01.000Z')
})

test('runtime status starts not ready with no error after reset', () => {
  resetRuntimeStatus()

  assert.equal(isRuntimeReady(), false)
  const status = getRuntimeStatus()
  assert.equal(status.ready, false)
  assert.equal(status.error, null)
  assert.equal(status.phase, 'environment')
  assert.equal(status.timeline?.at(-1)?.phase, 'environment')
})

test('setRuntimeReady clears an old error when readiness becomes true', () => {
  resetRuntimeStatus()
  setRuntimeError('runtime failed')

  setRuntimeReady(true)

  assert.equal(isRuntimeReady(), true)
  const status = getRuntimeStatus()
  assert.equal(status.ready, true)
  assert.equal(status.error, null)
  assert.equal(status.phase, 'ready')
  assert.equal(status.timeline?.at(-1)?.status, 'passed')
  assert.ok(status.checks?.some((check) => check.code === 'runtime.ready' && check.status === 'pass'))
})

test('setRuntimeReady can preserve or replace the current error explicitly', () => {
  resetRuntimeStatus()
  setRuntimeError('old error')

  setRuntimeReady(false)
  let status = getRuntimeStatus()
  assert.equal(status.ready, false)
  assert.equal(status.error, 'old error')

  setRuntimeReady(false, 'new error')
  status = getRuntimeStatus()
  assert.equal(status.ready, false)
  assert.equal(status.error, 'new error')
  assert.equal(status.phase, 'error')
})

test('setRuntimeError makes the runtime not ready while clear keeps readiness unchanged', () => {
  resetRuntimeStatus()
  setRuntimeReady(true)

  setRuntimeError('boot failed')
  let status = getRuntimeStatus()
  assert.equal(status.ready, false)
  assert.equal(status.error, 'boot failed')
  assert.equal(status.phase, 'error')

  setRuntimeReady(true)
  setRuntimeError(null)
  status = getRuntimeStatus()
  assert.equal(status.ready, true)
  assert.equal(status.error, null)
})

test('runtime status records readiness phases and doctor checks', () => {
  resetRuntimeStatus()

  recordRuntimeReadinessPhase('config-build', 'Validating config')
  recordRuntimeDoctorCheck({
    code: 'runtime.config_build',
    status: 'pass',
    message: 'Config valid',
  })

  const status = getRuntimeStatus()
  assert.equal(status.phase, 'config-build')
  assert.ok(status.updatedAt)
  assert.equal(status.timeline?.at(-1)?.code, 'runtime.config_build')
  const check = status.checks?.find((entry) => entry.code === 'runtime.config_build')
  assert.equal(check?.severity, 'info')
  assert.equal(check?.status, 'pass')
  assert.equal(check?.message, 'Config valid')
  assert.ok(check?.updatedAt)
})

test('runtime status redacts token-like text from errors and doctor messages', () => {
  resetRuntimeStatus()
  const apiKeyText = 'api' + 'Key=123456789012345678901234567890123456'
  const openRouterKey = 'sk-or-v1-' + '123456789012345678901234567890'

  setRuntimeError('failed with Authorization: Bearer secret-token-value')
  recordRuntimeDoctorCheck({
    code: 'runtime.secret_check',
    status: 'fail',
    message: apiKeyText,
    remediation: `remove ${openRouterKey}`,
  })

  const status = getRuntimeStatus()
  assert.match(status.error || '', /\[REDACTED_TOKEN\]/)
  const check = status.checks?.find((entry) => entry.code === 'runtime.secret_check')
  assert.match(check?.message || '', /\[REDACTED_TOKEN\]/)
  assert.match(check?.remediation || '', /\[REDACTED_TOKEN\]/)
})

test('runtime status records component verification reports as doctor checks', () => {
  resetRuntimeStatus()
  const report = verifyRuntimeComponentManifest({
    manifest: {
      format: RUNTIME_COMPONENT_MANIFEST_FORMAT,
      generatedAt: '2026-06-02T00:00:00.000Z',
      components: [{
        id: 'opencode-cli',
        kind: 'opencode-cli',
        version: '1.17.14',
        path: '/Users/alice/private/opencode',
        sha256: `sha256:${'a'.repeat(64)}`,
        observedSha256: `${'b'.repeat(64)}`,
        sourcePolicy: 'bundled',
        compatibilityStatus: 'supported',
      }],
    },
    now: () => new Date('2026-06-02T01:00:00.000Z'),
  })

  recordRuntimeComponentVerification(report)
  const status = getRuntimeStatus()

  assert.equal(status.components?.ok, false)
  assert.equal(status.components?.issues.some((issue) => issue.code === 'component_hash_mismatch'), true)
  assert.equal(status.components?.components[0]?.path?.includes('/Users/alice/private'), false)
  assert.ok(status.checks?.some((check) => check.code === 'runtime.components' && check.status === 'fail'))
  assert.ok(status.checks?.some((check) => check.code.includes('component_hash_mismatch') && check.status === 'fail'))
})
