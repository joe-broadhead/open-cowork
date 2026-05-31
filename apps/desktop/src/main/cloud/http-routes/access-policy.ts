import type { CloudPrincipal } from '../session-service.ts'

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
    return principal.tokenScopes?.includes('gateway') || principal.tokenScopes?.includes('admin') || false
  }
  return principal.role === 'owner' || principal.role === 'admin'
}

export function principalHasDesktopApiAccess(principal: CloudPrincipal) {
  if (principal.authSource === 'worker') return false
  if (principal.authSource === 'api_token') {
    return principal.tokenScopes?.includes('desktop') || principal.tokenScopes?.includes('admin') || false
  }
  return true
}

export function routeAllowsWorkerCredential(input: GatewayRouteAccessInput) {
  return input.resource === 'workers' && Boolean(input.sessionId) && input.action === 'heartbeat'
}

export function routeAllowsGatewayOnlyToken(input: GatewayRouteAccessInput) {
  if (input.resource === 'channels') return true
  if (input.resource !== 'sessions' || !input.sessionId || input.method !== 'GET') return false
  if (!input.action || input.action === 'view' || input.action === 'events') return true
  return input.action === 'artifacts' && Boolean(input.artifactId)
}

export function routeAllowsOperationalToken(principal: CloudPrincipal, input: GatewayRouteAccessInput) {
  if (principal.authSource !== 'api_token') return false
  const operational = principal.tokenScopes?.includes('operator') || principal.tokenScopes?.includes('worker-internal')
  if (!operational || input.method !== 'GET') return false
  if (input.resource === 'metrics' || input.resource === 'diagnostics') return true
  if (input.resource === 'workers' && input.sessionId === 'heartbeats' && !input.action) return true
  return input.resource === 'runtime' && input.sessionId === 'status' && !input.action
}
