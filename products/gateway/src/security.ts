import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { redactSecretText as sharedRedactSecretText } from '@open-cowork/shared'
import { constantTimeEqualsDigest } from '@open-cowork/shared/node'
import { getConfigDir, type ChannelAllowlistRule, type GatewayConfig } from './config.js'
import { configuredRedactionValues, readScopedHttpTokenFile } from './secrets-lifecycle.js'
import { decideHttpSecurityPolicy, type SecurityPolicyDecisionKind, type SecurityPolicyEvidence, type SecurityPolicyReasonCode } from './security-policy.js'

const SERVICE_SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|API[_-]?KEY)/i
const SECRET_OBJECT_KEY_PATTERN = /^(botToken|accessToken|verifyToken|appSecret|token|secret|password|credential|privateKey|apiKey|api_key|api-key)$/i
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const TELEGRAM_TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g
const KEY_VALUE_SECRET_PATTERN = /\b(token|secret|password|api[_-]?key|credential)=([^\s&]+)/gi

export function redactSecret(value?: string): string {
  if (!value) return 'not configured'
  return `<redacted:${value.length} chars>`
}

export function redactSensitiveText(value: string, config?: GatewayConfig, env: NodeJS.ProcessEnv = process.env): string {
  // Shared sanitizer first (token families), then product-configured secrets.
  let text = sharedRedactSecretText(String(value || ''))
    .replace(BEARER_PATTERN, 'Bearer <redacted>')
    .replace(KEY_VALUE_SECRET_PATTERN, (_match, key) => `${key}=<redacted>`)
    .replace(TELEGRAM_TOKEN_PATTERN, token => redactSecret(token))
  for (const secret of configuredSecrets(config, env)) {
    text = text.split(secret).join(redactSecret(secret))
  }
  return text
}

export function redactSensitiveObject<T>(value: T, config?: GatewayConfig, env: NodeJS.ProcessEnv = process.env): T {
  if (Array.isArray(value)) return value.map(item => redactSensitiveObject(item, config, env)) as T
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_OBJECT_KEY_PATTERN.test(key)
        ? typeof child === 'string' ? redactSecret(child) : child ? '<redacted>' : child
        : redactSensitiveObject(child, config, env)
    }
    return output as T
  }
  return typeof value === 'string' ? redactSensitiveText(value, config, env) as T : value
}

const LOCAL_HTTP_ADMIN_TOKEN_FILENAME = 'http-admin-token'

/** Absolute path to the local admin bearer-token file (`<configDir>/http-admin-token`). */
export function localHttpAdminTokenFilePath(): string {
  return path.join(getConfigDir(), LOCAL_HTTP_ADMIN_TOKEN_FILENAME)
}

/**
 * Ensure the local HTTP admin bearer-token file exists and return its path,
 * generating a strong random token when it is missing. This is the shared
 * provisioning used by `install`, `setup`, and the guided first-run so a CLI on
 * loopback can perform WRITE calls under the hardened `capabilityScopedLoopback`
 * default. Idempotent and benign: the same daemon-accepted token is referenced
 * via `OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE`. Never logs the token value.
 */
export function ensureLocalHttpAdminTokenFile(): string {
  const filePath = localHttpAdminTokenFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  repairOwnerOnlyDirectory(path.dirname(filePath))
  if (fs.existsSync(filePath)) {
    repairExistingTokenFile(filePath)
    if (readScopedHttpTokenFile(filePath)) return filePath
  }
  const token = randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600, flag: 'wx' })
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err
    repairExistingTokenFile(filePath)
    if (!readScopedHttpTokenFile(filePath)) fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 })
  }
  try { fs.chmodSync(filePath, 0o600) } catch {}
  return filePath
}

function repairOwnerOnlyDirectory(dirPath: string): void {
  try { fs.chmodSync(dirPath, 0o700) } catch {}
}

function repairExistingTokenFile(filePath: string): void {
  const stat = fs.lstatSync(filePath)
  if (stat.isSymbolicLink()) throw new Error(`local HTTP admin token file must not be a symlink: ${filePath}`)
  if (!stat.isFile()) throw new Error(`local HTTP admin token path must be a regular file: ${filePath}`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`local HTTP admin token file must be owned by the Gateway service user: ${filePath}`)
  try { fs.chmodSync(filePath, 0o600) } catch {}
}

export function gatewayServiceEnvironment(config: Pick<GatewayConfig, 'httpPort' | 'opencodeUrl'>, options: { adminTokenFile?: string } = {}): Record<string, string> {
  return assertNoServiceSecrets({
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    GATEWAY_HTTP_PORT: String(config.httpPort),
    OPENCODE_GATEWAY_URL: config.opencodeUrl,
    ...(options.adminTokenFile ? { OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE: options.adminTokenFile } : {}),
  })
}

