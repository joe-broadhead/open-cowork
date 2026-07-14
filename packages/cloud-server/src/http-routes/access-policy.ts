import type { CloudPrincipal } from '../session-service.ts'
import {
  principalHasOrgAdminRole,
  principalHasPrivilegedTokenScope,
  principalHasTokenScope,
} from '../principal-access.ts'

export type GatewayRouteAccessInput = {
  resource: string | undefined
  action: string | undefined
  method: string | undefined
  sessionId: string | undefined
  artifactId: string | undefined
}

export function principalHasGatewayAccess(principal: CloudPrincipal) {
  if (principal.authSource === 'local' || principal.authSource === 'header') return true
  if (principal.authSource === 'api_token') {
    return principalHasPrivilegedTokenScope(principal, 'gateway')
  }
  return principalHasOrgAdminRole(principal)
}

export function principalHasDesktopApiAccess(principal: CloudPrincipal) {
  if (principal.authSource === 'worker') return false
  if (principal.authSource === 'api_token') {
    return principalHasTokenScope(principal, 'desktop')
  }
  return true
}

export function routeAllowsWorkerCredential(input: GatewayRouteAccessInput) {
  return input.resource === 'workers' && Boolean(input.sessionId) && input.action === 'heartbeat'
}

export function routeAllowsGatewayOnlyToken(input: GatewayRouteAccessInput) {
  return input.resource === 'channels'
    || (input.resource === 'coordination' && input.sessionId === 'watches')
    || (
      input.resource === 'sessions'
      && Boolean(input.sessionId)
      && input.method === 'GET'
      && (!input.action || input.action === 'view' || input.action === 'events'
        || (input.action === 'artifacts' && Boolean(input.artifactId)))
    )
}

export function principalCanUseGatewayOnlyRoute(principal: CloudPrincipal, input: GatewayRouteAccessInput) {
  if (principal.authSource !== 'api_token') return false
  if (!principalHasPrivilegedTokenScope(principal, 'gateway')) return false
  if (input.resource === 'channels') return true
  if (input.resource === 'coordination' && input.sessionId === 'watches') return true
  if (input.resource !== 'sessions' || !input.sessionId || input.method !== 'GET') return false
  if (!input.action || input.action === 'view' || input.action === 'events') return true
  return input.action === 'artifacts' && Boolean(input.artifactId)
}

export function routeAllowsOperationalToken(principal: CloudPrincipal, input: GatewayRouteAccessInput) {
  if (principal.authSource !== 'api_token') return false
  const adminOperator = principalHasOrgAdminRole(principal) && Boolean(principal.tokenScopes?.includes('operator'))
  const workerInternal = Boolean(principal.tokenScopes?.includes('worker-internal'))
  if ((!adminOperator && !workerInternal) || input.method !== 'GET') return false
  if (input.resource === 'metrics' || input.resource === 'diagnostics') return adminOperator
  if (input.resource === 'workers' && input.sessionId === 'heartbeats' && !input.action) return true
  return input.resource === 'runtime' && input.sessionId === 'status' && !input.action
}
