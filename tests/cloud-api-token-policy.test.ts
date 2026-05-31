import test from 'node:test'
import assert from 'node:assert/strict'

import {
  enforceApiTokenScopePolicy,
  normalizeApiTokenExpiresAt,
  normalizeApiTokenScopes,
  resolvedSignupMode,
} from '../apps/desktop/src/main/cloud/services/api-token-policy.ts'
import { CloudServiceError } from '../apps/desktop/src/main/cloud/cloud-service-error.ts'

test('cloud API token policy normalizes TTL, scope, and signup policy outside session service', () => {
  assert.deepEqual(normalizeApiTokenScopes(['desktop', 'desktop', 'gateway']), ['desktop', 'gateway'])
  assert.deepEqual(enforceApiTokenScopePolicy(['desktop'], {
    allowSelfServiceSignup: true,
    apiTokenAllowedScopes: ['desktop'],
  }), ['desktop'])
  assert.equal(resolvedSignupMode({ allowSelfServiceSignup: false }), 'invite')
  assert.equal(resolvedSignupMode({ allowSelfServiceSignup: true, allowedEmailDomains: ['example.com'] }), 'domain')

  const now = new Date('2026-05-31T12:00:00.000Z')
  assert.equal(
    normalizeApiTokenExpiresAt(null, {
      allowSelfServiceSignup: true,
      apiTokenDefaultTtlMs: 1000,
      apiTokenMaxTtlMs: 2000,
    }, now).toISOString(),
    '2026-05-31T12:00:01.000Z',
  )
})

test('cloud API token policy rejects unsupported or disabled scopes', () => {
  assert.throws(() => normalizeApiTokenScopes(['unsupported' as never]), CloudServiceError)
  assert.throws(() => normalizeApiTokenScopes([]), CloudServiceError)
  assert.throws(() => enforceApiTokenScopePolicy(['admin'], {
    allowSelfServiceSignup: true,
    apiTokenAllowedScopes: ['desktop'],
  }), /disabled by cloud policy/)
})