export function assertNoServiceSecrets(env: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(env)) {
    if (SERVICE_SECRET_KEY_PATTERN.test(key) && !/_TOKEN_FILE$/i.test(key)) throw new Error(`service environment must not embed secret-like key: ${key}`)
  }
  return env
}

export function isLocalHttpHost(hostHeader: string | string[] | undefined): boolean {
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader
  if (!host) return true
  return isLocalHostname(extractHostname(host))
}

export function isLocalOrigin(originHeader: string | string[] | undefined): boolean {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
  if (!origin) return true
  try {
    return isLocalHttpHost(new URL(origin).host)
  } catch {
    return false
  }
}

export function isLocalRemoteAddress(address: string | undefined): boolean {
  if (!address) return true
  const value = address.trim().toLowerCase()
  return value === '127.0.0.1' || value === '::1' || value === 'localhost' || value.startsWith('::ffff:127.')
}

export function isLocalHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase()
  return value === '127.0.0.1' || value === 'localhost' || value === '::1'
}

export function extractHostname(host: string): string {
  const lower = String(host || '').trim().toLowerCase()
  if (lower.startsWith('[')) return lower.substring(1, lower.indexOf(']'))
  return lower.split(':')[0]!
}

export type HttpCapability = 'webhook' | 'read' | 'operator' | 'asset_write' | 'admin'

export interface HttpSecurityDecision {
  allowed: boolean
  reason: string
  actor: 'local' | 'webhook' | 'http-token' | 'unsafe-public' | 'rejected'
  requiredCapability?: HttpCapability
  grantedCapabilities?: HttpCapability[]
  reasonCode?: SecurityPolicyReasonCode
  policyDecision?: SecurityPolicyDecisionKind
  evidence?: SecurityPolicyEvidence
}

export interface HttpAuthPosture {
  configured: boolean
  capabilities: HttpCapability[]
  routePolicy: 'capability-scoped'
}

export interface PublicWebhookRoute {
  provider: 'whatsapp' | 'discord'
  method: 'GET' | 'POST'
  path: string
  purpose: string
}

export const PUBLIC_WEBHOOK_ROUTES: PublicWebhookRoute[] = [
  { provider: 'whatsapp', method: 'GET', path: '/webhooks/whatsapp', purpose: 'Meta verification challenge.' },
  { provider: 'whatsapp', method: 'POST', path: '/webhooks/whatsapp', purpose: 'Signed inbound WhatsApp messages.' },
  { provider: 'discord', method: 'POST', path: '/webhooks/discord', purpose: 'Signed Discord interactions.' },
]

interface HttpTokenGrant {
  token: string
  capabilities: HttpCapability[]
}

export function assertHttpBindAllowed(security: GatewayConfig['security']): void {
  const host = security?.httpHost || '127.0.0.1'
  if (isLocalHostname(extractHostname(host))) return
  if (!security.allowNonLocalHttp) throw new Error(`Refusing to bind Gateway daemon to non-local host ${host}; set security.allowNonLocalHttp=true to acknowledge exposed HTTP mode`)
  if (!hasHttpAuthTokens() && !security.publicWebhookMode && !security.unsafeAllowNoAuth) {
    throw new Error('Refusing exposed HTTP mode without a Gateway HTTP token, security.publicWebhookMode, or security.unsafeAllowNoAuth=true')
  }
  // Token-entropy floor: an exposed bearer token is the only credential standing
  // between the public internet and Gateway admin, so reject startup when it is
  // too short/low-entropy. Only applies when a token is actually the auth path;
  // public-webhook / unsafe-no-auth deployments carry no token to check.
  const strength = tokenStrengthThresholds(security)
  if (strength && hasHttpAuthTokens()) {
    const weak = configuredHttpTokenValues().find(token => !isStrongToken(token, strength))
    if (weak !== undefined) {
      throw new Error(`Refusing exposed HTTP mode: a configured Gateway HTTP token is too short or low-entropy (need >= ${strength.minLength} chars and >= ${strength.minEntropyBits} bits of entropy). Rotate to a longer random token or lower security.exposedHttp thresholds to acknowledge the weaker token.`)
    }
  }
}

export interface TokenStrengthThresholds {
  minLength: number
  minEntropyBits: number
}

function tokenStrengthThresholds(security: GatewayConfig['security']): TokenStrengthThresholds | undefined {
  const exposed = security?.exposedHttp
  if (exposed && exposed.requireStrongToken === false) return undefined
  return {
    minLength: exposed?.minTokenLength ?? 16,
    minEntropyBits: exposed?.minTokenEntropyBits ?? 48,
  }
}

/**
 * Estimated Shannon entropy in bits: length x log2(distinct alphabet). A crude
 * but monotonic floor that rejects short and repetitive tokens without a wordlist.
 */
