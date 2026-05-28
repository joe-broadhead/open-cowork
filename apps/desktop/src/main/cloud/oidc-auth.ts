import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, type JsonWebKey, verify } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { CloudAuthConfig } from '../config-types.ts'
import { CloudHttpError, type CloudAuthResolver, type CloudBrowserAuthProvider } from './http-server.ts'

type OidcFetchResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text?(): Promise<string>
}

type OidcFetch = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
}) => Promise<OidcFetchResponse>

type OidcDiscoveryDocument = {
  issuer: string
  jwks_uri: string
  authorization_endpoint?: string
  token_endpoint?: string
}

type JwksDocument = {
  keys: JsonWebKey[]
}

type JwtHeader = {
  alg: string
  kid?: string
  typ?: string
}

type JwtClaims = {
  iss?: string
  sub?: string
  aud?: string | string[]
  exp?: number
  nbf?: number
  iat?: number
  email?: string
  email_verified?: boolean
  preferred_username?: string
  name?: string
  hd?: string
  tid?: string
  tenant_id?: string
  tenant_name?: string
  nonce?: string
}

export type OidcCloudAuthResolverOptions = {
  fetch?: OidcFetch
  now?: () => Date
  discoveryCacheTtlMs?: number
  jwksCacheTtlMs?: number
  clockSkewSeconds?: number
}

export type OidcBrowserAuthOptions = OidcCloudAuthResolverOptions & {
  publicUrl?: string | null
  clientSecret?: string | null
  stateCookieSecret: string | Buffer
  stateCookieName?: string
  stateTtlMs?: number
  secureCookies?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  scope?: string
}

const SUPPORTED_ALGS: Record<string, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
}

const DEFAULT_CALLBACK_PATH = '/auth/callback'
const DEFAULT_STATE_COOKIE = 'open_cowork_cloud_oidc'
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000

function defaultFetch(): OidcFetch {
  return (url, init) => globalThis.fetch(url, init as RequestInit) as Promise<OidcFetchResponse>
}

function unauthorized(message = 'Cloud authentication failed.'): never {
  throw new CloudHttpError(401, message)
}

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

function base64UrlEncode(value: Buffer | string) {
  return Buffer.from(value).toString('base64url')
}

function parseJwtPart<T>(encoded: string): T {
  try {
    return JSON.parse(base64UrlDecode(encoded).toString('utf8')) as T
  } catch {
    unauthorized('Cloud authentication token is malformed.')
  }
}

function readBearerToken(req: IncomingMessage) {
  const raw = req.headers.authorization
  const value = Array.isArray(raw) ? raw[0] || '' : raw || ''
  const prefix = 'bearer '
  return value.trim().toLowerCase().startsWith(prefix)
    ? value.trim().slice(prefix.length).trim()
    : ''
}

function normalizeString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeEmail(value: unknown) {
  const email = normalizeString(value)?.toLowerCase()
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null
}

function emailDomain(email: string) {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase()
}

function audienceMatches(audience: string | string[] | undefined, clientId: string) {
  if (typeof audience === 'string') return audience === clientId
  return Array.isArray(audience) && audience.includes(clientId)
}

