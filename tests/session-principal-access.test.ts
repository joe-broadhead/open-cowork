import test from 'node:test'
import assert from 'node:assert/strict'
import type { CloudPrincipal } from '../apps/desktop/src/main/cloud/session-service.ts'
import {
  principalCanManageBilling,
  principalCanManageOrg,
  principalCanViewDiagnostics,
  principalCanViewOperations,
  principalEmailDomain,
} from '../apps/desktop/src/main/cloud/session-principal-access.ts'

// Security-focused coverage for the principal-authorization predicates extracted
// from session-service.ts: local principals are fully trusted, org-role gates
// management, and api_token principals require BOTH an admin role AND the right
// token scope. These are the access-control boundaries for billing/org/ops, so
// the negative cases (a member, or an admin token missing the scope) matter most.

function principal(overrides: Partial<CloudPrincipal>): CloudPrincipal {
  return {
    authSource: 'cloud',
    role: 'member',
    tokenScopes: [],
    userId: 'u1',
    ...overrides,
  } as unknown as CloudPrincipal
}

test('local principals may manage billing/org and view ops/diagnostics', () => {
  const local = principal({ authSource: 'local' })
  assert.equal(principalCanManageBilling(local), true)
  assert.equal(principalCanManageOrg(local), true)
  assert.equal(principalCanViewOperations(local), true)
  assert.equal(principalCanViewDiagnostics(local), true)
})

test('cloud management requires an org admin/owner role', () => {
  assert.equal(principalCanManageBilling(principal({ authSource: 'cloud', role: 'owner' })), true)
  assert.equal(principalCanManageBilling(principal({ authSource: 'cloud', role: 'admin' })), true)
  assert.equal(principalCanManageBilling(principal({ authSource: 'cloud', role: 'member' })), false)
  assert.equal(principalCanManageOrg(principal({ authSource: 'cloud', role: 'member' })), false)
})

test('api_token management requires BOTH an admin role AND an admin token scope', () => {
  // Admin role + admin scope → allowed.
  assert.equal(principalCanManageBilling(principal({ authSource: 'api_token', role: 'admin', tokenScopes: ['admin'] })), true)
  // Admin role but no admin scope → denied (scope gate).
  assert.equal(principalCanManageBilling(principal({ authSource: 'api_token', role: 'admin', tokenScopes: ['operator'] })), false)
  // Admin scope but member role → denied (role gate).
  assert.equal(principalCanManageBilling(principal({ authSource: 'api_token', role: 'member', tokenScopes: ['admin'] })), false)
})

test('viewing operations: worker-internal scope, or admin role + operator scope', () => {
  assert.equal(principalCanViewOperations(principal({ authSource: 'api_token', role: 'member', tokenScopes: ['worker-internal'] })), true)
  assert.equal(principalCanViewOperations(principal({ authSource: 'api_token', role: 'admin', tokenScopes: ['operator'] })), true)
  assert.equal(principalCanViewOperations(principal({ authSource: 'api_token', role: 'member', tokenScopes: ['operator'] })), false)
  assert.equal(principalCanViewOperations(principal({ authSource: 'cloud', role: 'admin' })), false)
})

test('viewing diagnostics requires admin role + operator scope for api tokens', () => {
  assert.equal(principalCanViewDiagnostics(principal({ authSource: 'api_token', role: 'admin', tokenScopes: ['operator'] })), true)
  assert.equal(principalCanViewDiagnostics(principal({ authSource: 'api_token', role: 'admin', tokenScopes: [] })), false)
  assert.equal(principalCanViewDiagnostics(principal({ authSource: 'api_token', role: 'member', tokenScopes: ['operator'] })), false)
  assert.equal(principalCanViewDiagnostics(principal({ authSource: 'cloud', role: 'owner' })), false)
})

test('principalEmailDomain extracts the lowercased domain', () => {
  assert.equal(principalEmailDomain('User@Example.COM'), 'example.com')
  assert.equal(principalEmailDomain('no-at-sign'), null)
  assert.equal(principalEmailDomain(null), null)
  assert.equal(principalEmailDomain(undefined), null)
})
