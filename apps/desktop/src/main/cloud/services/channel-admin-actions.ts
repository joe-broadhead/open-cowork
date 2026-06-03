import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ChannelBindingRecord,
  ChannelIdentityRecord,
  ChannelProviderId,
  HeadlessAgentRecord,
} from '../control-plane-store.ts'
import {
  publicChannelBinding,
  type PublicChannelBindingRecord,
} from '../public-channel-records.ts'
import type { CloudPrincipal } from '../session-service.ts'
import {
  assertChannelSetupAllowed,
  assertGatewayAccess,
  normalizedCloudListLimit,
  principalCanManageChannels,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export async function listHeadlessAgents(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: { limit?: number | null } = {},
): Promise<HeadlessAgentRecord[]> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  return (await options.store.listHeadlessAgents(options.principalOrgId(principal)))
    .slice(0, normalizedCloudListLimit(input.limit))
}

export async function createHeadlessAgent(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    name: string
    profileName?: string | null
    status?: HeadlessAgentRecord['status']
    managed?: boolean
    agentId?: string | null
  },
): Promise<HeadlessAgentRecord> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  await options.assertBillingAllowed({
    orgId: options.principalOrgId(principal),
    action: 'channel.manage',
    profileName: input.profileName || options.policy.profileName,
  })
  return options.store.createHeadlessAgent({
    agentId: input.agentId || options.ids.randomUUID(),
    orgId: options.principalOrgId(principal),
    tenantId: principal.tenantId,
    profileName: input.profileName || options.policy.profileName,
    name: input.name,
    status: input.status,
    managed: input.managed,
    createdByAccountId: principal.accountId || principal.userId,
  })
}

export async function updateHeadlessAgent(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  agentId: string,
  input: {
    name?: string
    profileName?: string
    status?: HeadlessAgentRecord['status']
    managed?: boolean
  },
): Promise<HeadlessAgentRecord | null> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  await options.assertBillingAllowed({
    orgId: options.principalOrgId(principal),
    action: 'channel.manage',
    profileName: input.profileName || undefined,
  })
  return options.store.updateHeadlessAgent({
    orgId: options.principalOrgId(principal),
    agentId,
    name: input.name,
    profileName: input.profileName,
    status: input.status,
    managed: input.managed,
    actor: options.auditActor(principal),
  })
}

export async function listChannelBindings(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  agentId?: string | null,
  input: { limit?: number | null } = {},
): Promise<PublicChannelBindingRecord[]> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  return (await options.store.listChannelBindings(options.principalOrgId(principal), agentId))
    .slice(0, normalizedCloudListLimit(input.limit))
    .map(publicChannelBinding)
}

export async function createChannelBinding(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    agentId: string
    provider: ChannelProviderId
    displayName: string
    externalWorkspaceId?: string | null
    status?: ChannelBindingRecord['status']
    credentialRef?: string | null
    settings?: Record<string, unknown>
    bindingId?: string | null
  },
): Promise<PublicChannelBindingRecord> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  const orgId = options.principalOrgId(principal)
  await options.assertBillingAllowed({ orgId, action: 'channel.manage' })
  const agent = await options.store.getHeadlessAgent(orgId, input.agentId)
  if (!agent) throw new CloudServiceError(404, 'Headless agent was not found.')
  const bindingLimit = options.usageGovernance.quotaLimit(await options.usageGovernance.effectiveQuotaLimit(
    orgId,
    options.abuse.maxGatewayChannelBindingsPerOrg,
    'maxGatewayChannelBindingsPerOrg',
  ))
  try {
    const binding = await options.store.createChannelBinding({
      bindingId: input.bindingId || options.ids.randomUUID(),
      orgId,
      agentId: input.agentId,
      provider: input.provider,
      externalWorkspaceId: input.externalWorkspaceId,
      displayName: input.displayName,
      status: input.status,
      credentialRef: input.credentialRef,
      settings: input.settings,
      quota: bindingLimit
        ? {
            maxGatewayChannelBindingsPerOrg: bindingLimit,
            policyCode: 'quota.gateway_channel_bindings_exceeded',
          }
        : null,
    })
    return publicChannelBinding(binding)
  } catch (error) {
    options.usageGovernance.translateQuotaError(error, 'Gateway channel binding quota exceeded.', 'quota.gateway_channel_bindings_exceeded')
  }
}

export async function updateChannelBinding(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  bindingId: string,
  input: {
    displayName?: string
    status?: ChannelBindingRecord['status']
    credentialRef?: string | null
    settings?: Record<string, unknown>
  },
): Promise<PublicChannelBindingRecord | null> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  await options.assertBillingAllowed({ orgId: options.principalOrgId(principal), action: 'channel.manage' })
  const binding = await options.store.updateChannelBinding({
    orgId: options.principalOrgId(principal),
    bindingId,
    displayName: input.displayName,
    status: input.status,
    credentialRef: input.credentialRef,
    settings: input.settings,
    actor: options.auditActor(principal),
  })
  return binding ? publicChannelBinding(binding) : null
}

export async function resolveChannelIdentity(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalUserId: string
    identityId?: string | null
    accountId?: string | null
    role?: ChannelIdentityRecord['role']
    status?: ChannelIdentityRecord['status']
    metadata?: Record<string, unknown>
  },
): Promise<ChannelIdentityRecord> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const orgId = options.principalOrgId(principal)
  const existing = await options.store.findChannelIdentity({
    orgId,
    provider: input.provider,
    externalWorkspaceId: input.externalWorkspaceId,
    externalUserId: input.externalUserId,
  })
  const setupAllowed = principalCanManageChannels(principal)
  return options.store.upsertChannelIdentity({
    identityId: existing?.identityId || input.identityId || options.ids.randomUUID(),
    orgId,
    provider: input.provider,
    externalWorkspaceId: input.externalWorkspaceId,
    externalUserId: input.externalUserId,
    accountId: setupAllowed ? input.accountId : existing?.accountId,
    role: setupAllowed ? input.role || existing?.role || 'viewer' : existing?.role || 'viewer',
    status: setupAllowed ? input.status || existing?.status || 'pending' : existing?.status || 'pending',
    metadata: input.metadata || existing?.metadata || {},
  })
}
