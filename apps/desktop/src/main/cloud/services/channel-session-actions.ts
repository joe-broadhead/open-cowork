import { normalizeCloudProjectSource } from '@open-cowork/shared'
import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ChannelCursorUpdateResult,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  SessionCommandRecord,
} from '../control-plane-store.ts'
import type {
  CloudPrincipal,
  CloudSessionView,
} from '../session-service.ts'
import {
  assertGatewayAccess,
  CHANNEL_HOUR_MS,
  requireChannelActor,
  type ChannelActorInput,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export async function bindChannelSession(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: ChannelActorInput & {
    channelBindingId: string
    provider: ChannelProviderId
    externalChatId: string
    externalThreadId: string
    sessionId?: string | null
    title?: string | null
    lastEventSequence?: number
    lastWorkspaceSequence?: number
    lastChatMessageId?: string | null
  },
): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView }> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const orgId = options.principalOrgId(principal)
  const channelBinding = await options.store.getChannelBinding(orgId, input.channelBindingId)
  if (!channelBinding) throw new CloudServiceError(404, 'Channel binding was not found.')
  if (channelBinding.status !== 'active') throw new CloudServiceError(403, 'Channel binding is not active.')
  if (channelBinding.provider !== input.provider) throw new CloudServiceError(400, 'Channel provider does not match binding.')
  const actor = await requireChannelActor(options, principal, input, 'prompt', {
    provider: channelBinding.provider,
    externalWorkspaceId: channelBinding.externalWorkspaceId,
  })
  const agent = await options.store.getHeadlessAgent(orgId, channelBinding.agentId)
  if (!agent || agent.status !== 'active') throw new CloudServiceError(403, 'Headless agent is not active.')
  await options.assertBillingAllowed({
    orgId,
    action: 'gateway.session.bind',
    profileName: agent.profileName,
  })

  const existing = await options.store.findChannelSessionBindingByThread({
    orgId,
    provider: input.provider,
    externalWorkspaceId: channelBinding.externalWorkspaceId,
    externalChatId: input.externalChatId,
    externalThreadId: input.externalThreadId,
  })
  if (existing) {
    if (existing.channelBindingId !== channelBinding.bindingId) {
      throw new CloudServiceError(409, 'Channel thread is already bound to a different channel binding.')
    }
    const owned = await options.store.getSession(principal.tenantId, principal.userId, existing.sessionId)
    if (!owned) throw new CloudServiceError(403, 'Channel session binding requires a session owned by the gateway principal.')
    return {
      binding: existing,
      session: {
        session: owned,
        projection: await options.store.getSessionProjection(principal.tenantId, existing.sessionId),
      },
    }
  }

  if (input.sessionId) {
    const owned = await options.store.getSession(principal.tenantId, principal.userId, input.sessionId)
    if (!owned) throw new CloudServiceError(403, 'Channel session binding requires a session owned by the gateway principal.')
  }
  const defaultProjectSource = input.sessionId
    ? null
    : options.normalizeAndValidateProjectSource(
        normalizeCloudProjectSource(channelBinding.settings.defaultProjectSource)
          || normalizeCloudProjectSource(options.policy.profile.defaultProjectSource),
        principal.tenantId,
      )
  const sessionId = input.sessionId || (await options.createCloudSessionRecord({
    tenantId: principal.tenantId,
    userId: principal.userId,
    orgId,
    accountId: principal.accountId || principal.userId,
    profileName: agent.profileName,
    sessionId: options.stableCloudId(
      'channel_session',
      orgId,
      input.provider,
      channelBinding.externalWorkspaceId || '',
      input.externalChatId,
      input.externalThreadId,
    ),
    title: input.title || `Channel ${input.provider}`,
    deferRuntime: Boolean(defaultProjectSource),
  })).sessionId
  if (defaultProjectSource) await options.bindSessionProjectSource(principal.tenantId, sessionId, defaultProjectSource)
  const binding = await options.store.bindChannelSession({
    bindingId: options.ids.randomUUID(),
    orgId,
    agentId: agent.agentId,
    channelBindingId: channelBinding.bindingId,
    provider: input.provider,
    externalWorkspaceId: channelBinding.externalWorkspaceId,
    externalThreadId: input.externalThreadId,
    externalChatId: input.externalChatId,
    sessionId,
    lastEventSequence: input.lastEventSequence,
    lastWorkspaceSequence: input.lastWorkspaceSequence,
    lastChatMessageId: input.lastChatMessageId,
  })
  await options.store.recordAuditEvent({
    orgId,
    accountId: actor.accountId,
    actorType: 'api_token',
    actorId: principal.tokenId || principal.userId,
    eventType: 'channel_session.bound_by_identity',
    targetType: 'channel_session_binding',
    targetId: binding.bindingId,
    metadata: { identityId: actor.identityId, provider: actor.provider, sessionId },
  })
  return { binding, session: await options.getTenantSessionView(principal.tenantId, sessionId) }
}

