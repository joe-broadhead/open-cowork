import { randomBytes, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import electron from 'electron'
import type {
  WikiConnectRequest,
  WikiConnectTokenRequest,
  WikiDocument,
  WikiGraph,
  WikiGraphNeighbors,
  WikiOverview,
  WikiPageIndexEntry,
  WikiRemoteConnectionSummary,
  WikiSearchResult,
  WikiSourceResult,
  WikiSourceState,
} from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import { mapGraphIndex, mapGraphNeighbors } from './graph-mappers.ts'

/**
 * Desktop connector for a hosted OpenWiki server.
 *
 * A "remote connection" stores a base origin plus credentials (OAuth 2.1
 * access/refresh tokens from the PKCE flow, or a scoped service-account bearer
 * token). Credentials are encrypted at rest with Electron safeStorage. The
 * renderer only ever sees connection summaries; tokens never leave main.
 *
 * The browse surface reads through one active source: the local CLI root
 * (default) or a connected remote wiki. Read-only by design — edits stay in
 * the agent-facing MCP / proposals.
 */

const electronApp = (electron as { app?: typeof import('electron').app }).app
const electronSafeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage
const electronShell = (electron as { shell?: typeof import('electron').shell }).shell

const LOOPBACK_CANDIDATE_PORTS = [47317, 47318, 47319, 47320, 47321]
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

type AuthMethod = 'oauth' | 'token'

type StoredConnection = {
  id: string
  origin: string
  label: string
  authMethod: AuthMethod
  /** safeStorage-encrypted (base64) access token / bearer token. */
  tokenCipher: string
  /** safeStorage-encrypted refresh token (oauth only). */
  refreshCipher?: string | null
  tokenExpiresAt?: string | null
  createdAt: string
  lastUsedAt: string | null
}

type StoredState = {
  connections: StoredConnection[]
  activeConnectionId: string | null
}

function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Wiki origin must start with https:// or http://')
  }
  return trimmed
}

function connectionIdForOrigin(origin: string): string {
  return `remote-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`
}

/** Map an HTTP API page/record list item to the sidebar entry shape. */
function toPageEntry(raw: Record<string, unknown>): WikiPageIndexEntry {
  const path = String(raw.path ?? '')
  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? (path || 'Untitled')),
    path,
    section: null,
    sectionTitle: null,
    isPrivate: false,
    summary: String(raw.summary ?? ''),
    topics: Array.isArray(raw.topics) ? (raw.topics as string[]).map(String) : [],
    updatedAt: raw.updated_at ? String(raw.updated_at) : null,
  }
}

/** Map an HTTP API PageRecord (GET /api/v1/pages/<id>) to the document shape. */
function toDocument(raw: Record<string, unknown>, fallbackId: string): WikiDocument {
  const path = String(raw.path ?? '')
  return {
    id: String(raw.id ?? fallbackId),
    title: String(raw.title ?? (path || fallbackId)),
    path,
    section: null,
    sectionTitle: null,
    isPrivate: false,
    bodyMarkdown: String(raw.body ?? ''),
    summary: String(raw.summary ?? ''),
    status: String(raw.status ?? ''),
    updatedAt: raw.updated_at ? String(raw.updated_at) : null,
  }
}

class RemoteWikiStore {
  private state: StoredState = { connections: [], activeConnectionId: null }
  private loaded = false

  private filePath(): string {
    if (!electronApp) throw new Error('Wiki remote state requires the Electron app path.')
    return join(electronApp.getPath('userData'), 'wiki-remote-state.json')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    await this.reloadFromDisk()
  }