export function estimateTokenEntropyBits(token: string): number {
  const value = String(token || '')
  if (!value) return 0
  const distinct = new Set(value.split('')).size
  if (distinct <= 1) return 0
  return value.length * Math.log2(distinct)
}

export function isStrongToken(token: string, thresholds: TokenStrengthThresholds = { minLength: 16, minEntropyBits: 48 }): boolean {
  const value = String(token || '').trim()
  if (value.length < thresholds.minLength) return false
  return estimateTokenEntropyBits(value) >= thresholds.minEntropyBits
}

export function configuredHttpTokenValues(): string[] {
  return configuredHttpTokens().map(grant => grant.token)
}

// --- Exposed-mode HTTP guard: sliding-window rate limit + auth-failure lockout ---
// State is module-level and only ever consulted in exposed mode (the local-trusted
// default path never calls these), so the single-operator localhost flow is
// completely unaffected. Memory is bounded by evicting least-recently-seen keys.

export interface ExposedHttpGuardConfig {
  rateLimit: { enabled: boolean; windowMs: number; maxRequests: number; maxTrackedClients: number }
  authLockout: { enabled: boolean; maxConsecutiveFailures: number; lockoutMs: number }
}

export interface ExposedHttpGuardKeys {
  rateLimitKey: string
  authLockoutKey: string
}

export type ExposedHttpGuardDecision =
  | { allowed: true }
  | { allowed: false; reason: 'rate_limited' | 'locked_out'; retryAfterSeconds: number }

interface ExposedRateBucket { timestamps: number[] }
interface ExposedLockoutBucket { failures: number; lockedUntil: number }

const exposedRateBuckets = new Map<string, ExposedRateBucket>()
const exposedLockoutBuckets = new Map<string, ExposedLockoutBucket>()

function touchLruEntry<T>(map: Map<string, T>, key: string, value: T, cap: number): void {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > Math.max(1, cap)) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/**
 * Consults the lockout backoff first, then consumes one sliding-window rate token.
 * Returns a 429-worthy decision with a Retry-After hint when either trips. Call
 * this before evaluating the security decision; record the auth outcome after.
 */
export function evaluateExposedHttpGuard(clientKey: string | ExposedHttpGuardKeys, config: ExposedHttpGuardConfig, now: number = Date.now()): ExposedHttpGuardDecision {
  const keys = normalizeExposedHttpGuardKeys(clientKey)
  if (config.authLockout.enabled) {
    const bucket = exposedLockoutBuckets.get(keys.authLockoutKey)
    if (bucket) {
      if (bucket.lockedUntil > now) {
        touchLruEntry(exposedLockoutBuckets, keys.authLockoutKey, bucket, config.rateLimit.maxTrackedClients)
        return { allowed: false, reason: 'locked_out', retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)) }
      }
      if (bucket.lockedUntil > 0) exposedLockoutBuckets.delete(keys.authLockoutKey)
    }
  }
  if (config.rateLimit.enabled) {
    const bucket = exposedRateBuckets.get(keys.rateLimitKey) || { timestamps: [] }
    const windowStart = now - config.rateLimit.windowMs
    bucket.timestamps = bucket.timestamps.filter(ts => ts > windowStart)
    if (bucket.timestamps.length >= config.rateLimit.maxRequests) {
      const oldest = bucket.timestamps[0]!
      touchLruEntry(exposedRateBuckets, keys.rateLimitKey, bucket, config.rateLimit.maxTrackedClients)
      return { allowed: false, reason: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil((oldest + config.rateLimit.windowMs - now) / 1000)) }
    }
    bucket.timestamps.push(now)
    touchLruEntry(exposedRateBuckets, keys.rateLimitKey, bucket, config.rateLimit.maxTrackedClients)
  }
  return { allowed: true }
}

export function recordExposedHttpAuthResult(clientKey: string | ExposedHttpGuardKeys, ok: boolean, config: ExposedHttpGuardConfig, now: number = Date.now()): void {
  if (!config.authLockout.enabled) return
  const key = normalizeExposedHttpGuardKeys(clientKey).authLockoutKey
  if (ok) {
    if (key.endsWith(':invalid')) return
    exposedLockoutBuckets.delete(key)
    return
  }
  const bucket = exposedLockoutBuckets.get(key) || { failures: 0, lockedUntil: 0 }
  bucket.failures += 1
  if (bucket.failures >= config.authLockout.maxConsecutiveFailures) {
    bucket.lockedUntil = now + config.authLockout.lockoutMs
  }
  touchLruEntry(exposedLockoutBuckets, key, bucket, config.rateLimit.maxTrackedClients)
}

