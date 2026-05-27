import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signBuffer, type JsonWebKey } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

import { DEFAULT_CONFIG, type OpenCoworkConfig } from '../apps/desktop/src/main/config-types.ts'
import { createCloudAuthResolverForConfig } from '../apps/desktop/src/main/cloud/app.ts'
import { CloudHttpError } from '../apps/desktop/src/main/cloud/http-server.ts'
import {
  createOidcBrowserAuthProvider,
  createOidcCloudAuthResolver,
  type OidcCloudAuthResolverOptions,
} from '../apps/desktop/src/main/cloud/oidc-auth.ts'

const issuerUrl = 'https://auth.example.test'
const clientId = 'open-cowork-cloud'
const TEST_COOKIE_KEY = 'not-a-real-cookie-key-for-tests'

function base64Url(value: Buffer | string) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function jsonPart(value: unknown) {
  return base64Url(JSON.stringify(value))
}

function createJwtFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey
  const kid = 'test-key-1'
  return {
    jwk: {
      ...jwk,
      kid,
      alg: 'RS256',
      use: 'sig',
    } as JsonWebKey,
    token(claims: Record<string, unknown> = {}) {
      const header = jsonPart({ alg: 'RS256', kid, typ: 'JWT' })
      const payload = jsonPart({
        iss: issuerUrl,
        aud: clientId,
        sub: 'user-subject-1',
        email: 'analyst@example.test',
        email_verified: true,
        tenant_id: 'tenant-a',
        tenant_name: 'Tenant A',
        exp: Math.floor(new Date('2026-05-26T12:00:00.000Z').getTime() / 1000) + 3600,
        ...claims,
      })
      const signed = `${header}.${payload}`
      const signature = signBuffer('RSA-SHA256', Buffer.from(signed), privateKey)
      return `${signed}.${base64Url(signature)}`
    },
  }
}

function jsonResponse(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value
    },
    async text() {
      return JSON.stringify(value)
    },
  }
}

