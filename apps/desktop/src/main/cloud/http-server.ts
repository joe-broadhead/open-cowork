import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  emptySessionImportItemCounts,
  isCloudSessionEventType,
  normalizeCloudProjectSource,
  type CloudSessionEventType,
  type CloudProjectSourceInput,
  type PublicBrandingConfig,
  type SessionImportRequest,
  type WorkflowDraft,
  type WorkflowStatus,
  type WorkflowTriggerType,
} from '@open-cowork/shared'
import type { CloudArtifactService } from './artifact-service.ts'
import { cloudBrowserAppHtml } from './browser-app.ts'
import {
  principalHasDesktopApiAccess,
  principalHasGatewayAccess,
  routeAllowsGatewayOnlyToken,
  routeAllowsOperationalToken,
  routeAllowsWorkerCredential,
} from './http-routes/access-policy.ts'
import { handleAdminApiRoute } from './http-routes/admin.ts'
import { handleApiTokensApiRoute } from './http-routes/api-tokens.ts'
import { handleBillingApiRoute } from './http-routes/billing.ts'
import { handleByokApiRoute } from './http-routes/byok.ts'
import { handleCapabilitiesApiRoute } from './http-routes/capabilities.ts'
import { handleChannelsApiRoute } from './http-routes/channels.ts'
import { handleProjectSourcesApiRoute } from './http-routes/project-sources.ts'
import { handleSettingsApiRoute } from './http-routes/settings.ts'
import { handleThreadsApiRoute } from './http-routes/threads.ts'
import { handleWorkspaceApiRoute } from './http-routes/workspace.ts'
import { CloudServiceError, type CloudPrincipal, type CloudSessionService } from './session-service.ts'
import { cloudSessionViewToSessionView } from './session-view-contract.ts'
import type { CloudWorker } from './worker.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import type { CloudReadinessReport } from './readiness.ts'
import type {
  ApiTokenScope,
  ChannelProviderId,
  ControlPlaneSessionStatus,
  SessionEventRecord,
  WorkspaceEventRecord,
} from './control-plane-store.ts'
import { recordCloudHttpRequest, recordCloudMetric } from './observability.ts'
import type { CloudCookieSession, CloudSessionCookieManager } from './session-cookie-auth.ts'
import {
  InMemoryWorkflowWebhookSecurityStore,
  WebhookHttpError,
  type WorkflowWebhookAuth,
  type WorkflowWebhookSecurityStore,
} from '../workflow/workflow-webhook-server.ts'

export type CloudAuthResolver = (req: IncomingMessage) => Promise<CloudPrincipal> | CloudPrincipal

export type CloudBrowserAuthRedirect = {
  location: string
  setCookieHeaders?: string[]
}

export type CloudBrowserAuthCallback = {
  principal: CloudPrincipal
  redirectTo: string
  setCookieHeaders?: string[]
}

export type CloudBrowserAuthProvider = {
  isCallbackPath(pathname: string): boolean
  login(req: IncomingMessage, url: URL): Promise<CloudBrowserAuthRedirect> | CloudBrowserAuthRedirect
  callback(req: IncomingMessage, url: URL): Promise<CloudBrowserAuthCallback> | CloudBrowserAuthCallback
}

export type CloudDesktopAuthConfig = {
  mode: 'oidc'
  issuerUrl: string
  clientId: string
  scope: string
}

export type CloudHttpServerOptions = {
  service: CloudSessionService
  artifacts?: CloudArtifactService | null
  policy: CloudRuntimePolicy
  publicBranding?: PublicBrandingConfig | null
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  desktopAuth?: CloudDesktopAuthConfig | null
  worker?: CloudWorker | null
  webhookSecurity?: WorkflowWebhookSecurityStore | null
  internalToken?: string | null
  sessionCookies?: CloudSessionCookieManager | null
  observability?: CloudObservabilityAdapter | null
  autoProcessCommands?: boolean
  corsOrigin?: string | null
  strictTransportSecurity?: boolean
  maxBodyBytes?: number
  ssePollMs?: number
  sseReplayHub?: CloudSseReplayHub
  sseStreamRegistry?: CloudSseStreamRegistry
  trustProxyHeaders?: boolean
  readiness?: () => Promise<CloudReadinessReport> | CloudReadinessReport
}

export class CloudHttpError extends Error {
  readonly status: number
  readonly publicMessage: string
  readonly policyCode: string | null
  readonly retryAfterMs: number | null

  constructor(status: number, message: string, details: {
    policyCode?: string | null
    retryAfterMs?: number | null
  } = {}) {
    super(message)
    this.status = status
    this.publicMessage = message
    this.policyCode = details.policyCode || null
    this.retryAfterMs = details.retryAfterMs || null
  }
}

type RouteContext = {
  principal: CloudPrincipal
  authSource: 'cookie' | 'resolver'
  cookieSession: CloudCookieSession | null
  url: URL
  segments: string[]
}

type SequencedSseEvent = { sequence: number }
const CHANNEL_DELIVERY_SSE_EVENT_TYPE = 'channel.delivery' satisfies CloudSessionEventType

type SseReplaySubscriber = {
  lastSequence: number
  listener: (event: SequencedSseEvent) => void
  onError?: (error: unknown) => void
}

type SseReplayTopic = {
  subscribers: Set<SseReplaySubscriber>
  loadEvents: (afterSequence: number) => Promise<SequencedSseEvent[]>
  lastSequence: number
  polling: boolean
  timer: ReturnType<typeof setInterval>
}

type ActiveSseStream = {
  res: ServerResponse
  socket: Socket | null
  close: () => void
}

export class CloudSseStreamRegistry {
  private readonly streams = new Set<ActiveSseStream>()
  private closing = false

  track(req: IncomingMessage, res: ServerResponse, cleanup: () => void) {
    if (this.closing) {
      const socket = res.socket || req.socket || null
      cleanup()
      if (!res.writableEnded && !res.destroyed) res.end()
      if (!res.destroyed) res.destroy()
      if (socket && !socket.destroyed) socket.destroy()
      return false
    }

    let closed = false
    const stream: ActiveSseStream = {
      res,
      socket: res.socket || req.socket || null,
      close: () => {
        if (closed) return
        closed = true
        this.streams.delete(stream)
        req.off('close', stream.close)
        res.off('close', stream.close)
        res.off('finish', stream.close)
        cleanup()
      },
    }
    this.streams.add(stream)
    req.once('close', stream.close)
    res.once('close', stream.close)
    res.once('finish', stream.close)
    return true
  }

  closeAll() {
    this.closing = true
    for (const stream of Array.from(this.streams)) {
      stream.close()
      if (!stream.res.writableEnded && !stream.res.destroyed) stream.res.end()
      if (!stream.res.destroyed) stream.res.destroy()
      if (stream.socket && !stream.socket.destroyed) stream.socket.destroy()
    }
  }
}

