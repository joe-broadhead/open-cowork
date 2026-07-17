import { createHmac, randomBytes } from 'node:crypto'
import { constantTimeEquals } from '@open-cowork/shared/node'
import type { IncomingMessage } from 'node:http'
import type { CloudPrincipal } from './session-service.ts'

export type CloudSessionCookieOptions = {
  secret: string | Buffer
  sessionCookieName?: string
  csrfCookieName?: string
  ttlMs?: number
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  path?: string
  now?: () => Date
}

export type CloudCookieSession = {
  principal: CloudPrincipal
  csrfToken: string
  expiresAt: string
}

export type CloudIssuedSessionCookies = CloudCookieSession & {
  setCookieHeaders: string[]
}

export type CloudSessionCookieManager = {
  sessionCookieName: string
  csrfCookieName: string
  issue(principal: CloudPrincipal): CloudIssuedSessionCookies
  read(req: IncomingMessage): CloudCookieSession | null
  assertCsrf(req: IncomingMessage): void
  clear(): string[]
}

type SignedSessionPayload = {
  version: 1
  principal: CloudPrincipal
  csrfToken: string
  expiresAtMs: number
}

const DEFAULT_SESSION_COOKIE = 'open_cowork_cloud_session'
const DEFAULT_CSRF_COOKIE = 'open_cowork_cloud_csrf'
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url')
}

function fromBase64url(input: string) {
  return Buffer.from(input, 'base64url')
}

function cookieMap(req: IncomingMessage) {
  const header = req.headers.cookie
  const raw = Array.isArray(header) ? header.join('; ') : header || ''
  const parsed = new Map<string, string>()
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name) continue
    parsed.set(name, decodeURIComponent(value))
  }
  return parsed
}

function sign(secret: string | Buffer, payload: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function serializeCookie(input: {
  name: string
  value: string
  maxAgeSeconds: number
  path: string
  sameSite: 'Strict' | 'Lax' | 'None'
  secure: boolean
  httpOnly: boolean
}) {
  const parts = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    `Max-Age=${input.maxAgeSeconds}`,
    `Path=${input.path}`,
    `SameSite=${input.sameSite}`,
  ]
  if (input.httpOnly) parts.push('HttpOnly')
  if (input.secure) parts.push('Secure')
  return parts.join('; ')
}

function normalizePrincipal(value: CloudPrincipal): CloudPrincipal {
  return {
    tenantId: value.tenantId,
    orgId: value.orgId,
    tenantName: value.tenantName,
    userId: value.userId,
    accountId: value.accountId,
    email: value.email,
    role: value.role,
    authSource: value.authSource,
    tokenId: value.tokenId,
  }
}

function parseSignedSession(secret: string | Buffer, value: string): SignedSessionPayload | null {
  const [payload, signature] = value.split('.')
  if (!payload || !signature || !constantTimeEquals(signature, sign(secret, payload))) return null
  try {
    const parsed = JSON.parse(fromBase64url(payload).toString('utf8')) as SignedSessionPayload
    if (parsed.version !== 1) return null
    if (!parsed.principal?.tenantId || !parsed.principal.userId || !parsed.principal.email || !parsed.csrfToken) return null
    if (!Number.isFinite(parsed.expiresAtMs)) return null
    return parsed
  } catch {
    return null
  }
}

export function createCloudSessionCookieManager(options: CloudSessionCookieOptions): CloudSessionCookieManager {
  // JOE-828: align session cookie secret strength with envelope keys (≥32 bytes).
  if (!options.secret || Buffer.byteLength(options.secret) < 32) {
    throw new Error('Cloud session cookie secret must be at least 32 bytes.')
  }
  const sessionCookieName = options.sessionCookieName || DEFAULT_SESSION_COOKIE
  const csrfCookieName = options.csrfCookieName || DEFAULT_CSRF_COOKIE
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const secure = options.secure !== false
  const sameSite = options.sameSite || 'Lax'
  const path = options.path || '/'
  const now = options.now || (() => new Date())

  function buildCookies(sessionValue: string, csrfToken: string, maxAgeSeconds: number) {
    return [
      serializeCookie({
        name: sessionCookieName,
        value: sessionValue,
        maxAgeSeconds,
        path,
        sameSite,
        secure,
        httpOnly: true,
      }),
      serializeCookie({
        name: csrfCookieName,
        value: csrfToken,
        maxAgeSeconds,
        path,
        sameSite,
        secure,
        httpOnly: false,
      }),
    ]
  }

  return {
    sessionCookieName,
    csrfCookieName,
    issue(principal) {
      const nowMs = now().getTime()
      const expiresAtMs = nowMs + ttlMs
      const csrfToken = randomBytes(32).toString('base64url')
      const payload: SignedSessionPayload = {
        version: 1,
        principal: normalizePrincipal(principal),
        csrfToken,
        expiresAtMs,
      }
      const encoded = base64url(JSON.stringify(payload))
      const sessionValue = `${encoded}.${sign(options.secret, encoded)}`
      return {
        principal: payload.principal,
        csrfToken,
        expiresAt: new Date(expiresAtMs).toISOString(),
        setCookieHeaders: buildCookies(sessionValue, csrfToken, Math.floor(ttlMs / 1000)),
      }
    },
    read(req) {
      const cookies = cookieMap(req)
      const value = cookies.get(sessionCookieName)
      if (!value) return null
      const payload = parseSignedSession(options.secret, value)
      if (!payload || payload.expiresAtMs <= now().getTime()) return null
      return {
        principal: payload.principal,
        csrfToken: payload.csrfToken,
        expiresAt: new Date(payload.expiresAtMs).toISOString(),
      }
    },
    assertCsrf(req) {
      const session = this.read(req)
      if (!session) throw new Error('Cloud session cookie is invalid.')
      const header = Array.isArray(req.headers['x-csrf-token'])
        ? req.headers['x-csrf-token'][0] || ''
        : req.headers['x-csrf-token'] || ''
      const csrfCookie = cookieMap(req).get(csrfCookieName) || ''
      if (!header || !csrfCookie || !constantTimeEquals(header, csrfCookie) || !constantTimeEquals(header, session.csrfToken)) {
        throw new Error('Cloud CSRF token is missing or invalid.')
      }
    },
    clear() {
      return buildCookies('', '', 0)
    },
  }
}
