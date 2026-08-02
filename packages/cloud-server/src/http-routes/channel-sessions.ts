import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudHttpServerOptions } from '../http-contracts.ts'
import type { ChannelRouteTools, RouteContext } from './channels.ts'

export async function handleChannelSessionRoutes(input: {
  req: IncomingMessage
  res: ServerResponse
  options: CloudHttpServerOptions
  context: RouteContext
  itemId: string | undefined
  itemAction: string | undefined
  tools: ChannelRouteTools
}): Promise<boolean> {
  const { req, res, options, context, itemId, itemAction, tools } = input

  if (itemId && itemAction && req.method === 'GET') {
    const nestedItemId = context.segments[5]
    const exactLength = context.segments.length
    if (
      (itemAction === 'snapshot' && exactLength === 5)
      || (itemAction === 'events' && exactLength === 5)
      || (itemAction === 'artifacts' && nestedItemId && exactLength === 6)
    ) {
      const binding = await options.service.domains.channels.getAuthorizedChannelSessionBinding(
        context.principal,
        itemId,
      )
      if (itemAction === 'snapshot') {
        tools.writeJson(
          res,
          200,
          await options.service.getSessionView(context.principal, binding.sessionId),
          options.corsOrigin,
        )
        return true
      }
      if (itemAction === 'events') {
        await tools.handleSessionSse(req, res, options, context, binding.sessionId)
        return true
      }
      if (!options.artifacts) {
        tools.writeError(res, 503, 'Cloud artifact storage is not configured.', options.corsOrigin)
        return true
      }
      const artifact = await options.artifacts.readSessionArtifact(
        context.principal,
        binding.sessionId,
        nestedItemId!,
      )
      tools.writeJson(res, 200, {
        artifact: {
          ...options.artifacts.publicArtifact(artifact),
          contentType: artifact.contentType,
          dataBase64: artifact.dataBase64,
        },
      }, options.corsOrigin)
      return true
    }
  }

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
    const bound = await options.service.domains.channels.bindChannelSession(context.principal, {
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
    const found = await options.service.domains.channels.getChannelSessionByThread(context.principal, {
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
    const result = await options.service.domains.channels.enqueueChannelPrompt(context.principal, {
      bindingId,
      text,
      agent: tools.readString(body.agent),
      identityId: tools.readString(body.identityId),
      provider: tools.readChannelProvider(body.provider),
      externalWorkspaceId: tools.readString(body.externalWorkspaceId),
      externalUserId: tools.readString(body.externalUserId),
    })
    const processed = await tools.processSessionCommandIfConfigured(
      options,
      context.principal.tenantId,
      result.binding.sessionId,
    )
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

  return false
}
