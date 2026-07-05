import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getDesktopShellHost } from '@open-cowork/shared/node'
import { evaluateHttpMcpUrlResolved, type McpDnsResolver } from '@open-cowork/runtime-host/mcp-url-policy'
import type { CloudWorkspaceConnectionRecord } from './cloud-workspace-registry.ts'

type CloudWorkspaceAuthResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text?(): Promise<string>
}

export type CloudWorkspaceAuthFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    redirect?: 'manual' | 'error' | 'follow'
  },
) => Promise<CloudWorkspaceAuthResponse>

export type CloudWorkspaceDesktopAuthConfig = {
  mode: 'oidc'
  issuerUrl: string
  clientId: string
  scope?: string
}

export type CloudWorkspaceLoginResult = {
  accessToken: string
  refreshToken: string | null
  expiresAt: string
  tenantId?: string
  userId?: string
  profileName?: string
}

export type CloudWorkspaceDesktopAuthenticatorOptions = {
  fetch?: CloudWorkspaceAuthFetch
  openExternal?: (url: string) => Promise<unknown> | unknown
  callbackTimeoutMs?: number
  brandName?: string
  dnsResolver?: McpDnsResolver
}

type OidcDiscovery = {
  authorization_endpoint?: string
  token_endpoint?: string
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_SCOPE = 'openid email profile offline_access'
const DEFAULT_BRAND_NAME = 'Open Cowork'

function defaultFetch(): CloudWorkspaceAuthFetch {
  return (url, init) => globalThis.fetch(url, init as RequestInit) as Promise<CloudWorkspaceAuthResponse>
}

function defaultOpenExternal(url: string) {
  const shell = getDesktopShellHost()
  if (!shell) throw new Error('Desktop shell is unavailable; cannot open an external URL.')
  return shell.openExternal(url)
}

function jsonRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} response must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

async function readJsonRecord(response: CloudWorkspaceAuthResponse, label: string) {
  const body = jsonRecord(await response.json(), label)
  if (!response.ok) {
    const message = typeof body.error === 'string' && body.error.trim()
      ? body.error.trim()
      : `${label} request failed with HTTP ${response.status}.`
    throw new Error(message)
  }
  return body
}

