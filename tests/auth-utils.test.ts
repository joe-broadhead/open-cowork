import test from 'node:test'
import assert from 'node:assert/strict'
import { getUsableAccessToken } from '../apps/desktop/src/main/auth-utils.ts'

test('getUsableAccessToken returns token when expiry is comfortably in the future', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0)
  const token = getUsableAccessToken({
    access_token: 'token-123',
    expiry_date: now + 5 * 60_000,
  }, now)

  assert.equal(token, 'token-123')
})

test('getUsableAccessToken returns null when token is expired or within skew window', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0)

  assert.equal(getUsableAccessToken({
    access_token: 'token-123',
    expiry_date: now + 30_000,
  }, now), null)

  assert.equal(getUsableAccessToken({
    access_token: 'token-123',
    expiry_date: now - 1,
  }, now), null)
})
