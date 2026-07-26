import { constantTimeEquals as constantTimeStringEqual } from '@open-cowork/shared/node'
import type { CloudAuthConfig, OpenCoworkConfig } from '@open-cowork/shared'
import { createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DEFAULT_HEADER_AUTH_SIGNATURE_AGE_MS } from './cloud-config.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import {
  CloudHttpError,
  type CloudAuthResolver,
  type CloudDesktopAuthConfig,
} from './http-server.ts'
import {
  createOidcCloudAuthResolver,
  type OidcCloudAuthResolverOptions,
} from './oidc-auth.ts'
import type { CloudPrincipal } from './session-service.ts'

const HEADER_AUTH_SIGNED_HEADERS = [
  'x-open-cowork-tenant-id',
  'x-open-cowork-tenant-name',
  'x-open-cowork-user-id',
  'x-open-cowork-user-email',
  'x-open-cowork-user-role',
] as const

function readHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

function canonicalHeaderAuthPayload(req: IncomingMessage, timestamp: string) {
  return [
    'v1',
    timestamp,
    ...HEADER_AUTH_SIGNED_HEADERS.map((name) => readHeader(req, name) || ''),
  ].join('\n')
}

function assertHeaderAuthSignature(req: IncomingMessage, secret: string, options: {
  maxAgeMs: number
  now?: () => Date
}) {
  const timestamp = readHeader(req, 'x-open-cowork-header-auth-timestamp')
  const signature = readHeader(req, 'x-open-cowork-header-auth-signature')
  if (!timestamp || !signature) {
    throw new CloudHttpError(401, 'Trusted header authentication signature is required.')
  }
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isFinite(timestampMs)) {
    throw new CloudHttpError(401, 'Trusted header authentication timestamp is invalid.')
  }
  const nowMs = (options.now?.() || new Date()).getTime()
  if (Math.abs(nowMs - timestampMs) > options.maxAgeMs) {
    throw new CloudHttpError(401, 'Trusted header authentication timestamp is outside the allowed window.')
  }
  const expected = `v1=${createHmac('sha256', secret).update(canonicalHeaderAuthPayload(req, timestamp)).digest('hex')}`
  if (!constantTimeStringEqual(signature, expected)) {
    throw new CloudHttpError(401, 'Trusted header authentication signature is invalid.')
  }
}

function readBearerToken(req: IncomingMessage) {
  const raw = readHeader(req, 'authorization') || ''
  return raw.toLowerCase().startsWith('bearer ') ? raw.slice('bearer '.length).trim() : ''
}

export function createHeaderCloudAuthResolver(defaults: Partial<CloudPrincipal> = {}, options: {
  headerSecret?: string | null
  requireSignedHeaders?: boolean
  maxSignatureAgeMs?: number
  now?: () => Date
} = {}): CloudAuthResolver {
  return (req) => {
    const expectedSecret = options.headerSecret?.trim()
    if (expectedSecret && !constantTimeStringEqual(readHeader(req, 'x-open-cowork-header-auth-secret'), expectedSecret)) {
      throw new CloudHttpError(401, 'Trusted header authentication secret is invalid.')
    }
    // Whenever a shared secret is configured, require HMAC-signed identity
    // headers. Unsigned role headers cannot elevate to owner/admin.
    const mustVerifySignature = Boolean(expectedSecret) || Boolean(options.requireSignedHeaders)
    if (mustVerifySignature) {
      if (!expectedSecret) {
        throw new CloudHttpError(401, 'Trusted header authentication requires a configured secret for signed headers.')
      }
      assertHeaderAuthSignature(req, expectedSecret, {
        maxAgeMs: options.maxSignatureAgeMs || DEFAULT_HEADER_AUTH_SIGNATURE_AGE_MS,
        now: options.now,
      })
    }
    const tenantId = readHeader(req, 'x-open-cowork-tenant-id') || defaults.tenantId || 'default'
    const userId = readHeader(req, 'x-open-cowork-user-id') || defaults.userId || 'local-user'
    const email = readHeader(req, 'x-open-cowork-user-email') || defaults.email || 'local@example.test'
    const role = readHeader(req, 'x-open-cowork-user-role') || defaults.role || 'member'
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      throw new CloudHttpError(401, 'Trusted header authentication role is invalid.')
    }
    if (!mustVerifySignature && (role === 'owner' || role === 'admin')) {
      throw new CloudHttpError(401, 'Trusted header authentication refuses elevated roles without signed headers.')
    }
    return {
      tenantId,
      orgId: defaults.orgId || tenantId,
      tenantName: readHeader(req, 'x-open-cowork-tenant-name') || defaults.tenantName || tenantId,
      userId,
      accountId: defaults.accountId || userId,
      email,
      role,
      authSource: 'header',
    }
  }
}