function normalizeExposedHttpGuardKeys(input: string | ExposedHttpGuardKeys): ExposedHttpGuardKeys {
  if (typeof input === 'string') {
    const key = input || 'unknown'
    return { rateLimitKey: key, authLockoutKey: key }
  }
  return {
    rateLimitKey: input.rateLimitKey || 'unknown',
    authLockoutKey: input.authLockoutKey || 'unknown:missing',
  }
}

/**
 * Rate limits remain client-address scoped. Unknown/malformed credentials all
 * share one address-scoped failure identity so rotating guesses cannot evade
 * lockout; configured valid credentials get separate one-way identities so an
 * attacker cannot lock out an operator sharing the same NAT or reverse proxy.
 */
export function exposedHttpGuardKeys(clientAddress: string, authorization?: string | string[]): ExposedHttpGuardKeys {
  const address = normalizeIpAddress(clientAddress) || 'unknown'
  const token = Array.isArray(authorization) && authorization.length !== 1 ? '' : bearerToken(authorization)
  const credential = token && findHttpTokenGrant(token)
    ? `valid:${createHash('sha256').update(token).digest('hex').slice(0, 24)}`
    : 'invalid'
  return {
    rateLimitKey: address,
    authLockoutKey: `${address}:${credential}`,
  }
}

/**
 * Resolve the first untrusted hop in a proxy chain. Forwarding headers are
 * ignored unless the immediate socket peer is explicitly trusted. Walking
 * right-to-left prevents a client-supplied leftmost value from being accepted
 * when a conforming proxy appends to an existing chain.
 */
export function resolveHttpClientAddress(input: {
  remoteAddress?: string
  forwarded?: string | string[]
  xForwardedFor?: string | string[]
  trustedProxyCidrs?: string[]
}): string {
  const remoteAddress = normalizeIpAddress(input.remoteAddress) || 'unknown'
  const trustedProxyCidrs = input.trustedProxyCidrs || []
  if (!isTrustedProxyAddress(remoteAddress, trustedProxyCidrs)) return remoteAddress
  const forwarded = parseForwardedChain(input.forwarded)
  const xForwardedFor = parseXForwardedForChain(input.xForwardedFor)
  if ((forwarded.present && !forwarded.valid) || (xForwardedFor.present && !xForwardedFor.valid)) return remoteAddress
  if (forwarded.present && xForwardedFor.present && !sameAddressChain(forwarded.addresses, xForwardedFor.addresses)) return remoteAddress
  const chain = forwarded.present ? forwarded.addresses : xForwardedFor.addresses
  let candidate = remoteAddress
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    if (!isTrustedProxyAddress(candidate, trustedProxyCidrs)) break
    candidate = chain[index]!
  }
  return candidate
}

interface ForwardingAddressChain {
  present: boolean
  valid: boolean
  addresses: string[]
}

function parseForwardedChain(header: string | string[] | undefined): ForwardingAddressChain {
  const present = header !== undefined
  if (!present) return { present: false, valid: true, addresses: [] }
  const value = Array.isArray(header) ? header.join(',') : String(header)
  const addresses: string[] = []
  for (const element of value.split(',')) {
    const parameters = element.split(';').map(part => part.trim()).filter(Boolean)
    const forParameters = parameters.filter(part => /^for\s*=/i.test(part))
    if (forParameters.length !== 1) return { present: true, valid: false, addresses: [] }
    const address = normalizeIpAddress(forParameters[0]!.replace(/^for\s*=\s*/i, ''))
    if (!address) return { present: true, valid: false, addresses: [] }
    addresses.push(address)
  }
  return { present: true, valid: addresses.length > 0, addresses }
}

function parseXForwardedForChain(header: string | string[] | undefined): ForwardingAddressChain {
  const present = header !== undefined
  if (!present) return { present: false, valid: true, addresses: [] }
  const value = Array.isArray(header) ? header.join(',') : String(header)
  const rawAddresses = value.split(',')
  const addresses = rawAddresses.map(normalizeIpAddress)
  if (addresses.length === 0 || addresses.some(address => !address)) return { present: true, valid: false, addresses: [] }
  return { present: true, valid: true, addresses: addresses as string[] }
}

function sameAddressChain(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((address, index) => address === right[index])
}

function normalizeIpAddress(raw: unknown): string | undefined {
  let value = String(raw || '').trim().replace(/^"|"$/g, '')
  if (!value || /^unknown$/i.test(value) || value.startsWith('_')) return undefined
  const bracketed = value.match(/^\[([^\]]+)](?::\d+)?$/)
  if (bracketed) value = bracketed[1]!
  const ipv4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (ipv4WithPort) value = ipv4WithPort[1]!
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped && net.isIPv4(mapped[1]!)) value = mapped[1]!
  return net.isIP(value) ? value.toLowerCase() : undefined
}

