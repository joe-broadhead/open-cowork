import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeByokProviderId,
  normalizeNonNegativeInteger,
  normalizePositiveInteger,
  normalizeTagColor,
  normalizeText,
  redactOperationalText,
  retryAfterMs,
  windowStart,
} from '@open-cowork/cloud-server/postgres-store-normalizers'

// Focused coverage for the pure normalizers extracted from
// postgres-control-plane-store.ts — including the security-relevant operational
// text redactor (must strip bearer tokens / api keys / provider secrets / long
// hex blobs before any operational text is persisted or surfaced).

test('redactOperationalText strips secrets and bounds length', () => {
  assert.match(redactOperationalText('Authorization: Bearer abc123.def-456', 200, 'x'), /\[redacted\]/)
  assert.match(redactOperationalText('api_key=SUPERSECRETVALUE', 200, 'x'), /api_key=\[redacted\]/)
  assert.match(redactOperationalText('using sk-abcdef123456 today', 200, 'x'), /\[redacted\]/)
  assert.match(redactOperationalText('token ocw_abcd1234efgh', 200, 'x'), /\[redacted\]/)
  // a 32+ char alnum blob is treated as a secret
  assert.match(redactOperationalText(`id ${'a'.repeat(40)}`, 200, 'x'), /\[redacted\]/)
  // truncation with ellipsis (a long but secret-free string is truncated, not redacted)
  const long = redactOperationalText('alpha beta gamma delta epsilon', 10, 'x')
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('...'))
  assert.throws(() => redactOperationalText('   ', 10, 'Note'), /Note is required/)
})

test('normalizeText requires a non-empty value within the max length', () => {
  assert.equal(normalizeText('  hi  ', 10, 'Name'), 'hi')
  assert.throws(() => normalizeText('', 10, 'Name'), /Name is required/)
  assert.throws(() => normalizeText('x'.repeat(11), 10, 'Name'), /exceeds 10 characters/)
})

test('normalizeTagColor accepts #rrggbb or falls back to the default', () => {
  assert.equal(normalizeTagColor('#A1B2C3'), '#A1B2C3')
  assert.equal(normalizeTagColor('red'), '#64748b')
  assert.equal(normalizeTagColor(42), '#64748b')
})

test('normalizeByokProviderId lowercases and validates the id shape', () => {
  assert.equal(normalizeByokProviderId('OpenAI'), 'openai')
  assert.equal(normalizeByokProviderId('aws-bedrock.v2'), 'aws-bedrock.v2')
  assert.throws(() => normalizeByokProviderId('-bad'), /Unsupported BYOK provider id/)
  assert.throws(() => normalizeByokProviderId('has space'), /Unsupported BYOK provider id/)
})

test('integer normalizers enforce their bounds', () => {
  assert.equal(normalizeNonNegativeInteger(0, 'n'), 0)
  assert.equal(normalizeNonNegativeInteger(undefined, 'n'), 0)
  assert.throws(() => normalizeNonNegativeInteger(-1, 'n'), /non-negative integer/)
  assert.throws(() => normalizeNonNegativeInteger(1.5, 'n'), /non-negative integer/)
  assert.equal(normalizePositiveInteger(3, 'n'), 3)
  assert.throws(() => normalizePositiveInteger(0, 'n'), /positive integer/)
})

test('rate-limit window math floors to the window and computes a positive retry', () => {
  assert.equal(windowStart(10_500, 1_000), 10_000)
  assert.equal(retryAfterMs(10_500, 10_000, 1_000), 500)
  // never returns < 1ms
  assert.equal(retryAfterMs(99_999, 10_000, 1_000), 1)
})
