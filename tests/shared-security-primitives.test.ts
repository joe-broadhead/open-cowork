import test from 'node:test'
import assert from 'node:assert/strict'
import {
  redactSecretRecord,
  redactSecretText,
  redactSecretTextForLog,
} from '@open-cowork/shared'
import {
  assertPrivateHttpEndpoint,
  constantTimeEquals,
  constantTimeEqualsDigest,
  fetchWithTimeout,
  isCloudMetadataHost,
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

test('isCloudMetadataHost and assertPrivateHttpEndpoint refuse IMDS targets', () => {
  assert.equal(isCloudMetadataHost('169.254.169.254'), true)
  assert.equal(isCloudMetadataHost('metadata.google.internal'), true)
  assert.equal(isCloudMetadataHost('metadata'), true)
  assert.equal(isCloudMetadataHost('fd00:ec2::254'), true)
  assert.equal(isCloudMetadataHost('10.0.0.1'), false)
  assert.equal(isCloudMetadataHost('127.0.0.1'), false)

  assert.throws(
    () => assertPrivateHttpEndpoint('http://169.254.169.254/latest/meta-data/'),
    /instance-metadata/,
  )
  assert.throws(
    () => assertPrivateHttpEndpoint('http://metadata.google.internal/computeMetadata/v1/'),
    /instance-metadata/,
  )
  // Lab OpenCode on plain RFC1918 remains allowed.
  const privateUrl = assertPrivateHttpEndpoint('http://10.0.0.5:4096/')
  assert.equal(privateUrl.hostname, '10.0.0.5')
})

test('withDeadline rejects after timeout', async () => {
  let lateSettled = false
  const late = new Promise<string>((resolve) => {
    setTimeout(() => {
      lateSettled = true
      resolve('late')
    }, 200)
  })
  await assert.rejects(
    () => withDeadline(late, 30, 'slow'),
    /timed out after 30ms/,
  )
  // Drain the late timer so the suite does not leak a pending promise/handle.
  await new Promise((resolve) => setTimeout(resolve, 220))
  assert.equal(lateSettled, true)
})

test('fetchWithTimeout is exported as a function', () => {
  assert.equal(typeof fetchWithTimeout, 'function')
})
