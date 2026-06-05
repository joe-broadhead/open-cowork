import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChannelProviderId, SessionCommandRecord } from '../control-plane-store.ts'
import type { CloudHttpServerOptions } from '../http-server.ts'
import type { CloudPrincipal } from '../session-service.ts'

type RouteContext = {
  principal: CloudPrincipal
  url: URL
}

export type ChannelRouteTools = {
  readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>>
  readString(value: unknown): string | null
  readRecord(value: unknown): Record<string, unknown> | null
  readChannelProvider(value: unknown): ChannelProviderId | undefined
  readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined
  readNonNegativeInteger(value: unknown, fallback?: number): number
  readOptionalDate(value: unknown): Date | null
  publicChannelInteraction(value: unknown): Record<string, unknown>
  writeJson(res: ServerResponse, status: number, body: unknown, origin?: string | null): void
  writeError(res: ServerResponse, status: number, message: string, origin?: string | null): void
  processSessionCommandIfConfigured(options: CloudHttpServerOptions, tenantId: string, sessionId: string): Promise<number>
  writeSessionCommandMutationResponse(
    res: ServerResponse,
    options: CloudHttpServerOptions,
    principal: CloudPrincipal,
    sessionId: string,
    command: SessionCommandRecord,
    processed: number,
    beforeProjectionSequence: number,
    extraBody?: Record<string, unknown>,
  ): Promise<void>
  handleChannelDeliveriesSse(
    req: IncomingMessage,
    res: ServerResponse,
    options: CloudHttpServerOptions,
    context: RouteContext,
  ): Promise<void>
}