function isTrustedProxyAddress(address: string, cidrs: string[]): boolean {
  if (!net.isIP(address) || cidrs.length === 0) return false
  const blockList = new net.BlockList()
  try {
    for (const cidr of cidrs) {
      const [network, prefixText] = cidr.split('/')
      const type = net.isIPv4(network!) ? 'ipv4' : net.isIPv6(network!) ? 'ipv6' : undefined
      if (!type) return false
      blockList.addSubnet(network!, Number(prefixText), type)
    }
    return blockList.check(address, net.isIPv4(address) ? 'ipv4' : 'ipv6')
  } catch {
    return false
  }
}

export function resetExposedHttpGuardsForTest(): void {
  exposedRateBuckets.clear()
  exposedLockoutBuckets.clear()
}

export function evaluateHttpRequestSecurity(input: {
  host?: string | string[]
  origin?: string | string[]
  remoteAddress?: string
  method?: string
  pathname?: string
  search?: string
  authorization?: string | string[]
}, security: GatewayConfig['security']): HttpSecurityDecision {
  const requiredCapability = httpCapabilityForRequest(input)
  const pathname = input.pathname || '/'
  const grant = findHttpTokenGrant(bearerToken(input.authorization))
  const policy = decideHttpSecurityPolicy({
    requiredCapability,
    isLocalRequest: !security.allowNonLocalHttp && isLocalHttpHost(input.host) && isLocalOrigin(input.origin) && isLocalRemoteAddress(input.remoteAddress),
    publicWebhookAllowed: Boolean(security.publicWebhookMode && isPublicWebhookRoute(input.method || 'GET', pathname)),
    allowNonLocalHttp: security.allowNonLocalHttp,
    unsafeAllowNoAuth: security.unsafeAllowNoAuth,
    capabilityScopedLoopback: security.capabilityScopedLoopback === true,
    grantCapabilities: grant?.capabilities,
  })
  return {
    allowed: policy.allowed,
    reason: policy.redactedMessage,
    actor: policy.actor,
    requiredCapability,
    grantedCapabilities: grant?.capabilities,
    reasonCode: policy.reasonCode,
    policyDecision: policy.decision,
    evidence: policy.evidence,
  }
}

export function hasHttpAuthTokens(): boolean {
  return configuredHttpTokens().length > 0
}

export function getHttpAuthPosture(): HttpAuthPosture {
  const tokens = configuredHttpTokens()
  const capabilities = [...new Set(tokens.flatMap(token => token.capabilities))].sort((a, b) => a.localeCompare(b)) as HttpCapability[]
  return {
    configured: tokens.length > 0,
    capabilities,
    routePolicy: 'capability-scoped',
  }
}