export function signHeaderCloudAuthRequest(input: {
  headers: Record<string, string | undefined>
  secret: string
  timestamp: string
}) {
  const payload = [
    'v1',
    input.timestamp,
    ...HEADER_AUTH_SIGNED_HEADERS.map((name) => input.headers[name] || input.headers[name.toLowerCase()] || ''),
  ].join('\n')
  return `v1=${createHmac('sha256', input.secret).update(payload).digest('hex')}`
}

export function createLocalCloudAuthResolver(defaults: Partial<CloudPrincipal> = {}): CloudAuthResolver {
  return () => ({
    tenantId: defaults.tenantId || 'default',
    orgId: defaults.orgId || defaults.tenantId || 'default',
    tenantName: defaults.tenantName || defaults.tenantId || 'Default',
    userId: defaults.userId || 'local-user',
    accountId: defaults.accountId || defaults.userId || 'local-user',
    email: defaults.email || 'local@example.test',
    role: defaults.role || 'owner',
    authSource: 'local',
  })
}

export function createApiTokenCloudAuthResolver(store: ControlPlaneStore): CloudAuthResolver {
  return async (req) => {
    const token = readBearerToken(req)
    if (!token) throw new CloudHttpError(401, 'Cloud API token authorization is required.')
    const record = await store.findApiTokenByPlaintext(token)
    if (!record) throw new CloudHttpError(401, 'Cloud API token is invalid or expired.')
    const membership = await store.resolvePrincipalMembership({
      tenantId: record.orgId,
      accountId: record.accountId,
    })
    if (!membership || membership.membership.status !== 'active') {
      throw new CloudHttpError(401, 'Cloud API token membership is not active.')
    }
    return {
      tenantId: membership.org.tenantId,
      orgId: membership.org.orgId,
      tenantName: membership.org.name,
      userId: membership.account.accountId,
      accountId: membership.account.accountId,
      email: membership.account.email,
      role: membership.membership.role,
      authSource: 'api_token',
      tokenId: record.tokenId,
      tokenScopes: record.scopes,
    }
  }
}

export function createManagedWorkerCloudAuthResolver(store: ControlPlaneStore): CloudAuthResolver {
  return async (req) => {
    const token = readBearerToken(req)
    if (!token || !token.startsWith('ocw_')) {
      throw new CloudHttpError(401, 'Managed worker authorization is required.')
    }
    const resolved = await store.findManagedWorkerCredentialByPlaintext(token)
    if (!resolved) throw new CloudHttpError(401, 'Managed worker credential is invalid or expired.')
    return {
      tenantId: resolved.worker.tenantId || resolved.pool.tenantId || resolved.pool.orgId,
      orgId: resolved.pool.orgId,
      tenantName: resolved.pool.name,
      userId: resolved.worker.workerId,
      accountId: resolved.worker.workerId,
      email: `${resolved.worker.workerId}@workers.open-cowork.local`,
      role: 'member',
      authSource: 'worker',
      workerId: resolved.worker.workerId,
      workerPoolId: resolved.pool.poolId,
      workerCredentialId: resolved.credential.credentialId,
      workerScopes: resolved.credential.scopes,
    }
  }
}

export function createCompositeCloudAuthResolver(...resolvers: CloudAuthResolver[]): CloudAuthResolver {
  return async (req) => {
    let lastError: unknown = null
    for (const resolver of resolvers) {
      try {
        return await resolver(req)
      } catch (error) {
        // Only a clean "credential not recognized" signal may fall through.
        // Infrastructure and programming failures must not degrade to a laxer resolver.
        if (!(error instanceof CloudHttpError) || error.status !== 401) throw error
        lastError = error
      }
    }
    if (lastError instanceof CloudHttpError) throw lastError
    throw new CloudHttpError(401, 'Cloud authentication failed.')
  }
}

export function createCloudAuthResolverForConfig(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  options: OidcCloudAuthResolverOptions = {},
): CloudAuthResolver {
  if (config.cloud.auth.mode === 'oidc') {
    return createOidcCloudAuthResolver(config.cloud.auth, options)
  }
  if (config.cloud.auth.mode === 'header') {
    return createHeaderCloudAuthResolver({}, {
      headerSecret: config.cloud.auth.headerSecret,
      requireSignedHeaders: Boolean(config.cloud.auth.headerSecret),
      maxSignatureAgeMs: config.cloud.auth.headerMaxSignatureAgeMs,
    })
  }
  return createLocalCloudAuthResolver()
}

export function createCloudDesktopAuthConfig(auth: CloudAuthConfig): CloudDesktopAuthConfig | null {
  if (auth.mode !== 'oidc' || !auth.issuerUrl?.trim() || !auth.clientId?.trim()) return null
  return {
    mode: 'oidc',
    issuerUrl: auth.issuerUrl.trim(),
    clientId: auth.clientId.trim(),
    scope: 'openid email profile offline_access',
  }
}
