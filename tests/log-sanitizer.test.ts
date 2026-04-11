import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeLogMessage, shortSessionId } from '../apps/desktop/src/main/log-sanitizer.ts'

test('sanitizeLogMessage redacts env-backed secrets, emails, and token-like values', () => {
  process.env.DATABRICKS_TOKEN = 'super-secret-token'

  const sanitized = sanitizeLogMessage(
    'email jane@example.com token super-secret-token bearer ya29.a0AfH6SMB1234',
  )

  assert.equal(
    sanitized,
    'email [REDACTED_EMAIL] token [REDACTED_SECRET] bearer [REDACTED_TOKEN]',
  )
})

test('shortSessionId keeps the tail for readable session references', () => {
  assert.equal(shortSessionId('ses_1234567890abcdef'), '90abcdef')
  assert.equal(shortSessionId('short-id'), 'short-id')
  assert.equal(shortSessionId(null), 'unknown')
})
