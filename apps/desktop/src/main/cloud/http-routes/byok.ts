import type { CloudApiRouteInput } from './types.ts'

export async function handleByokApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId: providerId, action, tools } = input

  if (!providerId && !action && req.method === 'GET') {
    tools.writeJson(res, 200, { secrets: await options.service.listByokSecrets(context.principal) }, options.corsOrigin)
    return true
  }

  if (providerId && !action && req.method === 'GET') {
    tools.writeJson(res, 200, { secret: await options.service.getByokSecret(context.principal, providerId) }, options.corsOrigin)
    return true
  }

  if (providerId && action === 'validate' && req.method === 'POST') {
    const secret = await options.service.validateByokSecret(context.principal, providerId)
    tools.writeJson(res, 200, { secret, validated: Boolean(secret?.lastValidatedAt) }, options.corsOrigin)
    return true
  }

  if (providerId && !action && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const plaintext = tools.readString(body.plaintext)
      || tools.readString(body.apiKey)
      || tools.readString(body.key)
      || tools.readString(body.secret)
    const kmsRef = tools.readString(body.kmsRef)
    if ((plaintext && kmsRef) || (!plaintext && !kmsRef)) {
      tools.writeError(res, 400, 'BYOK credential requires exactly one of plaintext/apiKey/key/secret or kmsRef.', options.corsOrigin)
      return true
    }
    const secret = await options.service.setByokSecret(context.principal, {
      providerId,
      plaintext: plaintext || null,
      kmsRef: kmsRef || null,
    })
    tools.writeJson(res, 201, { secret }, options.corsOrigin)
    return true
  }

  if (providerId && !action && req.method === 'DELETE') {
    const secret = await options.service.disableByokSecret(context.principal, providerId)
    tools.writeJson(res, 200, { secret, disabled: Boolean(secret) }, options.corsOrigin)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
