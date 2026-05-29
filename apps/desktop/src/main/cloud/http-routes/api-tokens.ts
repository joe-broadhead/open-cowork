import type { CloudApiRouteInput } from './types.ts'

export async function handleApiTokensApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, tools } = input

  if (!itemId && req.method === 'GET') {
    tools.writeJson(res, 200, { tokens: await options.service.listApiTokens(context.principal) }, options.corsOrigin)
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
    const issued = await options.service.issueApiToken(context.principal, {
      name,
      scopes,
      expiresAt: tools.readOptionalDate(body.expiresAt),
    })
    tools.writeJson(res, 201, issued, options.corsOrigin)
    return true
  }

  if (itemId && !action && req.method === 'DELETE') {
    const token = await options.service.revokeApiToken(context.principal, itemId)
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
