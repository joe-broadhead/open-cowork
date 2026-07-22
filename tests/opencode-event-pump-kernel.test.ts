import assert from 'node:assert/strict'
import test from 'node:test'
import {
  exponentialReconnectDelayMs,
  nextReconnectFailureCount,
  OPENCODE_DURABLE_RECONNECT_INITIAL_MS_CLOUD,
  OPENCODE_DURABLE_RECONNECT_MAX_MS_CLOUD,
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
