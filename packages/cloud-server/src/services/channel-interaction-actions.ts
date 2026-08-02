import type { RemoteInteractionKind } from '@open-cowork/shared'
import { CloudServiceError } from '../cloud-service-error.ts'
import { ControlPlaneIdConflictError } from '../control-plane-errors.ts'
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
import {
  resolveGatewayChannelBindingScope,
  resolveGatewayChannelSessionBinding,
} from './channel-binding-scope.ts'

const CHANNEL_INTERACTION_NOT_FOUND = 'Channel interaction was not found or is no longer pending.'

function channelInteractionNotFound() {
  return new CloudServiceError(404, CHANNEL_INTERACTION_NOT_FOUND)
}

export async function createChannelInteraction(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    agentId: string
    sessionBindingId?: string | null
    sessionId: string
    provider: ChannelProviderId
    kind: ChannelInteractionRecord['kind']
    targetId: string
    externalInteractionId?: string | null
    expiresAt?: Date | null
    interactionId?: string | null
    tokenSecret?: string | null
  },
): Promise<IssuedChannelInteractionRecord> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const sessionBinding = input.sessionBindingId
    ? await resolveGatewayChannelSessionBinding(options, principal, input.sessionBindingId)
    : await resolveUniqueGatewaySessionBinding(options, principal, input)
  if (
    sessionBinding.sessionId !== input.sessionId
    || sessionBinding.agentId !== input.agentId
    || sessionBinding.provider !== input.provider
  ) {
    throw new CloudServiceError(403, 'Gateway API token is not authorized for the requested channel binding.')
  }
  const session = await options.store.getSession(principal.tenantId, principal.userId, input.sessionId)
  if (!session) throw new CloudServiceError(403, 'Channel interaction requires a session owned by the gateway principal.')
  const orgId = options.principalOrgId(principal)
  const agent = await options.store.getHeadlessAgent(orgId, input.agentId)
  if (!agent) throw new CloudServiceError(404, 'Headless agent was not found.')
  const interactionId = input.interactionId && principal.authSource !== 'local'
    ? options.stableCloudId(
        'channel_interaction',
        orgId,
        sessionBinding.channelBindingId,
        input.interactionId,
      )
    : input.interactionId || options.ids.randomUUID()
  try {
    return await options.store.createChannelInteraction({
      interactionId,
      orgId,
      agentId: agent.agentId,
      channelBindingId: sessionBinding.channelBindingId,
      sessionBindingId: sessionBinding.bindingId,
      sessionId: input.sessionId,
      provider: input.provider,
      externalInteractionId: input.externalInteractionId,
      kind: input.kind,
      targetId: input.targetId,
      expiresAt: input.expiresAt || new Date(Date.now() + 10 * 60 * 1000),
      tokenSecret: input.tokenSecret || undefined,
    })
  } catch (error) {
    if (error instanceof ControlPlaneIdConflictError) {
      throw new CloudServiceError(409, 'Channel resource id is unavailable.')
    }
    throw error
  }
}

async function resolveUniqueGatewaySessionBinding(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    agentId: string
    sessionId: string
    provider: ChannelProviderId
  },
) {
  const scope = await resolveGatewayChannelBindingScope(options, principal)
  const bindings = await options.store.listChannelSessionBindingsForSession(
    options.principalOrgId(principal),
    input.sessionId,
  )
  const matches = bindings.filter((binding) => (
    binding.status === 'active'
    && binding.agentId === input.agentId
    && binding.provider === input.provider
    && (!scope.channelBindingIds || scope.channelBindingIds.includes(binding.channelBindingId))
  ))
  if (matches.length !== 1) {
    throw new CloudServiceError(403, 'Gateway API token is not authorized for the requested channel binding.')
  }
  return matches[0]!
}

export async function resolveChannelInteraction(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: ChannelInteractionResolutionInput,
): Promise<{ interaction: ChannelInteractionRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const gatewayScope = await resolveGatewayChannelBindingScope(options, principal)
  const pendingInteraction = await options.store.findChannelInteraction({
    orgId: options.principalOrgId(principal),
    channelBindingIds: gatewayScope.channelBindingIds,
    token: input.token,
    externalInteractionId: input.externalInteractionId,
    provider: input.provider,
  })
  const commandId = options.ids.randomUUID()
  // A profile-level denial must not reveal whether a permission/question token
  // exists. Evaluate that invariant immediately after the same lookup for every
  // request, before binding, actor, or session checks can expose target state.
  // When the token is valid, keep the denial audit target-specific; otherwise
  // use deliberately opaque audit identifiers that do not contain credentials.
  if (options.policy.allowRemoteApprovalResponses === false) {
    await options.assertRemoteInteractionAllowed(principal, {
      authority: 'cloud-channel-gateway',
      actorWorkspaceMember: true,
      recordAllowedAudit: false,
      deniedEventType: 'channel_interaction.remote_policy.denied',
      targetType: 'channel_interaction',
      auditTargetId: pendingInteraction?.interactionId || 'unresolved',
      sessionId: pendingInteraction?.sessionId || 'unresolved',
      commandId,
      interaction: pendingInteraction
        ? remoteInteractionKind(pendingInteraction, input)
        : 'permission-approval',
      targetId: pendingInteraction?.targetId || 'unresolved',
    })
  }
  if (!pendingInteraction) throw channelInteractionNotFound()
  if (
    !pendingInteraction.channelBindingId
    || !pendingInteraction.sessionBindingId
    || (gatewayScope.channelBindingIds && !gatewayScope.channelBindingIds.includes(pendingInteraction.channelBindingId))
  ) {
    throw channelInteractionNotFound()
  }
  const parentBinding = await options.store.getChannelBinding(
    options.principalOrgId(principal),
    pendingInteraction.channelBindingId,
  )
  if (!parentBinding || parentBinding.status !== 'active') {
    throw channelInteractionNotFound()
  }
  const sessionBinding = await options.store.getChannelSessionBinding(
    options.principalOrgId(principal),
    pendingInteraction.sessionBindingId,
  )
  if (
    !sessionBinding
    || sessionBinding.status !== 'active'
    || sessionBinding.channelBindingId !== pendingInteraction.channelBindingId
    || sessionBinding.sessionId !== pendingInteraction.sessionId
    || sessionBinding.agentId !== pendingInteraction.agentId
    || sessionBinding.provider !== pendingInteraction.provider
  ) {
    throw channelInteractionNotFound()
  }
  let actor: Awaited<ReturnType<typeof requireChannelActorForSession>>
  try {
    actor = await requireChannelActorForSession(
      options,
      principal,
      input as ChannelActorInput,
      'approve',
      pendingInteraction.sessionId,
      pendingInteraction.provider,
    )
  } catch (error) {
    if (error instanceof CloudServiceError && error.status === 403) throw channelInteractionNotFound()
    throw error
  }
  const session = await options.store.getSession(principal.tenantId, principal.userId, pendingInteraction.sessionId)
  if (!session) throw channelInteractionNotFound()
  const beforeProjectionSequence = (await options.store.getSessionProjection(principal.tenantId, pendingInteraction.sessionId))?.sequence || 0
  const interactionKind = remoteInteractionKind(pendingInteraction, input)
  const command = {
    commandId,
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
    channelBindingIds: gatewayScope.channelBindingIds,
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

function remoteInteractionKind(
  interaction: Pick<ChannelInteractionRecord, 'kind'>,
  input: Pick<ChannelInteractionResolutionInput, 'reject'>,
): RemoteInteractionKind {
  return interaction.kind === 'permission'
    ? 'permission-approval'
    : input.reject
      ? 'question-reject'
      : 'question-reply'
}