  /** Re-read persisted state so a mutation from any instance is visible. */
  private async reloadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.filePath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredState>
      this.state = {
        connections: Array.isArray(parsed.connections) ? (parsed.connections as StoredConnection[]) : [],
        activeConnectionId: parsed.activeConnectionId ?? null,
      }
    } catch {
      this.state = { connections: [], activeConnectionId: null }
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filePath()), { recursive: true })
    await writeFile(this.filePath(), JSON.stringify(this.state, null, 2), 'utf8')
  }

  private encrypt(plain: string): string {
    try {
      if (electronSafeStorage?.isEncryptionAvailable()) {
        return electronSafeStorage.encryptString(plain).toString('base64')
      }
    } catch (error) {
      log('wiki', `safeStorage unavailable (${error instanceof Error ? error.message : String(error)}); storing token base64`)
    }
    return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
  }

  private decrypt(cipher: string): string {
    try {
      if (cipher.startsWith('plain:')) {
        return Buffer.from(cipher.slice(6), 'base64').toString('utf8')
      }
      return electronSafeStorage!.decryptString(Buffer.from(cipher, 'base64'))
    } catch (error) {
      log('wiki', `failed to decrypt wiki credential: ${error instanceof Error ? error.message : String(error)}`)
      return ''
    }
  }

  async saveOauthConnection(
    origin: string,
    label: string,
    accessToken: string,
    refreshToken: string | null,
    expiresAt: string | null,
  ): Promise<WikiSourceResult> {
    return this.upsertConnection(origin, label, 'oauth', accessToken, refreshToken, expiresAt)
  }

  async saveTokenConnection(origin: string, label: string, token: string): Promise<WikiSourceResult> {
    return this.upsertConnection(origin, label, 'token', token, null, null)
  }

  private async upsertConnection(
    origin: string,
    label: string,
    authMethod: AuthMethod,
    accessToken: string,
    refreshToken: string | null,
    expiresAt: string | null,
  ): Promise<WikiSourceResult> {
    await this.load()
    const id = connectionIdForOrigin(origin)
    const now = new Date().toISOString()
    const existing = this.state.connections.find((c) => c.id === id)
    const connection: StoredConnection = {
      id,
      origin,
      label: label?.trim() || existing?.label || origin,
      authMethod,
      tokenCipher: this.encrypt(accessToken),
      ...(refreshToken ? { refreshCipher: this.encrypt(refreshToken) } : {}),
      ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    }
    if (existing) {
      this.state.connections = this.state.connections.map((c) => (c.id === id ? connection : c))
    } else {
      this.state.connections.push(connection)
    }
    this.state.activeConnectionId = id
    await this.save()
    return this.sourceResult(null, null)
  }

  /** Active connection credentials, or null when source is local / connection missing. */
  async activeCredentials(): Promise<{ origin: string; token: string; connection: StoredConnection } | null> {
    await this.reloadFromDisk()
    if (this.state.activeConnectionId === null) return null
    const connection = this.state.connections.find((c) => c.id === this.state.activeConnectionId)
    if (!connection) return null
    const token = this.decrypt(connection.tokenCipher)
    if (!token) return null
    return { origin: connection.origin, token, connection }
  }

  async summaries(): Promise<WikiRemoteConnectionSummary[]> {
    await this.reloadFromDisk()
    return Promise.all(
      this.state.connections.map(async (c) => {
        const client = new RemoteWikiClient(c.origin, this.decrypt(c.tokenCipher))
        let status: WikiRemoteConnectionSummary['status'] = 'connected'
        let workspace: string | null = null
        let pageCount: number | null = null
        let error: string | null = null
        try {
          const health = await client.health()
          workspace = health.workspace ?? null
          pageCount = health.pageCount
        } catch (err) {
          status = 'unavailable'
          error = err instanceof Error ? err.message : String(err)
        }
        return {
          id: c.id,
          origin: c.origin,
          label: c.label,
          authMethod: c.authMethod,
          status,
          error,
          workspace,
          pageCount,
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt,
        }
      }),
    )
  }

  async remove(id: string): Promise<WikiSourceResult> {
    await this.load()
    this.state.connections = this.state.connections.filter((c) => c.id !== id)
    if (this.state.activeConnectionId === id) this.state.activeConnectionId = null
    await this.save()
    return this.sourceResult(null, null)
  }

  async setActive(connectionId: string | null): Promise<WikiSourceResult> {
    await this.load()
    if (connectionId !== null && !this.state.connections.some((c) => c.id === connectionId)) {
      return this.sourceResult(false, `Unknown wiki connection ${connectionId}`)
    }
    this.state.activeConnectionId = connectionId
    await this.save()
    return this.sourceResult(null, null)
  }

  async sourceState(): Promise<WikiSourceState> {
    await this.reloadFromDisk()
    const summaries = await this.summaries()
    const active = summaries.find((s) => s.id === this.state.activeConnectionId) ?? null
    return {
      kind: active ? 'remote' : 'local',
      connectionId: active?.id ?? null,
      connection: active,
      connections: summaries,
    }
  }

  private async sourceResult(okOverride: boolean | null, errorOverride: string | null): Promise<WikiSourceResult> {
    const state = await this.sourceState()
    return {
      ...state,
      ok: okOverride ?? (errorOverride === null),
      error: errorOverride,
    }
  }
}

