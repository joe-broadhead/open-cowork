import type { CloudApiRouteInput } from './types.ts'

export async function handleBillingApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, tools } = input

  if (itemId === 'subscription' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, await options.service.getBillingSubscription(context.principal), options.corsOrigin)
    return true
  }

  if (itemId === 'checkout' && !action && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const checkout = await options.service.createBillingCheckout(context.principal, {
      planKey: tools.readString(body.planKey),
      successUrl: tools.readString(body.successUrl),
      cancelUrl: tools.readString(body.cancelUrl),
    })
    tools.writeJson(res, 200, checkout, options.corsOrigin)
    return true
  }

  if (itemId === 'portal' && !action && req.method === 'POST') {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const portal = await options.service.createBillingPortal(context.principal, {
      returnUrl: tools.readString(body.returnUrl),
    })
    tools.writeJson(res, 200, portal, options.corsOrigin)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