export function httpCapabilityForRequest(input: { method?: string; pathname?: string; search?: string }): HttpCapability {
  const method = String(input.method || 'GET').toUpperCase()
  const pathname = input.pathname || '/'
  const search = input.search || ''

  if (isPublicWebhookRoute(method, pathname)) return 'webhook'
  if (method === 'OPTIONS') return 'read'
  if (pathname === '/config' && method === 'GET' && new URLSearchParams(search).get('redact') === 'false') return 'admin'
  if (pathname === '/config' && method !== 'GET') return 'admin'
  if (pathname === '/events' && method === 'GET') {
    const params = new URLSearchParams(search)
    if (params.get('raw') === 'true' || params.get('unredacted') === 'true') return 'admin'
  }
  if (pathname === '/evidence/export' && method === 'GET') {
    const params = new URLSearchParams(search)
    if (params.get('redact') === 'false' || params.get('unredacted') === 'true') return 'admin'
  }
  if (pathname === '/live/events' && method === 'GET') return 'admin'
  if (/^\/runs\/[^/]+$/.test(pathname) && method === 'GET') {
    const params = new URLSearchParams(search)
    if (params.get('raw') === 'true' || params.get('unredacted') === 'true') return 'admin'
  }
  if (pathname === '/opencode/sessions' && method === 'GET') {
    const params = new URLSearchParams(search)
    if (params.get('all') === 'true' || params.get('gatewayOnly') === 'false' || params.get('raw') === 'true' || params.get('unredacted') === 'true') return 'admin'
  }
  if (/^\/opencode\/sessions\/[^/]+$/.test(pathname) && method === 'GET') {
    const params = new URLSearchParams(search)
    if (params.get('raw') === 'true' || params.get('unredacted') === 'true' || params.get('redact') === 'false') return 'admin'
  }
  if (/^\/opencode\/sessions\/[^/]+\/messages$/.test(pathname) && method === 'GET') return 'admin'
  if (pathname === '/opencode/mcp' && method === 'GET') {
    const params = new URLSearchParams(search)
    if (params.get('redact') === 'false' || params.get('raw') === 'true' || params.get('unredacted') === 'true') return 'admin'
  }
  if (pathname === '/storage/export') return 'admin'
  if (pathname.startsWith('/storage/') && method !== 'GET') return 'admin'
  if (/^\/dispatch-acquisitions\/[^/]+\/[^/]+\/settle$/.test(pathname) && method === 'POST') return 'admin'
  if (/^\/tasks\/[^/]+$/.test(pathname) && method === 'DELETE') return 'admin'
  if (/^\/roadmaps\/[^/]+$/.test(pathname) && method === 'DELETE') return 'admin'
  if (pathname === '/shutdown' || pathname === '/restart') return 'admin'
  if (pathname === '/channels/claims' && method !== 'GET') return 'admin'
  if (pathname === '/channels/bindings' && method !== 'GET') return 'admin'
  if (pathname === '/scheduler' && method !== 'GET') return 'admin'
  if (/^\/scheduler\/(pause|resume|run)$/.test(pathname) && method === 'POST') return 'operator'
  if (/^\/permissions\/[^/]+\/reply$/.test(pathname) && method === 'POST') return 'admin'
  if ((pathname === '/profiles' || pathname.startsWith('/profiles/')) && method !== 'GET') return 'asset_write'
  if ((pathname === '/agent-teams' || pathname.startsWith('/agent-teams/')) && method !== 'GET') return 'asset_write'
  if (pathname === '/blueprints/apply' && method === 'POST') return 'asset_write'
  if (pathname === '/agent-factory/teams/assemble' && method === 'POST') return 'asset_write'
  if ((pathname === '/promotion/decisions' || pathname.startsWith('/promotion/decisions/')) && method !== 'GET') return 'asset_write'
  // Personas write an OpenCode primary agent (+ optional skill) to disk — the
  // same asset class as /opencode/agents/:name — so they need asset_write, not
  // the fall-through operator default.
  if ((pathname === '/personas' || pathname.startsWith('/personas/')) && method !== 'GET') return 'asset_write'
  // Session admission is a session-creating primitive, and presence mutations
  // re-bind where trusted free-text is routed; both are admin-tier control-plane
  // operations, not ordinary operator work.
  if (pathname === '/sessions/admit' && method !== 'GET') return 'admin'
  if ((pathname === '/agent-presences' || pathname.startsWith('/agent-presences/')) && method !== 'GET') return 'admin'
  if (isOpenCodeAssetMutation(method, pathname)) return 'asset_write'
  if (method === 'GET' || method === 'HEAD') return 'read'
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return 'operator'
  return 'operator'
}

export function hasChannelAllowlist(provider: string, config: GatewayConfig): boolean {
  return channelAllowlist(provider, config).length > 0
}

export function isChannelProviderConfigured(provider: string, config: GatewayConfig): boolean {
  if (provider === 'telegram') return Boolean(process.env['TELEGRAM_BOT_TOKEN'] || config.channels?.telegram?.botToken)
  if (provider === 'whatsapp') {
    const cfg = config.channels?.whatsapp || {}
    return Boolean(
      process.env['WHATSAPP_ACCESS_TOKEN'] ||
      process.env['WHATSAPP_PHONE_NUMBER_ID'] ||
      process.env['WHATSAPP_VERIFY_TOKEN'] ||
      process.env['WHATSAPP_APP_SECRET'] ||
      cfg.accessToken ||
      cfg.phoneNumberId ||
      cfg.verifyToken ||
      cfg.appSecret
    )
  }
  if (provider === 'discord') {
    const cfg = config.channels?.discord || {}
    return Boolean(
      process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] === 'true' ||
      process.env['DISCORD_BOT_TOKEN'] ||
      process.env['DISCORD_APPLICATION_ID'] ||
      process.env['DISCORD_PUBLIC_KEY'] ||
      cfg.enabled ||
      cfg.botToken ||
      cfg.applicationId ||
      cfg.publicKey
    )
  }
  return false
}

export function allowsAllChannelTargets(provider: string, config: GatewayConfig): boolean {
  if (provider === 'telegram') return config.security?.unsafeAllowAllChannelTargets?.telegram === true
  if (provider === 'whatsapp') return config.security?.unsafeAllowAllChannelTargets?.whatsapp === true
  if (provider === 'discord') return config.security?.unsafeAllowAllChannelTargets?.discord === true
  return false
}

export function isTrustedChannelTarget(provider: string, chatId: string, threadId?: string, config?: GatewayConfig): boolean {
  if (!config) return true
  const rules = channelAllowlist(provider, config)
  // Fail closed: a provider without allowlist rules rejects every target, even when
  // the provider looks unconfigured. The only opt-out is the explicit, documented
  // security.unsafeAllowAllChannelTargets.<provider> test flag. Pre-trust onboarding
  // (claim codes and setup-safe commands) is handled by the callers before this gate.
  if (rules.length === 0) return allowsAllChannelTargets(provider, config)
  const targetThread = threadId || ''
  return rules.some(rule => rule.chatId === chatId && (!rule.threadId || rule.threadId === targetThread))
}

