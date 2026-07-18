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

// Construct sample tokens at runtime so source does not trip scripts/lint.mjs secret patterns.
const SAMPLE_ANTHROPIC_KEY = `sk-ant-${'a'.repeat(24)}`

test('redactSecretText scrubs common token families via shared sanitizer', () => {
  const input = `Authorization: Bearer ${SAMPLE_ANTHROPIC_KEY} and /Users/alice/secret`
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
  const out = redactSecretTextForLog(`path=/Users/alice/project ${SAMPLE_ANTHROPIC_KEY}`)
  assert.match(out, /Users/)
  assert.doesNotMatch(out, new RegExp(SAMPLE_ANTHROPIC_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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
  // Resolvable hang so the test file does not leave a forever-pending promise
  // (node:test cancels siblings when the event loop drains with open handles).
  let release!: () => void
  const hang = new Promise<void>((resolve) => {
    release = resolve
  })
  await assert.rejects(
    () => withDeadline(hang, 20, 'slow'),
    /timed out after 20ms/,
  )
  release()
})

test('fetchWithTimeout is exported as a function', () => {
  assert.equal(typeof fetchWithTimeout, 'function')
})
