import assert from 'node:assert/strict'
import test from 'node:test'
import {
  attemptReconnectDelayMs,
  cloudDurableReconnectDelayMs,
  desktopDurableReconnectDelayMs,
  exponentialReconnectDelayMs,
  nextReconnectFailureCount,
  OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD,
  OPENCODE_DURABLE_RECONNECT_INITIAL_MS_DESKTOP,
  OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD,
  OPENCODE_DURABLE_RECONNECT_MAX_MS_DESKTOP,
  OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS,
  waitForAbortableDelay,
} from '@open-cowork/runtime-host'

test('exponentialReconnectDelayMs grows until cap', () => {
  assert.equal(
    exponentialReconnectDelayMs(1, OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD, OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD),
    100,
  )
  assert.equal(
    exponentialReconnectDelayMs(2, OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD, OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD),
    200,
  )
  assert.equal(
    exponentialReconnectDelayMs(10, OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD, OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD),
    OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD,
  )
})

test('named cloud/desktop reconnect helpers match constants', () => {
  assert.equal(cloudDurableReconnectDelayMs(1), OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD)
  assert.equal(desktopDurableReconnectDelayMs(1), OPENCODE_DURABLE_RECONNECT_INITIAL_MS_DESKTOP)
  assert.equal(cloudDurableReconnectDelayMs(20), OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD)
  assert.equal(desktopDurableReconnectDelayMs(20), OPENCODE_DURABLE_RECONNECT_MAX_MS_DESKTOP)
})

test('attemptReconnectDelayMs respects attempt caps', () => {
  assert.equal(attemptReconnectDelayMs(0, 100, 1000, 3), 100)
  assert.equal(attemptReconnectDelayMs(1, 100, 1000, 3), 200)
  assert.equal(attemptReconnectDelayMs(3, 100, 1000, 3), null)
  assert.equal(attemptReconnectDelayMs(0, 100, 1000, 0), null)
})

test('nextReconnectFailureCount resets after receive', () => {
  assert.equal(nextReconnectFailureCount(5, true), 1)
  assert.equal(nextReconnectFailureCount(5, false), 6)
  assert.equal(nextReconnectFailureCount(16, false), 16)
})

test('waitForAbortableDelay resolves on abort', async () => {
  const controller = new AbortController()
  const pending = waitForAbortableDelay(controller.signal, 60_000)
  controller.abort()
  await pending
})

test('owned SSE retry constant is 1', () => {
  assert.equal(OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS, 1)
})