export class CloudSseReplayHub {
  private readonly topics = new Map<string, SseReplayTopic>()
  private closed = false

  subscribe(
    input: {
      key: string
      afterSequence: number
      pollMs: number
      loadEvents: (afterSequence: number) => Promise<SequencedSseEvent[]>
      listener: (event: SequencedSseEvent) => void
      onError?: (error: unknown) => void
    },
  ) {
    if (this.closed) return () => {}
    let topic = this.topics.get(input.key)
    if (!topic) {
      topic = {
        subscribers: new Set(),
        loadEvents: input.loadEvents,
        lastSequence: input.afterSequence,
        polling: false,
        timer: setInterval(() => {
          void this.poll(input.key)
        }, input.pollMs),
      }
      this.topics.set(input.key, topic)
    }
    const subscriber: SseReplaySubscriber = {
      lastSequence: input.afterSequence,
      listener: input.listener,
      onError: input.onError,
    }
    topic.subscribers.add(subscriber)
    return () => {
      const current = this.topics.get(input.key)
      if (!current) return
      current.subscribers.delete(subscriber)
      if (current.subscribers.size > 0) return
      clearInterval(current.timer)
      this.topics.delete(input.key)
    }
  }

  get topicCount() {
    return this.topics.size
  }

  close() {
    this.closed = true
    for (const topic of this.topics.values()) {
      clearInterval(topic.timer)
      topic.subscribers.clear()
    }
    this.topics.clear()
  }

  private async poll(key: string) {
    if (this.closed) return
    const topic = this.topics.get(key)
    if (!topic || topic.polling) return
    topic.polling = true
    try {
      const events = await topic.loadEvents(topic.lastSequence)
      if (this.closed || this.topics.get(key) !== topic) return
      for (const event of events) {
        if (event.sequence <= topic.lastSequence) continue
        topic.lastSequence = event.sequence
        for (const subscriber of topic.subscribers) {
          if (event.sequence <= subscriber.lastSequence) continue
          subscriber.listener(event)
          subscriber.lastSequence = event.sequence
        }
      }
    } catch (error) {
      for (const subscriber of topic.subscribers) subscriber.onError?.(error)
    } finally {
      if (this.topics.get(key) === topic) topic.polling = false
    }
  }
}

const DEFAULT_PRINCIPAL: CloudPrincipal = {
  tenantId: 'default',
  tenantName: 'Default',
  orgId: 'default',
  userId: 'local-user',
  accountId: 'local-user',
  email: 'local@example.test',
  role: 'owner',
  authSource: 'local',
}

const CLOUD_WEBHOOK_REQUEST_WINDOW_MS = 60 * 1000
const CLOUD_WEBHOOK_REQUEST_LIMIT = 120
const CLOUD_WEBHOOK_AUTH_FAILURE_WINDOW_MS = 60 * 1000
const CLOUD_WEBHOOK_AUTH_FAILURE_LIMIT = 5
const CLOUD_WEBHOOK_AUTH_BACKOFF_MS = 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512
const SESSION_IMPORT_MAX_ARTIFACTS = 25

function defaultAuthResolver(): CloudPrincipal {
  return DEFAULT_PRINCIPAL
}

function readHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

