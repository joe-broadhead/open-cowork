import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyProviderFailure } from '../dist/provider-errors.js'

test('classifyProviderFailure defaults unknown errors to non-transient (delivery send path)', () => {
  // No idempotency key on a non-webhook send → an ambiguous failure must NOT be retried (P2-16).
  assert.equal(classifyProviderFailure(new Error('provider exploded in a novel way')).transient, false)
  assert.equal(classifyProviderFailure(new Error('weird')).transient, false)
})

test('classifyProviderFailure retries unknown errors when the caller opts in (idempotent re-render)', () => {
  assert.equal(classifyProviderFailure(new Error('provider down'), { defaultTransient: true }).transient, true)
})

test('classifyProviderFailure honours known signals regardless of the default', () => {
  // Known-transient is retried even on the conservative (delivery) default.
  for (const message of ['ETIMEDOUT connecting', 'socket hang up', 'HTTP 503 Service Unavailable', '429 Too Many Requests']) {
    assert.equal(classifyProviderFailure(new Error(message)).transient, true, message)
  }
  // Known-permanent is never retried even on the permissive (session) default.
  for (const message of ['channel does not support attachments', 'message too large', 'invalid recipient']) {
    assert.equal(classifyProviderFailure(new Error(message), { defaultTransient: true }).transient, false, message)
  }
})
