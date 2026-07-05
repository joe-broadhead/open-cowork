import test from 'node:test'
import assert from 'node:assert/strict'
import {
  asRecord,
  boundedOptionalText,
  boundedText,
  includesAllowed,
  normalizeControlPlaneRole,
  normalizeEmailAddress,
  normalizeMembershipStatus,
  normalizedCloudListLimit,
  readNullableString,
  readString,
  stableCloudId,
} from '@open-cowork/cloud-server/session-input-validation'

// Focused coverage for the pure session-service input validators/normalizers
// extracted from session-service.ts — including the security-adjacent role/status
// normalization (clamps unknown input to a safe enum value) and the content-hash
// stable-id helper.

test('asRecord coerces plain objects and rejects arrays/primitives', () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 })
  assert.deepEqual(asRecord([1, 2]), {})
  assert.deepEqual(asRecord('x'), {})
  assert.deepEqual(asRecord(null), {})
})

test('readString returns trimmed-non-empty or the fallback', () => {
  assert.equal(readString('hi'), 'hi')
  assert.equal(readString('  '), '')
  assert.equal(readString(42, 'fb'), 'fb')
  assert.equal(readString(undefined, 'fb'), 'fb')
})

test('readNullableString trims or returns null', () => {
  assert.equal(readNullableString('  hi  '), 'hi')
  assert.equal(readNullableString('   '), null)
  assert.equal(readNullableString(5), null)
})

test('boundedText requires a value and enforces the max length', () => {
  assert.equal(boundedText('  hi  ', 'Name', 10), 'hi')
  assert.throws(() => boundedText('', 'Name', 10), /Name is required/)
  assert.throws(() => boundedText('x'.repeat(11), 'Name', 10), /exceeds 10 characters/)
})

test('boundedOptionalText passes through null/empty and otherwise bounds', () => {
  assert.equal(boundedOptionalText(undefined, 'Bio', 10), null)
  assert.equal(boundedOptionalText('', 'Bio', 10), null)
  assert.equal(boundedOptionalText(' hi ', 'Bio', 10), 'hi')
  assert.throws(() => boundedOptionalText('x'.repeat(11), 'Bio', 10), /exceeds/)
})

test('includesAllowed treats a null allow-list as "any" and otherwise checks membership', () => {
  assert.equal(includesAllowed('a', null), true)
  assert.equal(includesAllowed('a', ['a', 'b']), true)
  assert.equal(includesAllowed('c', ['a', 'b']), false)
  assert.equal(includesAllowed(null, ['a']), false)
})

test('normalizeControlPlaneRole clamps unknown input to the fallback', () => {
  assert.equal(normalizeControlPlaneRole('owner'), 'owner')
  assert.equal(normalizeControlPlaneRole('admin'), 'admin')
  assert.equal(normalizeControlPlaneRole('superuser'), 'member')
  assert.equal(normalizeControlPlaneRole(undefined, 'admin'), 'admin')
})

test('normalizeMembershipStatus clamps unknown input to the fallback', () => {
  assert.equal(normalizeMembershipStatus('invited'), 'invited')
  assert.equal(normalizeMembershipStatus('banned'), 'active')
  assert.equal(normalizeMembershipStatus(null, 'disabled'), 'disabled')
})

test('stableCloudId is deterministic, prefixed, and a 32-hex digest', () => {
  const id = stableCloudId('tok', 'a', 'b')
  assert.match(id, /^tok_[0-9a-f]{32}$/)
  assert.equal(stableCloudId('tok', 'a', 'b'), id)
  assert.notEqual(stableCloudId('tok', 'a', 'c'), id)
  // Joined with a NUL separator, so ['a','b'] and ['ab'] do not collide.
  assert.notEqual(stableCloudId('tok', 'ab'), id)
})

test('normalizeEmailAddress trims/lowercases valid emails and rejects invalid input', () => {
  assert.equal(normalizeEmailAddress('  User@Example.COM '), 'user@example.com')
  assert.throws(() => normalizeEmailAddress('not-an-email'), /valid member email/)
  assert.throws(() => normalizeEmailAddress(''), /valid member email/)
  assert.throws(() => normalizeEmailAddress('a@b'), /valid member email/)
  assert.throws(() => normalizeEmailAddress(`${'x'.repeat(250)}@example.com`), /valid member email/)
  assert.throws(() => normalizeEmailAddress(42), /valid member email/)
})

test('normalizedCloudListLimit clamps to [1, max] and falls back on non-finite input', () => {
  assert.equal(normalizedCloudListLimit(50), 50)
  assert.equal(normalizedCloudListLimit(9999, 100, 500), 500)
  assert.equal(normalizedCloudListLimit(0, 100), 100)
  assert.equal(normalizedCloudListLimit(null, 25), 25)
  assert.equal(normalizedCloudListLimit(Number.NaN, 25), 25)
  assert.equal(normalizedCloudListLimit(-5, 100, 500), 1)
})