function constantTimeEquals(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function internalTokenIsValid(req: IncomingMessage, expected: string | null | undefined) {
  if (!expected) return false
  const provided = readHeader(req, 'x-open-cowork-internal-token')
  return typeof provided === 'string' && constantTimeEquals(provided, expected)
}

function writeSecurityHeaders(res: ServerResponse, options: { strictTransportSecurity?: boolean } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (options.strictTransportSecurity) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

function writeCorsHeaders(res: ServerResponse, origin: string | null | undefined) {
  if (!origin) return
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token')
}

function writeJson(res: ServerResponse, status: number, body: unknown, origin?: string | null) {
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function writeHtml(res: ServerResponse, status: number, body: string, origin?: string | null, nonce?: string | null) {
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'"
  const styleSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'"
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: https:",
      `style-src ${styleSrc}`,
      `script-src ${scriptSrc}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(body)
}

function writeError(
  res: ServerResponse,
  status: number,
  message: string,
  origin?: string | null,
  details: { policyCode?: string | null, retryAfterMs?: number | null } = {},
) {
  if (details.retryAfterMs && details.retryAfterMs > 0) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(details.retryAfterMs / 1000))))
  }
  const body: Record<string, unknown> = { error: message }
  if (details.retryAfterMs && details.retryAfterMs > 0) body.retryAfterMs = details.retryAfterMs
  if (details.policyCode) {
    body.verdict = {
      allowed: false,
      reason: message,
      policyCode: details.policyCode,
    }
  }
  writeJson(res, status, body, origin)
}

function writePolicyError(
  res: ServerResponse,
  status: number,
  message: string,
  policyCode: string,
  origin?: string | null,
) {
  writeJson(res, status, {
    error: message,
    verdict: {
      allowed: false,
      reason: message,
      policyCode,
    },
  }, origin)
}

function writeRedirect(
  res: ServerResponse,
  location: string,
  setCookieHeaders: string[] | undefined,
  origin?: string | null,
) {
  writeCorsHeaders(res, origin)
  if (setCookieHeaders?.length) res.setHeader('Set-Cookie', setCookieHeaders)
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
  })
  res.end()
}

function methodRequiresCsrf(method: string | undefined) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

async function readJsonBodyWithRaw(req: IncomingMessage, maxBodyBytes: number) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maxBodyBytes) throw new CloudHttpError(413, 'Request body is too large.')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return { body: {}, rawBody: '' }
  const rawBody = Buffer.concat(chunks).toString('utf8')
  const text = rawBody.trim()
  if (!text) return { body: {}, rawBody }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new CloudHttpError(400, 'Request body must be valid JSON.')
  }
  const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { body, rawBody }
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number) {
  return (await readJsonBodyWithRaw(req, maxBodyBytes)).body
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function readOptionalCloudProjectSource(body: Record<string, unknown>): CloudProjectSourceInput | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'projectSource')) return undefined
  const raw = body.projectSource
  if (raw === undefined || raw === null) return null
  const normalized = normalizeCloudProjectSource(raw)
  if (!normalized) throw new CloudHttpError(400, 'Cloud project source is invalid.')
  return normalized
}

function readStringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null
}

function readApiTokenScopes(value: unknown): ApiTokenScope[] | null {
  const scopes = readStringArray(value)
  if (!scopes) return null
  const allowed = new Set<ApiTokenScope>(['desktop', 'gateway', 'admin', 'operator', 'worker-internal'])
  if (scopes.some((scope) => !allowed.has(scope as ApiTokenScope))) return null
  const normalized = [...new Set(scopes as ApiTokenScope[])]
  return normalized.length > 0 ? normalized : null
}

function readRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseSequenceValue(raw: string | null | undefined) {
  if (!raw) return 0
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function parseAfterSequence(req: IncomingMessage, url: URL) {
  const fromQuery = parseSequenceValue(url.searchParams.get('after'))
  if (fromQuery > 0) return fromQuery
  return parseSequenceValue(firstHeader(req.headers['last-event-id']).trim())
}

function parseLimit(url: URL) {
  const raw = url.searchParams.get('limit')
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseSessionStatus(value: string | null): ControlPlaneSessionStatus | null {
  if (!value) return null
  if (value === 'idle' || value === 'running' || value === 'closed' || value === 'errored') return value
  throw new CloudServiceError(400, 'Unsupported session status filter.', {
    policyCode: 'sessions.status.invalid',
  })
}

function readNonNegativeInteger(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function readOptionalDate(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim()) throw new CloudHttpError(400, 'Date value must be an ISO timestamp.')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new CloudHttpError(400, 'Date value must be a valid ISO timestamp.')
  return date
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const raw = readString(value)
  return raw && (allowed as readonly string[]).includes(raw) ? raw as T : undefined
}

function readChannelProvider(value: unknown): ChannelProviderId | undefined {
  const provider = readString(value)
  if (!provider) return undefined
  if (['telegram', 'slack', 'email', 'discord', 'whatsapp', 'signal', 'webhook', 'cli'].includes(provider)) {
    return provider as ChannelProviderId
  }
  return /^[a-z][a-z0-9_-]{1,63}$/.test(provider) && provider.includes('-')
    ? provider as ChannelProviderId
    : undefined
}

function parseTagIds(url: URL) {
  const repeated = url.searchParams.getAll('tagId')
  const csv = url.searchParams.get('tagIds')?.split(',') || []
  return [...repeated, ...csv].map((value) => value.trim()).filter(Boolean)
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function workflowScopeKey(workflowId: string) {
  return createHash('sha256').update(workflowId || 'unknown-workflow').digest('hex').slice(0, 16)
}

function webhookSource(req: IncomingMessage) {
  return req.socket.remoteAddress || 'unknown'
}

function requestSource(req: IncomingMessage, trustProxyHeaders = false) {
  const forwardedFor = trustProxyHeaders
    ? firstHeader(req.headers['x-forwarded-for']).split(',')[0]?.trim()
    : ''
  return forwardedFor || req.socket.remoteAddress || 'unknown'
}

function requestCorsOrigin(req: IncomingMessage, configuredOrigin: string | null | undefined) {
  const configured = configuredOrigin?.trim()
  if (!configured) return null
  const origin = firstHeader(req.headers.origin).trim()
  return origin === configured ? configured : null
}

function requestHeaderRecord(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return headers
}

function authFailureScopes(req: IncomingMessage, trustProxyHeaders = false) {
  const source = requestSource(req, trustProxyHeaders)
  const authorization = firstHeader(req.headers.authorization).trim()
  const scopes = [`ip:${source}`]
  if (!authorization) return scopes
  const tokenHash = createHash('sha256').update(authorization).digest('hex').slice(0, 16)
  scopes.push(`auth:${tokenHash}`)
  return scopes
}

function webhookAuthScope(source: string, workflowId: string) {
  return `${source}:${workflowScopeKey(workflowId)}`
}

function extractSignatureWebhookAuth(req: IncomingMessage, rawBody: string): WorkflowWebhookAuth {
  const timestamp = firstHeader(req.headers['x-open-cowork-timestamp']).trim()
  const signature = firstHeader(req.headers['x-open-cowork-signature']).trim()
  if (!timestamp || !signature) {
    throw new WebhookHttpError(401, 'Workflow webhook signature authorization is required.')
  }
  return { kind: 'signature', timestamp, signature, rawBody }
}

function writeSseEvent(res: ServerResponse, event: {
  tenantId?: string
  userId?: string
  sessionId?: string | null
  sequence: number
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: CloudSessionEventType
  eventId: string
  payload: Record<string, unknown>
  createdAt?: string
}) {
  res.write(`id: ${event.sequence}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function writeChannelDeliverySseEvent(res: ServerResponse, delivery: unknown) {
  const record = readRecord(delivery) || {}
  const deliveryId = readString(record.deliveryId) || 'delivery'
  res.write(`id: ${deliveryId}\n`)
  res.write(`event: ${CHANNEL_DELIVERY_SSE_EVENT_TYPE}\n`)
  res.write(`data: ${JSON.stringify({ delivery })}\n\n`)
}

function publicChannelInteraction(value: unknown) {
  const record = { ...(readRecord(value) || {}) }
  delete record.tokenHash
  return record
}

function writeSnapshotRequiredEvent(
  res: ServerResponse,
  afterSequence: number,
  payload: Record<string, unknown>,
) {
  writeSseEvent(res, {
    sequence: afterSequence,
    type: 'snapshot.required',
    eventId: `snapshot-required:${afterSequence}`,
    entityType: 'workspace',
    entityId: 'workspace',
    operation: 'snapshot_required',
    projectionVersion: afterSequence,
    createdAt: new Date().toISOString(),
    payload,
  })
}

function ssePollMs(options: CloudHttpServerOptions) {
  const value = options.ssePollMs ?? 1000
  return Number.isInteger(value) && value > 0 ? value : 1000
}

async function processCommandIfConfigured(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
) {
  return processSessionCommandIfConfigured(options, principal.tenantId, sessionId)
}

async function processSessionCommandIfConfigured(
  options: CloudHttpServerOptions,
  tenantId: string,
  sessionId: string,
) {
  if (!options.worker || !options.autoProcessCommands) return 0
  return options.worker.processSessionCommands(tenantId, sessionId)
}

async function handleCloudWorkflowWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  url: URL,
) {
  const match = url.pathname.match(/^\/webhooks\/workflows\/([^/]+)$/)
  if (!match) {
    writeError(res, 404, 'Webhook not found.', options.corsOrigin)
    return
  }
  if (req.method !== 'POST') {
    writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return
  }
  if (!options.policy.features.workflows || !options.policy.features.webhooks) {
    writeError(res, 404, 'Webhook not found.', options.corsOrigin)
    return
  }

  const source = webhookSource(req)
  const startedAt = Date.now()
  const workflowId = decodeURIComponent(match[1] || '')
  const scope = webhookAuthScope(source, workflowId)
  const securityStore = options.webhookSecurity || new InMemoryWorkflowWebhookSecurityStore()
  try {
    const requestAccepted = await securityStore.claimRequest({
      source,
      nowMs: startedAt,
      windowMs: CLOUD_WEBHOOK_REQUEST_WINDOW_MS,
      limit: CLOUD_WEBHOOK_REQUEST_LIMIT,
    })
    if (!requestAccepted) throw new WebhookHttpError(429, 'Too many workflow webhook requests. Try again later.')
    const authAccepted = await securityStore.checkAuthBackoff({
      scope,
      nowMs: startedAt,
    })
    if (!authAccepted) throw new WebhookHttpError(429, 'Too many rejected workflow webhook requests. Try again later.')
    const { body, rawBody } = await readJsonBodyWithRaw(req, options.maxBodyBytes || 256 * 1024)
    const auth = extractSignatureWebhookAuth(req, rawBody)
    const started = await options.service.runWorkflowWebhook({
      workflowId,
      auth,
      payload: body,
      securityStore,
      now: new Date(startedAt),
    })
    const processed = await processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
    writeJson(res, 202, {
      ok: true,
      workflowId,
      runId: started.run.id,
      sessionId: started.sessionId,
      processed,
    }, options.corsOrigin)
  } catch (error) {
    const status = error instanceof WebhookHttpError ? error.status : 400
    const message = error instanceof WebhookHttpError ? error.publicMessage : 'Workflow webhook request failed.'
    if (status === 401) {
      await securityStore.recordAuthFailure({
        scope,
        source,
        nowMs: Date.now(),
        windowMs: CLOUD_WEBHOOK_AUTH_FAILURE_WINDOW_MS,
        limit: CLOUD_WEBHOOK_AUTH_FAILURE_LIMIT,
        backoffMs: CLOUD_WEBHOOK_AUTH_BACKOFF_MS,
      })
    }
    writeError(res, status, message, options.corsOrigin)
  }
}

async function handleBillingWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
) {
  if (req.method !== 'POST') {
    writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return
  }

  const source = `billing:${requestSource(req, options.trustProxyHeaders)}`
  const startedAt = Date.now()
  const securityStore = options.webhookSecurity || new InMemoryWorkflowWebhookSecurityStore()
  let replayClaim: Awaited<ReturnType<WorkflowWebhookSecurityStore['claimSignature']>> | null = null
  try {
    const requestAccepted = await securityStore.claimRequest({
      source,
      nowMs: startedAt,
      windowMs: CLOUD_WEBHOOK_REQUEST_WINDOW_MS,
      limit: CLOUD_WEBHOOK_REQUEST_LIMIT,
    })
    if (!requestAccepted) throw new CloudHttpError(429, 'Too many billing webhook requests. Try again later.')
    const authAccepted = await securityStore.checkAuthBackoff({
      scope: source,
      nowMs: startedAt,
    })
    if (!authAccepted) throw new CloudHttpError(429, 'Too many rejected billing webhook requests. Try again later.')
    const { body, rawBody } = await readJsonBodyWithRaw(req, options.maxBodyBytes || 256 * 1024)
    const verified = await options.service.verifyBillingWebhook({
      headers: requestHeaderRecord(req),
      rawBody,
      body,
    })
    const eventId = verified.eventId || readString(body.id) || createHash('sha256').update(rawBody).digest('hex')
    replayClaim = await securityStore.claimSignature({
      key: `billing:${eventId}`,
      nowMs: startedAt,
      windowMs: WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS,
      cacheLimit: WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT,
    })
    if (!replayClaim) {
      writeJson(res, 200, { ok: true, replayed: true }, options.corsOrigin)
      return
    }
    const result = await options.service.applyBillingWebhookResult(verified)
    await replayClaim.accept()
    writeJson(res, 200, {
      ok: true,
      providerId: result.providerId,
      eventId: result.eventId,
      eventType: result.eventType,
      subscription: result.subscriptionRecord || null,
    }, options.corsOrigin)
  } catch (error) {
    await replayClaim?.release()
    const status = error instanceof CloudHttpError
      ? error.status
      : error instanceof CloudServiceError
        ? error.status
        : 400
    if (status === 401) {
      await securityStore.recordAuthFailure({
        scope: source,
        source,
        nowMs: Date.now(),
        windowMs: CLOUD_WEBHOOK_AUTH_FAILURE_WINDOW_MS,
        limit: CLOUD_WEBHOOK_AUTH_FAILURE_LIMIT,
        backoffMs: CLOUD_WEBHOOK_AUTH_BACKOFF_MS,
      })
    }
    const message = error instanceof CloudHttpError
      ? error.publicMessage
      : error instanceof CloudServiceError
        ? error.publicMessage
        : 'Billing webhook request failed.'
    writeError(res, status, message, options.corsOrigin)
  }
}

function trackSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  cleanup: () => void,
) {
  if (options.sseStreamRegistry) return options.sseStreamRegistry.track(req, res, cleanup)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    req.off('close', close)
    res.off('close', close)
    res.off('finish', close)
    cleanup()
  }
  req.once('close', close)
  res.once('close', close)
  res.once('finish', close)
  return true
}

