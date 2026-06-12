import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildChannelProviderStatuses } from '@open-cowork/shared'
import type { CloudHttpServerOptions } from '../http-server.ts'
import type { CloudPrincipal } from '../session-service.ts'
import type { ChannelRouteTools } from './channels.ts'

type ChannelDirectoryRouteInput = {
  req: IncomingMessage
  res: ServerResponse
  options: CloudHttpServerOptions
  context: {
    principal: CloudPrincipal
    url: URL
  }
  collection: string | undefined
  itemId: string | undefined
  tools: ChannelRouteTools
}

export async function handleChannelDirectoryRoute(input: ChannelDirectoryRouteInput): Promise<boolean> {
  const { req, res, options, context, collection, itemId, tools } = input
  if (collection === 'providers' && !itemId && req.method === 'GET') {
    const bindings = await options.service.listChannelBindings(context.principal, null, {
      limit: tools.readNonNegativeInteger(context.url.searchParams.get('limit'), 500),
    })
    tools.writeJson(res, 200, { providers: buildChannelProviderStatuses(bindings) }, options.corsOrigin)
    return true
  }
  if (collection !== 'identities' || itemId || req.method !== 'GET') return false
  tools.writeJson(res, 200, {
    identities: await options.service.listChannelIdentities(context.principal, {
      provider: tools.readChannelProvider(context.url.searchParams.get('provider')),
      externalWorkspaceId: context.url.searchParams.has('externalWorkspaceId')
        ? tools.readString(context.url.searchParams.get('externalWorkspaceId'))
        : undefined,
      role: tools.readEnum(context.url.searchParams.get('role'), ['owner', 'admin', 'member', 'approver', 'viewer'] as const),
      status: tools.readEnum(context.url.searchParams.get('status'), ['active', 'disabled', 'pending'] as const),
      limit: tools.readNonNegativeInteger(context.url.searchParams.get('limit'), 100),
    }),
  }, options.corsOrigin)
  return true
}
