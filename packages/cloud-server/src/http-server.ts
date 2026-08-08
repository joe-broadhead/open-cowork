import { createSqliteKnowledgeStore } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import { InMemoryWorkflowWebhookSecurityStore, WebhookHttpError, type WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CLOUD_SESSION_EVENT_TYPES,
  evaluateWorkspaceCapabilityPolicy,
  normalizeCloudProjectSource,
  type CloudProjectSourceInput,
} from '@open-cowork/shared'
import {
  BROWSER_RENDERER_ASSET_CACHE_CONTROL,
  browserRendererChartFrameHtml,
  browserRendererHtml,
  getBrowserRendererAsset,
  isBrowserRendererAssetPath,
  isBrowserRendererChartFramePath,
} from './browser-renderer-app.ts'
import { handleAdminApiRoute } from './http-routes/admin.ts'
import { handleScimApiRoute } from './http-routes/scim.ts'
import { handleArtifactsApiRoute } from './http-routes/artifacts.ts'
import { handleApiTokensApiRoute } from './http-routes/api-tokens.ts'
import { handlePolicyApiRoute } from './http-routes/policy.ts'
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
import { handleSessionsApiRoute } from './http-routes/sessions.ts'
import { handleThreadsApiRoute } from './http-routes/threads.ts'
import { handleWorkflowsApiRoute } from './http-routes/workflows.ts'
import { handleWorkspaceApiRoute } from './http-routes/workspace.ts'
import { authorizeCloudApiWorkspaceRequest } from './http-routes/workspace-authorization.ts'
import { CloudByokRuntimeConfigError } from './byok-runtime-config.ts'
import { internalTokenIsValid } from './http-auth-helpers.ts'
import {
  CloudHttpError,
  type CloudAuthResolver,
  type CloudHttpRouteContext,
  type CloudHttpServerOptions,
} from './http-contracts.ts'
import { CloudServiceError, type CloudPrincipal } from './session-service.ts'
import { handleCloudHealthRoute } from './http-health-routes.ts'
import {
  firstHeader,
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
  writeBrowserRendererChartFrameHtml,
  writeBrowserRendererHtml,
  writeCorsHeaders,
  writeError,
  writeJson,
  writePolicyError,
  writeRedirect,
  writeSecurityHeaders,
} from './http-response-writers.ts'
import { publicChannelInteraction } from './http-sse-helpers.ts'
import {
  armSseSocketLifetime,
  handleSessionSse,
  handleWorkspaceSse,
  ssePollMs,
  trackSseStream,
} from './http-sse-streams.ts'
import {
  authFailureScopes,
  extractSignatureWebhookAuth,
  requestCorsOrigin,
  requestHeaderRecord,
  requestSource,
  webhookAuthScope,
} from './http-request-context.ts'
import { CloudSseReplayHub, CloudSseStreamRegistry } from './sse-replay.ts'
import {
  recordCloudHttpRequest,
  recordCloudLog,
  recordCloudMetric,
  recordCloudWorkspacePolicyDecision, templateCloudHttpPath,
} from './observability.ts'
import {
  currentSessionProjectionSequence,
  processCommandIfConfigured,
  processSessionCommandIfConfigured,
  writeSessionCommandMutationResponse,
} from './http-session-mutations.ts'

export { CloudHttpError }
export type {
  CloudAuthResolver,
  CloudBrowserAuthCallback,
  CloudBrowserAuthProvider,
  CloudBrowserAuthRedirect,
  CloudDesktopAuthConfig,
  CloudHttpServerOptions,
} from './http-contracts.ts'

type AuthAccountingOperation = 'check_backoff' | 'record_failure'