async function handleSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
  sessionId: string,
) {
  const afterSequence = parseAfterSequence(req, context.url)
  await options.service.getSessionView(context.principal, sessionId)
  writeCorsHeaders(res, options.corsOrigin)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  let lastSequence = afterSequence
  let cleaned = false
  let unsubscribe: (() => void) | null = null
  let replayUnsubscribe: (() => void) | null = null
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    replayUnsubscribe?.()
    unsubscribe?.()
  }
  if (!trackSseStream(req, res, options, cleanup)) return
  const writeIfNew = (event: {
    sequence: number
    type: string
    eventId: string
    payload: Record<string, unknown>
  }) => {
    if (cleaned || res.destroyed) return
    if (event.sequence <= lastSequence) return
    if (!isCloudSessionEventType(event.type)) {
      lastSequence = event.sequence
      return
    }
    const type: CloudSessionEventType = event.type
    writeSseEvent(res, { ...event, type })
    lastSequence = event.sequence
  }
  for (const event of await options.service.listEvents(context.principal, sessionId, afterSequence)) {
    writeIfNew(event)
  }
  if (cleaned) return
  unsubscribe = options.service.eventBus.subscribe({
    tenantId: context.principal.tenantId,
    sessionId,
    afterSequence,
  }, (event) => {
    writeIfNew(event)
  })
  replayUnsubscribe = options.sseReplayHub?.subscribe({
    key: `session:${context.principal.tenantId}:${context.principal.userId}:${sessionId}`,
    afterSequence: lastSequence,
    pollMs: ssePollMs(options),
    loadEvents: (sequence) => options.service.listEvents(context.principal, sessionId, sequence),
    listener: (event) => writeIfNew(event as SessionEventRecord),
  }) ?? null
  keepAliveTimer = setInterval(() => {
    if (cleaned || res.destroyed) return
    res.write(': keep-alive\n\n')
  }, ssePollMs(options))
}

