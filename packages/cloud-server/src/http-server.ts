import { createSqliteKnowledgeStore } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import { InMemoryWorkflowWebhookSecurityStore, WebhookHttpError, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { emptySessionImportItemCounts, createCloudProjectionFenceToken, isCloudSessionEventType, normalizeCloudProjectSource, type CloudProjectionFenceToken, type CloudSessionEventType, type CloudProjectSourceInput, type PublicBrandingConfig, type SessionImportRequest, type WorkflowDraft, type WorkflowStatus, type WorkflowTriggerType, type KnowledgeStore } from '@open-cowork/shared'
import type { CloudArtifactService } from './artifact-service.ts'
import { cloudBrowserAppHtml } from './browser-app.ts'
import {
  principalHasDesktopApiAccess,
  routeAllowsGatewayOnlyToken,
  routeAllowsOperationalToken,
  routeAllowsWorkerCredential,
} from './http-routes/access-policy.ts'
import { handleAdminApiRoute } from './http-routes/admin.ts'
import { handleArtifactsApiRoute } from './http-routes/artifacts.ts'
import { handleApiTokensApiRoute } from './http-routes/api-tokens.ts'
import { handleBillingApiRoute } from './http-routes/billing.ts'
import { handleByokApiRoute } from './http-routes/byok.ts'
import { handleCapabilitiesApiRoute } from './http-routes/capabilities.ts'
import { handleChannelsApiRoute } from './http-routes/channels.ts'
import { handleCoordinationApiRoute } from './http-routes/coordination.ts'
import { handleKnowledgeApiRoute } from './http-routes/knowledge.ts'
import { handleKnowledgeAgentProposeRoute } from './http-routes/knowledge-agent.ts'
import { handleLaunchpadApiRoute } from './http-routes/launchpad.ts'
import { handleProjectSourcesApiRoute } from './http-routes/project-sources.ts'
import { handleSettingsApiRoute } from './http-routes/settings.ts'
import { handleSessionArtifactsApiRoute } from './http-routes/session-artifacts.ts'
import { handleThreadsApiRoute } from './http-routes/threads.ts'
import { handleWorkspaceApiRoute } from './http-routes/workspace.ts'
import { CloudServiceError, type CloudPrincipal, type CloudSessionService, type CloudSessionView } from './session-service.ts'
import {
  firstHeader,
  parseAfterSequence,
  parseLimit,
  parseSessionStatus,
  parseTagIds,
  readApiTokenScopes,
  readChannelProvider,
  readEnum,
  readNonNegativeInteger,
  readRecord,
  readString,
  readStringArray,
} from './http-request-parsers.ts'
import {
  methodRequiresCsrf,
  writeBinary,
  writeCorsHeaders,
  writeError,
  writeHtml,
  writeJson,
  writePolicyError,
  writeRedirect,
  writeSecurityHeaders,
} from './http-response-writers.ts'
import { internalTokenIsValid } from './http-auth-helpers.ts'
import {
  publicChannelInteraction,
  writeSnapshotRequiredEvent,
  writeSseEvent,
} from './http-sse-helpers.ts'
import {
  authFailureScopes,
  extractSignatureWebhookAuth,
  requestCorsOrigin,
  requestHeaderRecord,
  requestSource,
  webhookAuthScope,
} from './http-request-context.ts'
import { cloudSessionViewToSessionView } from './session-view-contract.ts'
import type { CloudWorker } from './worker.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import type { CloudReadinessReport } from './readiness.ts'
import { CloudSseReplayHub, CloudSseStreamRegistry } from './sse-replay.ts'
import { resolveCloudWebStaticAsset } from './web-static-assets.ts'
import type {
  SessionEventRecord,
  SessionCommandRecord,
  WorkspaceEventRecord,
} from './control-plane-store.ts'
import { recordCloudHttpRequest, recordCloudLog, recordCloudMetric } from './observability.ts'
import type { CloudCookieSession, CloudSessionCookieManager } from './session-cookie-auth.ts'
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
  trustedProxyCidrs?: readonly string[] | null
  readiness?: () => Promise<CloudReadinessReport> | CloudReadinessReport
  knowledgeDataDir?: string | null
  /**
   * Backend for cloud knowledge wiki reads/writes. When omitted, the server
   * falls back to a SQLite store rooted at {@link knowledgeDataDir} (desktop /
   * local / in-memory). The cloud app injects a Postgres-backed store when the
   * control plane is Postgres so knowledge shares the durable control plane
   * rather than a node-local SQLite file.
   */
  knowledgeStore?: KnowledgeStore
  /**
   * Cloud signing secret used to verify the per-session, tenant-scoped knowledge
   * agent token presented by the knowledge MCP on the agent-propose route. When
   * omitted, the route fails closed (401) — no agent proposals are accepted.
   * Same secret the cloud app uses for session cookies / team-invite tokens.
   */
  knowledgeAgentTokenSecret?: string | null
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

type AuthAccountingOperation = 'check_backoff' | 'record_failure'

function isRequestPolicyError(error: unknown): error is CloudHttpError | CloudServiceError {
  return error instanceof CloudHttpError || error instanceof CloudServiceError
}

function authAccountingErrorType(error: unknown) {
  return error instanceof Error && error.name ? error.name : typeof error
}

type RouteContext = {
  principal: CloudPrincipal
  authSource: 'cookie' | 'resolver'
  cookieSession: CloudCookieSession | null
  url: URL
  segments: string[]
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

function readOptionalCloudProjectSource(body: Record<string, unknown>): CloudProjectSourceInput | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'projectSource')) return undefined
  const raw = body.projectSource
  if (raw === undefined || raw === null) return null
  const normalized = normalizeCloudProjectSource(raw)
  if (!normalized) throw new CloudHttpError(400, 'Cloud project source is invalid.')
  return normalized
}

