import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeForExport, sanitizeLogMessage, shortSessionId } from '../apps/desktop/src/main/log-sanitizer.ts'

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
  const input = '/Users/dev/repo used ghp_0123456789ABCDEFGHIJKLMNOPQRSTUV to push'
  const exported = sanitizeForExport(input)
  assert.match(exported, /\[REDACTED_TOKEN\]/)
  assert.ok(!exported.includes('dev'))
})

test('sanitizeForExport redacts generic bearer authorization headers', () => {
  const exported = sanitizeForExport('curl -H "Authorization: Bearer opaque-token-from-docs" https://api.example.test')
  assert.ok(!exported.includes('opaque-token-from-docs'))
  assert.match(exported, /\[REDACTED_TOKEN\]/)
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
