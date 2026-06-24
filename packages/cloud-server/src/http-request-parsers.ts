import type { IncomingMessage } from 'node:http'
import { CloudServiceError } from './session-service.ts'
import type { ApiTokenScope, ChannelProviderId, ControlPlaneSessionStatus } from './control-plane-store.ts'

// Pure request-input parsers for the cloud HTTP server, extracted from
// http-server.ts so the input-validation concern is separate from the route
// wiring. No side effects, no server state — each maps raw query/body/header
// input to a validated value (or null/undefined). (Parsers that depend on the
// server-local CloudHttpError stay in http-server.ts.)

export function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

export function readStringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null
}

export function readApiTokenScopes(value: unknown): ApiTokenScope[] | null {
  const scopes = readStringArray(value)
  if (!scopes) return null
  const allowed = new Set<ApiTokenScope>(['desktop', 'gateway', 'admin', 'operator', 'worker-internal'])
  if (scopes.some((scope) => !allowed.has(scope as ApiTokenScope))) return null
  const normalized = [...new Set(scopes as ApiTokenScope[])]
  return normalized.length > 0 ? normalized : null
}

export function readRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function parseSequenceValue(raw: string | null | undefined) {
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function parseAfterSequence(req: IncomingMessage, url: URL) {
  const fromQuery = parseSequenceValue(url.searchParams.get('after'))
  if (fromQuery > 0) return fromQuery
  return parseSequenceValue(firstHeader(req.headers['last-event-id']).trim())
}

export function parseLimit(url: URL) {
  const raw = url.searchParams.get('limit')
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function parseSessionStatus(value: string | null): ControlPlaneSessionStatus | null {
  if (!value) return null
  if (value === 'idle' || value === 'running' || value === 'closed' || value === 'errored') return value
  throw new CloudServiceError(400, 'Unsupported session status filter.', {
    policyCode: 'sessions.status.invalid',
  })
}

export function readNonNegativeInteger(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const raw = readString(value)
  return raw && (allowed as readonly string[]).includes(raw) ? raw as T : undefined
}

export function readChannelProvider(value: unknown): ChannelProviderId | undefined {
  const provider = readString(value)
  if (!provider) return undefined
  if (['telegram', 'slack', 'email', 'discord', 'whatsapp', 'signal', 'webhook', 'cli'].includes(provider)) {
    return provider as ChannelProviderId
  }
  return /^[a-z][a-z0-9_-]{1,63}$/.test(provider) && provider.includes('-')
    ? provider as ChannelProviderId
    : undefined
}

export function parseTagIds(url: URL) {
  const repeated = url.searchParams.getAll('tagId')
  const csv = url.searchParams.get('tagIds')?.split(',') || []
  return [...repeated, ...csv].map((value) => value.trim()).filter(Boolean)
}

export function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}