function readOptionalDate(value: unknown) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !value.trim()) throw new CloudHttpError(400, 'Date value must be an ISO timestamp.')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new CloudHttpError(400, 'Date value must be a valid ISO timestamp.')
  return date
}


function ssePollMs(options: CloudHttpServerOptions) {
  const value = options.ssePollMs ?? 1000
  return Number.isInteger(value) && value > 0 ? value : 1000
}

// Bounds each SSE replay-poll read so a topic never drags an unbounded event history
// per poll; the replay hub paginates by advancing its cursor (and re-polls immediately
// when a full batch is returned), so delivery stays complete.
const SSE_REPLAY_BATCH = 1_000

// Hard cap on per-connection outbound SSE bytes buffered in Node's writable queue. A
// client that drains slower than events arrive would otherwise grow this without bound
// (heap pressure); past the cap the connection is dropped (cleanup unsubscribes on close).
export const SSE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024

// TCP keep-alive probe interval applied to every SSE socket so the kernel detects a
// half-open peer (gone without FIN/RST) instead of the gap only surfacing once the OS
// send buffer fills. Independent of the app-level ': keep-alive' comments, which a dead
// peer silently absorbs.
const SSE_TCP_KEEPALIVE_MS = 30_000

// Hard ceiling on a single SSE stream's lifetime. A wedged or half-open connection
// cannot pin a server slot indefinitely; EventSource clients reconnect transparently
// (with their Last-Event-ID), so the cap is invisible to healthy clients.
function sseMaxStreamLifetimeMs(): number {
  const raw = Number(process.env.OPEN_COWORK_CLOUD_SSE_MAX_LIFETIME_MS)
  return Number.isInteger(raw) && raw > 0 ? raw : 30 * 60_000
}

