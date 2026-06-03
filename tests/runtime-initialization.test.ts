import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getRuntimeInitializationStatus,
  resolveRuntimeInitializationError,
  setRuntimeInitializationPhase,
} from '../apps/desktop/src/main/runtime-initialization.ts'
import {
  getRuntimeStatus,
  resetRuntimeStatus,
} from '../apps/desktop/src/main/runtime-status.ts'

test('runtime initialization errors record phase-specific readiness failure checks', () => {
  resetRuntimeStatus()
  setRuntimeInitializationPhase('managed-server', 'Starting managed OpenCode server.')

  resolveRuntimeInitializationError('OpenCode startup failed with Authorization: Bearer secret-token-value')

  const loading = getRuntimeInitializationStatus()
  const status = getRuntimeStatus()
  const phaseCheck = status.checks?.find((check) => check.code === 'runtime.process_launch.failed')
  const aggregateCheck = status.checks?.find((check) => check.code === 'runtime.startup')

  assert.equal(loading.phase, 'error')
  assert.equal(status.timeline?.at(-1)?.phase, 'process-launch')
  assert.equal(status.timeline?.at(-1)?.status, 'failed')
  assert.equal(status.timeline?.at(-1)?.code, 'runtime.process_launch.failed')
  assert.equal(phaseCheck?.status, 'fail')
  assert.equal(phaseCheck?.severity, 'error')
  assert.equal(phaseCheck?.evidence?.loadingPhase, 'managed-server')
  assert.equal(phaseCheck?.evidence?.readinessPhase, 'process-launch')
  assert.match(phaseCheck?.message || '', /\[REDACTED_TOKEN\]/)
  assert.equal(aggregateCheck?.status, 'fail')
})

test('runtime initialization errors classify event stream startup failures separately', () => {
  resetRuntimeStatus()
  setRuntimeInitializationPhase('connecting-events', 'Connecting event stream.')

  resolveRuntimeInitializationError('Event stream auth health check failed.')

  const status = getRuntimeStatus()
  const phaseCheck = status.checks?.find((check) => check.code === 'runtime.event_stream.failed')

  assert.equal(status.timeline?.at(-1)?.phase, 'event-stream')
  assert.equal(status.timeline?.at(-1)?.code, 'runtime.event_stream.failed')
  assert.equal(phaseCheck?.status, 'fail')
  assert.equal(phaseCheck?.evidence?.loadingPhase, 'connecting-events')
})