/** Minimal bearer-token client for the OpenWiki HTTP API (read surface). */
export class RemoteWikiClient {
  private readonly origin: string
  private readonly token: string

  constructor(origin: string, token: string) {
    this.origin = origin
    this.token = token
  }

  private async request<T>(path: string, timeoutMs = 20_000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${this.origin}${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''} from ${this.origin}${path}`)
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async health(): Promise<{ status: string; workspace: string | null; pageCount: number | null }> {
    const body = (await this.request<Record<string, unknown>>('/api/v1/health')) as {
      status?: string
      workspace_id?: string
      counts?: Record<string, unknown>
    }
    const counts = (body.counts ?? {}) as Record<string, unknown>
    return {
      status: body.status ?? 'unknown',
      workspace: body.workspace_id ? String(body.workspace_id) : null,
      pageCount: typeof counts.pages === 'number' ? counts.pages : null,
    }
  }

  async listPages(): Promise<WikiPageIndexEntry[]> {
    const body = (await this.request<{ records?: unknown }>('/api/v1/records?type=page&limit=500')) as {
      records?: Array<Record<string, unknown>>
    }
    return (body.records ?? []).map(toPageEntry)
  }

  async readPage(id: string): Promise<WikiDocument | null> {
    const body = await this.request<Record<string, unknown>>(`/api/v1/pages/${encodeURIComponent(id)}`)
    return toDocument(body, id)
  }

  async search(query: string): Promise<WikiSearchResult[]> {
    const body = (await this.request<{ results?: unknown }>(`/api/v1/search?q=${encodeURIComponent(query)}&limit=50`)) as {
      results?: Array<Record<string, unknown>>
    }
    return (body.results ?? [])
      .filter((r) => String(r.type ?? '') === 'page')
      .map((r) => ({
        id: String(r.id ?? ''),
        title: String(r.title ?? ''),
        path: String(r.path ?? ''),
        snippet: String(r.summary ?? ''),
        isPrivate: false,
      }))
  }

  async graph(): Promise<WikiGraph> {
    const body = await this.request<unknown>('/api/v1/graph?limit=2000')
    return mapGraphIndex(body)
  }

  async graphNeighbors(id: string): Promise<WikiGraphNeighbors | null> {
    const body = await this.request<unknown>(`/api/v1/graph/${encodeURIComponent(id)}/neighbors?depth=1`)
    return mapGraphNeighbors(body)
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.1 PKCE connect flow (RFC 8252 loopback redirect + RFC 7591 dynamic
// client registration against the OpenWiki server).
// ---------------------------------------------------------------------------

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(48))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

type OAuthTokens = { accessToken: string; refreshToken: string | null; expiresAt: string | null }

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

function listenLoopback(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolve({ server, port: actualPort })
    })
  })
}

function waitForRedirect(server: Server, timeoutMs: number): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for the wiki authorization redirect.'))
    }, timeoutMs)
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      if (error) {
        clearTimeout(timer)
        response.writeHead(400, { 'content-type': 'text/plain' }).end(`Authorization failed: ${error}\n`)
        server.close()
        reject(new Error(`Wiki authorization failed: ${error}`))
        return
      }
      if (!code || !state) {
        response.writeHead(400, { 'content-type': 'text/plain' }).end('Missing code or state.\n')
        return
      }
      clearTimeout(timer)
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><meta charset="utf-8"><title>Open Cowork</title><p>Wiki connected. You can close this tab and return to Open Cowork.</p>')
      server.close()
      resolve({ code, state })
    })
  })
}

/**
 * Run the full PKCE connect flow against a hosted OpenWiki server:
 * register a public client, open the system browser for consent, exchange the
 * authorization code on a loopback redirect, and persist the tokens.
 */
export async function connectRemoteOAuth(request: WikiConnectRequest): Promise<WikiSourceResult> {
  const store = remoteWikiStore
  const origin = normalizeOrigin(request.origin)
  const { verifier, challenge } = pkcePair()
  const state = base64Url(randomBytes(16))

  // Find a free loopback port and register the client with that redirect URI.
  let loopback: { server: Server; port: number } | null = null
  for (const port of LOOPBACK_CANDIDATE_PORTS) {
    try {
      loopback = await listenLoopback(port)
      break
    } catch {
      // try next candidate
    }
  }
  if (!loopback) {
    return { ...(await store.sourceState()), ok: false, error: 'Could not open a loopback port for the authorization redirect.' }
  }
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`

  try {
    const registered = await postJson<{ client_id?: string; error?: string }>(`${origin}/oauth/register`, {
      client_name: 'Open Cowork Desktop',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'wiki:read wiki:search',
    })
    const clientId = registered.client_id
    if (!clientId) {
      loopback.server.close()
      return {
        ...(await store.sourceState()),
        ok: false,
        error: 'The wiki rejected dynamic client registration. Enable OPENWIKI_OAUTH_DYNAMIC_CLIENT_REGISTRATION=1 on the server, or connect with a service-account token instead.',
      }
    }

    const authorizeUrl = new URL(`${origin}/oauth/authorize`)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', clientId)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('scope', 'wiki:read wiki:search')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    if (!electronShell) {
      loopback.server.close()
      return { ...(await store.sourceState()), ok: false, error: 'Cannot open the authorization page from this runtime.' }
    }
    void electronShell.openExternal(authorizeUrl.toString())

    const redirect = await waitForRedirect(loopback.server, OAUTH_TIMEOUT_MS)
    if (redirect.state !== state) {
      return { ...(await store.sourceState()), ok: false, error: 'Authorization state mismatch; try again.' }
    }

    const tokenResponse = await postJson<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string }>(
      `${origin}/oauth/token`,
      {
        grant_type: 'authorization_code',
        code: redirect.code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      },
    )
    if (!tokenResponse.access_token) {
      return {
        ...(await store.sourceState()),
        ok: false,
        error: tokenResponse.error ? `Token exchange failed: ${tokenResponse.error}` : 'Token exchange returned no access token.',
      }
    }
    const expiresAt = typeof tokenResponse.expires_in === 'number'
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : null
    const tokens: OAuthTokens = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? null,
      expiresAt,
    }
    return store.saveOauthConnection(origin, request.label ?? '', tokens.accessToken, tokens.refreshToken, tokens.expiresAt)
  } catch (error) {
    try { loopback.server.close() } catch { /* already closed by waitForRedirect */ }
    const message = error instanceof Error ? error.message : String(error)
    return { ...(await store.sourceState()), ok: false, error: message }
  }
}

/** Save a scoped service-account bearer token for a hosted wiki origin. */
export async function connectRemoteWithToken(request: WikiConnectTokenRequest): Promise<WikiSourceResult> {
  const store = remoteWikiStore
  try {
    const origin = normalizeOrigin(request.origin)
    const token = request.token.trim()
    if (!token) return { ...(await store.sourceState()), ok: false, error: 'Token is empty.' }
    // Validate before persisting: a read probe must succeed with this token.
    const probe = new RemoteWikiClient(origin, token)
    await probe.health()
    return store.saveTokenConnection(origin, request.label ?? '', token)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...(await store.sourceState()), ok: false, error: `Connection failed: ${message}` }
  }
}

export const remoteWikiStore = new RemoteWikiStore()