async function fetchJson<T>(fetcher: OidcFetch, url: string): Promise<T> {
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    const detail = response.text ? await response.text().catch(() => '') : ''
    throw new Error(`OIDC metadata fetch failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 256)}` : ''}.`)
  }
  return response.json() as Promise<T>
}

function validateDiscovery(value: unknown, issuerUrl: string): OidcDiscoveryDocument {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const issuer = normalizeString(record.issuer)
  const jwksUri = normalizeString(record.jwks_uri)
  const authorizationEndpoint = normalizeString(record.authorization_endpoint)
  const tokenEndpoint = normalizeString(record.token_endpoint)
  if (!issuer || !jwksUri) throw new Error('OIDC discovery document is missing issuer or jwks_uri.')
  if (trimTrailingSlash(issuer) !== trimTrailingSlash(issuerUrl)) {
    throw new Error('OIDC discovery issuer does not match configured issuer.')
  }
  return {
    issuer,
    jwks_uri: jwksUri,
    authorization_endpoint: authorizationEndpoint || undefined,
    token_endpoint: tokenEndpoint || undefined,
  }
}

function validateJwks(value: unknown): JwksDocument {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const keys = Array.isArray(record.keys)
    ? record.keys.filter((key): key is JsonWebKey => Boolean(key && typeof key === 'object' && !Array.isArray(key)))
    : []
  if (keys.length === 0) throw new Error('OIDC JWKS document contains no usable keys.')
  return { keys }
}

function signingInput(token: string) {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) {
    unauthorized('Cloud authentication token is malformed.')
  }
  return {
    header: parseJwtPart<JwtHeader>(parts[0]),
    claims: parseJwtPart<JwtClaims>(parts[1]),
    signed: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecode(parts[2]),
  }
}

function verifyJwtSignature(input: ReturnType<typeof signingInput>, keys: JsonWebKey[]) {
  const algorithm = SUPPORTED_ALGS[input.header.alg]
  if (!algorithm) unauthorized('Cloud authentication token uses an unsupported algorithm.')
  const candidates = input.header.kid
    ? keys.filter((key) => key.kid === input.header.kid)
    : keys
  for (const jwk of candidates) {
    try {
      const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
      if (verify(algorithm, Buffer.from(input.signed), publicKey, input.signature)) return
    } catch {
      // Try the next key. A malformed or mismatched key should not weaken verification.
    }
  }
  unauthorized('Cloud authentication token signature is invalid.')
}

function validateClaims(
  claims: JwtClaims,
  input: {
    issuerUrl: string
    clientId: string
    allowedEmailDomains: string[]
    nowSeconds: number
    clockSkewSeconds: number
    nonce?: string | null
  },
) {
  if (trimTrailingSlash(claims.iss || '') !== trimTrailingSlash(input.issuerUrl)) {
    unauthorized('Cloud authentication token issuer is invalid.')
  }
  if (!claims.sub) unauthorized('Cloud authentication token subject is missing.')
  if (!audienceMatches(claims.aud, input.clientId)) {
    unauthorized('Cloud authentication token audience is invalid.')
  }
  if (typeof claims.exp !== 'number' || claims.exp <= input.nowSeconds - input.clockSkewSeconds) {
    unauthorized('Cloud authentication token has expired.')
  }
  if (typeof claims.nbf === 'number' && claims.nbf > input.nowSeconds + input.clockSkewSeconds) {
    unauthorized('Cloud authentication token is not valid yet.')
  }
  if (input.nonce && claims.nonce !== input.nonce) {
    unauthorized('Cloud authentication token nonce is invalid.')
  }
  const email = normalizeEmail(claims.email || claims.preferred_username)
  if (!email) unauthorized('Cloud authentication token email is missing.')
  if (claims.email_verified === false) unauthorized('Cloud authentication token email is not verified.')
  const allowedDomains = input.allowedEmailDomains.map((domain) => domain.toLowerCase())
  if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain(email))) {
    unauthorized('Cloud authentication token email domain is not allowed.')
  }
  return { email }
}

function stableUserId(issuerUrl: string, subject: string) {
  return createHash('sha256').update(`${trimTrailingSlash(issuerUrl)}\0${subject}`).digest('hex').slice(0, 32)
}

function claimsToPrincipal(claims: JwtClaims, issuerUrl: string, email: string) {
  const tenantId = normalizeString(claims.tenant_id)
    || normalizeString(claims.tid)
    || normalizeString(claims.hd)
    || emailDomain(email)
  const userId = stableUserId(issuerUrl, claims.sub || '')
  return {
    tenantId,
    orgId: tenantId,
    tenantName: normalizeString(claims.tenant_name) || tenantId,
    userId,
    accountId: userId,
    email,
    role: 'member' as const,
    authSource: 'user' as const,
  }
}

function createOidcVerifier(
  config: CloudAuthConfig,
  options: OidcCloudAuthResolverOptions = {},
) {
  if (config.mode !== 'oidc') throw new Error('OIDC cloud auth resolver requires cloud.auth.mode=oidc.')
  if (!config.issuerUrl?.trim()) throw new Error('OIDC cloud auth requires cloud.auth.issuerUrl.')
  if (!config.clientId?.trim()) throw new Error('OIDC cloud auth requires cloud.auth.clientId.')

  const issuerUrl = trimTrailingSlash(config.issuerUrl)
  const clientId = config.clientId.trim()
  const allowedEmailDomains = config.allowedEmailDomains || []
  const fetcher = options.fetch || defaultFetch()
  const now = options.now || (() => new Date())
  const discoveryCacheTtlMs = options.discoveryCacheTtlMs ?? 10 * 60 * 1000
  const jwksCacheTtlMs = options.jwksCacheTtlMs ?? 5 * 60 * 1000
  const clockSkewSeconds = options.clockSkewSeconds ?? 60
  let discoveryCache: { expiresAt: number, value: OidcDiscoveryDocument } | null = null
  let jwksCache: { expiresAt: number, value: JwksDocument } | null = null

  async function discovery() {
    const nowMs = now().getTime()
    if (discoveryCache && discoveryCache.expiresAt > nowMs) return discoveryCache.value
    const value = validateDiscovery(
      await fetchJson(fetcher, `${issuerUrl}/.well-known/openid-configuration`),
      issuerUrl,
    )
    discoveryCache = { value, expiresAt: nowMs + discoveryCacheTtlMs }
    return value
  }

  async function jwks() {
    const nowMs = now().getTime()
    if (jwksCache && jwksCache.expiresAt > nowMs) return jwksCache.value
    const metadata = await discovery()
    const value = validateJwks(await fetchJson(fetcher, metadata.jwks_uri))
    jwksCache = { value, expiresAt: nowMs + jwksCacheTtlMs }
    return value
  }

  async function verifyToken(token: string, nonce?: string | null) {
    const parsed = signingInput(token)
    verifyJwtSignature(parsed, (await jwks()).keys)
    const { email } = validateClaims(parsed.claims, {
      issuerUrl,
      clientId,
      allowedEmailDomains,
      nowSeconds: Math.floor(now().getTime() / 1000),
      clockSkewSeconds,
      nonce,
    })
    return claimsToPrincipal(parsed.claims, issuerUrl, email)
  }

  return {
    issuerUrl,
    clientId,
    fetcher,
    now,
    discovery,
    verifyToken,
  }
}

export function createOidcCloudAuthResolver(
  config: CloudAuthConfig,
  options: OidcCloudAuthResolverOptions = {},
): CloudAuthResolver {
  const verifier = createOidcVerifier(config, options)

  return async (req) => {
    const token = readBearerToken(req)
    if (!token) unauthorized('Cloud bearer authorization is required.')
    return verifier.verifyToken(token)
  }
}

type OidcStatePayload = {
  version: 1
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
  expiresAtMs: number
}

function signState(secret: string | Buffer, payload: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
}

function parseCookieHeader(req: IncomingMessage) {
  const header = req.headers.cookie
  const raw = Array.isArray(header) ? header.join('; ') : header || ''
  const cookies = new Map<string, string>()
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (!name) continue
    cookies.set(name, decodeURIComponent(part.slice(index + 1).trim()))
  }
  return cookies
}

function serializeCookie(input: {
  name: string
  value: string
  maxAgeSeconds: number
  sameSite: 'Strict' | 'Lax' | 'None'
  secure: boolean
}) {
  const parts = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    `Max-Age=${input.maxAgeSeconds}`,
    'Path=/',
    `SameSite=${input.sameSite}`,
    'HttpOnly',
  ]
  if (input.secure) parts.push('Secure')
  return parts.join('; ')
}

function signedStateCookie(secret: string | Buffer, payload: OidcStatePayload) {
  const encoded = base64UrlEncode(JSON.stringify(payload))
  return `${encoded}.${signState(secret, encoded)}`
}

function readSignedStateCookie(
  req: IncomingMessage,
  input: { secret: string | Buffer, cookieName: string, nowMs: number },
) {
  const value = parseCookieHeader(req).get(input.cookieName)
  if (!value) unauthorized('OIDC login state is missing.')
  const [encoded, signature] = value.split('.')
  if (!encoded || !signature || !constantTimeEquals(signature, signState(input.secret, encoded))) {
    unauthorized('OIDC login state is invalid.')
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OidcStatePayload
    if (parsed.version !== 1 || !parsed.state || !parsed.nonce || !parsed.codeVerifier) {
      unauthorized('OIDC login state is invalid.')
    }
    if (!Number.isFinite(parsed.expiresAtMs) || parsed.expiresAtMs <= input.nowMs) {
      unauthorized('OIDC login state has expired.')
    }
    return parsed
  } catch {
    unauthorized('OIDC login state is invalid.')
  }
}

function normalizeCallbackPath(value: string | undefined) {
  const path = value?.trim() || DEFAULT_CALLBACK_PATH
  return path.startsWith('/') && !path.startsWith('//') ? path : DEFAULT_CALLBACK_PATH
}

function requestOrigin(req: IncomingMessage) {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  if (!host) return 'http://localhost'
  return `http://${String(host).split(',')[0].trim()}`
}