export interface ChannelActorAuthorization {
  allowed: boolean
  reason: string
}

export function isTrustedChannelActor(input: {
  provider: string
  chatId: string
  userId?: string
  threadId?: string
  privileged?: boolean
}, config?: GatewayConfig): ChannelActorAuthorization {
  if (!config) return { allowed: true, reason: 'no config' }
  // Non-privileged (free-text) traffic is actor-checked by default. The explicit
  // security.trustTargetMembersForFreeText opt-out restores target-only trust for
  // free text, e.g. single-user chats where the target and actor are the same person.
  if (!input.privileged && config.security?.trustTargetMembersForFreeText === true) {
    return { allowed: true, reason: 'security.trustTargetMembersForFreeText accepts free text from any member of a trusted target' }
  }
  if (allowsAllChannelTargets(input.provider, config)) return { allowed: true, reason: 'unsafe all channel targets allowed' }
  const userId = String(input.userId || '').trim()
  if (!userId) return { allowed: false, reason: 'sender user id is missing' }
  const rules = matchingChannelAllowlistRules(input.provider, input.chatId, input.threadId, config)
  // Fail closed: no matching allowlist rule means no actor can be authorized.
  if (rules.length === 0) return { allowed: false, reason: 'no channel allowlist rule matches this target' }
  if (rules.some(rule => channelRuleAllowsActor(rule, userId))) return { allowed: true, reason: 'sender is allowed by channel actor policy' }
  if (input.chatId === userId && rules.some(rule => !hasChannelActorPolicy(rule))) return { allowed: true, reason: 'sender matches private chat id' }
  return input.privileged
    ? { allowed: false, reason: `sender ${userId} is not allowed for privileged actions in this channel` }
    : { allowed: false, reason: `sender ${userId} is not a trusted actor for inbound text in this channel` }
}

/**
 * Signals that an inbound channel message could not be processed because a
 * downstream dependency (usually OpenCode) is transiently unavailable. Channel
 * adapters must NOT acknowledge the message as processed: Telegram keeps its
 * polling cursor so the update is re-fetched, and the WhatsApp webhook returns
 * a non-2xx status so Meta redelivers. Permanent (poison) failures use plain
 * errors and are skipped with a redacted audit instead.
 */
export class TransientInboundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientInboundError'
  }
}

export function isTransientInboundError(err: unknown): boolean {
  return err instanceof TransientInboundError || (err as any)?.name === 'TransientInboundError'
}

export interface ChannelAllowlistActorGap {
  provider: string
  /** Redacted target label (stable hash), safe for alerts and logs. */
  target: string
  reason: string
}

/**
 * Flags allowlist rules created before per-sender actor policies existed: rules
 * with no userIds/adminUserIds on targets where the private-chat fallback
 * (sender id === chat id) can never apply. Free text from those chats is denied
 * by the default-strict actor gate with no in-band recovery hint, so the daemon
 * raises a startup alert naming the remediations.
 */
export function listChannelAllowlistActorGaps(config: GatewayConfig): ChannelAllowlistActorGap[] {
  if (config.security?.trustTargetMembersForFreeText === true) return []
  const gaps: ChannelAllowlistActorGap[] = []
  for (const provider of ['telegram', 'whatsapp', 'discord']) {
    if (allowsAllChannelTargets(provider, config)) continue
    for (const rule of channelAllowlist(provider, config)) {
      if (hasChannelActorPolicy(rule)) continue
      if (!channelRuleLacksDmActorFallback(provider, rule)) continue
      gaps.push({
        provider,
        target: redactedChannelTargetLabel(provider, rule.chatId, rule.threadId),
        reason: provider === 'discord'
          ? 'Discord channel ids never match sender ids, so no sender can pass the free-text actor gate'
          : 'group-shaped chat id cannot match a sender id, so no sender can pass the free-text actor gate',
      })
    }
  }
  return gaps
}

function channelRuleLacksDmActorFallback(provider: string, rule: ChannelAllowlistRule): boolean {
  // Discord: the trusted target is a channel id, which never equals an author id.
  if (provider === 'discord') return true
  // Telegram: group/supergroup chat ids are negative; DM chat ids are positive
  // and equal the operator's user id, so the private-chat fallback applies.
  if (provider === 'telegram') return rule.chatId.startsWith('-')
  // WhatsApp chat ids are the sender's own number (DM-shaped), fallback applies.
  return false
}

