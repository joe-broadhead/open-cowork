import type { ApiTokenScope } from './control-plane-store.ts'
import type { CloudPrincipal } from './session-service.ts'

export function principalHasOrgAdminRole(principal: CloudPrincipal) {
  return principal.role === 'owner' || principal.role === 'admin'
}

export function principalHasTokenScope(principal: CloudPrincipal, scope: ApiTokenScope) {
  return principal.tokenScopes?.includes(scope) || principal.tokenScopes?.includes('admin') || false
}

export function principalHasPrivilegedTokenScope(principal: CloudPrincipal, scope: ApiTokenScope) {
  return principalHasOrgAdminRole(principal) && principalHasTokenScope(principal, scope)
}
