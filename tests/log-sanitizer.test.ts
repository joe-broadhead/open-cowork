import { sanitizeForExport, sanitizeLogMessage, shortSessionId } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNoSecretFixtureLeaks, redactionFixtureCorpus } from './fixtures/secret-redaction-fixtures.ts'

test('sanitizeLogMessage redacts env-backed secrets, emails, and token-like values', () => {
  process.env.DATABRICKS_TOKEN = 'super-secret-token'

  const sanitized = sanitizeLogMessage(
    'email jane@example.com token super-secret-token bearer ya29.a0AfH6SMB1234 github_pat_0123456789ABCDEFGHIJKLMNOP',
  )

  assert.equal(
    sanitized,
    'email [REDACTED_EMAIL] token [REDACTED_SECRET] bearer [REDACTED_TOKEN] [REDACTED_TOKEN]',
  )
})

test('sanitizeLogMessage redacts the provider token fixture matrix', () => {
  const sanitized = sanitizeLogMessage(redactionFixtureCorpus())
  assertNoSecretFixtureLeaks(sanitized)
  assert.match(sanitized, /\[REDACTED_TOKEN\]/)
})

test('sanitizeLogMessage stays linear on adversarial input (ReDoS regression)', () => {
  // The prior EMAIL/KEYED patterns backtracked quadratically: ~11s on a 160 KB dotted
  // domain. The bounded patterns complete in tens of ms; assert a generous budget so a
  // regression to quadratic (which would blow past 1s) fails loudly without flakiness.
  const dottedDomain = `a@${'a.'.repeat(120_000)}`
  const keywordRun = 'token'.repeat(40_000)
  const longLocal = 'a'.repeat(240_000)
  for (const input of [dottedDomain, keywordRun, longLocal]) {
    const startedAt = Date.now()
    sanitizeLogMessage(input)
    assert.ok(Date.now() - startedAt < 1_000, `sanitizeLogMessage took too long on a ${input.length}-char input`)
  }
})

test('sanitizeLogMessage caps pathological input length', () => {
  const sanitized = sanitizeLogMessage('x'.repeat(2_000_000))
  assert.ok(sanitized.endsWith('…[truncated]'))
  assert.ok(sanitized.length < 300_000)
})

test('shortSessionId keeps the tail for readable session references', () => {
  assert.equal(shortSessionId('ses_1234567890abcdef'), '90abcdef')
  assert.equal(shortSessionId('short-id'), 'short-id')
  assert.equal(shortSessionId(null), 'unknown')
})

test('sanitizeForExport scrubs home-directory paths on top of secret redaction', () => {
  const input = 'Loading config from /Users/alice/work/secret-project/config.json'
  const exported = sanitizeForExport(input)
  assert.ok(!exported.includes('alice'), 'should not leak username')
  assert.ok(!exported.includes('secret-project'), 'should not leak project-folder name')
  assert.match(exported, /\[REDACTED_HOME\]/)
})

test('sanitizeForExport keeps a top-level platform hint so the log stays readable', () => {
  // The sanitizer strips the username AND everything below it —
  // project folder names can also be commercially sensitive. The
  // top-level `/Users` / `/home` prefix survives so readers still
  // see which platform the log came from.
  const macPath = sanitizeForExport('/Users/bob/docs')
  assert.match(macPath, /^\/Users\/\[REDACTED_HOME\]$/)
  const linuxPath = sanitizeForExport('/home/carol/docs')
  assert.match(linuxPath, /^\/home\/\[REDACTED_HOME\]$/)
})

test('sanitizeForExport still applies token redaction', () => {
  const input = `/Users/dev/repo used ${redactionFixtureCorpus()} to push`
  const exported = sanitizeForExport(input)
  assertNoSecretFixtureLeaks(exported)
  assert.match(exported, /\[REDACTED_TOKEN\]/)
  assert.ok(!exported.includes('dev'))
})

test('sanitizeForExport redacts generic bearer authorization headers', () => {
  const exported = sanitizeForExport('curl -H "Authorization: Bearer opaque-token-from-docs" https://api.example.test')
  assert.ok(!exported.includes('opaque-token-from-docs'))
  assert.match(exported, /\[REDACTED_TOKEN\]/)
})

test('sanitizeForExport redacts managed runtime Basic authorization headers', () => {
  const exported = sanitizeForExport('Authorization: Basic b3BlbmNvd29yazpzZWNyZXQ=')
  assert.ok(!exported.includes('b3BlbmNvd29yazpzZWNyZXQ='))
  assert.match(exported, /\[REDACTED_TOKEN\]/)
})