function oidcFetch(jwk: JsonWebKey, calls: string[] = []): OidcCloudAuthResolverOptions['fetch'] {
  return async (url) => {
    calls.push(url)
    if (url === `${issuerUrl}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: issuerUrl,
        jwks_uri: `${issuerUrl}/.well-known/jwks.json`,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
      })
    }
    if (url === `${issuerUrl}/.well-known/jwks.json`) {
      return jsonResponse({ keys: [jwk] })
    }
    return jsonResponse({ error: 'not found' }, 404)
  }
}

function requestWithBearer(token: string | null) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage
}

function requestWithHeaders(headers: Record<string, string> = {}) {
  return { headers } as unknown as IncomingMessage
}

function cookieHeader(headers: string[]) {
  return headers.map((header) => header.split(';')[0]).join('; ')
}

function oidcConfig(): OpenCoworkConfig {
  return {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      auth: {
        mode: 'oidc',
        issuerUrl,
        clientId,
        allowedEmailDomains: ['example.test'],
      },
    },
  }
}

test('cloud OIDC auth resolves a verified bearer token into a tenant principal', async () => {
  const fixture = createJwtFixture()
  const resolver = createOidcCloudAuthResolver(oidcConfig().cloud.auth, {
    fetch: oidcFetch(fixture.jwk),
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })

  const principal = await resolver(requestWithBearer(fixture.token()))

  assert.equal(principal.tenantId, 'tenant-a')
  assert.equal(principal.tenantName, 'Tenant A')
  assert.equal(principal.email, 'analyst@example.test')
  assert.equal(principal.userId.length, 32)
})

test('cloud OIDC auth rejects missing, invalid-audience, and disallowed-domain tokens', async () => {
  const fixture = createJwtFixture()
  const resolver = createOidcCloudAuthResolver(oidcConfig().cloud.auth, {
    fetch: oidcFetch(fixture.jwk),
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })

  await assert.rejects(
    () => resolver(requestWithBearer(null)),
    (error) => error instanceof CloudHttpError && error.status === 401,
  )
  await assert.rejects(
    () => resolver(requestWithBearer(fixture.token({ aud: 'other-client' }))),
    /audience/,
  )
  await assert.rejects(
    () => resolver(requestWithBearer(fixture.token({ email: 'analyst@blocked.test' }))),
    /domain/,
  )
})

test('cloud OIDC auth fails closed for tampered signatures and expired tokens', async () => {
  const fixture = createJwtFixture()
  const resolver = createOidcCloudAuthResolver(oidcConfig().cloud.auth, {
    fetch: oidcFetch(fixture.jwk),
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })
  const token = fixture.token()
  const tampered = `${token.slice(0, -2)}aa`

  await assert.rejects(
    () => resolver(requestWithBearer(tampered)),
    /signature/,
  )
  await assert.rejects(
    () => resolver(requestWithBearer(fixture.token({ exp: Math.floor(new Date('2026-05-26T10:00:00.000Z').getTime() / 1000) }))),
    /expired/,
  )
})

test('cloud OIDC auth caches discovery and JWKS documents', async () => {
  const fixture = createJwtFixture()
  const calls: string[] = []
  const resolver = createCloudAuthResolverForConfig(oidcConfig(), {
    fetch: oidcFetch(fixture.jwk, calls),
    now: () => new Date('2026-05-26T12:00:00.000Z'),
  })

  await resolver(requestWithBearer(fixture.token({ sub: 'user-a' })))
  await resolver(requestWithBearer(fixture.token({ sub: 'user-b' })))

  assert.deepEqual(calls, [
    `${issuerUrl}/.well-known/openid-configuration`,
    `${issuerUrl}/.well-known/jwks.json`,
  ])
})

test('cloud OIDC browser auth completes authorization-code login with state, PKCE, and nonce checks', async () => {
  const fixture = createJwtFixture()
  const calls: string[] = []
  let expectedNonce = ''
  let tokenBody: URLSearchParams | null = null
  const fetcher: OidcCloudAuthResolverOptions['fetch'] = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url}`)
    if (url === `${issuerUrl}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: issuerUrl,
        jwks_uri: `${issuerUrl}/.well-known/jwks.json`,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
      })
    }
    if (url === `${issuerUrl}/token`) {
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['content-type'], 'application/x-www-form-urlencoded')
      tokenBody = new URLSearchParams(init?.body || '')
      assert.equal(tokenBody.get('grant_type'), 'authorization_code')
      assert.equal(tokenBody.get('code'), 'code-1')
      assert.equal(tokenBody.get('client_id'), clientId)
      assert.equal(tokenBody.get('client_secret'), 'client-secret')
      assert.equal(tokenBody.get('redirect_uri'), 'https://cloud.example.test/auth/callback')
      assert.match(tokenBody.get('code_verifier') || '', /^[A-Za-z0-9_-]{40,}$/)
      return jsonResponse({ id_token: fixture.token({ nonce: expectedNonce }) })
    }
    if (url === `${issuerUrl}/.well-known/jwks.json`) {
      return jsonResponse({ keys: [fixture.jwk] })
    }
    return jsonResponse({ error: 'not found' }, 404)
  }
  const browserAuth = createOidcBrowserAuthProvider(oidcConfig().cloud.auth, {
    fetch: fetcher,
    now: () => new Date('2026-05-26T12:00:00.000Z'),
    publicUrl: 'https://cloud.example.test',
    stateCookieSecret: TEST_COOKIE_KEY,
    clientSecret: 'client-secret',
  })

  const login = await browserAuth.login(
    requestWithHeaders({ host: 'internal.example.test' }),
    new URL('http://internal.example.test/auth/login?returnTo=/cloud'),
  )

  const authUrl = new URL(login.location)
  expectedNonce = authUrl.searchParams.get('nonce') || ''
  const state = authUrl.searchParams.get('state') || ''
  assert.equal(authUrl.origin, issuerUrl)
  assert.equal(authUrl.pathname, '/authorize')
  assert.equal(authUrl.searchParams.get('response_type'), 'code')
  assert.equal(authUrl.searchParams.get('client_id'), clientId)
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://cloud.example.test/auth/callback')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.match(authUrl.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{40,}$/)
  assert.ok(expectedNonce)
  assert.ok(state)
  assert.equal(login.setCookieHeaders?.length, 1)
  assert.match(login.setCookieHeaders?.[0] || '', /HttpOnly/)
  assert.match(login.setCookieHeaders?.[0] || '', /Secure/)
  assert.match(login.setCookieHeaders?.[0] || '', /SameSite=Lax/)

  const callback = await browserAuth.callback(
    requestWithHeaders({ cookie: cookieHeader(login.setCookieHeaders || []) }),
    new URL(`https://cloud.example.test/auth/callback?code=code-1&state=${state}`),
  )

  assert.equal(callback.principal.tenantId, 'tenant-a')
  assert.equal(callback.principal.email, 'analyst@example.test')
  assert.equal(callback.redirectTo, '/cloud')
  assert.match(callback.setCookieHeaders?.[0] || '', /Max-Age=0/)
  assert.ok(tokenBody)
  assert.deepEqual(calls, [
    `GET ${issuerUrl}/.well-known/openid-configuration`,
    `POST ${issuerUrl}/token`,
    `GET ${issuerUrl}/.well-known/jwks.json`,
  ])
})

test('cloud OIDC browser auth rejects callback state replay or tampering', async () => {
  const fixture = createJwtFixture()
  const browserAuth = createOidcBrowserAuthProvider(oidcConfig().cloud.auth, {
    fetch: oidcFetch(fixture.jwk),
    now: () => new Date('2026-05-26T12:00:00.000Z'),
    publicUrl: 'https://cloud.example.test',
    stateCookieSecret: TEST_COOKIE_KEY,
  })
  const login = await browserAuth.login(
    requestWithHeaders({ host: 'internal.example.test' }),
    new URL('http://internal.example.test/auth/login'),
  )

  await assert.rejects(
    () => browserAuth.callback(
      requestWithHeaders({ cookie: cookieHeader(login.setCookieHeaders || []) }),
      new URL('https://cloud.example.test/auth/callback?code=code-1&state=other-state'),
    ),
    /state/,
  )
})
