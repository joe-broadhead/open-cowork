import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getRuntimeStatus,
  isRuntimeReady,
  setRuntimeError,
  setRuntimeReady,
} from '../apps/desktop/src/main/runtime-status.ts'

function resetRuntimeStatus() {
  setRuntimeReady(false, null)
}

test('runtime status starts not ready with no error after reset', () => {
  resetRuntimeStatus()

  assert.equal(isRuntimeReady(), false)
  assert.deepEqual(getRuntimeStatus(), {
    ready: false,
    error: null,
  })
})

test('setRuntimeReady clears an old error when readiness becomes true', () => {
  resetRuntimeStatus()
  setRuntimeError('runtime failed')

  setRuntimeReady(true)

  assert.equal(isRuntimeReady(), true)
  assert.deepEqual(getRuntimeStatus(), {
    ready: true,
    error: null,
  })
})

test('setRuntimeReady can preserve or replace the current error explicitly', () => {
  resetRuntimeStatus()
  setRuntimeError('old error')

  setRuntimeReady(false)
  assert.deepEqual(getRuntimeStatus(), {
    ready: false,
    error: 'old error',
  })

  setRuntimeReady(false, 'new error')
  assert.deepEqual(getRuntimeStatus(), {
    ready: false,
    error: 'new error',
  })
})

test('setRuntimeError makes the runtime not ready while clear keeps readiness unchanged', () => {
  resetRuntimeStatus()
  setRuntimeReady(true)

  setRuntimeError('boot failed')
  assert.deepEqual(getRuntimeStatus(), {
    ready: false,
    error: 'boot failed',
  })

  setRuntimeReady(true)
  setRuntimeError(null)
  assert.deepEqual(getRuntimeStatus(), {
    ready: true,
    error: null,
  })
})
