import test from 'node:test'
import assert from 'node:assert/strict'
import {
  firstHeader,
  parseLimit,
  parseSequenceValue,
  parseSessionStatus,
  parseTagIds,
  readApiTokenScopes,
  readChannelProvider,
  readEnum,
  readNonNegativeInteger,
  readRecord,
  readString,
  readStringArray,
} from '@open-cowork/cloud-server/http-request-parsers'

// Focused edge-case coverage for the pure HTTP request parsers extracted from
// http-server.ts. The 100-test cloud-http-server suite exercises these through
// routes; these lock the validation boundaries directly.

test('readString returns trimmed-non-empty strings and rejects everything else', () => {
  assert.equal(readString('hello'), 'hello')
  assert.equal(readString('   '), null)
  assert.equal(readString(''), null)
  assert.equal(readString(42), null)
  assert.equal(readString(null), null)
  assert.equal(readString(undefined), null)
})

test('readStringArray accepts only arrays of strings', () => {
  assert.deepEqual(readStringArray(['a', 'b']), ['a', 'b'])
  assert.deepEqual(readStringArray([]), [])
  assert.equal(readStringArray(['a', 1]), null)
  assert.equal(readStringArray('a'), null)
  assert.equal(readStringArray(null), null)
})

test('readApiTokenScopes validates against the allowed set, dedupes, and rejects unknowns', () => {
  assert.deepEqual(readApiTokenScopes(['desktop', 'admin']), ['desktop', 'admin'])
  assert.deepEqual(readApiTokenScopes(['gateway', 'gateway']), ['gateway'])
  assert.equal(readApiTokenScopes(['desktop', 'root']), null)
  assert.equal(readApiTokenScopes([]), null)
  assert.equal(readApiTokenScopes('desktop'), null)
})

test('readChannelProvider accepts known providers and hyphenated custom ids only', () => {
  assert.equal(readChannelProvider('telegram'), 'telegram')
  assert.equal(readChannelProvider('slack'), 'slack')
  assert.equal(readChannelProvider('custom-provider'), 'custom-provider')
  assert.equal(readChannelProvider('nohyphen'), undefined)
  assert.equal(readChannelProvider('Bad-Caps'), undefined)
  assert.equal(readChannelProvider(''), undefined)
  assert.equal(readChannelProvider(42), undefined)
})

test('parseSessionStatus passes known statuses and throws on unknown', () => {
  assert.equal(parseSessionStatus('running'), 'running')
  assert.equal(parseSessionStatus('idle'), 'idle')
  assert.equal(parseSessionStatus(null), null)
  assert.throws(() => parseSessionStatus('bogus'), /Unsupported session status/)
})

test('parseLimit returns positive integers or undefined', () => {
  assert.equal(parseLimit(new URL('https://x/?limit=10')), 10)
  assert.equal(parseLimit(new URL('https://x/?limit=0')), undefined)
  assert.equal(parseLimit(new URL('https://x/?limit=-5')), undefined)
  assert.equal(parseLimit(new URL('https://x/?limit=abc')), undefined)
  assert.equal(parseLimit(new URL('https://x/')), undefined)
})

test('parseSequenceValue clamps to a non-negative integer, defaulting to 0', () => {
  assert.equal(parseSequenceValue('5'), 5)
  assert.equal(parseSequenceValue('-3'), 0)
  assert.equal(parseSequenceValue('nope'), 0)
  assert.equal(parseSequenceValue(null), 0)
  assert.equal(parseSequenceValue(undefined), 0)
})

test('readNonNegativeInteger falls back on invalid or negative input', () => {
  assert.equal(readNonNegativeInteger(7), 7)
  assert.equal(readNonNegativeInteger(0), 0)
  assert.equal(readNonNegativeInteger(-1), 0)
  assert.equal(readNonNegativeInteger('bad', 3), 3)
  assert.equal(readNonNegativeInteger(undefined, 9), 9)
})

test('readEnum only returns values within the allowed list', () => {
  const tones = ['a', 'b', 'c'] as const
  assert.equal(readEnum('b', tones), 'b')
  assert.equal(readEnum('z', tones), undefined)
  assert.equal(readEnum(5, tones), undefined)
})

test('readRecord returns plain objects only', () => {
  assert.deepEqual(readRecord({ a: 1 }), { a: 1 })
  assert.equal(readRecord([1, 2]), null)
  assert.equal(readRecord('x'), null)
  assert.equal(readRecord(null), null)
})

test('parseTagIds merges repeated query params and comma-separated values', () => {
  assert.deepEqual(parseTagIds(new URL('https://x/?tagId=a&tagId=b&tagIds=c,d, e ')), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(parseTagIds(new URL('https://x/')), [])
})

test('firstHeader collapses string-array headers to the first value', () => {
  assert.equal(firstHeader(['one', 'two']), 'one')
  assert.equal(firstHeader('solo'), 'solo')
  assert.equal(firstHeader(undefined), '')
  assert.equal(firstHeader([]), '')
})