function isRequestPolicyError(error: unknown): error is CloudHttpError | CloudServiceError {
  return error instanceof CloudHttpError || error instanceof CloudServiceError
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
    const started = await options.service.domains.workflows.runWorkflowWebhook({
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
    const status = error instanceof WebhookHttpError || error instanceof CloudServiceError ? error.status : 400
    const message = error instanceof WebhookHttpError || error instanceof CloudServiceError
      ? error.publicMessage
      : 'Workflow webhook request failed.'
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
    if (error instanceof CloudServiceError && error.policyCode) {
      writePolicyError(res, status, message, error.policyCode, options.corsOrigin)
    } else writeError(res, status, message, options.corsOrigin)
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
    const verified = await options.service.domains.billing.verifyBillingWebhook({
      headers: requestHeaderRecord(req),
      rawBody,
      body,
    })
    const policyDecision = evaluateWorkspaceCapabilityPolicy({
      action: 'billing.webhookApply',
      principal: { authSource: 'verified_billing_webhook' },
      features: options.policy.features,
    })
    await recordCloudWorkspacePolicyDecision(options.observability, policyDecision)
    if (policyDecision.outcome === 'deny') {
      writePolicyError(
        res,
        403,
        policyDecision.message,
        policyDecision.code,
        options.corsOrigin,
      )
      return
    }
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
    const result = await options.service.domains.billing.applyBillingWebhookResult(verified)
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

// Default per-org SSE connection cap when the resolver did not supply one. The
// env var (OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG) is parsed once in the
// central resolver and passed through CloudHttpServerOptions.maxSseConnectionsPerOrg.

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: CloudHttpRouteContext,
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

  const schedulerTick = resource === 'workflows'
    && sessionId === 'scheduler'
    && action === 'tick'
    && context.segments.length === 4
    && req.method === 'POST'
  if (schedulerTick && !options.internalToken) {
    writeError(res, 404, 'Not found.', options.corsOrigin)
    return
  }
  const policyPrincipal: CloudPrincipal = schedulerTick && internalTokenIsValid(req, options.internalToken)
    ? {
        ...context.principal,
        authSource: 'api_token',
        tokenScopes: ['worker-internal'],
    }
    : context.principal

  const workspaceAuthorization = await authorizeCloudApiWorkspaceRequest({
    req,
    res,
    options,
    segments: context.segments,
    principal: policyPrincipal,
    readJsonBody,
  })
  if (!workspaceAuthorization.allowed) return

  const routeTools = {
    readJsonBody: workspaceAuthorization.readJsonBody,
    readString,
    readRecord,
    readStringArray,
    readOptionalDate,
    readApiTokenScopes,
    readOptionalCloudProjectSource,
    parseLimit,
    parseSessionStatus,
    parseTagIds,
    writeJson,
    writeError,
    writePolicyError,
    handleSessionSse,
    handleWorkspaceSse,
    currentSessionProjectionSequence,
    processCommandIfConfigured,
    processSessionCommandIfConfigured,
    writeSessionCommandMutationResponse,
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

  if (resource === 'policy') {
    await handlePolicyApiRoute({
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
    const handled = await handleChannelsApiRoute({
      req,
      res,
      options,
      context,
      collection: sessionId,
      itemId: action,
      itemAction: artifactId,
      tools: {
        readJsonBody: workspaceAuthorization.readJsonBody,
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
        armSseSocketLifetime,
        ssePollMs,
        processSessionCommandIfConfigured,
        writeSessionCommandMutationResponse,
        handleSessionSse,
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

  if (await handleSessionsApiRoute({
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

  if (await handleWorkflowsApiRoute({
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

  writeError(res, 404, 'Not found.', options.corsOrigin)
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: CloudHttpRouteContext | null,
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
    // Total connection cap. The env var (OPEN_COWORK_CLOUD_MAX_CONNECTIONS) is parsed
    // once in the central resolver and threaded through options.maxConnections rather
    // than read from process.env here, so it is injected/validated like every other knob.
    const maxConnections = options.maxConnections
    this.server.maxConnections = Number.isInteger(maxConnections) && (maxConnections as number) > 0 ? (maxConnections as number) : 10_000
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

  private async recordAuthAccountingError(operation: AuthAccountingOperation) {
    await recordCloudMetric(this.options.observability, {
      name: 'open_cowork_cloud_auth_accounting_errors_total',
      value: 1,
      unit: '1',
      attributes: {
        'cloud.auth.accounting.operation': operation,
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
        await this.recordAuthAccountingError('check_backoff')
      }
    }
  }

  private async recordAuthFailure(source: string, scopes: string[]) {
    const results = await Promise.allSettled(scopes.map((scope) => (
      this.options.service.recordCloudAuthFailure({ scope, source })
    )))
    for (const result of results) {
      if (result.status === 'rejected') {
        await this.recordAuthAccountingError('record_failure')
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

  private async recordPolicyErrorMetric(error: CloudHttpError | CloudServiceError, req: IncomingMessage) {
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
        'http.response.status_code': error.status,
        'cloud.role': this.options.policy.role,
        'cloud.profile': this.options.policy.profileName,
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

      // The DEFAULT route (and /app below) both serve the UNIFIED RENDERER browser
      // build (packages/app/dist-browser) — the one-UI-codebase cutover, so the cloud
      // URL itself runs the same renderer as the Electron app. The bespoke website is
      // gone; the renderer is the only UI the cloud serves. Both routes use the
      // relaxed-but-script-strict CSP (writeBrowserRendererHtml) because the SPA injects
      // its surface stylesheet via a runtime-created <style> element.
      if ((url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app' || url.pathname === '/app/') && req.method === 'GET') {
        // SEC-2: only a size-enforced upload capability with a currently attested
        // cleanup owner contributes a cross-origin target or asks the browser to
        // allocate/hash direct-upload bytes.
        const objectStoreOrigin = this.options.artifacts
          ? await this.options.artifacts.presignedUploadOrigin()
          : null
        // Minimal public bootstrap: the shim derives the same-origin endpoint
        // base from window.location and reads the CSRF token from /auth/me.
        const html = browserRendererHtml({
          // Public bootstrap contract: expose only whether the SPA must present
          // sign-in, never cookie secrets, provider configuration, or tenant data.
          authRequired: Boolean(this.options.sessionCookies && this.options.browserAuth),
          sessionEventTypes: [...CLOUD_SESSION_EVENT_TYPES],
          artifactDirectUpload: objectStoreOrigin !== null,
        })
        if (html === null) {
          writeError(res, 404, 'Unified renderer browser build was not found.', requestOptions.corsOrigin)
          return
        }
        writeBrowserRendererHtml(res, 200, html, requestOptions.corsOrigin, objectStoreOrigin)
        return
      }

      // The sandboxed Vega chart iframe document (embedded by the SPA's VegaChart).
      // Served with a chart-frame-specific CSP (vega needs 'unsafe-eval') and
      // X-Frame-Options SAMEORIGIN so the same-origin SPA can embed it.
      if (req.method === 'GET' && isBrowserRendererChartFramePath(url.pathname)) {
        const html = browserRendererChartFrameHtml()
        if (html === null) {
          writeError(res, 404, 'Unified renderer chart frame was not found.', requestOptions.corsOrigin)
          return
        }
        writeBrowserRendererChartFrameHtml(res, 200, html, requestOptions.corsOrigin)
        return
      }

      if (req.method === 'GET' && isBrowserRendererAssetPath(url.pathname)) {
        const asset = getBrowserRendererAsset(url.pathname)
        if (asset) {
          // The sandboxed chart iframe has an OPAQUE origin (sandbox without
          // allow-same-origin), and ES module subresources are always fetched in CORS
          // mode, so it loads its hashed /app/assets chunks with `Origin: null`. These
          // are public, immutable, non-credentialed bundle files, so serve them with a
          // wildcard ACAO; the main SPA loads the identical files same-origin.
          res.setHeader('Access-Control-Allow-Origin', '*')
          writeBinary(res, asset.body, asset.contentType, BROWSER_RENDERER_ASSET_CACHE_CONTROL)
          return
        }
        writeError(res, 404, 'Unified renderer asset was not found.', requestOptions.corsOrigin)
        return
      }

      if (await handleCloudHealthRoute({
        pathname: url.pathname,
        res,
        corsOrigin: requestOptions.corsOrigin,
        policy: this.options.policy,
        draining: this.draining,
        readiness: this.options.readiness,
        progress: this.options.progress,
      })) return

      if (url.pathname.startsWith('/webhooks/workflows/')) {
        await handleCloudWorkflowWebhook(req, res, requestOptions, url)
        return
      }

      if (url.pathname === '/webhooks/billing') {
        await handleBillingWebhook(req, res, requestOptions)
        return
      }

      // SCIM 2.0 provisioning (#895): mounted top-level (pre-user-auth) because the IdP
      // presents the org's SCIM bearer token, not a user session. The handler owns its
      // own auth (service.domains.scim.authenticate) and renders SCIM error shapes.
      if (url.pathname === '/scim/v2' || url.pathname.startsWith('/scim/v2/')) {
        await this.enforceIpRateLimit(req)
        await handleScimApiRoute({
          req,
          res,
          url,
          service: this.options.service,
          corsOrigin: requestOptions.corsOrigin,
          maxBodyBytes: this.options.maxBodyBytes || 1024 * 1024,
          tools: { readJsonBody },
        })
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
        const membership = await this.options.service.domains.members.acceptMembershipInvite(token)
        writeJson(res, 200, { membership }, requestOptions.corsOrigin)
        return
      }

      if (url.pathname === '/api/knowledge/agent/propose') {
        const knowledgeStore = this.options.knowledgeStore ?? createSqliteKnowledgeStore({ storageDataDir: this.options.knowledgeDataDir })
        await handleKnowledgeAgentProposeRoute({
          req,
          res,
          secret: this.options.knowledgeAgentTokenSecret || '',
          store: knowledgeStore,
          knowledgeEnabled: this.options.policy.features.knowledge,
          runtimeCapabilityPolicy: this.options.runtimeCapabilityPolicy,
          observability: this.options.observability,
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
      const context: CloudHttpRouteContext = {
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
        await this.recordPolicyErrorMetric(error, req)
        writeError(res, error.status, error.publicMessage, requestOptions.corsOrigin, {
          policyCode: error.policyCode,
          retryAfterMs: error.retryAfterMs,
        })
        return
      }
      if (error instanceof CloudServiceError) {
        await this.recordPolicyErrorMetric(error, req)
        writeError(res, error.status, error.publicMessage, requestOptions.corsOrigin, {
          policyCode: error.policyCode,
          retryAfterMs: error.retryAfterMs,
        })
        return
      }
      if (error instanceof CloudByokRuntimeConfigError) {
        // Missing/blocked BYOK is an operator-fixable precondition, not an unexpected 500.
        const status = error.code === 'missing_required_byok' ? 409
          : error.code === 'kms_not_supported' ? 501
            : 403
        writeError(res, status, error.message, requestOptions.corsOrigin, {
          policyCode: `byok.${error.code}`,
        })
        return
      }
      await recordCloudLog(this.options.observability, {
        level: 'error',
        name: 'cloud.http.unexpected_error',
        message: 'Unexpected cloud HTTP request failure.',
        attributes: {
          request_id: requestId,
          'http.request.method': req.method || 'GET',
          'url.path': templateCloudHttpPath(url.pathname),
          'cloud.role': this.options.policy.role,
          'cloud.profile': this.options.policy.profileName,
          error_code: 'unexpected_http_error',
        },
      })
      writeError(res, 500, 'Internal server error.', requestOptions.corsOrigin)
    }
  }
}

export const createCloudHttpServer = (options: CloudHttpServerOptions) => new CloudHttpServer(options)