export async function getChannelSessionByThread(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalChatId: string
    externalThreadId: string
  },
): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView } | null> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const binding = await options.store.findChannelSessionBindingByThread({
    orgId: options.principalOrgId(principal),
    provider: input.provider,
    externalWorkspaceId: input.externalWorkspaceId,
    externalChatId: input.externalChatId,
    externalThreadId: input.externalThreadId,
  })
  if (!binding) return null
  const session = await options.store.getSession(principal.tenantId, principal.userId, binding.sessionId)
  if (!session) throw new CloudServiceError(403, 'Channel thread lookup requires a session owned by the gateway principal.')
  return {
    binding,
    session: {
      session,
      projection: await options.store.getSessionProjection(principal.tenantId, binding.sessionId),
    },
  }
}

export async function updateChannelCursor(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  },
): Promise<ChannelCursorUpdateResult> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  return options.store.updateChannelCursor({
    orgId: options.principalOrgId(principal),
    bindingId: input.bindingId,
    lastEventSequence: input.lastEventSequence,
    lastWorkspaceSequence: input.lastWorkspaceSequence,
    lastChatMessageId: input.lastChatMessageId,
  })
}

export async function enqueueChannelPrompt(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: ChannelActorInput & {
    bindingId: string
    text: string
    agent?: string | null
    commandId?: string | null
  },
): Promise<{ binding: ChannelSessionBindingRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const orgId = options.principalOrgId(principal)
  const binding = await options.store.getChannelSessionBinding(orgId, input.bindingId)
  if (!binding || binding.status !== 'active') throw new CloudServiceError(404, 'Channel session binding was not found.')
  const channelBinding = await options.store.getChannelBinding(orgId, binding.channelBindingId)
  if (!channelBinding) throw new CloudServiceError(404, 'Channel binding was not found.')
  const actor = await requireChannelActor(options, principal, input, 'prompt', {
    provider: binding.provider,
    externalWorkspaceId: channelBinding.externalWorkspaceId,
  })
  const session = await options.store.getSession(principal.tenantId, principal.userId, binding.sessionId)
  if (!session) throw new CloudServiceError(403, 'Channel prompt requires a session owned by the gateway principal.')
  const beforeProjectionSequence = (await options.store.getSessionProjection(principal.tenantId, binding.sessionId))?.sequence || 0
  await options.assertBillingAllowed({ orgId, action: 'prompt.enqueue', profileName: session.profileName })
  const promptQuota = await options.usageGovernance.usageQuotaForOrg({
    orgId,
    quotaKey: 'prompts:hour',
    limit: options.abuse.maxPromptsPerHour,
    entitlementLimitKey: 'maxPromptsPerHour',
    windowMs: CHANNEL_HOUR_MS,
    policyCode: 'quota.prompts_per_hour_exceeded',
  })
  const gatewayPromptQuota = await options.usageGovernance.usageQuotaForOrg({
    orgId,
    quotaKey: 'gateway_prompts:hour',
    limit: options.abuse.maxGatewayPromptsPerHour,
    entitlementLimitKey: 'maxGatewayPromptsPerHour',
    windowMs: CHANNEL_HOUR_MS,
    policyCode: 'quota.gateway_prompts_per_hour_exceeded',
  })
  let command: SessionCommandRecord
  try {
    command = await options.store.enqueueSessionCommand({
      commandId: input.commandId || options.ids.randomUUID(),
      tenantId: principal.tenantId,
      userId: session.userId,
      sessionId: binding.sessionId,
      kind: 'prompt',
      payload: { text: input.text, agent: input.agent || 'build' },
      quota: await options.usageGovernance.commandQueueQuotaForOrg(orgId),
      usageQuotas: [promptQuota, gatewayPromptQuota].filter((quota) => quota !== null),
    })
  } catch (error) {
    options.usageGovernance.translateQuotaError(error, 'Cloud command queue is full.', 'quota.queued_commands_exceeded')
  }
  await options.store.recordAuditEvent({
    orgId,
    accountId: actor.accountId,
    actorType: 'api_token',
    actorId: principal.tokenId || principal.userId,
    eventType: 'channel_prompt.enqueued',
    targetType: 'session',
    targetId: binding.sessionId,
    metadata: { identityId: actor.identityId, provider: actor.provider },
  })
  for (const eventType of ['work.queued', 'prompt.enqueued']) {
    await options.usageGovernance.recordUsage({
      orgId,
      accountId: actor.accountId,
      eventType,
      unit: 'count',
      metadata: {
        tenantId: principal.tenantId,
        sessionId: binding.sessionId,
        ...(eventType === 'work.queued' ? { commandId: command.commandId, commandKind: command.kind } : {}),
        source: 'gateway',
        provider: actor.provider,
      },
    })
  }
  return { binding, command, beforeProjectionSequence }
}