function redirectUri(req: IncomingMessage, publicUrl: string | null | undefined, callbackPath: string) {
  const base = publicUrl?.trim() || requestOrigin(req)
  return new URL(callbackPath, trimTrailingSlash(base)).toString()
}

function safeReturnTo(url: URL) {
  const value = url.searchParams.get('returnTo') || '/'
  return value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function codeChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url')
}

async function tokenResponseJson(response: OidcFetchResponse) {
  if (!response.ok) {
    throw new CloudHttpError(401, 'OIDC token exchange failed.')
  }
  const value = await response.json()
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function createOidcBrowserAuthProvider(
  config: CloudAuthConfig,
  options: OidcBrowserAuthOptions,
): CloudBrowserAuthProvider {
  if (!options.stateCookieSecret || Buffer.byteLength(options.stateCookieSecret) < 16) {
    throw new Error('OIDC browser auth state cookie secret must be at least 16 bytes.')
  }
  const verifier = createOidcVerifier(config, options)
  const callbackPath = normalizeCallbackPath(config.callbackPath)
  const cookieName = options.stateCookieName || DEFAULT_STATE_COOKIE
  const stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS
  const secure = options.secureCookies !== false
  const sameSite = options.sameSite || 'Lax'
  const scope = options.scope || 'openid email profile'
  const clientSecret = options.clientSecret?.trim() || null

  function clearCookie() {
    return serializeCookie({
      name: cookieName,
      value: '',
      maxAgeSeconds: 0,
      sameSite,
      secure,
    })
  }

  return {
    isCallbackPath(pathname) {
      return pathname === callbackPath
    },
    async login(req, url) {
      const metadata = await verifier.discovery()
      if (!metadata.authorization_endpoint) {
        throw new Error('OIDC discovery document is missing authorization_endpoint.')
      }
      const state = randomBytes(24).toString('base64url')
      const nonce = randomBytes(24).toString('base64url')
      const codeVerifier = randomBytes(32).toString('base64url')
      const callbackUrl = redirectUri(req, options.publicUrl, callbackPath)
      const payload: OidcStatePayload = {
        version: 1,
        state,
        nonce,
        codeVerifier,
        returnTo: safeReturnTo(url),
        expiresAtMs: verifier.now().getTime() + stateTtlMs,
      }
      const authUrl = new URL(metadata.authorization_endpoint)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', verifier.clientId)
      authUrl.searchParams.set('redirect_uri', callbackUrl)
      authUrl.searchParams.set('scope', scope)
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('nonce', nonce)
      authUrl.searchParams.set('code_challenge', codeChallenge(codeVerifier))
      authUrl.searchParams.set('code_challenge_method', 'S256')
      return {
        location: authUrl.toString(),
        setCookieHeaders: [
          serializeCookie({
            name: cookieName,
            value: signedStateCookie(options.stateCookieSecret, payload),
            maxAgeSeconds: Math.floor(stateTtlMs / 1000),
            sameSite,
            secure,
          }),
        ],
      }
    },
    async callback(req, url) {
      const error = url.searchParams.get('error')
      if (error) throw new CloudHttpError(401, `OIDC login failed: ${error}.`)
      const code = url.searchParams.get('code') || ''
      const state = url.searchParams.get('state') || ''
      if (!code || !state) unauthorized('OIDC callback requires code and state.')
      const loginState = readSignedStateCookie(req, {
        secret: options.stateCookieSecret,
        cookieName,
        nowMs: verifier.now().getTime(),
      })
      if (state !== loginState.state) unauthorized('OIDC callback state is invalid.')

      const metadata = await verifier.discovery()
      if (!metadata.token_endpoint) {
        throw new Error('OIDC discovery document is missing token_endpoint.')
      }
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(req, options.publicUrl, callbackPath),
        client_id: verifier.clientId,
        code_verifier: loginState.codeVerifier,
      })
      if (clientSecret) form.set('client_secret', clientSecret)
      const tokenResponse = await tokenResponseJson(await verifier.fetcher(metadata.token_endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }))
      const idToken = normalizeString(tokenResponse.id_token)
      if (!idToken) unauthorized('OIDC token response is missing id_token.')
      return {
        principal: await verifier.verifyToken(idToken, loginState.nonce),
        redirectTo: loginState.returnTo,
        setCookieHeaders: [clearCookie()],
      }
    },
  }
}
