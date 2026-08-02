import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  WORKSPACE_ACTION_DEFINITIONS,
  workspaceActionFeatureDenialCode,
  workspaceActionNeedsGatewayBindingVerification,
} from '@open-cowork/shared'
import type { CloudHttpServerOptions } from '../http-contracts.ts'
import { recordCloudWorkspacePolicyDecision } from '../observability.ts'
import type { CloudPrincipal } from '../session-service.ts'
import { writePolicyError } from '../http-response-writers.ts'
import {
  evaluateCloudApiWorkspacePolicy,
  resolveCloudApiRoutePolicy,
} from './workspace-policy.ts'

type ReadJsonBody = (
  req: IncomingMessage,
  maxBodyBytes: number,
) => Promise<Record<string, unknown>>

export async function authorizeCloudApiWorkspaceRequest(input: {
  req: IncomingMessage
  res: ServerResponse
  options: CloudHttpServerOptions
  segments: readonly string[]
  principal: CloudPrincipal
  readJsonBody: ReadJsonBody
}): Promise<{ allowed: boolean, readJsonBody: ReadJsonBody }> {
  let policyRequestBody: Record<string, unknown> | undefined
  let route = resolveCloudApiRoutePolicy(input.req.method, input.segments)
  if (route?.action === 'workflows.create') {
    policyRequestBody = await input.readJsonBody(
      input.req,
      input.options.maxBodyBytes || 1024 * 1024,
    )
    route = resolveCloudApiRoutePolicy(input.req.method, input.segments, policyRequestBody)
  }

  const featureDenial = route
    ? workspaceActionFeatureDenialCode(route.action, input.options.policy.features)
    : null
  // Feature flags are profile-level public configuration. Complete their
  // denial before reading membership grants, request resources, or gateway
  // binding grants. The matrix still emits the one final decision below.
  if (featureDenial) {
    const decision = evaluateCloudApiWorkspacePolicy({
      method: input.req.method,
      segments: input.segments,
      principal: input.principal,
      policy: input.options.policy,
      route,
    })
    await recordCloudWorkspacePolicyDecision(input.options.observability, decision)
    if (decision.outcome === 'deny') {
      writePolicyError(
        input.res,
        403,
        decision.message,
        decision.code,
        input.options.corsOrigin,
      )
    }
    return {
      allowed: false,
      readJsonBody: cachedBodyReader(input.req, input.readJsonBody, policyRequestBody),
    }
  }

  const definition = route && WORKSPACE_ACTION_DEFINITIONS[route.action]
  const needsHumanAuthorizationContext = (
    input.principal.authSource === 'user'
    || input.principal.authSource === 'header'
  ) && Boolean(
    definition
    && ('humanPermissions' in definition || 'humanRoles' in definition),
  )
  // Resolve only context the matrix needs, through a read-only seam. Unknown
  // and feature-disabled data-plane routes never bootstrap identity records.
  if (needsHumanAuthorizationContext) {
    await input.options.service.domains.principals
      .hydrateAuthorizationPrincipal(input.principal)
  }

  let bindingScopeVerified: boolean | undefined
  if (
    route?.requiresBindingScope
    && workspaceActionNeedsGatewayBindingVerification(route.action, input.principal)
  ) {
    if (gatewayTargetUsesRequestBody(input.req.method, input.segments)) {
      policyRequestBody ||= await input.readJsonBody(
        input.req,
        input.options.maxBodyBytes || 1024 * 1024,
      )
    }
    bindingScopeVerified = await input.options.service.domains.channels
      .hasActiveGatewayChannelBindingScope(
        input.principal,
        gatewayBindingTarget(input.segments, input.req, policyRequestBody),
      )
  }
  const decision = evaluateCloudApiWorkspacePolicy({
    method: input.req.method,
    segments: input.segments,
    principal: input.principal,
    policy: input.options.policy,
    route,
    bindingScopeVerified,
  })
  await recordCloudWorkspacePolicyDecision(input.options.observability, decision)
  if (decision.outcome === 'deny') {
    writePolicyError(
      input.res,
      403,
      decision.message,
      decision.code,
      input.options.corsOrigin,
    )
  }

  return {
    allowed: decision.outcome === 'allow',
    readJsonBody: cachedBodyReader(input.req, input.readJsonBody, policyRequestBody),
  }
}

function cachedBodyReader(
  policyRequest: IncomingMessage,
  readJsonBody: ReadJsonBody,
  cachedBody: Record<string, unknown> | undefined,
): ReadJsonBody {
  return (req, maxBodyBytes) => (
    req === policyRequest && cachedBody !== undefined
      ? Promise.resolve(cachedBody)
      : readJsonBody(req, maxBodyBytes)
  )
}

function gatewayTargetUsesRequestBody(method: string | undefined, segments: readonly string[]) {
  if (method?.toUpperCase() !== 'POST') return false
  const [, resource, collection, itemId] = segments
  if (resource !== 'channels') return false
  if (collection === 'identities' && itemId === 'resolve') return true
  if (collection === 'sessions' && (itemId === 'bind' || itemId === 'prompt')) return true
  if (collection === 'cursor' && !itemId) return true
  if (collection === 'interactions' && !itemId) return true
  if (collection === 'provider-events') return true
  return collection === 'deliveries'
}

function gatewayBindingTarget(
  segments: readonly string[],
  req: IncomingMessage,
  body: Readonly<Record<string, unknown>> | undefined,
): { channelBindingIds?: string[], sessionBindingIds?: string[] } {
  const [, , collection, itemId, itemAction] = segments
  if (
    collection === 'sessions'
    && itemId
    && !['bind', 'prompt', 'by-thread'].includes(itemId)
    && ['snapshot', 'events', 'artifacts'].includes(String(itemAction))
  ) return { sessionBindingIds: [itemId] }

  const channelBindingId = stringValue(body?.channelBindingId)
  if (channelBindingId) return { channelBindingIds: [channelBindingId] }
  if ((collection === 'sessions' && itemId === 'prompt') || collection === 'cursor') {
    const sessionBindingId = stringValue(body?.bindingId)
    return sessionBindingId ? { sessionBindingIds: [sessionBindingId] } : {}
  }
  if (collection === 'interactions' && !itemId) {
    const sessionBindingId = stringValue(body?.sessionBindingId)
    return sessionBindingId ? { sessionBindingIds: [sessionBindingId] } : {}
  }
  if (collection === 'deliveries' && req.method === 'GET') {
    const url = new URL(req.url || '/', 'http://cloud.invalid')
    const channelBindingIds = url.searchParams.getAll('channelBindingId')
      .map((value) => value.trim())
      .filter(Boolean)
    return channelBindingIds.length > 0 ? { channelBindingIds } : {}
  }
  // by-thread and interaction-resolve targets are intentionally absent here:
  // their binding is derivable only from a token/resource lookup. Their domain
  // resolvers perform one target-scoped lookup and collapse missing/cross-scope
  // results to the same opaque denial; they must not trigger a second matrix
  // decision after this request-level grant proof.
  return {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
