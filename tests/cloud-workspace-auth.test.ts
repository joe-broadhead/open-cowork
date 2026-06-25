import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CloudWorkspaceDesktopAuthenticator,
  type CloudWorkspaceAuthFetch,
} from '../apps/desktop/src/main/cloud-workspace-auth.ts'

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

// Stub DNS so the OIDC SSRF validation (P1-A) is deterministic against reserved `.test`
// hostnames; maps a hostname to the address the policy checks against the blocklists.
function resolverFor(map: Record<string, string>) {
  return async (hostname: string) => {
    const address = map[hostname]
    if (!address) throw new Error(`no DNS stub for ${hostname}`)
    return [{ address, family: address.includes(':') ? 6 : 4 }]
  }
}

const PUBLIC_RESOLVER = resolverFor({ 'issuer.example.test': '93.184.216.34' })

function connectionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
    ...overrides,
  } as never
}

test('cloud workspace desktop authenticator performs OIDC PKCE loopback login', async () => {
  const calls: string[] = []
  let tokenBody: URLSearchParams | null = null
  const fetcher: CloudWorkspaceAuthFetch = async (url, init) => {
    calls.push(url)
    if (url === 'https://cloud.example.test/auth/desktop/config') {
      return jsonResponse({
        mode: 'oidc',
        issuerUrl: 'https://issuer.example.test',
        clientId: 'open-cowork-desktop',
        scope: 'openid email profile offline_access',
      })
    }
    if (url === 'https://issuer.example.test/.well-known/openid-configuration') {
      return jsonResponse({
        authorization_endpoint: 'https://issuer.example.test/authorize',
        token_endpoint: 'https://issuer.example.test/token',
      })
    }
    if (url === 'https://issuer.example.test/token') {
      tokenBody = new URLSearchParams(init?.body || '')
      return jsonResponse({
        access_token: 'access-token-1',
        refresh_token: 'refresh-token-1',
        expires_in: 3600,
      })
    }
    if (url === 'https://cloud.example.test/auth/me') {
      assert.equal(init?.headers?.authorization, 'Bearer access-token-1')
      return jsonResponse({
        principal: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          email: 'user@example.test',
        },
        profileName: 'default',
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  }
  const authenticator = new CloudWorkspaceDesktopAuthenticator({
    fetch: fetcher,
    openExternal: async (authUrl) => {
      const parsed = new URL(authUrl)
      assert.equal(parsed.origin + parsed.pathname, 'https://issuer.example.test/authorize')
      assert.equal(parsed.searchParams.get('response_type'), 'code')
      assert.equal(parsed.searchParams.get('client_id'), 'open-cowork-desktop')
      assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256')
      assert.ok(parsed.searchParams.get('code_challenge'))
      const redirectUri = parsed.searchParams.get('redirect_uri')
      const state = parsed.searchParams.get('state')
      assert.ok(redirectUri)
      assert.ok(state)
      const callbackResponse = await fetch(`${redirectUri}?code=code-1&state=${state}`)
      const callbackHtml = await callbackResponse.text()
      assert.match(callbackHtml, /Acme &lt;Cowork&gt; Cloud login complete/)
      assert.match(callbackHtml, /You can return to Acme &lt;Cowork&gt;\./)
    },
    callbackTimeoutMs: 2000,
    brandName: 'Acme <Cowork>',
    dnsResolver: PUBLIC_RESOLVER,
  })

  const result = await authenticator.login({
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  })

  assert.equal(result.accessToken, 'access-token-1')
  assert.equal(result.refreshToken, 'refresh-token-1')
  assert.equal(result.tenantId, 'tenant-1')
  assert.equal(result.userId, 'user-1')
  assert.equal(result.profileName, 'default')
  assert.equal(tokenBody?.get('grant_type'), 'authorization_code')
  assert.equal(tokenBody?.get('code'), 'code-1')
  assert.equal(tokenBody?.get('client_id'), 'open-cowork-desktop')
  assert.ok(tokenBody?.get('redirect_uri')?.startsWith('http://127.0.0.1:'))
  assert.ok(tokenBody?.get('code_verifier'))
  assert.deepEqual(calls, [
    'https://cloud.example.test/auth/desktop/config',
    'https://issuer.example.test/.well-known/openid-configuration',
    'https://issuer.example.test/token',
    'https://cloud.example.test/auth/me',
  ])
})

test('cloud workspace desktop authenticator rejects invalid callback state', async () => {
  const fetcher: CloudWorkspaceAuthFetch = async (url) => {
    if (url === 'https://cloud.example.test/auth/desktop/config') {
      return jsonResponse({
        mode: 'oidc',
        issuerUrl: 'https://issuer.example.test',
        clientId: 'open-cowork-desktop',
      })
    }
    if (url === 'https://issuer.example.test/.well-known/openid-configuration') {
      return jsonResponse({
        authorization_endpoint: 'https://issuer.example.test/authorize',
        token_endpoint: 'https://issuer.example.test/token',
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  }
  const authenticator = new CloudWorkspaceDesktopAuthenticator({
    fetch: fetcher,
    openExternal: async (authUrl) => {
      const redirectUri = new URL(authUrl).searchParams.get('redirect_uri')
      assert.ok(redirectUri)
      await fetch(`${redirectUri}?code=code-1&state=wrong-state`)
    },
    callbackTimeoutMs: 2000,
    dnsResolver: PUBLIC_RESOLVER,
  })

  await assert.rejects(
    () => authenticator.login({
      id: 'cloud:test',
      baseUrl: 'https://cloud.example.test',
      label: 'Cloud',
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
      lastSyncedAt: null,
    }),
    /state is invalid/,
  )
})

test('cloud workspace desktop authenticator refreshes OIDC access tokens', async () => {
  let tokenBody: URLSearchParams | null = null
  const fetcher: CloudWorkspaceAuthFetch = async (url, init) => {
    if (url === 'https://cloud.example.test/auth/desktop/config') {
      return jsonResponse({
        mode: 'oidc',
        issuerUrl: 'https://issuer.example.test',
        clientId: 'open-cowork-desktop',
      })
    }
    if (url === 'https://issuer.example.test/.well-known/openid-configuration') {
      return jsonResponse({
        authorization_endpoint: 'https://issuer.example.test/authorize',
        token_endpoint: 'https://issuer.example.test/token',
      })
    }
    if (url === 'https://issuer.example.test/token') {
      tokenBody = new URLSearchParams(init?.body || '')
      return jsonResponse({
        access_token: 'access-token-2',
        expires_in: 3600,
      })
    }
    if (url === 'https://cloud.example.test/auth/me') {
      assert.equal(init?.headers?.authorization, 'Bearer access-token-2')
      return jsonResponse({
        principal: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          email: 'user@example.test',
        },
      })
    }
    throw new Error(`Unexpected URL ${url}`)
  }
  const authenticator = new CloudWorkspaceDesktopAuthenticator({ fetch: fetcher, dnsResolver: PUBLIC_RESOLVER })

  const result = await authenticator.refresh({
    id: 'cloud:test',
    baseUrl: 'https://cloud.example.test',
    label: 'Cloud',
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
    lastSyncedAt: null,
  }, 'refresh-token-1')

  assert.equal(result.accessToken, 'access-token-2')
  assert.equal(result.refreshToken, 'refresh-token-1')
  assert.equal(tokenBody?.get('grant_type'), 'refresh_token')
  assert.equal(tokenBody?.get('refresh_token'), 'refresh-token-1')
  assert.equal(tokenBody?.get('client_id'), 'open-cowork-desktop')
})

test('cloud-login rejects an OIDC issuer that resolves to a private address (SSRF) — P1-A', async () => {
  const auth = new CloudWorkspaceDesktopAuthenticator({
    fetch: async (url) => jsonResponse(url.includes('/auth/desktop/config')
      ? { mode: 'oidc', issuerUrl: 'https://evil.example.test', clientId: 'c' }
      : { error: 'unexpected' }),
    dnsResolver: resolverFor({ 'evil.example.test': '10.0.0.5' }),
  })
  await assert.rejects(() => auth.refresh(connectionRecord(), 'rt'), /OIDC issuer endpoint is not allowed/)
})

test('cloud-login rejects a literal cloud-metadata token endpoint (SSRF) — P1-A', async () => {
  const auth = new CloudWorkspaceDesktopAuthenticator({
    fetch: async (url) => jsonResponse(
      url.includes('/auth/desktop/config') ? { mode: 'oidc', issuerUrl: 'https://issuer.example.test', clientId: 'c' }
      : url.includes('/.well-known/openid-configuration') ? { token_endpoint: 'http://169.254.169.254/token' }
      : { error: 'unexpected' }),
    dnsResolver: PUBLIC_RESOLVER,
  })
  await assert.rejects(() => auth.refresh(connectionRecord(), 'rt'), /OIDC token endpoint is not allowed/)
})

test('cloud-login pins redirect:manual on every outbound fetch (credential-redirect SSRF) — P1-A', async () => {
  const redirects: Array<string | undefined> = []
  const auth = new CloudWorkspaceDesktopAuthenticator({
    fetch: async (url, init) => {
      redirects.push(init?.redirect)
      return jsonResponse(
        url.includes('/auth/desktop/config') ? { mode: 'oidc', issuerUrl: 'https://issuer.example.test', clientId: 'c' }
        : url.includes('/.well-known/openid-configuration') ? { token_endpoint: 'https://issuer.example.test/token' }
        : url.includes('/token') ? { access_token: 'at', refresh_token: 'rt2', expires_in: 3600 }
        : url.includes('/auth/me') ? { principal: { tenantId: 't1', userId: 'u1' } }
        : { error: 'unexpected' })
    },
    dnsResolver: PUBLIC_RESOLVER,
  })
  const result = await auth.refresh(connectionRecord(), 'rt')
  assert.equal(result.accessToken, 'at')
  assert.ok(redirects.length >= 3)
  for (const redirect of redirects) assert.equal(redirect, 'manual')
})

test('cloud-login allows loopback endpoints only when the base URL is loopback (local dev) — P1-A', async () => {
  const auth = new CloudWorkspaceDesktopAuthenticator({
    fetch: async (url) => jsonResponse(
      url.includes('/auth/desktop/config') ? { mode: 'oidc', issuerUrl: 'http://localhost:8787', clientId: 'c' }
      : url.includes('/.well-known/openid-configuration') ? { token_endpoint: 'http://localhost:8787/token' }
      : url.includes('/token') ? { access_token: 'at', refresh_token: 'rt2', expires_in: 3600 }
      : url.includes('/auth/me') ? { principal: { tenantId: 't1', userId: 'u1' } }
      : { error: 'unexpected' }),
    dnsResolver: resolverFor({ localhost: '127.0.0.1' }),
  })
  const result = await auth.refresh(connectionRecord({ baseUrl: 'http://localhost:8787' }), 'rt')
  assert.equal(result.accessToken, 'at')
})