export function isPublicWebhookRoute(method: string, pathname: string): boolean {
  const normalizedMethod = String(method || 'GET').toUpperCase()
  return PUBLIC_WEBHOOK_ROUTES.some(route => route.path === pathname && route.method === normalizedMethod)
}

export function publicWebhookRoutesForProvider(provider: string): PublicWebhookRoute[] {
  return PUBLIC_WEBHOOK_ROUTES.filter(route => route.provider === provider)
}

export function channelTargetLabel(provider: string, chatId: string, threadId?: string): string {
  return `${provider}:${chatId}${threadId ? `:${threadId}` : ''}`
}

export function channelTargetFingerprint(provider: string, chatId: string, threadId?: string): string {
  return createHash('sha256').update(`${provider}:${chatId}:${threadId || ''}`).digest('hex').slice(0, 16)
}

export function redactedChannelTargetLabel(provider: string, chatId: string, threadId?: string): string {
  const target = channelTargetFingerprint(provider, chatId, threadId)
  const thread = threadId ? `:thread:${createHash('sha256').update(String(threadId)).digest('hex').slice(0, 8)}` : ''
  return `${provider}:target:${target}${thread}`
}

function findHttpTokenGrant(token: string): HttpTokenGrant | undefined {
  if (!token) return undefined
  return configuredHttpTokens().find(grant => constantTimeTokenEquals(grant.token, token))
}

function constantTimeTokenEquals(a: string, b: string): boolean {
  // Digest-based compare (shared) — no secret-length timing side channel.
  return constantTimeEqualsDigest(a, b)
}

function configuredHttpTokens(): HttpTokenGrant[] {
  const grants: HttpTokenGrant[] = []
  addHttpTokenGrant(grants, httpTokenValue('OPENCODE_GATEWAY_HTTP_READ_TOKEN'), ['read'])
  addHttpTokenGrant(grants, httpTokenValue('OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'), ['operator'])
  addHttpTokenGrant(grants, httpTokenValue('OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'), ['admin'])
  addHttpTokenGrant(grants, httpTokenValue('OPENCODE_GATEWAY_HTTP_ASSET_WRITE_TOKEN'), ['asset_write'])
  addHttpTokenGrant(grants, httpTokenValue('OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN'), ['webhook'])
  return mergeHttpTokenGrants(grants)
}

function httpTokenValue(name: string): string | undefined {
  const direct = String(process.env[name] || '').trim()
  if (direct) return direct
  return readScopedHttpTokenFile(process.env[`${name}_FILE`])
}

function addHttpTokenGrant(grants: HttpTokenGrant[], token: string | undefined, capabilities: HttpCapability[]): void {
  const value = String(token || '').trim()
  if (!value) return
  grants.push({ token: value, capabilities })
}

function mergeHttpTokenGrants(grants: HttpTokenGrant[]): HttpTokenGrant[] {
  const byToken = new Map<string, Set<HttpCapability>>()
  for (const grant of grants) {
    const set = byToken.get(grant.token) || new Set<HttpCapability>()
    for (const capability of grant.capabilities) set.add(capability)
    byToken.set(grant.token, set)
  }
  return [...byToken.entries()].map(([token, capabilities]) => ({ token, capabilities: [...capabilities].sort((a, b) => a.localeCompare(b)) as HttpCapability[] }))
}

function isOpenCodeAssetMutation(method: string, pathname: string): boolean {
  if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE') return false
  return /^\/opencode\/(mcp|tools|agents|skills)\/[^/]+$/.test(pathname)
}

function bearerToken(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header
  const match = String(value || '').match(/^Bearer\s+(.+)$/i)
  return match ? match[1]!.trim() : ''
}

function configuredSecrets(config?: GatewayConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  return configuredRedactionValues(config, env)
}

function channelAllowlist(provider: string, config: GatewayConfig) {
  const allowlists = config.security?.channelAllowlists || { telegram: [], whatsapp: [], discord: [] }
  if (provider === 'telegram') return allowlists.telegram || []
  if (provider === 'whatsapp') return allowlists.whatsapp || []
  if (provider === 'discord') return allowlists.discord || []
  return []
}

function matchingChannelAllowlistRules(provider: string, chatId: string, threadId: string | undefined, config: GatewayConfig): ChannelAllowlistRule[] {
  const targetThread = threadId || ''
  return channelAllowlist(provider, config).filter(rule => rule.chatId === chatId && (!rule.threadId || rule.threadId === targetThread))
}

function hasChannelActorPolicy(rule: ChannelAllowlistRule): boolean {
  return Boolean(rule.userIds?.length || rule.adminUserIds?.length)
}

function channelRuleAllowsActor(rule: ChannelAllowlistRule, userId: string): boolean {
  return Boolean(rule.adminUserIds?.includes(userId) || rule.userIds?.includes(userId))
}