function readRequiredString(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is missing ${key}.`)
  return value.trim()
}

function readOptionalString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function base64Url(bytes: Buffer | string) {
  return Buffer.from(bytes).toString('base64url')
}

function codeChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url')
}

function tokenExpiresAt(record: Record<string, unknown>) {
  const expiresAt = readOptionalString(record, 'expires_at')
  if (expiresAt && Number.isFinite(Date.parse(expiresAt))) return new Date(Date.parse(expiresAt)).toISOString()
  const expiresIn = record.expires_in
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn)
    ? expiresIn
    : typeof expiresIn === 'string'
      ? Number(expiresIn)
      : 3600
  const ttlMs = Math.max(60, Number.isFinite(seconds) ? seconds : 3600) * 1000
  return new Date(Date.now() + ttlMs).toISOString()
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function callbackPage(title: string, body = '') {
  return `<!doctype html><html><body><h2>${escapeHtml(title)}</h2>${body ? `<p>${escapeHtml(body)}</p>` : ''}</body></html>`
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '')
}

function isLoopbackCloudWorkspaceBaseUrl(baseUrl: string) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

async function closeServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function createLoopbackCallback(timeoutMs: number, brandName: string) {
  let resolveCallback: ((value: { code: string; state: string }) => void) | null = null
  let rejectCallback: ((error: Error) => void) | null = null
  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(callbackPage(`${brandName} Cloud login failed`))
      rejectCallback?.(new Error(`Cloud OIDC login failed: ${error}.`))
      return
    }
    if (!code || !state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(callbackPage(`${brandName} Cloud login failed`))
      rejectCallback?.(new Error('Cloud OIDC callback requires code and state.'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(callbackPage(`${brandName} Cloud login complete`, `You can return to ${brandName}.`))
    resolveCallback?.({ code, state })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo | null
  if (!address) throw new Error('Cloud OIDC callback server did not bind.')
  const timeout = setTimeout(() => {
    rejectCallback?.(new Error('Cloud OIDC login timed out.'))
  }, timeoutMs)
  timeout.unref()
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    async wait() {
      try {
        return await callbackPromise
      } finally {
        clearTimeout(timeout)
      }
    },
    close: () => closeServer(server),
  }
}

export class CloudWorkspaceDesktopAuthenticator {
  private readonly fetcher: CloudWorkspaceAuthFetch
  private readonly openExternal: (url: string) => Promise<unknown> | unknown
  private readonly callbackTimeoutMs: number
  private readonly brandName: string
  private readonly dnsResolver?: McpDnsResolver

  constructor(options: CloudWorkspaceDesktopAuthenticatorOptions = {}) {
    this.fetcher = options.fetch || defaultFetch()
    this.openExternal = options.openExternal || defaultOpenExternal
    this.callbackTimeoutMs = options.callbackTimeoutMs || DEFAULT_CALLBACK_TIMEOUT_MS
    this.brandName = options.brandName?.trim() || DEFAULT_BRAND_NAME
    this.dnsResolver = options.dnsResolver
  }

  // Validate an OIDC endpoint URL returned by the (only TLS-trusted) cloud backend before
  // the main process fetches it: a malicious/compromised backend must not be able to steer
  // discovery/token requests — which carry the auth code, PKCE verifier, and refresh token —
  // at internal hosts or cloud metadata. Resolves DNS and blocks private/metadata addresses
  // (matching the MCP/webhook SSRF policy). Loopback is allowed only when the workspace base
  // URL is itself loopback (local development); otherwise https is required.
  private async assertSafeEndpoint(rawUrl: string, baseUrl: string, label: string): Promise<string> {
    const baseLoopback = isLoopbackCloudWorkspaceBaseUrl(baseUrl)
    const verdict = await evaluateHttpMcpUrlResolved(rawUrl, {
      allowPrivateNetwork: baseLoopback,
      resolveHostname: this.dnsResolver,
    })
    if (!verdict.ok) {
      throw new Error(`${label} endpoint is not allowed: ${verdict.reason}`)
    }
    if (!baseLoopback && verdict.url.protocol !== 'https:') {
      throw new Error(`${label} endpoint must use https.`)
    }
    return verdict.url.toString()
  }

  async login(connection: CloudWorkspaceConnectionRecord): Promise<CloudWorkspaceLoginResult> {
    const config = await this.fetchDesktopConfig(connection)
    const issuerUrl = await this.assertSafeEndpoint(config.issuerUrl, connection.baseUrl, 'OIDC issuer')
    const discovery = await this.fetchDiscovery(issuerUrl)
    const authorizationEndpoint = await this.assertSafeEndpoint(
      readRequiredString(discovery, 'authorization_endpoint', 'OIDC discovery'), connection.baseUrl, 'OIDC authorization')
    const tokenEndpoint = await this.assertSafeEndpoint(
      readRequiredString(discovery, 'token_endpoint', 'OIDC discovery'), connection.baseUrl, 'OIDC token')
    const state = base64Url(randomBytes(24))
    const nonce = base64Url(randomBytes(24))
    const verifier = base64Url(randomBytes(32))
    const callback = await createLoopbackCallback(this.callbackTimeoutMs, this.brandName)
    try {
      const authUrl = new URL(authorizationEndpoint)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('client_id', config.clientId)
      authUrl.searchParams.set('redirect_uri', callback.redirectUri)
      authUrl.searchParams.set('scope', config.scope || DEFAULT_SCOPE)
      authUrl.searchParams.set('state', state)
      authUrl.searchParams.set('nonce', nonce)
      authUrl.searchParams.set('code_challenge', codeChallenge(verifier))
      authUrl.searchParams.set('code_challenge_method', 'S256')
      await this.openExternal(authUrl.toString())
      const completed = await callback.wait()
      if (completed.state !== state) throw new Error('Cloud OIDC callback state is invalid.')
      const token = await this.exchangeCode(tokenEndpoint, {
        code: completed.code,
        clientId: config.clientId,
        redirectUri: callback.redirectUri,
        verifier,
      })
      const accessToken = readOptionalString(token, 'access_token') || readOptionalString(token, 'id_token')
      if (!accessToken) throw new Error('Cloud OIDC token response is missing access_token.')
      const me = await this.fetchPrincipal(connection, accessToken)
      const principal = jsonRecord(me.principal, 'Cloud principal')
      return {
        accessToken,
        refreshToken: readOptionalString(token, 'refresh_token'),
        expiresAt: tokenExpiresAt(token),
        tenantId: readOptionalString(principal, 'tenantId') || undefined,
        userId: readOptionalString(principal, 'userId') || undefined,
        profileName: readOptionalString(me, 'profileName') || undefined,
      }
    } finally {
      await callback.close()
    }
  }

  async refresh(connection: CloudWorkspaceConnectionRecord, refreshToken: string): Promise<CloudWorkspaceLoginResult> {
    const config = await this.fetchDesktopConfig(connection)
    const issuerUrl = await this.assertSafeEndpoint(config.issuerUrl, connection.baseUrl, 'OIDC issuer')
    const discovery = await this.fetchDiscovery(issuerUrl)
    const tokenEndpoint = await this.assertSafeEndpoint(
      readRequiredString(discovery, 'token_endpoint', 'OIDC discovery'), connection.baseUrl, 'OIDC token')
    const token = await this.refreshToken(tokenEndpoint, {
      clientId: config.clientId,
      refreshToken,
    })
    const accessToken = readOptionalString(token, 'access_token') || readOptionalString(token, 'id_token')
    if (!accessToken) throw new Error('Cloud OIDC refresh response is missing access_token.')
    const me = await this.fetchPrincipal(connection, accessToken)
    const principal = jsonRecord(me.principal, 'Cloud principal')
    return {
      accessToken,
      refreshToken: readOptionalString(token, 'refresh_token') || refreshToken,
      expiresAt: tokenExpiresAt(token),
      tenantId: readOptionalString(principal, 'tenantId') || undefined,
      userId: readOptionalString(principal, 'userId') || undefined,
      profileName: readOptionalString(me, 'profileName') || undefined,
    }
  }

  private async fetchDesktopConfig(connection: CloudWorkspaceConnectionRecord): Promise<CloudWorkspaceDesktopAuthConfig> {
    const body = await readJsonRecord(
      await this.fetcher(`${normalizeBaseUrl(connection.baseUrl)}/auth/desktop/config`, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
      }),
      'Cloud desktop auth config',
    )
    const mode = readRequiredString(body, 'mode', 'Cloud desktop auth config')
    if (mode !== 'oidc') throw new Error(`Unsupported cloud desktop auth mode: ${mode}.`)
    return {
      mode: 'oidc',
      issuerUrl: readRequiredString(body, 'issuerUrl', 'Cloud desktop auth config'),
      clientId: readRequiredString(body, 'clientId', 'Cloud desktop auth config'),
      scope: readOptionalString(body, 'scope') || DEFAULT_SCOPE,
    }
  }

  private async fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery & Record<string, unknown>> {
    const issuer = normalizeBaseUrl(issuerUrl)
    return await readJsonRecord(
      await this.fetcher(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
      }),
      'OIDC discovery',
    ) as OidcDiscovery & Record<string, unknown>
  }

  private async exchangeCode(
    tokenEndpoint: string,
    input: {
      code: string
      clientId: string
      redirectUri: string
      verifier: string
    },
  ) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
    })
    return readJsonRecord(
      await this.fetcher(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        redirect: 'manual',
      }),
      'OIDC token',
    )
  }

  private async refreshToken(
    tokenEndpoint: string,
    input: {
      clientId: string
      refreshToken: string
    },
  ) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    })
    return readJsonRecord(
      await this.fetcher(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        redirect: 'manual',
      }),
      'OIDC refresh',
    )
  }

  private async fetchPrincipal(connection: CloudWorkspaceConnectionRecord, accessToken: string) {
    return readJsonRecord(
      await this.fetcher(`${normalizeBaseUrl(connection.baseUrl)}/auth/me`, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        redirect: 'manual',
      }),
      'Cloud auth bootstrap',
    )
  }
}

export function createCloudWorkspaceDesktopAuthenticator(options?: CloudWorkspaceDesktopAuthenticatorOptions) {
  return new CloudWorkspaceDesktopAuthenticator(options)
}
