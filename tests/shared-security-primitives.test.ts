import test from 'node:test'
import assert from 'node:assert/strict'
import {
  redactSecretRecord,
  redactSecretText,
  redactSecretTextForLog,
} from '@open-cowork/shared'
import {
  constantTimeEquals,
  constantTimeEqualsDigest,
  fetchWithTimeout,
  isLoopbackOrPrivateHost,
  withDeadline,
} from '@open-cowork/shared/node'

test('redactSecretText scrubs common token families via shared sanitizer', () => {
  const input = 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz12 and /Users/alice/secret'
  const out = redactSecretText(input)
  assert.doesNotMatch(out, /sk-ant-/)
  assert.doesNotMatch(out, /alice/)
  assert.match(out, /REDACTED/)
})

test('redactSecretRecord redacts secret-looking keys', () => {
  const out = redactSecretRecord({
    botToken: '12345:ABCDEFGHIJKLMNOPQRSTUV',
    title: 'ok',
  })
  assert.equal(out.title, 'ok')
  assert.match(String(out.botToken), /redacted/)
})

test('redactSecretTextForLog keeps home paths (log path)', () => {
  const out = redactSecretTextForLog('path=/Users/alice/project sk-ant-abcdefghijklmnopqrstuvwxyz12')
  assert.match(out, /Users/)
  assert.doesNotMatch(out, /sk-ant-abcdefghijklmnopqrstuvwxyz12/)
})

test('constantTimeEquals and digest reject empty secrets', () => {
  assert.equal(constantTimeEquals('', 'x'), false)
  assert.equal(constantTimeEqualsDigest('', 'x'), false)
  assert.equal(constantTimeEquals('abc', 'abc'), true)
  assert.equal(constantTimeEqualsDigest('abc', 'abc'), true)
  assert.equal(constantTimeEquals('abc', 'abd'), false)
})

test('isLoopbackOrPrivateHost covers RFC1918 and localhost', () => {
  assert.equal(isLoopbackOrPrivateHost('127.0.0.1'), true)
  assert.equal(isLoopbackOrPrivateHost('10.1.2.3'), true)
  assert.equal(isLoopbackOrPrivateHost('192.168.1.1'), true)
  assert.equal(isLoopbackOrPrivateHost('8.8.8.8'), false)
  assert.equal(isLoopbackOrPrivateHost('example.com'), false)
  assert.equal(isLoopbackOrPrivateHost('host.docker.internal'), true)
})

test('withDeadline rejects after timeout', async () => {
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 20, 'slow'),
    /timed out after 20ms/,
  )
})

test('fetchWithTimeout is exported as a function', () => {
  assert.equal(typeof fetchWithTimeout, 'function')
})
