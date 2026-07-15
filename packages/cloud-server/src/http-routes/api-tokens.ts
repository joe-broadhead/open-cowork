import type { CloudApiRouteInput } from './types.ts'

export async function handleApiTokensApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, tools } = input

  if (!itemId && req.method === 'GET') {
    tools.writeJson(res, 200, {
      tokens: await options.service.domains.apiTokens.listApiTokens(context.principal, {
        limit: tools.parseLimit(context.url),
      }),
    }, options.corsOrigin)
    return true
  }

  if (!itemId && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const name = tools.readString(body.name)
    const scopes = tools.readApiTokenScopes(body.scopes)
    if (!name || !scopes) {
      tools.writeError(res, 400, 'API token requires a name and at least one valid scope.', options.corsOrigin)
      return true
    }
    const channelBindingIds = readOptionalStringArray(body.channelBindingIds)
    if (channelBindingIds === false) {
      tools.writeError(res, 400, 'Channel binding grants must be an array of strings.', options.corsOrigin)
      return true
    }
    const issued = await options.service.domains.apiTokens.issueApiToken(context.principal, {
      name,
      scopes,
      expiresAt: tools.readOptionalDate(body.expiresAt),
      channelBindingIds,
    })
    tools.writeJson(res, 201, issued, options.corsOrigin)
    return true
  }

  if (itemId && action === 'channel-bindings' && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const channelBindingId = tools.readString(body.channelBindingId)
    if (!channelBindingId) {
      tools.writeError(res, 400, 'Channel binding id is required.', options.corsOrigin)
      return true
    }
    const result = await options.service.domains.apiTokens.grantApiTokenChannelBinding(context.principal, itemId, { channelBindingId })
    tools.writeJson(res, 200, result, options.corsOrigin)
    return true
  }

  if (itemId && !action && req.method === 'DELETE') {
    const token = await options.service.domains.apiTokens.revokeApiToken(context.principal, itemId)
    if (!token) {
      tools.writeError(res, 404, 'API token was not found.', options.corsOrigin)
      return true
    }
    tools.writeJson(res, 200, { token, revoked: true }, options.corsOrigin)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}

function readOptionalStringArray(value: unknown): string[] | null | false {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return false
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
}
