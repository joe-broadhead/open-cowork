import type { SetManagedPolicyRequest } from '../services/policy-service.ts'
import { toManagedDesktopPolicyView } from '../control-plane-store.ts'
import type { CloudApiRouteInput } from './types.ts'

// Managed workspace & desktop policy routes (#898):
//   GET  /api/policy            → the stored org policy record (admin, policy:manage)
//   PUT  /api/policy            → merge a partial policy update (admin, policy:manage)
//   GET  /api/policy/effective  → the effective policy view any member enforces
// Permission gating lives in the service layer (assertPermission), so a missing
// permission surfaces as the service's 403. Reads of the *effective* policy are open to
// any authenticated member because every desktop seat must fetch it to enforce it.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// A tri-state array field: absent ⇒ leave unchanged (undefined); null ⇒ clear to
// unrestricted; array ⇒ constrain. Anything else is a client error.
function readNullableStringArray(body: Record<string, unknown>, field: string): string[] | null | undefined {
  if (!(field in body)) return undefined
  const value = body[field]
  if (value === null) return null
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[]
  throw new Error(`"${field}" must be an array of strings or null.`)
}

function readStringArrayField(body: Record<string, unknown>, field: string): string[] | undefined {
  if (!(field in body)) return undefined
  const value = body[field]
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value as string[]
  throw new Error(`"${field}" must be an array of strings.`)
}

function parseSetPolicyBody(body: Record<string, unknown>): SetManagedPolicyRequest {
  const request: SetManagedPolicyRequest = {}
  request.allowedProviders = readNullableStringArray(body, 'allowedProviders')
  request.allowedModels = readNullableStringArray(body, 'allowedModels')
  const deniedProviders = readStringArrayField(body, 'deniedProviders')
  if (deniedProviders !== undefined) request.deniedProviders = deniedProviders
  const deniedModels = readStringArrayField(body, 'deniedModels')
  if (deniedModels !== undefined) request.deniedModels = deniedModels
  if ('keyManagement' in body) {
    const value = body.keyManagement
    if (value !== null && typeof value !== 'string') throw new Error('"keyManagement" must be a string or null.')
    request.keyManagement = value as string | null
  }
  if ('extensions' in body) {
    const value = body.extensions
    if (value !== null && !isPlainObject(value)) throw new Error('"extensions" must be an object or null.')
    request.extensions = value as SetManagedPolicyRequest['extensions']
  }
  if ('features' in body) {
    const value = body.features
    if (value !== null && !isPlainObject(value)) throw new Error('"features" must be an object or null.')
    request.features = value as SetManagedPolicyRequest['features']
  }
  if ('permissionCeilings' in body) {
    const value = body.permissionCeilings
    if (value !== null && !isPlainObject(value)) throw new Error('"permissionCeilings" must be an object or null.')
    request.permissionCeilings = value as SetManagedPolicyRequest['permissionCeilings']
  }
  if ('updateChannel' in body) {
    const value = body.updateChannel
    if (value !== null && typeof value !== 'string') throw new Error('"updateChannel" must be a string or null.')
    request.updateChannel = value as string | null
  }
  return request
}

export async function handlePolicyApiRoute(input: CloudApiRouteInput): Promise<boolean> {
  const { req, res, options, context, itemId, action, tools } = input

  if (itemId === 'effective' && !action && req.method === 'GET') {
    tools.writeJson(res, 200, {
      policy: await options.service.getEffectiveManagedPolicy(context.principal),
    }, options.corsOrigin)
    return true
  }

  if (!itemId && req.method === 'GET') {
    const record = await options.service.getManagedPolicy(context.principal)
    tools.writeJson(res, 200, {
      policy: record,
      view: toManagedDesktopPolicyView(record),
    }, options.corsOrigin)
    return true
  }

  if (!itemId && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await tools.readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    let request: SetManagedPolicyRequest
    try {
      request = parseSetPolicyBody(body)
    } catch (error) {
      tools.writeError(res, 400, error instanceof Error ? error.message : 'Invalid policy update.', options.corsOrigin)
      return true
    }
    const record = await options.service.setManagedPolicy(context.principal, request)
    tools.writeJson(res, 200, {
      policy: record,
      view: toManagedDesktopPolicyView(record),
    }, options.corsOrigin)
    return true
  }

  tools.writeError(res, 404, 'Not found.', options.corsOrigin)
  return true
}
