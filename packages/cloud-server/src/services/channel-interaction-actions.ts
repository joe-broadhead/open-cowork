import type { RemoteInteractionKind } from '@open-cowork/shared'
import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ChannelInteractionRecord,
  ChannelProviderId,
  IssuedChannelInteractionRecord,
  SessionCommandRecord,
} from '../control-plane-store.ts'
import type { CloudPrincipal } from '../session-service.ts'
import {
  assertGatewayAccess,
  requireChannelActorForSession,
  type ChannelActorInput,
  type ChannelInteractionResolutionInput,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export async function createChannelInteraction(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    agentId: string
    sessionId: string
    provider: ChannelProviderId
    kind: ChannelInteractionRecord['kind']
    targetId: string
    externalInteractionId?: string | null
    createdByIdentityId?: string | null
    expiresAt?: Date | null
    interactionId?: string | null
    tokenSecret?: string | null
  },
): Promise<IssuedChannelInteractionRecord> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const session = await options.store.getSession(principal.tenantId, principal.userId, input.sessionId)
  if (!session) throw new CloudServiceError(403, 'Channel interaction requires a session owned by the gateway principal.')
  const orgId = options.principalOrgId(principal)
  const agent = await options.store.getHeadlessAgent(orgId, input.agentId)
  if (!agent) throw new CloudServiceError(404, 'Headless agent was not found.')
  return options.store.createChannelInteraction({
    interactionId: input.interactionId || options.ids.randomUUID(),
    orgId,
    agentId: agent.agentId,
    sessionId: input.sessionId,
    provider: input.provider,
    externalInteractionId: input.externalInteractionId,
    kind: input.kind,
    targetId: input.targetId,
    createdByIdentityId: input.createdByIdentityId,
    expiresAt: input.expiresAt || new Date(Date.now() + 10 * 60 * 1000),
    tokenSecret: input.tokenSecret || undefined,
  })
}

export async function resolveChannelInteraction(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: ChannelInteractionResolutionInput,
): Promise<{ interaction: ChannelInteractionRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const pendingInteraction = await options.store.findChannelInteraction({
    orgId: options.principalOrgId(principal),
    token: input.token,
    externalInteractionId: input.externalInteractionId,
    provider: input.provider,
  })
  if (!pendingInteraction) throw new CloudServiceError(404, 'Channel interaction was not found or is no longer pending.')
  const actor = await requireChannelActorForSession(
    options,
    principal,
    input as ChannelActorInput,
    'approve',
    pendingInteraction.sessionId,
    pendingInteraction.provider,
  )
  const session = await options.store.getSession(principal.tenantId, principal.userId, pendingInteraction.sessionId)
  if (!session) throw new CloudServiceError(403, 'Channel interaction requires a session owned by the gateway principal.')
  const beforeProjectionSequence = (await options.store.getSessionProjection(principal.tenantId, pendingInteraction.sessionId))?.sequence || 0
  const interactionKind: RemoteInteractionKind = pendingInteraction.kind === 'permission'
    ? 'permission-approval'
    : input.reject
      ? 'question-reject'
      : 'question-reply'
  const command = {
    commandId: options.ids.randomUUID(),
    tenantId: principal.tenantId,
    userId: session.userId,
    sessionId: pendingInteraction.sessionId,
    kind: pendingInteraction.kind === 'permission'
      ? 'permission.respond' as const
      : input.reject
        ? 'question.reject' as const
        : 'question.reply' as const,
    payload: pendingInteraction.kind === 'permission'
      ? { permissionId: pendingInteraction.targetId, response: input.response ?? null }
      : input.reject
        ? { requestId: pendingInteraction.targetId }
        : { requestId: pendingInteraction.targetId, answers: Array.isArray(input.answers) ? input.answers : [] },
  }
  const policyDecision = await options.assertRemoteInteractionAllowed(principal, {
    authority: 'cloud-channel-gateway',
    actorWorkspaceMember: true,
    recordAllowedAudit: false,
    deniedEventType: 'channel_interaction.remote_policy.denied',
    targetType: 'channel_interaction',
    auditTargetId: pendingInteraction.interactionId,
    sessionId: pendingInteraction.sessionId,
    commandId: command.commandId,
    interaction: interactionKind,
    targetId: pendingInteraction.targetId,
  })
  const resolved = await options.store.resolveChannelInteractionWithCommand({
    orgId: options.principalOrgId(principal),
    token: input.token,
    externalInteractionId: input.externalInteractionId,
    provider: input.provider,
    identityId: actor.identityId,
    command,
  })
  if (!resolved) throw new CloudServiceError(409, 'Channel interaction was already resolved.')
  await options.store.recordAuditEvent({
    orgId: options.principalOrgId(principal),
    accountId: actor.accountId,
    actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
    actorId: principal.tokenId || principal.userId,
    eventType: resolved.command.kind === 'permission.respond'
      ? 'channel_interaction.permission.responded'
      : resolved.command.kind === 'question.reject'
        ? 'channel_interaction.question.rejected'
        : 'channel_interaction.question.replied',
    targetType: 'channel_interaction',
    targetId: resolved.interaction.interactionId,
    metadata: {
      identityId: actor.identityId,
      provider: actor.provider,
      sessionId: resolved.interaction.sessionId,
      targetId: resolved.interaction.targetId,
      commandId: resolved.command.commandId,
      policyVersion: policyDecision.version,
      policyMode: policyDecision.mode,
      policyReasonCode: policyDecision.reasonCode,
      authority: 'cloud-channel-gateway',
    },
  })
  return { ...resolved, beforeProjectionSequence }
}