async function handleWorkspaceSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
) {
  const afterSequence = parseAfterSequence(req, context.url)
  writeCorsHeaders(res, options.corsOrigin)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  let lastSequence = afterSequence
  let cleaned = false
  let unsubscribe: (() => void) | null = null
  let replayUnsubscribe: (() => void) | null = null
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    replayUnsubscribe?.()
    unsubscribe?.()
  }
  if (!trackSseStream(req, res, options, cleanup)) return
  const writeIfNew = (event: {
    tenantId?: string
    userId?: string
    sessionId?: string | null
    sequence: number
    entityType?: string
    entityId?: string
    operation?: string
    projectionVersion?: number
    type: string
    eventId: string
    payload: Record<string, unknown>
    createdAt?: string
  }) => {
    if (cleaned || res.destroyed) return
    if (event.sequence <= lastSequence) return
    if (!isCloudSessionEventType(event.type)) {
      lastSequence = event.sequence
      return
    }
    const type: CloudSessionEventType = event.type
    writeSseEvent(res, { ...event, type })
    lastSequence = event.sequence
  }

  const retainedEvents = await options.service.listWorkspaceEvents(context.principal, 0)
  if (cleaned || res.destroyed) return
  const earliestSequence = retainedEvents[0]?.sequence
  const hasReplayGap = afterSequence > 0
    && earliestSequence !== undefined
    && earliestSequence > afterSequence + 1

  if (hasReplayGap) {
    const latestSequence = retainedEvents[retainedEvents.length - 1]?.sequence || afterSequence
    writeSnapshotRequiredEvent(res, afterSequence, {
      reason: 'event_retention_gap',
      afterSequence,
      earliestSequence,
      latestSequence,
    })
    lastSequence = Math.max(lastSequence, latestSequence)
  } else {
    for (const event of retainedEvents) writeIfNew(event)
  }

  if (cleaned) return
  unsubscribe = options.service.workspaceEventBus.subscribe({
    tenantId: context.principal.tenantId,
    userId: context.principal.userId,
    afterSequence: lastSequence,
  }, (event) => {
    writeIfNew(event)
  })
  replayUnsubscribe = options.sseReplayHub?.subscribe({
    key: `workspace:${context.principal.tenantId}:${context.principal.userId}`,
    afterSequence: lastSequence,
    pollMs: ssePollMs(options),
    loadEvents: (sequence) => options.service.listWorkspaceEvents(context.principal, sequence),
    listener: (event) => writeIfNew(event as WorkspaceEventRecord),
  }) ?? null
  keepAliveTimer = setInterval(() => {
    if (cleaned || res.destroyed) return
    res.write(': keep-alive\n\n')
  }, ssePollMs(options))
}

