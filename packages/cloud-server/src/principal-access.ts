import type { ApiTokenScope, ControlPlanePermission } from './control-plane-store.ts'
import type { CloudPrincipal } from './session-service.ts'

function principalHasOrgAdminRole(principal: CloudPrincipal) {
  return principal.role === 'owner' || principal.role === 'admin'
}

/**
 * Built-in human roles keep their established owner/admin authority. When a
 * custom role is assigned, its resolved permission map replaces that base role
 * and becomes authoritative for both upgrades and downgrades.
 */
export function principalHasHumanPermissionOrAdminRole(
  principal: CloudPrincipal,
  permissions: readonly ControlPlanePermission[],
) {
  if (principal.authSource === 'api_token' || principal.authSource === 'worker') return false
  if (principal.customRoleKey !== undefined && principal.customRoleKey !== null) {
    if (!principal.customRoleKey.trim() || !Array.isArray(principal.permissions)) return false
    return permissions.some((permission) => principal.permissions?.includes(permission))
  }
  return principalHasOrgAdminRole(principal)
}

export function principalHasTokenScope(principal: CloudPrincipal, scope: ApiTokenScope) {
  return principal.tokenScopes?.includes(scope) || false
}

export function principalHasPrivilegedTokenScope(
  principal: CloudPrincipal,
  scope: ApiTokenScope,
  permissions: readonly ControlPlanePermission[] = [],
) {
  if (!principalHasTokenScope(principal, scope)) return false
  if (principal.customRoleKey !== undefined && principal.customRoleKey !== null) {
    if (!principal.customRoleKey.trim() || !Array.isArray(principal.permissions)) return false
    return permissions.some((permission) => principal.permissions?.includes(permission))
  }
  return principalHasOrgAdminRole(principal)
}
