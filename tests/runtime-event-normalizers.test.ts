import { extractRuntimeErrorMessage, normalizePermissionEvent, readRuntimeSessionId } from '@open-cowork/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
test('readRuntimeSessionId accepts SDK sessionID and camelCase sessionId fields', () => {
  assert.equal(readRuntimeSessionId({ sessionID: 'session-a' }), 'session-a')
  assert.equal(readRuntimeSessionId({ sessionId: 'session-b' }), 'session-b')
  assert.equal(readRuntimeSessionId({}), null)
})

test('normalizePermissionEvent merges nested permission payloads with top-level request ids', () => {
  assert.deepEqual(normalizePermissionEvent({
    id: 'perm-1',
    sessionID: 'root-session',
    permission: {
      permission: 'bash',
      title: 'Run shell command',
      metadata: { command: 'pwd' },
    },
  }), {
    id: 'perm-1',
    sessionId: 'root-session',
    permissionType: 'bash',
    title: 'Run shell command',
    input: { command: 'pwd' },
  })
})

test('normalizePermissionEvent prefers nested metadata over input and outer metadata', () => {
  assert.deepEqual(normalizePermissionEvent({
    input: { value: 'outer-input' },
    metadata: { value: 'outer-metadata' },
    permission: {
      id: 'perm-2',
      sessionID: 'root-session',
      type: 'tool',
      input: { value: 'nested-input' },
      metadata: { value: 'nested-metadata' },
    },
  }), {
    id: 'perm-2',
    sessionId: 'root-session',
    permissionType: 'tool',
    title: 'tool',
    input: { value: 'nested-metadata' },
  })
})

test('extractRuntimeErrorMessage reads common nested provider error shapes', () => {
  assert.equal(extractRuntimeErrorMessage({}, {
    error: {
      data: { message: 'provider rejected model' },
    },
  }), 'provider rejected model')

  assert.equal(extractRuntimeErrorMessage({}, {
    response: {
      body: { error: 'rate limited' },
    },
  }), 'rate limited')
})

test('extractRuntimeErrorMessage stringifies unfamiliar payloads before falling back to a generic message', () => {
  const message = extractRuntimeErrorMessage({}, {
    provider_shape: 'unknown',
    nested: { hint: 'inspect this' },
  })

  assert.notEqual(message, 'An error occurred')
  assert.ok(message.includes('provider_shape'))
})