async function handleChannelDeliveriesSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
) {
  if (!principalHasGatewayAccess(context.principal)) {
    writeError(res, 403, 'Gateway channel access requires a gateway-scoped API token.', options.corsOrigin)
    return
  }
  writeCorsHeaders(res, options.corsOrigin)
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const claimedBy = context.url.searchParams.get('claimedBy') || context.principal.tokenId || context.principal.userId || 'gateway'
  const ttlMsRaw = Number(context.url.searchParams.get('ttlMs') || 30_000)
  const ttlMs = Number.isInteger(ttlMsRaw) && ttlMsRaw > 0 ? ttlMsRaw : 30_000
  let closed = false
  let pollActive = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const cleanup = () => {
    if (closed) return
    closed = true
    if (pollTimer) clearInterval(pollTimer)
  }
  if (!trackSseStream(req, res, options, cleanup)) return
  const poll = async () => {
    if (pollActive || closed || res.destroyed) return
    pollActive = true
    try {
      let claimed = await options.service.claimNextChannelDelivery(context.principal, { claimedBy, ttlMs })
      while (claimed && !closed && !res.destroyed) {
        writeChannelDeliverySseEvent(res, claimed)
        claimed = await options.service.claimNextChannelDelivery(context.principal, { claimedBy, ttlMs })
      }
      if (!closed && !res.destroyed) res.write(': keep-alive\n\n')
    } catch (error) {
      if (!closed && !res.destroyed) {
        const message = error instanceof CloudServiceError
          ? error.publicMessage
          : 'Channel delivery stream failed.'
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
      }
    } finally {
      pollActive = false
    }
  }
  await poll()
  if (closed) return
  pollTimer = setInterval(() => {
    void poll()
  }, ssePollMs(options))
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext,
) {
  if (context.authSource === 'cookie' && methodRequiresCsrf(req.method)) {
    try {
      options.sessionCookies?.assertCsrf(req)
    } catch {
      writeError(res, 403, 'Cloud CSRF token is missing or invalid.', options.corsOrigin)
      return
    }
  }

  const [api, resource, sessionId, action] = context.segments
  const artifactId = context.segments[4]
  if (api !== 'api') {
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (!principalHasDesktopApiAccess(context.principal) && !routeAllowsGatewayOnlyToken({
    resource,
    action,
    method: req.method,
    sessionId,
    artifactId,
  }) && !routeAllowsOperationalToken(context.principal, {
    resource,
    action,
    method: req.method,
    sessionId,
    artifactId,
  }) && !routeAllowsWorkerCredential({
    resource,
    action,
    method: req.method,
    sessionId,
    artifactId,
  })) {
    writeError(res, 403, 'Desktop cloud API access requires a desktop-scoped API token.', options.corsOrigin)
    return
  }

  const routeTools = {
    readJsonBody,
    readString,
    readRecord,
    readStringArray,
    readOptionalDate,
    readApiTokenScopes,
    readOptionalCloudProjectSource,
    parseLimit,
    parseTagIds,
    writeJson,
    writeError,
    writePolicyError,
    handleWorkspaceSse,
  }

  if (await handleWorkspaceApiRoute({
    req,
    res,
    options,
    context,
    resource,
    itemId: sessionId,
    action,
    artifactId,
    tools: routeTools,
  })) return

  if (resource === 'project-sources') {
    await handleProjectSourcesApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'admin') {
    await handleAdminApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'api-tokens') {
    await handleApiTokensApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'billing') {
    await handleBillingApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'byok') {
    await handleByokApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'capabilities') {
    await handleCapabilitiesApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'settings') {
    await handleSettingsApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'threads') {
    await handleThreadsApiRoute({
      req,
      res,
      options,
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'channels') {
    const handled = await handleChannelsApiRoute({
      req,
      res,
      options,
      context,
      collection: sessionId,
      itemId: action,
      itemAction: artifactId,
      tools: {
        readJsonBody,
        readString,
        readRecord,
        readChannelProvider,
        readEnum,
        readNonNegativeInteger,
        readOptionalDate,
        publicChannelInteraction,
        writeJson,
        writeError,
        processSessionCommandIfConfigured,
        handleChannelDeliveriesSse,
      },
    })
    if (!handled) writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource === 'import') {
    if (sessionId === 'sessions' && !action && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 35 * 1024 * 1024)
      const importRequest = body as SessionImportRequest
      const artifactUploads = Array.isArray(importRequest.artifacts)
        ? importRequest.artifacts.slice(0, SESSION_IMPORT_MAX_ARTIFACTS)
        : []
      if (artifactUploads.length > 0 && !options.artifacts) {
        writeError(res, 503, 'Cloud artifact storage is not configured for session import.', options.corsOrigin)
        return
      }
      let createdSessionId: string | null = null
      try {
        const created = await options.service.createImportedSession(context.principal, {
          ...importRequest,
          artifacts: [],
        })
        createdSessionId = created.session.sessionId
        for (const artifact of artifactUploads) {
          await options.artifacts!.uploadSessionArtifact(context.principal, createdSessionId, {
            filename: artifact.filename,
            contentType: artifact.contentType || null,
            dataBase64: artifact.dataBase64,
          })
        }
        const itemCounts = emptySessionImportItemCounts({
          ...(importRequest.itemCounts || {}),
          artifacts: artifactUploads.length,
        })
        await options.service.completeSessionImport(context.principal, createdSessionId, {
          sourceFingerprint: importRequest.source?.fingerprint || '',
          itemCounts,
        })
        writeJson(res, 201, await options.service.getSessionView(context.principal, createdSessionId), options.corsOrigin)
      } catch (error) {
        if (createdSessionId) {
          await options.service.recordImportFailed(context.principal, {
            sessionId: createdSessionId,
            sourceFingerprint: importRequest.source?.fingerprint || '',
            itemCounts: importRequest.itemCounts,
            error,
          }).catch(() => undefined)
        }
        throw error
      }
      return
    }
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource === 'workflows') {
    if (!options.policy.features.workflows) {
      writePolicyError(res, 403, 'Workflows are disabled for this cloud profile.', 'workflows.disabled', options.corsOrigin)
      return
    }

    const workflowId = sessionId
    const workflowAction = action

    if (!workflowId && req.method === 'GET') {
      writeJson(res, 200, await options.service.listWorkflows(context.principal, {
        limit: parseLimit(context.url),
      }), options.corsOrigin)
      return
    }

    if (!workflowId && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const draft = body as Partial<WorkflowDraft>
      const workflow = await options.service.createWorkflow(context.principal, {
        title: readString(draft.title) || '',
        instructions: readString(draft.instructions) || '',
        agentName: readString(draft.agentName) || 'build',
        skillNames: readStringArray(draft.skillNames) || [],
        toolIds: readStringArray(draft.toolIds) || [],
        projectDirectory: readString(draft.projectDirectory),
        draftSessionId: readString(draft.draftSessionId),
        triggers: Array.isArray(draft.triggers) ? draft.triggers : [],
      })
      writeJson(res, 201, { workflow }, options.corsOrigin)
      return
    }

    if (workflowId === 'scheduler' && workflowAction === 'tick' && req.method === 'POST') {
      if (!options.internalToken) {
        writeError(res, 404, 'Not found.', options.corsOrigin)
        return
      }
      if (!internalTokenIsValid(req, options.internalToken)) {
        writeError(res, 403, 'Internal scheduler token is missing or invalid.', options.corsOrigin)
        return
      }
      const started = await options.service.claimAndStartDueWorkflow()
      const processed = started
        ? await processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
        : 0
      writeJson(res, 200, {
        claimed: started
          ? {
              tenantId: started.tenantId,
              workflowId: started.workflow.id,
              runId: started.run.id,
              sessionId: started.sessionId,
            }
          : null,
        processed,
      }, options.corsOrigin)
      return
    }

    if (!workflowId) {
      writeError(res, 405, 'Method not allowed.', options.corsOrigin)
      return
    }

    if (!workflowAction && req.method === 'GET') {
      const workflow = await options.service.getWorkflow(context.principal, workflowId)
      if (!workflow) {
        writeError(res, 404, 'Workflow was not found.', options.corsOrigin)
        return
      }
      writeJson(res, 200, { workflow }, options.corsOrigin)
      return
    }

    if (workflowAction === 'run' && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
      const triggerType = readString(body.triggerType) as WorkflowTriggerType | null
      const started = await options.service.runWorkflow(context.principal, workflowId, {
        triggerType: triggerType || 'manual',
        triggerPayload: readRecord(body.triggerPayload),
      })
      const processed = await processSessionCommandIfConfigured(options, started.tenantId, started.sessionId)
      const workflow = await options.service.getWorkflow(context.principal, workflowId)
      writeJson(res, 202, {
        ...started,
        workflow: workflow || started.workflow,
        run: workflow?.runs.find((run) => run.id === started.run.id) || started.run,
        processed,
      }, options.corsOrigin)
      return
    }

    if ((workflowAction === 'pause' || workflowAction === 'resume' || workflowAction === 'archive') && req.method === 'POST') {
      const status: WorkflowStatus = workflowAction === 'resume'
        ? 'active'
        : workflowAction === 'pause'
          ? 'paused'
          : 'archived'
      const workflow = await options.service.updateWorkflowStatus(context.principal, workflowId, status)
      if (!workflow) {
        writeError(res, 404, 'Workflow was not found.', options.corsOrigin)
        return
      }
      writeJson(res, 200, { workflow }, options.corsOrigin)
      return
    }

    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource !== 'sessions') {
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (!sessionId && req.method === 'GET') {
    const page = await options.service.listSessionsPage(context.principal, {
      limit: parseLimit(context.url),
      cursor: context.url.searchParams.get('cursor'),
      status: parseSessionStatus(context.url.searchParams.get('status')),
      profileName: context.url.searchParams.get('profileName'),
      query: context.url.searchParams.get('q') || context.url.searchParams.get('query'),
    })
    writeJson(res, 200, {
      sessions: page.items,
      nextCursor: page.nextCursor,
      totalEstimate: page.totalEstimate,
    }, options.corsOrigin)
    return
  }

  if (!sessionId && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const created = await options.service.createSession(context.principal, {
      profileName: readString(body.profileName),
      projectSource: readOptionalCloudProjectSource(body),
    })
    writeJson(res, 201, created, options.corsOrigin)
    return
  }

  if (!sessionId) {
    writeError(res, 405, 'Method not allowed.', options.corsOrigin)
    return
  }

  if (!action && req.method === 'GET') {
    writeJson(res, 200, await options.service.getSessionView(context.principal, sessionId), options.corsOrigin)
    return
  }

  if (action === 'activate' && req.method === 'POST') {
    writeJson(res, 200, await options.service.getSessionView(context.principal, sessionId), options.corsOrigin)
    return
  }

  if (action === 'view' && req.method === 'GET') {
    const cloudView = await options.service.getSessionView(context.principal, sessionId)
    writeJson(res, 200, {
      session: cloudView.session,
      projection: cloudView.projection,
      view: cloudSessionViewToSessionView(cloudView),
    }, options.corsOrigin)
    return
  }

  if (action === 'projection-status' && req.method === 'GET') {
    writeJson(res, 200, await options.service.getSessionProjectionStatus(context.principal, sessionId), options.corsOrigin)
    return
  }

  if (action === 'projection-repair' && req.method === 'POST') {
    writeJson(res, 200, await options.service.repairSessionProjection(context.principal, sessionId), options.corsOrigin)
    return
  }

  if (action === 'events' && req.method === 'GET') {
    await handleSse(req, res, options, context, sessionId)
    return
  }

  if (action === 'artifacts') {
    if (!options.policy.features.artifacts) {
      writePolicyError(res, 403, 'Artifacts are disabled for this cloud profile.', 'artifacts.disabled', options.corsOrigin)
      return
    }
    if (!options.artifacts) {
      writeError(res, 503, 'Cloud artifact storage is not configured.', options.corsOrigin)
      return
    }
    if (!artifactId && req.method === 'GET') {
      writeJson(res, 200, {
        artifacts: await options.artifacts.listSessionArtifacts(context.principal, sessionId),
      }, options.corsOrigin)
      return
    }
    if (!artifactId && req.method === 'POST') {
      const body = await readJsonBody(req, options.maxBodyBytes || 35 * 1024 * 1024)
      const uploaded = await options.artifacts.uploadSessionArtifact(context.principal, sessionId, {
        filename: readString(body.filename) || '',
        contentType: readString(body.contentType),
        dataBase64: readString(body.dataBase64) || '',
      })
      writeJson(res, 201, { artifact: uploaded }, options.corsOrigin)
      return
    }
    if (artifactId && req.method === 'GET') {
      const artifact = await options.artifacts.readSessionArtifact(context.principal, sessionId, artifactId)
      writeJson(res, 200, { artifact }, options.corsOrigin)
      return
    }
  }

  if (action === 'prompt' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const text = readString(body.text)
    if (!text) {
      writeError(res, 400, 'Prompt text is required.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueuePrompt(context.principal, sessionId, {
      text,
      agent: readString(body.agent),
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, {
      command,
      processed,
      view: await options.service.getSessionView(context.principal, sessionId),
    }, options.corsOrigin)
    return
  }

  if (action === 'abort' && req.method === 'POST') {
    const command = await options.service.enqueueAbort(context.principal, sessionId)
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, {
      command,
      processed,
      view: await options.service.getSessionView(context.principal, sessionId),
    }, options.corsOrigin)
    return
  }

  if (action === 'question-reply' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = readString(body.requestId)
    if (!requestId || !Array.isArray(body.answers)) {
      writeError(res, 400, 'Question reply requires requestId and answers.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueueQuestionReply(context.principal, sessionId, {
      requestId,
      answers: body.answers,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, { command, processed }, options.corsOrigin)
    return
  }

  if (action === 'question-reject' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = readString(body.requestId)
    if (!requestId) {
      writeError(res, 400, 'Question rejection requires requestId.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueueQuestionReject(context.principal, sessionId, {
      requestId,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, { command, processed }, options.corsOrigin)
    return
  }

  if (action === 'permission-respond' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const permissionId = readString(body.permissionId)
    if (!permissionId) {
      writeError(res, 400, 'Permission response requires permissionId.', options.corsOrigin)
      return
    }
    const command = await options.service.enqueuePermissionResponse(context.principal, sessionId, {
      permissionId,
      response: body.response ?? null,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    writeJson(res, 202, { command, processed }, options.corsOrigin)
    return
  }

  writeError(res, 404, 'Not found.', options.corsOrigin)
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: RouteContext | null,
  auth: CloudAuthResolver,
) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === '/auth/me' && req.method === 'GET') {
    if (!context) {
      writeError(res, 401, 'Cloud authentication is required.', options.corsOrigin)
      return
    }
    writeJson(res, 200, {
      principal: context.principal,
      csrfToken: context.cookieSession?.csrfToken || null,
      expiresAt: context.cookieSession?.expiresAt || null,
    }, options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/desktop/config' && req.method === 'GET') {
    if (!options.desktopAuth) {
      writeError(res, 404, 'Cloud desktop auth is not configured.', options.corsOrigin)
      return
    }
    writeJson(res, 200, options.desktopAuth, options.corsOrigin)
    return
  }

  if (!options.sessionCookies) {
    writeError(res, 404, 'Cloud browser sessions are not configured.', options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/login' && req.method === 'GET') {
    if (!options.browserAuth) {
      writeError(res, 404, 'Cloud browser OIDC login is not configured.', options.corsOrigin)
      return
    }
    const redirect = await options.browserAuth.login(req, url)
    writeRedirect(res, redirect.location, redirect.setCookieHeaders, options.corsOrigin)
    return
  }

  if (options.browserAuth?.isCallbackPath(url.pathname) && req.method === 'GET') {
    const completed = await options.browserAuth.callback(req, url)
    const issued = options.sessionCookies.issue(completed.principal)
    writeRedirect(res, completed.redirectTo || '/', [
      ...(completed.setCookieHeaders || []),
      ...issued.setCookieHeaders,
    ], options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/session' && req.method === 'POST') {
    const principal = await auth(req)
    const issued = options.sessionCookies.issue(principal)
    res.setHeader('Set-Cookie', issued.setCookieHeaders)
    writeJson(res, 200, {
      principal: issued.principal,
      csrfToken: issued.csrfToken,
      expiresAt: issued.expiresAt,
    }, options.corsOrigin)
    return
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    if (context?.authSource === 'cookie') {
      try {
        options.sessionCookies.assertCsrf(req)
      } catch {
        writeError(res, 403, 'Cloud CSRF token is missing or invalid.', options.corsOrigin)
        return
      }
    }
    res.setHeader('Set-Cookie', options.sessionCookies.clear())
    writeJson(res, 200, { ok: true }, options.corsOrigin)
    return
  }

  writeError(res, 404, 'Not found.', options.corsOrigin)
}

export class CloudHttpServer {
  private readonly server: Server
  private readonly options: CloudHttpServerOptions
  private readonly sseReplayHub: CloudSseReplayHub
  private readonly sseStreamRegistry: CloudSseStreamRegistry

  constructor(options: CloudHttpServerOptions) {
    this.sseReplayHub = options.sseReplayHub || new CloudSseReplayHub()
    this.sseStreamRegistry = options.sseStreamRegistry || new CloudSseStreamRegistry()
    this.options = {
      ...options,
      sseReplayHub: this.sseReplayHub,
      sseStreamRegistry: this.sseStreamRegistry,
      webhookSecurity: options.webhookSecurity || new InMemoryWorkflowWebhookSecurityStore(),
    }
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  async listen(port = 0, hostname = '127.0.0.1') {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, hostname, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    return this.url()
  }

  url() {
    const address = this.server.address() as AddressInfo | null
    if (!address) throw new Error('Cloud HTTP server is not listening.')
    return `http://${address.address}:${address.port}`
  }

  async close() {
    this.sseReplayHub.close()
    this.sseStreamRegistry.closeAll()
    this.server.closeIdleConnections?.()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private async enforceIpRateLimit(req: IncomingMessage) {
    await this.options.service.claimHttpRateLimit({
      scope: 'ip',
      source: requestSource(req, this.options.trustProxyHeaders),
    })
  }

  private async enforcePrincipalRateLimit(principal: CloudPrincipal) {
    await this.options.service.claimHttpRateLimit({
      scope: 'org',
      source: principal.orgId || principal.tenantId,
    })
    if (principal.tokenId) {
      await this.options.service.claimHttpRateLimit({
        scope: 'token',
        source: principal.tokenId,
      })
    }
  }

  private async resolvePrincipal(req: IncomingMessage, auth: CloudAuthResolver) {
    const source = requestSource(req, this.options.trustProxyHeaders)
    const scopes = authFailureScopes(req, this.options.trustProxyHeaders)
    await Promise.all(scopes.map((scope) => (
      this.options.service.checkCloudAuthBackoff({ scope, source })
    )))
    try {
      return await auth(req)
    } catch (error) {
      const status = error instanceof CloudHttpError
        ? error.status
        : error instanceof CloudServiceError
          ? error.status
          : 401
      if (status === 401) {
        await Promise.all(scopes.map((scope) => (
          this.options.service.recordCloudAuthFailure({ scope, source })
        )))
      }
      throw error
    }
  }

  private async recordPolicyErrorMetric(error: CloudHttpError | CloudServiceError, req: IncomingMessage, url: URL) {
    const policyCode = error.policyCode || ''
    const isQuotaRejection = error.status === 429 || policyCode.startsWith('quota.') || policyCode.startsWith('rate_limit.')
    const isAuthFailure = error.status === 401 || policyCode.startsWith('auth.')
    const name = isQuotaRejection
      ? 'open_cowork_cloud_quota_rejections_total'
      : isAuthFailure
        ? 'open_cowork_cloud_auth_failures_total'
        : null
    if (!name) return
    await recordCloudMetric(this.options.observability, {
      name,
      value: 1,
      unit: '1',
      attributes: {
        'http.request.method': req.method || 'GET',
        'url.path': url.pathname,
        'http.response.status_code': error.status,
        'cloud.role': this.options.policy.role,
        'cloud.profile': this.options.policy.profileName,
        policy_code: policyCode || undefined,
      },
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const startedAt = Date.now()
    const requestId = firstHeader(req.headers['x-request-id']).trim() || randomUUID()
    const url = new URL(req.url || '/', 'http://localhost')
    const requestOptions: CloudHttpServerOptions = {
      ...this.options,
      corsOrigin: requestCorsOrigin(req, this.options.corsOrigin),
    }
    res.setHeader('X-Request-Id', requestId)
    writeSecurityHeaders(res, { strictTransportSecurity: this.options.strictTransportSecurity })
    res.on('finish', () => {
      void recordCloudHttpRequest(this.options.observability, {
        requestId,
        method: req.method || 'GET',
        path: url.pathname,
        statusCode: res.statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        role: this.options.policy.role,
        profileName: this.options.policy.profileName,
        timestamp: new Date(),
      }).catch(() => {})
    })
    try {
      writeCorsHeaders(res, requestOptions.corsOrigin)
      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if ((url.pathname === '/' || url.pathname === '/index.html') && req.method === 'GET') {
        const nonce = randomBytes(16).toString('base64url')
        writeHtml(res, 200, cloudBrowserAppHtml(this.options.policy, this.options.publicBranding, nonce), requestOptions.corsOrigin, nonce)
        return
      }

      if (url.pathname === '/livez' || url.pathname === '/healthz') {
        writeJson(res, 200, {
          ok: true,
          role: this.options.policy.role,
          profileName: this.options.policy.profileName,
        }, requestOptions.corsOrigin)
        return
      }

      if (url.pathname === '/readyz') {
        const readiness = this.options.readiness
          ? await this.options.readiness()
          : {
              ok: false,
              role: this.options.policy.role,
              profileName: this.options.policy.profileName,
              checks: [{
                name: 'readiness_config',
                status: 'error',
                detail: 'Readiness checks are not configured for this server.',
              }],
            } satisfies CloudReadinessReport
        writeJson(res, readiness.ok ? 200 : 503, readiness, requestOptions.corsOrigin)
        return
      }

      if (url.pathname.startsWith('/webhooks/workflows/')) {
        await handleCloudWorkflowWebhook(req, res, requestOptions, url)
        return
      }

      if (url.pathname === '/webhooks/billing') {
        await handleBillingWebhook(req, res, requestOptions)
        return
      }

      await this.enforceIpRateLimit(req)

      if (url.pathname.startsWith('/auth/') || this.options.browserAuth?.isCallbackPath(url.pathname)) {
        const auth = this.options.auth || defaultAuthResolver
        const authWithBackoff: CloudAuthResolver = (request) => this.resolvePrincipal(request, auth)
        const cookieSession = this.options.sessionCookies?.read(req) || null
        const principal = cookieSession?.principal || (
          url.pathname === '/auth/me'
            ? await authWithBackoff(req)
            : null
        )
        if (principal) await this.enforcePrincipalRateLimit(principal)
        const context = principal
          ? {
              principal,
              authSource: cookieSession ? 'cookie' as const : 'resolver' as const,
              cookieSession,
              url,
              segments: url.pathname.split('/').filter(Boolean),
            }
          : null
        await handleAuthRequest(req, res, requestOptions, context, authWithBackoff)
        return
      }
      const auth = this.options.auth || defaultAuthResolver
      const cookieSession = this.options.sessionCookies?.read(req) || null
      const principal = cookieSession?.principal || await this.resolvePrincipal(req, auth)
      await this.enforcePrincipalRateLimit(principal)
      const context: RouteContext = {
        principal,
        authSource: cookieSession ? 'cookie' : 'resolver',
        cookieSession,
        url,
        segments: url.pathname.split('/').filter(Boolean),
      }
      const segments = url.pathname.split('/').filter(Boolean)
      await handleApiRequest(req, res, requestOptions, {
        ...context,
        segments,
      })
    } catch (error) {
      if (error instanceof CloudHttpError) {
        await this.recordPolicyErrorMetric(error, req, url)
        writeError(res, error.status, error.publicMessage, requestOptions.corsOrigin, {
          policyCode: error.policyCode,
          retryAfterMs: error.retryAfterMs,
        })
        return
      }
      if (error instanceof CloudServiceError) {
        await this.recordPolicyErrorMetric(error, req, url)
        writeError(res, error.status, error.publicMessage, requestOptions.corsOrigin, {
          policyCode: error.policyCode,
          retryAfterMs: error.retryAfterMs,
        })
        return
      }
      writeError(res, 500, 'Internal server error.', requestOptions.corsOrigin)
    }
  }
}

export function createCloudHttpServer(options: CloudHttpServerOptions) {
  return new CloudHttpServer(options)
}
