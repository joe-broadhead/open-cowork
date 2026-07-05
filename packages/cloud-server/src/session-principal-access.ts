import { principalHasOrgAdminRole, principalHasPrivilegedTokenScope } from './principal-access.ts'
import type { CloudPrincipal } from './session-service.ts'

// Pure principal-authorization predicates for the cloud session service: who may
// manage billing / API tokens / the org, and who may view operations /
// diagnostics. Extracted from session-service.ts so these security-relevant
// access checks live in one focused, directly-testable module. No service state.

export function principalCanManageBilling(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') return principalHasPrivilegedTokenScope(principal, 'admin')
  return principalHasOrgAdminRole(principal)
}

export function principalCanManageApiTokens(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') return principalHasPrivilegedTokenScope(principal, 'admin')
  return principalHasOrgAdminRole(principal)
}

export function principalCanManageOrg(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') return principalHasPrivilegedTokenScope(principal, 'admin')
  return principalHasOrgAdminRole(principal)
}

export function principalEmailDomain(email: string | null | undefined) {
  const normalized = email?.trim().toLowerCase()
  const at = normalized?.lastIndexOf('@') ?? -1
  return normalized && at >= 0 ? normalized.slice(at + 1) : null
}

export function principalCanViewOperations(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') {
    return Boolean(
      principal.tokenScopes?.includes('worker-internal')
      || (principalHasOrgAdminRole(principal) && principal.tokenScopes?.includes('operator'))
    )
  }
  return false
}

export function principalCanViewDiagnostics(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') {
    return principalHasOrgAdminRole(principal) && Boolean(principal.tokenScopes?.includes('operator'))
  }
  return false
}