// Enable TCP keep-alive on the SSE socket and arm a max-lifetime timer that ends the
// response. Returns the timer so the caller clears it from its cleanup path.
function armSseSocketLifetime(req: IncomingMessage, res: ServerResponse): ReturnType<typeof setTimeout> {
  req.socket?.setKeepAlive(true, SSE_TCP_KEEPALIVE_MS)
  const timer = setTimeout(() => {
    if (!res.destroyed) res.end()
  }, sseMaxStreamLifetimeMs())
  timer.unref?.()
  return timer
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

function sessionEventCommandId(event: SessionEventRecord) {
  return readString(readRecord(event.payload)?.commandId)
}

async function sessionProjectionFenceForCommand(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  command: SessionCommandRecord,
  view: CloudSessionView,
  processed: number,
  afterProjectionSequence: number,
): Promise<CloudProjectionFenceToken | null> {
  if (processed <= 0) return null
  const observedSequence = typeof view.projection?.sequence === 'number' && Number.isInteger(view.projection.sequence) && view.projection.sequence > 0
    ? view.projection.sequence
    : null
  if (observedSequence === null || observedSequence <= afterProjectionSequence) return null
  const events = await options.service.listEvents(principal, command.sessionId, afterProjectionSequence)
  const commandEvent = events.find((event) => event.sequence <= observedSequence && sessionEventCommandId(event) === command.commandId)
  if (!commandEvent) return null
  return createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: principal.tenantId,
    sessionId: view.session.sessionId,
    commandId: command.commandId,
    sequence: commandEvent.sequence,
    projectionVersion: commandEvent.sequence,
  })
}

async function writeSessionCommandMutationResponse(
  res: ServerResponse,
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
  command: SessionCommandRecord,
  processed: number,
  beforeProjectionSequence: number,
  extraBody: Record<string, unknown> = {},
) {
  const view = await options.service.getSessionView(principal, sessionId)
  const projectionFence = await sessionProjectionFenceForCommand(
    options,
    principal,
    command,
    view,
    processed,
    beforeProjectionSequence,
  )
  writeJson(res, 202, {
    ...extraBody,
    command,
    processed,
    view,
    projectionFence,
  }, options.corsOrigin)
}

