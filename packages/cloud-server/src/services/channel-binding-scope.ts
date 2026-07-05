import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ChannelBindingRecord,
  ChannelProviderId,
} from '../control-plane-store.ts'
import type { CloudPrincipal } from '../session-service.ts'
import {
  assertGatewayAccess,
  principalCanManageChannels,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export type GatewayChannelBindingScope = {
  gatewayTokenId: string | null
  channelBindingIds: readonly string[] | null
}

export async function resolveGatewayChannelBindingScope(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  requestedChannelBindingIds?: readonly string[] | null,
): Promise<GatewayChannelBindingScope> {
  const requested = normalizeRequestedChannelBindingIds(requestedChannelBindingIds)
  if (principalCanManageChannels(principal)) {
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
  const allowed = [...new Set(grants.map((grant) => grant.channelBindingId))].sort()
  if (allowed.length === 0) {
    throw new CloudServiceError(403, 'Gateway API token is not authorized for any channel bindings.')
  }
  if (requested.length > 0) {
    const ungranted = requested.filter((channelBindingId) => !allowed.includes(channelBindingId))
    if (ungranted.length > 0) {
      throw new CloudServiceError(403, 'Gateway API token is not authorized for one or more requested channel bindings.')
    }
  }
  return {
    gatewayTokenId: principal.tokenId,
    channelBindingIds: requested.length > 0 ? requested : allowed,
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
  if (input.channelBindingId) {
    const binding = await options.store.getChannelBinding(orgId, input.channelBindingId)
    if (!binding) throw new CloudServiceError(404, 'Channel binding was not found.')
    assertProviderScopedBindingMatches(binding, input.provider, requestedWorkspaceId)
    return binding
  }
  const candidates = (await options.store.listChannelBindings(orgId))
    .filter((binding) => {
      if (binding.status !== 'active') return false
      if (binding.provider !== input.provider) return false
      return binding.externalWorkspaceId === (requestedWorkspaceId || null)
    })
  if (candidates.length === 0) throw new CloudServiceError(404, 'Channel binding was not found for gateway operation.')
  if (candidates.length > 1) {
    throw new CloudServiceError(400, `${operationLabel} requires channelBindingId when multiple channel bindings match.`)
  }
  return candidates[0]!
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