test('sanitizeLogMessage redacts structured authorization values', () => {
  const input = [
    '{"authorization":"Bearer opaque-renderer-token"}',
    '{"Authorization":"Basic b3BlbmNvd29yazpzZWNyZXQ="}',
    'authorization=Bearer query-param-token',
  ].join(' ')
  const sanitized = sanitizeLogMessage(input)

  assert.equal(sanitized.includes('opaque-renderer-token'), false)
  assert.equal(sanitized.includes('b3BlbmNvd29yazpzZWNyZXQ='), false)
  assert.equal(sanitized.includes('query-param-token'), false)
  assert.equal((sanitized.match(/\[REDACTED_TOKEN\]/g) || []).length, 3)
})

test('sanitizeLogMessage redacts webhook and signing header values', () => {
  const input = [
    'x-open-cowork-signature: sha256=abcdef1234567890abcdef1234567890',
    'x-open-cowork-gateway-webhook-signature=sha256=fedcba0987654321fedcba0987654321',
    '"x-slack-signature":"v0=1234567890abcdef1234567890abcdef"',
    'stripe-signature: t=1783590000,v1=0123456789abcdef0123456789abcdef',
    '"signature":"sha256=99999999999999999999999999999999"',
  ].join(' ')
  const sanitized = sanitizeLogMessage(input)

  for (const secret of [
    'abcdef1234567890abcdef1234567890',
    'fedcba0987654321fedcba0987654321',
    '1234567890abcdef1234567890abcdef',
    '0123456789abcdef0123456789abcdef',
    '99999999999999999999999999999999',
  ]) {
    assert.equal(sanitized.includes(secret), false)
  }
  assert.equal((sanitized.match(/\[REDACTED_SIGNATURE\]/g) || []).length, 5)
})

test('sanitizeLogMessage redacts managed runtime env-backed secrets', () => {
  process.env.OPENCODE_SERVER_PASSWORD = 'managed-runtime-password'
  process.env.OPENCODE_CONFIG_CONTENT = '{"provider":{"secret":"value"}}'

  const sanitized = sanitizeLogMessage(
    'password managed-runtime-password config {"provider":{"secret":"value"}}',
  )

  assert.ok(!sanitized.includes('managed-runtime-password'))
  assert.ok(!sanitized.includes('provider'))
  assert.equal((sanitized.match(/\[REDACTED_SECRET\]/g) || []).length, 2)
  delete process.env.OPENCODE_SERVER_PASSWORD
  delete process.env.OPENCODE_CONFIG_CONTENT
})

test('sanitizeLogMessage redacts cloud connection strings and keyed high-entropy values', () => {
  const googleSecret = ['GOC', 'SPX', '-abcdefghijklmnopqrstuvwxyz1234567890'].join('')
  const genericSecret = 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const input = [
    `azure DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${genericSecret};EndpointSuffix=core.windows.net`,
    `google ${googleSecret}`,
    'aws AKIAABCDEFGHIJKLMNOP',
    `client_secret=${genericSecret}`,
  ].join(' ')
  const sanitized = sanitizeLogMessage(input)

  assert.equal((sanitized.match(/\[REDACTED_TOKEN\]/g) || []).length, 4)
  assert.ok(!sanitized.includes('AccountKey=abcdefghijklmnopqrstuvwxyz'))
  assert.ok(!sanitized.includes(googleSecret))
  assert.ok(!sanitized.includes('AKIAABCDEFGHIJKLMNOP'))
  assert.ok(!sanitized.includes('client_secret=abcdefghijklmnopqrstuvwxyz'))
})

test('sanitizeLogMessage redacts cloud secret refs and encrypted envelopes', () => {
  const input = [
    'ref gcp-sm://projects/PROJECT/secrets/open-cowork-secret/versions/latest',
    'aws aws-sm://open-cowork/cloud-secret?region=us-east-1',
    'azure azure-kv://vault/secrets/cloud-secret/v1',
    'url https://vault.vault.azure.net/secrets/cloud-secret/v1',
    'cipher enc:v1:abcdefghijklmnopqrstuvwxyz1234567890',
  ].join(' ')
  const sanitized = sanitizeLogMessage(input)

  assert.equal(sanitized.includes('gcp-sm://'), false)
  assert.equal(sanitized.includes('aws-sm://'), false)
  assert.equal(sanitized.includes('azure-kv://'), false)
  assert.equal(sanitized.includes('vault.azure.net/secrets'), false)
  assert.equal(sanitized.includes('enc:v1:'), false)
  assert.match(sanitized, /\[REDACTED_SECRET_REF\]/)
  assert.match(sanitized, /\[REDACTED_SECRET\]/)
})
