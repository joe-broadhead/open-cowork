import type {
  CloudProjectSource,
  RemoteApprovalPolicyDecision,
} from '@open-cowork/shared'
import type { CloudAbuseConfig } from '@open-cowork/shared'
import type { BillingAction } from '../billing-adapter.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { CloudRuntimePolicy } from '../cloud-config.ts'
import type { ChannelControlPlaneStore } from '../control-plane-domains/channels.ts'
import type {
  ChannelIdentityRecord,
  ChannelIdentityRole,
  ChannelProviderId,
  SessionRecord,
} from '../control-plane-store.ts'
import {
  principalHasOrgAdminRole,
  principalHasPrivilegedTokenScope,
} from '../principal-access.ts'
import type {
  CloudPrincipal,
  CloudSessionView,
} from '../session-service.ts'
import type { RemoteInteractionPolicyInput } from './remote-approval-policy.ts'
import type { CloudUsageGovernanceService } from './usage-governance-service.ts'

export const CHANNEL_HOUR_MS = 60 * 60 * 1000

export type ChannelActorInput = {
  identityId?: string | null
  provider?: ChannelProviderId | null
  externalWorkspaceId?: string | null
  externalUserId?: string | null
  // Chat the responder is acting from, used to scope interaction approval to the chat the
  // interaction was sent to (audit #922) rather than the whole provider/workspace.
  externalChatId?: string | null
}

export type ChannelInteractionResolutionInput = ChannelActorInput & {
  token?: string | null
  externalInteractionId?: string | null
  response?: unknown
  answers?: unknown[]
  reject?: boolean
}

export type CreateChannelSessionRecordInput = {
  tenantId: string
  userId: string
  orgId?: string | null
  accountId?: string | null
  profileName: string
  sessionId?: string | null
  title?: string | null
  deferRuntime?: boolean
}

export type ChannelAuditActor = {
  actorType: 'user' | 'api_token'
  actorId: string
  accountId: string | null
}

export type CloudChannelDomainServiceOptions = {
  store: ChannelControlPlaneStore
  policy: CloudRuntimePolicy
  ids: { randomUUID: () => string }
  abuse: CloudAbuseConfig
  usageGovernance: CloudUsageGovernanceService
  ensurePrincipal(principal: CloudPrincipal): Promise<void>
  principalOrgId(principal: CloudPrincipal): string
  assertBillingAllowed(input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }): Promise<void>
  normalizeAndValidateProjectSource(source: unknown, tenantId: string): CloudProjectSource | null
  createCloudSessionRecord(input: CreateChannelSessionRecordInput): Promise<SessionRecord>
  bindSessionProjectSource(tenantId: string, sessionId: string, projectSource: CloudProjectSource): Promise<void>
  getTenantSessionView(tenantId: string, sessionId: string): Promise<CloudSessionView>
  assertRemoteInteractionAllowed(
    principal: CloudPrincipal,
    input: RemoteInteractionPolicyInput,
  ): Promise<RemoteApprovalPolicyDecision>
  auditActor(principal: CloudPrincipal): ChannelAuditActor
  stableCloudId(prefix: string, ...parts: string[]): string
}

export function normalizedCloudListLimit(value: number | null | undefined, fallback = 100, max = 500) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value || fallback)))
}

export function principalCanManageChannels(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') return principalHasPrivilegedTokenScope(principal, 'admin')
  return principalHasOrgAdminRole(principal)
}

export function assertChannelSetupAllowed(principal: CloudPrincipal) {
  if (!principalCanManageChannels(principal)) {
    throw new CloudServiceError(403, 'Channel administration requires an org admin or admin-scoped API token.')
  }
}

export function assertGatewayAccess(principal: CloudPrincipal) {
  const allowed = principal.authSource === 'local'
    || (principal.authSource === 'api_token' && principalHasPrivilegedTokenScope(principal, 'gateway'))
    || principalHasOrgAdminRole(principal)
  if (!allowed) throw new CloudServiceError(403, 'Gateway channel access requires a gateway-scoped API token.')
}

function channelRoleCanPrompt(role: ChannelIdentityRole) {
  return role === 'owner' || role === 'admin' || role === 'member'
}

function channelRoleCanApprove(role: ChannelIdentityRole) {
  return role === 'owner' || role === 'admin' || role === 'member' || role === 'approver'
}

export async function requireChannelActor(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: ChannelActorInput,
  purpose: 'prompt' | 'approve',
  scope: { provider?: ChannelProviderId | null, externalWorkspaceId?: string | null } = {},
): Promise<ChannelIdentityRecord> {
  const orgId = options.principalOrgId(principal)
  const identity = input.identityId
    ? await options.store.getChannelIdentity(orgId, input.identityId)
    : input.provider && input.externalUserId
      ? await options.store.findChannelIdentity({
          orgId,
          provider: input.provider,
          externalWorkspaceId: input.externalWorkspaceId,
          externalUserId: input.externalUserId,
        })
      : null
  if (!identity) throw new CloudServiceError(403, 'Channel actor identity is not authorized.')
  if (identity.status !== 'active') throw new CloudServiceError(403, 'Channel actor identity is not active.')
  if (scope.provider && identity.provider !== scope.provider) {
    throw new CloudServiceError(403, 'Channel actor identity is not authorized for this provider.')
  }
  if (scope.externalWorkspaceId !== undefined && identity.externalWorkspaceId !== (scope.externalWorkspaceId || null)) {
    throw new CloudServiceError(403, 'Channel actor identity is not authorized for this channel workspace.')
  }
  if (purpose === 'prompt' && !channelRoleCanPrompt(identity.role)) {
    throw new CloudServiceError(403, 'Channel actor is not allowed to prompt this agent.')
  }
  if (purpose === 'approve' && !channelRoleCanApprove(identity.role)) {
    throw new CloudServiceError(403, 'Channel actor is not allowed to approve this interaction.')
  }
  return identity
}

export async function requireChannelActorForSession(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: ChannelActorInput,
  purpose: 'prompt' | 'approve',
  sessionId: string,
  provider: ChannelProviderId,
): Promise<ChannelIdentityRecord> {
  const actor = await requireChannelActor(options, principal, input, purpose, { provider })
  const orgId = options.principalOrgId(principal)
  // Same-chat scoping (audit #922): the responder must be acting from the chat the session (and thus
  // the interaction) is bound to. Providers without workspace scoping (Telegram/email) match
  // null===null on the workspace alone, so without the chat check a bystander in another chat who
  // holds the token could approve. When the caller supplies the responder chat we require it to
  // match a binding; a caller that cannot supply it falls back to the workspace match.
  const responderChatId = typeof input.externalChatId === 'string' && input.externalChatId
    ? input.externalChatId
    : null
  const bindings = await options.store.listChannelSessionBindingsForSession(orgId, sessionId)
  for (const binding of bindings) {
    if (binding.provider !== provider) continue
    if (responderChatId && binding.externalChatId !== responderChatId) continue
    const channelBinding = await options.store.getChannelBinding(orgId, binding.channelBindingId)
    if (!channelBinding) continue
    if (channelBinding.externalWorkspaceId === actor.externalWorkspaceId) return actor
  }
  throw new CloudServiceError(403, 'Channel actor identity is not authorized for this channel session.')
}
