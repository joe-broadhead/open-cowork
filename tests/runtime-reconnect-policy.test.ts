import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldScheduleRuntimeReconnect } from '../apps/desktop/src/main/runtime-reconnect-policy.ts'

test('runtime reconnect remains enabled after startup cleanup', () => {
  assert.equal(shouldScheduleRuntimeReconnect({
    appCleanupStarted: false,
    appIsQuitting: false,
    reconnectTimerActive: false,
  }), true)
})

test('runtime reconnect is blocked only by shutdown or an active reconnect timer', () => {
  assert.equal(shouldScheduleRuntimeReconnect({
    appCleanupStarted: true,
    appIsQuitting: false,
    reconnectTimerActive: false,
  }), false)
  assert.equal(shouldScheduleRuntimeReconnect({
    appCleanupStarted: false,
    appIsQuitting: true,
    reconnectTimerActive: false,
  }), false)
  assert.equal(shouldScheduleRuntimeReconnect({
    appCleanupStarted: false,
    appIsQuitting: false,
    reconnectTimerActive: true,
  }), false)
})