export async function handleChannelsApiRoute(input: {
  req: IncomingMessage
  res: ServerResponse
  options: CloudHttpServerOptions
  context: RouteContext
  collection: string | undefined
  itemId: string | undefined
  itemAction: string | undefined
  tools: ChannelRouteTools
}): Promise<boolean> {
  const {
    req,
    res,
    options,
    context,
    collection,
    itemId,
    itemAction,
    tools,
  } = input

  if (collection === 'agents') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, {
        agents: await options.service.listHeadlessAgents(context.principal, {
          limit: tools.readNonNegativeInteger(context.url.searchParams.get('limit'), 100),
        }),
      }, options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const name = tools.readString(body.name)
      if (!name) {
        tools.writeError(res, 400, 'Headless agent name is required.', options.corsOrigin)
        return true
      }
      const agent = await options.service.createHeadlessAgent(context.principal, {
        agentId: tools.readString(body.agentId),
        name,
        profileName: tools.readString(body.profileName),
        status: tools.readEnum(body.status, ['active', 'disabled'] as const),
        managed: body.managed === true,
      })
      tools.writeJson(res, 201, { agent }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'PATCH') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const agent = await options.service.updateHeadlessAgent(context.principal, itemId, {
        name: body.name === undefined ? undefined : tools.readString(body.name) || '',
        profileName: body.profileName === undefined ? undefined : tools.readString(body.profileName) || '',
        status: body.status === undefined ? undefined : tools.readEnum(body.status, ['active', 'disabled'] as const),
        managed: body.managed === undefined ? undefined : body.managed === true,
      })
      if (!agent) {
        tools.writeError(res, 404, 'Headless agent was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { agent }, options.corsOrigin)
      return true
    }
  }

  if (collection === 'bindings') {
    if (!itemId && req.method === 'GET') {
      tools.writeJson(res, 200, {
        bindings: await options.service.listChannelBindings(context.principal, context.url.searchParams.get('agentId'), {
          limit: tools.readNonNegativeInteger(context.url.searchParams.get('limit'), 100),
        }),
      }, options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const agentId = tools.readString(body.agentId)
      const provider = tools.readChannelProvider(body.provider)
      const displayName = tools.readString(body.displayName)
      if (!agentId || !provider || !displayName) {
        tools.writeError(res, 400, 'Channel binding requires agentId, provider, and displayName.', options.corsOrigin)
        return true
      }
      const binding = await options.service.createChannelBinding(context.principal, {
        bindingId: tools.readString(body.bindingId),
        agentId,
        provider,
        externalWorkspaceId: tools.readString(body.externalWorkspaceId),
        displayName,
        status: tools.readEnum(body.status, ['active', 'disabled', 'auth_required', 'error'] as const),
        credentialRef: tools.readString(body.credentialRef),
        settings: tools.readRecord(body.settings) || {},
      })
      tools.writeJson(res, 201, { binding }, options.corsOrigin)
      return true
    }
    if (itemId && !itemAction && req.method === 'PATCH') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const binding = await options.service.updateChannelBinding(context.principal, itemId, {
        displayName: body.displayName === undefined ? undefined : tools.readString(body.displayName) || '',
        status: body.status === undefined ? undefined : tools.readEnum(body.status, ['active', 'disabled', 'auth_required', 'error'] as const),
        credentialRef: body.credentialRef === undefined ? undefined : tools.readString(body.credentialRef),
        settings: body.settings === undefined ? undefined : tools.readRecord(body.settings) || {},
      })
      if (!binding) {
        tools.writeError(res, 404, 'Channel binding was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { binding }, options.corsOrigin)
      return true
    }
  }

  if (collection === 'identities' && itemId === 'resolve' && !itemAction && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const provider = tools.readChannelProvider(body.provider)
    const externalUserId = tools.readString(body.externalUserId)
    if (!provider || !externalUserId) {
      tools.writeError(res, 400, 'Channel identity resolution requires provider and externalUserId.', options.corsOrigin)
      return true
    }
    const identity = await options.service.resolveChannelIdentity(context.principal, {
      identityId: tools.readString(body.identityId),
      provider,
      externalWorkspaceId: tools.readString(body.externalWorkspaceId),
      externalUserId,
      accountId: tools.readString(body.accountId),
      role: tools.readEnum(body.role, ['owner', 'admin', 'member', 'approver', 'viewer'] as const),
      status: tools.readEnum(body.status, ['active', 'disabled', 'pending'] as const),
      metadata: tools.readRecord(body.metadata) || {},
    })
    tools.writeJson(res, 200, { identity }, options.corsOrigin)
    return true
  }

  if (collection === 'sessions') {
    if (itemId === 'bind' && !itemAction && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const channelBindingId = tools.readString(body.channelBindingId)
      const provider = tools.readChannelProvider(body.provider)
      const externalChatId = tools.readString(body.externalChatId)
      const externalThreadId = tools.readString(body.externalThreadId)
      if (!channelBindingId || !provider || !externalChatId || !externalThreadId) {
        tools.writeError(res, 400, 'Channel session binding requires channelBindingId, provider, externalChatId, and externalThreadId.', options.corsOrigin)
        return true
      }
      const bound = await options.service.bindChannelSession(context.principal, {
        identityId: tools.readString(body.identityId),
        externalUserId: tools.readString(body.externalUserId),
        externalWorkspaceId: tools.readString(body.externalWorkspaceId),
        channelBindingId,
        provider,
        externalChatId,
        externalThreadId,
        sessionId: tools.readString(body.sessionId),
        title: tools.readString(body.title),
        lastEventSequence: tools.readNonNegativeInteger(body.lastEventSequence),
        lastWorkspaceSequence: tools.readNonNegativeInteger(body.lastWorkspaceSequence),
        lastChatMessageId: tools.readString(body.lastChatMessageId),
      })
      tools.writeJson(res, 200, bound, options.corsOrigin)
      return true
    }
    if (itemId === 'by-thread' && !itemAction && req.method === 'GET') {
      const provider = tools.readChannelProvider(context.url.searchParams.get('provider'))
      const externalChatId = context.url.searchParams.get('externalChatId')
      const externalThreadId = context.url.searchParams.get('externalThreadId')
      if (!provider || !externalChatId || !externalThreadId) {
        tools.writeError(res, 400, 'Channel thread lookup requires provider, externalChatId, and externalThreadId.', options.corsOrigin)
        return true
      }
      const found = await options.service.getChannelSessionByThread(context.principal, {
        provider,
        externalWorkspaceId: context.url.searchParams.get('externalWorkspaceId'),
        externalChatId,
        externalThreadId,
      })
      if (!found) {
        tools.writeError(res, 404, 'Channel session binding was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, found, options.corsOrigin)
      return true
    }
    if (itemId === 'prompt' && !itemAction && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const bindingId = tools.readString(body.bindingId)
      const text = tools.readString(body.text)
      if (!bindingId || !text) {
        tools.writeError(res, 400, 'Channel prompt requires bindingId and text.', options.corsOrigin)
        return true
      }
      const result = await options.service.enqueueChannelPrompt(context.principal, {
        bindingId,
        text,
        agent: tools.readString(body.agent),
        identityId: tools.readString(body.identityId),
        provider: tools.readChannelProvider(body.provider),
        externalWorkspaceId: tools.readString(body.externalWorkspaceId),
        externalUserId: tools.readString(body.externalUserId),
      })
      const processed = await tools.processSessionCommandIfConfigured(options, context.principal.tenantId, result.binding.sessionId)
      await tools.writeSessionCommandMutationResponse(
        res,
        options,
        context.principal,
        result.binding.sessionId,
        result.command,
        processed,
        result.beforeProjectionSequence,
        { binding: result.binding },
      )
      return true
    }
  }

  if (collection === 'cursor' && !itemId && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const bindingId = tools.readString(body.bindingId)
    if (!bindingId) {
      tools.writeError(res, 400, 'Channel cursor update requires bindingId.', options.corsOrigin)
      return true
    }
    const result = await options.service.updateChannelCursor(context.principal, {
      bindingId,
      lastEventSequence: tools.readNonNegativeInteger(body.lastEventSequence),
      lastWorkspaceSequence: tools.readNonNegativeInteger(body.lastWorkspaceSequence),
      lastChatMessageId: body.lastChatMessageId === undefined ? undefined : tools.readString(body.lastChatMessageId),
    })
    if (!result.ok && result.reason === 'not_found') {
      tools.writeError(res, 404, 'Channel session binding was not found.', options.corsOrigin)
      return true
    }
    tools.writeJson(res, 200, { binding: result.binding, result }, options.corsOrigin)
    return true
  }

  if (collection === 'interactions') {
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const agentId = tools.readString(body.agentId)
      const sessionForInteraction = tools.readString(body.sessionId)
      const provider = tools.readChannelProvider(body.provider)
      const kind = tools.readEnum(body.kind, ['permission', 'question'] as const)
      const targetId = tools.readString(body.targetId)
      if (!agentId || !sessionForInteraction || !provider || !kind || !targetId) {
        tools.writeError(res, 400, 'Channel interaction requires agentId, sessionId, provider, kind, and targetId.', options.corsOrigin)
        return true
      }
      const issued = await options.service.createChannelInteraction(context.principal, {
        interactionId: tools.readString(body.interactionId),
        agentId,
        sessionId: sessionForInteraction,
        provider,
        kind,
        targetId,
        externalInteractionId: tools.readString(body.externalInteractionId),
        createdByIdentityId: tools.readString(body.createdByIdentityId),
        expiresAt: tools.readOptionalDate(body.expiresAt),
        tokenSecret: tools.readString(body.tokenSecret),
      })
      tools.writeJson(res, 201, {
        interaction: tools.publicChannelInteraction(issued.interaction),
        plaintextToken: issued.plaintextToken,
      }, options.corsOrigin)
      return true
    }
    if (itemId === 'resolve' && !itemAction && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const result = await options.service.resolveChannelInteraction(context.principal, {
        identityId: tools.readString(body.identityId),
        provider: tools.readChannelProvider(body.provider),
        externalWorkspaceId: tools.readString(body.externalWorkspaceId),
        externalUserId: tools.readString(body.externalUserId),
        token: tools.readString(body.token),
        externalInteractionId: tools.readString(body.externalInteractionId),
        response: body.response ?? null,
        answers: Array.isArray(body.answers) ? body.answers : undefined,
        reject: body.reject === true,
      })
      let processed = 0
      let processingError: string | null = null
      try {
        processed = await tools.processSessionCommandIfConfigured(options, context.principal.tenantId, result.interaction.sessionId)
      } catch (error) {
        processingError = error instanceof Error ? error.message : String(error)
      }
      await tools.writeSessionCommandMutationResponse(
        res,
        options,
        context.principal,
        result.interaction.sessionId,
        result.command,
        processed,
        result.beforeProjectionSequence,
        {
          interaction: tools.publicChannelInteraction(result.interaction),
          ...(processingError ? { processingError } : {}),
        },
      )
      return true
    }
  }

  if (collection === 'deliveries') {
    if (itemId === 'stream' && !itemAction && req.method === 'GET') {
      await tools.handleChannelDeliveriesSse(req, res, options, context)
      return true
    }
    if (!itemId && req.method === 'GET') {
      const status = tools.readEnum(context.url.searchParams.get('status'), ['pending', 'claimed', 'sent', 'failed', 'dead'] as const)
      const deliveries = await options.service.listChannelDeliveries(context.principal, {
        status,
        channelBindingId: tools.readString(context.url.searchParams.get('channelBindingId')),
        limit: tools.readNonNegativeInteger(context.url.searchParams.get('limit'), 50),
      })
      tools.writeJson(res, 200, { deliveries }, options.corsOrigin)
      return true
    }
    if (!itemId && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const agentId = tools.readString(body.agentId)
      const channelBindingId = tools.readString(body.channelBindingId)
      const provider = tools.readChannelProvider(body.provider)
      const eventType = tools.readString(body.eventType)
      const target = tools.readRecord(body.target)
      const payload = tools.readRecord(body.payload)
      if (!agentId || !channelBindingId || !provider || !eventType || !target || !payload) {
        tools.writeError(res, 400, 'Channel delivery requires agentId, channelBindingId, provider, target, eventType, and payload.', options.corsOrigin)
        return true
      }
      const delivery = await options.service.createChannelDelivery(context.principal, {
        deliveryId: tools.readString(body.deliveryId),
        agentId,
        channelBindingId,
        sessionBindingId: tools.readString(body.sessionBindingId),
        provider,
        target,
        eventType,
        payload,
        status: tools.readEnum(body.status, ['pending', 'claimed', 'sent', 'failed', 'dead'] as const),
        nextAttemptAt: tools.readOptionalDate(body.nextAttemptAt),
      })
      tools.writeJson(res, 201, { delivery }, options.corsOrigin)
      return true
    }
    if (itemId && itemAction === 'ack' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const status = tools.readString(body.status) as 'sent' | 'failed' | 'dead' | null
      if (!status || !['sent', 'failed', 'dead'].includes(status)) {
        tools.writeError(res, 400, 'Channel delivery ack requires status sent, failed, or dead.', options.corsOrigin)
        return true
      }
      const delivery = await options.service.ackChannelDelivery(context.principal, {
        deliveryId: itemId,
        claimedBy: tools.readString(body.claimedBy) || context.url.searchParams.get('claimedBy') || context.principal.tokenId || context.principal.userId,
        status,
        lastError: tools.readString(body.lastError),
        nextAttemptAt: tools.readOptionalDate(body.nextAttemptAt),
      })
      if (!delivery) {
        tools.writeError(res, 404, 'Channel delivery was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { delivery }, options.corsOrigin)
      return true
    }
    if (itemId && itemAction === 'retry' && req.method === 'POST') {
      const delivery = await options.service.retryChannelDelivery(context.principal, itemId)
      if (!delivery) {
        tools.writeError(res, 404, 'Channel delivery was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { delivery }, options.corsOrigin)
      return true
    }
    if (itemId && itemAction === 'dead-letter' && req.method === 'POST') {
      const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const delivery = await options.service.deadLetterChannelDelivery(context.principal, {
        deliveryId: itemId,
        lastError: tools.readString(body.lastError),
      })
      if (!delivery) {
        tools.writeError(res, 404, 'Channel delivery was not found.', options.corsOrigin)
        return true
      }
      tools.writeJson(res, 200, { delivery }, options.corsOrigin)
      return true
    }
  }

  return false
}