async function currentSessionProjectionSequence(
  options: CloudHttpServerOptions,
  principal: CloudPrincipal,
  sessionId: string,
) {
  const view = await options.service.getSessionView(principal, sessionId)
  return view.projection?.sequence || 0
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

  const source = requestSource(req, options.trustProxyHeaders, options.trustedProxyCidrs)
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

  const source = `billing:${requestSource(req, options.trustProxyHeaders, options.trustedProxyCidrs)}`
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

function sseMaxConnectionsPerOrg(): number {
  const raw = Number(process.env.OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG)
  return Number.isInteger(raw) && raw > 0 ? raw : 200
}

function trackSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  cleanup: () => void,
  orgKey?: string | null,
) {
  if (options.sseStreamRegistry) {
    return options.sseStreamRegistry.track(req, res, cleanup, { orgKey: orgKey || undefined, maxPerOrg: sseMaxConnectionsPerOrg() })
  }

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
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    replayUnsubscribe?.()
    unsubscribe?.()
  }
  if (!trackSseStream(req, res, options, cleanup, context.principal.orgId || context.principal.tenantId)) return
  lifetimeTimer = armSseSocketLifetime(req, res)
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
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) res.destroy()
  }
  // Drain the catch-up backlog in bounded keyset pages — the initial connect previously
  // loaded the session's entire event history (no retention) into memory in one read.
  let drainAfter = afterSequence
  for (;;) {
    const batch = await options.service.listEvents(context.principal, sessionId, drainAfter, SSE_REPLAY_BATCH)
    for (const event of batch) writeIfNew(event)
    if (cleaned || batch.length < SSE_REPLAY_BATCH) break
    drainAfter = batch[batch.length - 1]!.sequence
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
    loadEvents: (sequence) => options.service.listSessionEventsForStream(context.principal.tenantId, sessionId, sequence, SSE_REPLAY_BATCH),
    listener: (event) => writeIfNew(event as SessionEventRecord),
    batchSize: SSE_REPLAY_BATCH,
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
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    replayUnsubscribe?.()
    unsubscribe?.()
  }
  if (!trackSseStream(req, res, options, cleanup, context.principal.orgId || context.principal.tenantId)) return
  lifetimeTimer = armSseSocketLifetime(req, res)
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
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) res.destroy()
  }

  const cursor = await options.service.getWorkspaceEventCursor(context.principal)
  if (cleaned || res.destroyed) return
  const earliestSequence = cursor.earliestSequence
  const hasReplayGap = afterSequence > 0
    && earliestSequence !== null
    && earliestSequence > afterSequence + 1

  if (hasReplayGap) {
    const latestSequence = cursor.latestSequence || afterSequence
    writeSnapshotRequiredEvent(res, afterSequence, {
      reason: 'event_retention_gap',
      afterSequence,
      earliestSequence,
      latestSequence,
    })
    lastSequence = Math.max(lastSequence, latestSequence)
  } else {
    // Bounded keyset drain of the workspace backlog (see the session handler).
    let drainAfter = afterSequence
    for (;;) {
      const batch = await options.service.listWorkspaceEvents(context.principal, drainAfter, SSE_REPLAY_BATCH)
      for (const event of batch) writeIfNew(event)
      if (cleaned || batch.length < SSE_REPLAY_BATCH) break
      drainAfter = batch[batch.length - 1]!.sequence
    }
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
    loadEvents: (sequence) => options.service.listWorkspaceEventsForStream(context.principal.tenantId, context.principal.userId, sequence, SSE_REPLAY_BATCH),
    listener: (event) => writeIfNew(event as WorkspaceEventRecord),
    batchSize: SSE_REPLAY_BATCH,
  }) ?? null
  keepAliveTimer = setInterval(() => {
    if (cleaned || res.destroyed) return
    res.write(': keep-alive\n\n')
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

  if (resource === 'coordination') {
    await handleCoordinationApiRoute({
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

  if (resource === 'knowledge') {
    // Resolve the effective knowledge backend once per request: the injected
    // store (Postgres in cloud) when present, otherwise a SQLite store rooted at
    // knowledgeDataDir. Thread it through so the route always sees a concrete
    // KnowledgeStore on `input.options.knowledgeStore`.
    const knowledgeStore = options.knowledgeStore
      ?? createSqliteKnowledgeStore({ storageDataDir: options.knowledgeDataDir })
    await handleKnowledgeApiRoute({
      req,
      res,
      options: { ...options, knowledgeStore },
      context,
      resource,
      itemId: sessionId,
      action,
      artifactId,
      tools: routeTools,
    })
    return
  }

  if (resource === 'launchpad') {
    await handleLaunchpadApiRoute({
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
    if (!options.policy.features.channels) {
      writePolicyError(res, 403, 'Channels are disabled for this cloud profile.', 'channels.disabled', options.corsOrigin)
      return
    }
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
        writeCorsHeaders,
        trackSseStream,
        ssePollMs,
        processSessionCommandIfConfigured,
        writeSessionCommandMutationResponse,
      },
    })
    if (!handled) writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }

  if (resource === 'artifacts') {
    await handleArtifactsApiRoute({
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
            kind: artifact.kind || null,
            status: artifact.status || null,
            authorAgentId: artifact.authorAgentId || null,
            projectId: artifact.projectId || null,
            taskId: artifact.taskId || null,
            statusUpdatedBy: artifact.statusUpdatedBy || null,
            statusUpdatedAt: artifact.statusUpdatedAt || null,
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
        steps: Array.isArray(draft.steps) ? draft.steps : undefined,
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

  if (await handleSessionArtifactsApiRoute({ req, res, options, context, resource, itemId: sessionId, action, artifactId, tools: routeTools })) return

  if (action === 'prompt' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const text = readString(body.text)
    if (!text) {
      writeError(res, 400, 'Prompt text is required.', options.corsOrigin)
      return
    }
    const beforeProjectionSequence = await currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueuePrompt(context.principal, sessionId, {
      text,
      agent: readString(body.agent),
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    await writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return
  }

  if (action === 'abort' && req.method === 'POST') {
    const beforeProjectionSequence = await currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueueAbort(context.principal, sessionId)
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    await writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return
  }

  if (action === 'question-reply' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = readString(body.requestId)
    if (!requestId || !Array.isArray(body.answers)) {
      writeError(res, 400, 'Question reply requires requestId and answers.', options.corsOrigin)
      return
    }
    const beforeProjectionSequence = await currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueueQuestionReply(context.principal, sessionId, {
      requestId,
      answers: body.answers,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    await writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return
  }

  if (action === 'question-reject' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const requestId = readString(body.requestId)
    if (!requestId) {
      writeError(res, 400, 'Question rejection requires requestId.', options.corsOrigin)
      return
    }
    const beforeProjectionSequence = await currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueueQuestionReject(context.principal, sessionId, {
      requestId,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    await writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
    return
  }

  if (action === 'permission-respond' && req.method === 'POST') {
    const body = await readJsonBody(req, options.maxBodyBytes || 1024 * 1024)
    const permissionId = readString(body.permissionId)
    if (!permissionId) {
      writeError(res, 400, 'Permission response requires permissionId.', options.corsOrigin)
      return
    }
    const beforeProjectionSequence = await currentSessionProjectionSequence(options, context.principal, sessionId)
    const command = await options.service.enqueuePermissionResponse(context.principal, sessionId, {
      permissionId,
      response: body.response ?? null,
    })
    const processed = await processCommandIfConfigured(options, context.principal, sessionId)
    await writeSessionCommandMutationResponse(res, options, context.principal, sessionId, command, processed, beforeProjectionSequence)
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
  // Set the instant close() begins so /readyz reports 503 during drain — the LB/ingress
  // stops routing to this pod immediately while in-flight work finishes.
  private draining = false

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
    // Slowloris + connection-exhaustion guards (Node defaults are 300s/60s/unbounded).
    // The body reader caps bytes but not time; bound header/request receipt and total
    // connections. keepAliveTimeout is left at the Node default deliberately — raising it
    // is an LB-coordination concern (avoid 502 races), not part of this hardening.
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 20_000
    const maxConnections = Number(process.env.OPEN_COWORK_CLOUD_MAX_CONNECTIONS)
    this.server.maxConnections = Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : 10_000
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

  async close(forceCloseAfterMs = 10_000) {
    this.draining = true
    this.sseReplayHub.close()
    this.sseStreamRegistry.closeAll()
    this.server.closeIdleConnections?.()
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        // A single hung/long request would otherwise block close() until the K8s
        // SIGKILL; force-terminate stragglers after a bounded grace so drain is clean.
        forceTimer = setTimeout(() => this.server.closeAllConnections?.(), forceCloseAfterMs)
        forceTimer.unref?.()
        this.server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    } finally {
      if (forceTimer) clearTimeout(forceTimer)
    }
  }

  private async enforceIpRateLimit(req: IncomingMessage) {
    await this.options.service.claimHttpRateLimit({
      scope: 'ip',
      source: requestSource(req, this.options.trustProxyHeaders, this.options.trustedProxyCidrs),
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

  private async recordAuthAccountingError(operation: AuthAccountingOperation, error: unknown) {
    await recordCloudMetric(this.options.observability, {
      name: 'open_cowork_cloud_auth_accounting_errors_total',
      value: 1,
      unit: '1',
      attributes: {
        'cloud.auth.accounting.operation': operation,
        'error.type': authAccountingErrorType(error),
      },
    })
  }

  private async checkAuthBackoff(source: string, scopes: string[]) {
    const results = await Promise.allSettled(scopes.map((scope) => (
      this.options.service.checkCloudAuthBackoff({ scope, source })
    )))
    for (const result of results) {
      if (result.status === 'rejected' && isRequestPolicyError(result.reason)) {
        throw result.reason
      }
    }
    for (const result of results) {
      if (result.status === 'rejected') {
        await this.recordAuthAccountingError('check_backoff', result.reason)
      }
    }
  }

  private async recordAuthFailure(source: string, scopes: string[]) {
    const results = await Promise.allSettled(scopes.map((scope) => (
      this.options.service.recordCloudAuthFailure({ scope, source })
    )))
    for (const result of results) {
      if (result.status === 'rejected') {
        await this.recordAuthAccountingError('record_failure', result.reason)
      }
    }
  }

  private async resolvePrincipal(req: IncomingMessage, auth: CloudAuthResolver) {
    const source = requestSource(req, this.options.trustProxyHeaders, this.options.trustedProxyCidrs)
    const scopes = authFailureScopes(req, this.options.trustProxyHeaders, this.options.trustedProxyCidrs)
    await this.checkAuthBackoff(source, scopes)
    try {
      return await auth(req)
    } catch (error) {
      const status = error instanceof CloudHttpError
        ? error.status
        : error instanceof CloudServiceError
          ? error.status
          : 401
      if (status === 401) {
        await this.recordAuthFailure(source, scopes)
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

      if (req.method === 'GET') {
        const asset = resolveCloudWebStaticAsset(url.pathname)
        if (asset?.status === 'ok') {
          writeBinary(res, asset.body, asset.contentType, asset.cacheControl, requestOptions.corsOrigin)
          return
        }
        if (asset) {
          writeError(res, 404, asset.message, requestOptions.corsOrigin)
          return
        }
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
        if (this.draining) {
          writeJson(res, 503, {
            ok: false,
            role: this.options.policy.role,
            profileName: this.options.policy.profileName,
            checks: [{ name: 'draining', status: 'error', detail: 'Server is shutting down.' }],
          }, requestOptions.corsOrigin)
          return
        }
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

      // Public, pre-auth: the signed invite token is the bearer credential (like the billing
      // webhook above), so an invitee can accept before they have a session. IP-rate-limited.
      if (url.pathname === '/api/invites/accept' && req.method === 'POST') {
        const body = await readJsonBody(req, this.options.maxBodyBytes || 1024 * 1024)
        const token = readString(body.token)
        if (!token) {
          writeError(res, 400, 'An invite token is required.', requestOptions.corsOrigin)
          return
        }
        const membership = await this.options.service.acceptMembershipInvite(token)
        writeJson(res, 200, { membership }, requestOptions.corsOrigin)
        return
      }

      // Public, pre-user-auth: the cloud agent-propose route. A coworker (agent)
      // in a cloud session proposes a knowledge edit via the knowledge MCP,
      // which carries a per-session, tenant-scoped signed token as its bearer
      // credential (NOT the user cookie/principal). The route verifies the token,
      // derives the workspace from the TOKEN (never the body), forces `by`, and
      // creates a PENDING proposal. Propose-only; placed like /api/invites/accept
      // so it bypasses the desktop-API user-principal gate. IP-rate-limited above.
      if (url.pathname === '/api/knowledge/agent/propose') {
        const knowledgeStore = this.options.knowledgeStore
          ?? createSqliteKnowledgeStore({ storageDataDir: this.options.knowledgeDataDir })
        await handleKnowledgeAgentProposeRoute({
          req,
          res,
          secret: this.options.knowledgeAgentTokenSecret || '',
          store: knowledgeStore,
          knowledgeEnabled: this.options.policy.features.knowledge,
          maxBodyBytes: this.options.maxBodyBytes || 1024 * 1024,
          corsOrigin: requestOptions.corsOrigin,
          tools: { readJsonBody, writeJson, writeError, writePolicyError },
        })
        return
      }

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
      await recordCloudLog(this.options.observability, {
        level: 'error',
        name: 'cloud.http.unexpected_error',
        message: error instanceof Error ? error.message : String(error),
        attributes: {
          request_id: requestId,
          'http.request.method': req.method || 'GET',
          'url.path': url.pathname,
          'cloud.role': this.options.policy.role,
          'cloud.profile': this.options.policy.profileName,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: error instanceof Error ? error.message : String(error),
        },
      })
      writeError(res, 500, 'Internal server error.', requestOptions.corsOrigin)
    }
  }
}

export function createCloudHttpServer(options: CloudHttpServerOptions) {
  return new CloudHttpServer(options)
}
