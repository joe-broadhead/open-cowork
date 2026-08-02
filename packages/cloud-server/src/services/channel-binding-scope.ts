import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ChannelBindingRecord,
  ChannelProviderId,
  ChannelSessionBindingRecord,
} from '../control-plane-store.ts'
import type { CloudPrincipal } from '../session-service.ts'
import { principalHasTokenScope } from '../principal-access.ts'
import {
  assertGatewayAccess,
  principalCanManageChannels,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export type GatewayChannelBindingScope = {
  gatewayTokenId: string | null
  channelBindingIds: readonly string[] | null
}

export type GatewayChannelBindingTarget = {
  channelBindingIds?: readonly string[] | null
  sessionBindingIds?: readonly string[] | null
}

export async function resolveGatewayChannelBindingScope(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  requestedChannelBindingIds?: readonly string[] | null,
): Promise<GatewayChannelBindingScope> {
  const requested = normalizeRequestedChannelBindingIds(requestedChannelBindingIds)
  // Reaching this resolver means the request selected a gateway action. Mixed
  // scopes compose for other actions, but gateway traffic itself must still be
  // bound to the token's explicit grant set.
  const gatewayServiceToken = principal.authSource === 'api_token'
    && principalHasTokenScope(principal, 'gateway')
  if (principalCanManageChannels(principal) && !gatewayServiceToken) {
    return {
      gatewayTokenId: null,
      channelBindingIds: requested.length > 0 ? requested : null,
    }
  }
  assertGatewayAccess(principal)
  if (principal.authSource !== 'api_token' || !principal.tokenId) {
    throw new CloudServiceError(403, 'Gateway channel operations require a gateway API token.')
  }
  const grants = await options.store.listApiTokenChannelBindingGrants({
    orgId: options.principalOrgId(principal),
    tokenId: principal.tokenId,
  })
  const granted = [...new Set(grants.map((grant) => grant.channelBindingId))].sort()
  if (granted.length === 0) throw bindingScopeDenied()
  if (requested.length > 0) {
    if (requested.some((channelBindingId) => !granted.includes(channelBindingId))) throw bindingScopeDenied()
  }
  const candidates = requested.length > 0 ? requested : granted
  const active: string[] = []
  for (const channelBindingId of candidates) {
    const binding = await options.store.getChannelBinding(options.principalOrgId(principal), channelBindingId)
    if (binding?.status === 'active') active.push(channelBindingId)
  }
  if (active.length === 0 || (requested.length > 0 && active.length !== candidates.length)) {
    throw bindingScopeDenied()
  }
  return {
    gatewayTokenId: principal.tokenId,
    channelBindingIds: active,
  }
}

export async function hasActiveGatewayChannelBindingScope(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  target: GatewayChannelBindingTarget = {},
): Promise<boolean> {
  if (
    principal.authSource !== 'api_token'
    || !principalHasTokenScope(principal, 'gateway')
  ) return false
  try {
    const scope = await resolveGatewayChannelBindingScope(
      options,
      principal,
      target.channelBindingIds,
    )
    if (!scope.channelBindingIds?.length) return false
    for (const sessionBindingId of normalizeRequestedChannelBindingIds(target.sessionBindingIds)) {
      const binding = await options.store.getChannelSessionBinding(
        options.principalOrgId(principal),
        sessionBindingId,
      )
      if (
        !binding
        || binding.status !== 'active'
        || !scope.channelBindingIds.includes(binding.channelBindingId)
      ) return false
    }
    return true
  } catch (error) {
    if (error instanceof CloudServiceError && error.status === 403) return false
    throw error
  }
}

export async function resolveGatewayChannelBindingForProviderScope(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    provider: ChannelProviderId
    channelBindingId?: string | null
    externalWorkspaceId?: string | null
  },
  operationLabel = 'Gateway channel operation',
): Promise<ChannelBindingRecord> {
  const orgId = options.principalOrgId(principal)
  const requestedWorkspaceId = input.externalWorkspaceId === undefined ? undefined : input.externalWorkspaceId || null
  // Resolve token grants before touching a caller-selected binding id so granted
  // and nonexistent identifiers have the same externally visible denial.
  const scope = await resolveGatewayChannelBindingScope(
    options,
    principal,
    input.channelBindingId ? [input.channelBindingId] : null,
  )
  if (input.channelBindingId) {
    const binding = await options.store.getChannelBinding(orgId, input.channelBindingId)
    if (!binding) throw bindingScopeDenied()
    assertProviderScopedBindingMatches(binding, input.provider, requestedWorkspaceId)
    return binding
  }
  const candidates = (await options.store.listChannelBindings(orgId))
    .filter((binding) => {
      if (scope.channelBindingIds && !scope.channelBindingIds.includes(binding.bindingId)) return false
      if (binding.status !== 'active') return false
      if (binding.provider !== input.provider) return false
      return binding.externalWorkspaceId === (requestedWorkspaceId || null)
    })
  if (candidates.length === 0) throw bindingScopeDenied()
  if (candidates.length > 1) {
    throw new CloudServiceError(400, `${operationLabel} requires channelBindingId when multiple channel bindings match.`)
  }
  return candidates[0]!
}

export async function resolveGatewayChannelSessionBinding(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  sessionBindingId: string,
): Promise<ChannelSessionBindingRecord> {
  const scope = await resolveGatewayChannelBindingScope(options, principal)
  const binding = await options.store.getChannelSessionBinding(
    options.principalOrgId(principal),
    sessionBindingId,
  )
  if (
    !binding
    || binding.status !== 'active'
    || (scope.channelBindingIds && !scope.channelBindingIds.includes(binding.channelBindingId))
  ) {
    throw bindingScopeDenied()
  }
  const channelBinding = await options.store.getChannelBinding(
    options.principalOrgId(principal),
    binding.channelBindingId,
  )
  if (!channelBinding || channelBinding.status !== 'active') throw bindingScopeDenied()
  return binding
}

function normalizeRequestedChannelBindingIds(input: readonly string[] | null | undefined) {
  return [...new Set((input || []).map((value) => value.trim()).filter(Boolean))]
}

function assertProviderScopedBindingMatches(
  binding: ChannelBindingRecord,
  provider: ChannelProviderId,
  requestedWorkspaceId: string | null | undefined,
) {
  if (binding.status !== 'active') throw new CloudServiceError(403, 'Channel binding is not active.')
  if (binding.provider !== provider) throw new CloudServiceError(400, 'Channel provider does not match binding.')
  if (requestedWorkspaceId !== undefined && binding.externalWorkspaceId !== requestedWorkspaceId) {
    throw new CloudServiceError(403, 'Channel binding is not authorized for this provider workspace.')
  }
}

function bindingScopeDenied() {
  return new CloudServiceError(403, 'Gateway API token is not authorized for the requested channel binding.')
}
