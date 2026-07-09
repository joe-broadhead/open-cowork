/// <reference types="node" />
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { log } from './logger.js'

const DEFAULT_WEBHOOK_PORT = 47839
const WORKFLOW_WEBHOOK_BIND_HOST = '127.0.0.1'
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024
const WEBHOOK_REQUEST_WINDOW_MS = 60 * 1000
const WEBHOOK_REQUEST_LIMIT = 120
const WEBHOOK_AUTH_FAILURE_WINDOW_MS = 60 * 1000
const WEBHOOK_AUTH_FAILURE_LIMIT = 5
const WEBHOOK_AUTH_BACKOFF_MS = 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS = 5 * 60 * 1000
const WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT = 512

let server: Server | null = null
let baseUrl: string | null = null
let serverStartPromise: Promise<string> | null = null
let triggerHandler: ((input: {
  workflowId: string
  auth: WorkflowWebhookAuth
  payload: Record<string, unknown>
}) => Promise<void>) | null = null

export type WebhookRateRecord = {
  windowStartedAt: number
  count: number
}

export type WebhookAuthFailureRecord = {
  authWindowStartedAt: number
  authFailureCount: number
  blockedUntil: number
}

type SeenWebhookSignature = {
  seenAt: number
  status: 'pending' | 'accepted'
}

export type WorkflowWebhookReplayClaim = {
  accept: () => void | Promise<void>
  release: () => void | Promise<void>
}

export type WorkflowWebhookSecurityStore = {
  clearOnStop?: boolean
  claimRequest(input: {
    source: string
    nowMs: number
    windowMs: number
    limit: number
  }): boolean | Promise<boolean>
  checkAuthBackoff(input: {
    scope: string
    nowMs: number
  }): boolean | Promise<boolean>
  recordAuthFailure(input: {
    scope: string
    source: string
    nowMs: number
    windowMs: number
    limit: number
    backoffMs: number
  }): WebhookAuthFailureRecord | Promise<WebhookAuthFailureRecord>
  claimSignature(input: {
    key: string
    nowMs: number
    windowMs: number
    cacheLimit: number
  }): WorkflowWebhookReplayClaim | null | Promise<WorkflowWebhookReplayClaim | null>
  clear(): void | Promise<void>
}

export type WorkflowWebhookAuth =
  | { kind: 'secret'; secret: string }
  | { kind: 'signature'; timestamp: string; signature: string; rawBody: string }

export function isWorkflowWebhookLoopbackBindAddress(address: string) {
  return address === WORKFLOW_WEBHOOK_BIND_HOST || address === `::ffff:${WORKFLOW_WEBHOOK_BIND_HOST}`
}

export class WebhookHttpError extends Error {
  readonly status: number
  readonly publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.publicMessage = message
  }
}

export class InMemoryWorkflowWebhookSecurityStore implements WorkflowWebhookSecurityStore {
  private readonly rateBySource = new Map<string, WebhookRateRecord>()
  private readonly authFailureByScope = new Map<string, WebhookAuthFailureRecord>()
  private readonly seenSignatures = new Map<string, SeenWebhookSignature>()

  claimRequest(input: {
    source: string
    nowMs: number
    windowMs: number
    limit: number
  }) {
    this.pruneRateRecords(input.nowMs, input.windowMs)
    const record = this.rateRecordForSource(input.source, input.nowMs)
    if (input.nowMs - record.windowStartedAt > input.windowMs) {
      record.windowStartedAt = input.nowMs
      record.count = 0
    }
    record.count += 1
    return record.count <= input.limit
  }

  checkAuthBackoff(input: { scope: string, nowMs: number }) {
    this.pruneRateRecords(input.nowMs, WEBHOOK_AUTH_FAILURE_WINDOW_MS)
    const record = this.authFailureRecordForScope(input.scope, input.nowMs)
    return record.blockedUntil <= input.nowMs
  }

  recordAuthFailure(input: {
    scope: string
    source: string
    nowMs: number
    windowMs: number
    limit: number
    backoffMs: number
  }) {
    const record = this.authFailureRecordForScope(input.scope, input.nowMs)
    if (input.nowMs - record.authWindowStartedAt > input.windowMs) {
      record.authWindowStartedAt = input.nowMs
      record.authFailureCount = 0
    }
    record.authFailureCount += 1
    if (record.authFailureCount >= input.limit) {
      record.blockedUntil = Math.max(record.blockedUntil, input.nowMs + input.backoffMs)
    }
    return { ...record }
  }

  claimSignature(input: {
    key: string
    nowMs: number
    windowMs: number
    cacheLimit: number
  }) {
    this.pruneSeenSignatures(input.nowMs, input.windowMs, input.cacheLimit)
    if (this.seenSignatures.has(input.key)) return null
    this.seenSignatures.set(input.key, { seenAt: input.nowMs, status: 'pending' })
    let active = true
    return {
      accept: () => {
        if (!active) return
        active = false
        this.seenSignatures.set(input.key, { seenAt: input.nowMs, status: 'accepted' })
      },
      release: () => {
        if (!active) return
        active = false
        const current = this.seenSignatures.get(input.key)
        if (current?.status === 'pending') this.seenSignatures.delete(input.key)
      },
    }
  }

  clear() {
    this.rateBySource.clear()
    this.authFailureByScope.clear()
    this.seenSignatures.clear()
  }

  private rateRecordForSource(source: string, nowMs: number) {
    const existing = this.rateBySource.get(source)
    if (existing) return existing
    const record: WebhookRateRecord = {
      windowStartedAt: nowMs,
      count: 0,
    }
    this.rateBySource.set(source, record)
    return record
  }

  private authFailureRecordForScope(scope: string, nowMs: number) {
    const existing = this.authFailureByScope.get(scope)
    if (existing) return existing
    const record: WebhookAuthFailureRecord = {
      authWindowStartedAt: nowMs,
      authFailureCount: 0,
      blockedUntil: 0,
    }
    this.authFailureByScope.set(scope, record)
    return record
  }

  private pruneRateRecords(nowMs: number, authWindowMs: number) {
    for (const [source, record] of this.rateBySource) {
      if (nowMs - record.windowStartedAt > WEBHOOK_REQUEST_WINDOW_MS) {
        this.rateBySource.delete(source)
      }
    }
    for (const [scope, record] of this.authFailureByScope) {
      const authWindowExpired = nowMs - record.authWindowStartedAt > authWindowMs
      if (authWindowExpired && record.blockedUntil <= nowMs) this.authFailureByScope.delete(scope)
    }
  }

  private pruneSeenSignatures(nowMs: number, windowMs: number, cacheLimit: number) {
    for (const [key, seen] of this.seenSignatures) {
      if (nowMs - seen.seenAt > windowMs) this.seenSignatures.delete(key)
    }
    while (this.seenSignatures.size > cacheLimit) {
      const oldest = this.seenSignatures.keys().next().value as string | undefined
      if (!oldest) break
      this.seenSignatures.delete(oldest)
    }
  }
}

let webhookSecurityStore: WorkflowWebhookSecurityStore = new InMemoryWorkflowWebhookSecurityStore()
let requireSignatureAuth = false

export async function resetWorkflowWebhookSecurityStateForTests() {
  await webhookSecurityStore.clear()
  webhookSecurityStore = new InMemoryWorkflowWebhookSecurityStore()
  requireSignatureAuth = false
}

export function setWorkflowWebhookSecurityStoreForTests(store: WorkflowWebhookSecurityStore) {
  webhookSecurityStore = store
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_WEBHOOK_BODY_BYTES) throw new WebhookHttpError(413, 'Webhook payload is too large.')
    chunks.push(buffer)
  }
  const rawBody = Buffer.concat(chunks).toString('utf8')
  if (chunks.length === 0) return { payload: {}, rawBody }
  const contentType = String(req.headers['content-type'] || '')
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new WebhookHttpError(400, 'Webhook payload must be JSON.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody) as unknown
  } catch {
    throw new WebhookHttpError(400, 'Webhook payload must be valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookHttpError(400, 'Webhook payload must be a JSON object.')
  }
  return { payload: parsed as Record<string, unknown>, rawBody }
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function bearerTokenFromAuthorization(value: string) {
  const trimmed = value.trim()
  const prefix = 'bearer '
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : ''
}

function extractWorkflowWebhookAuth(req: IncomingMessage, rawBody: string): WorkflowWebhookAuth {
  const bearer = bearerTokenFromAuthorization(firstHeader(req.headers.authorization))
  if (bearer) return { kind: 'secret', secret: bearer }

  const headerSecret = firstHeader(req.headers['x-open-cowork-webhook-secret']).trim()
  if (headerSecret) return { kind: 'secret', secret: headerSecret }

  const timestamp = firstHeader(req.headers['x-open-cowork-timestamp']).trim()
  const signature = firstHeader(req.headers['x-open-cowork-signature']).trim()
  if (timestamp && signature) return { kind: 'signature', timestamp, signature, rawBody }

  throw new WebhookHttpError(401, 'Workflow webhook authorization is required.')
}

function webhookSource(req: IncomingMessage) {
  return req.socket.remoteAddress || 'unknown'
}

function workflowScopeKey(workflowId: string) {
  return createHash('sha256').update(workflowId || 'unknown-workflow').digest('hex').slice(0, 16)
}

function webhookAuthScope(source: string, workflowId: string) {
  const workflowKey = workflowScopeKey(workflowId)
  return `${source}:${workflowKey}`
}

async function enforceWebhookRequestRateLimit(source: string, nowMs: number) {
  const accepted = await webhookSecurityStore.claimRequest({
    source,
    nowMs,
    windowMs: WEBHOOK_REQUEST_WINDOW_MS,
    limit: WEBHOOK_REQUEST_LIMIT,
  })
  if (!accepted) {
    log('warn', `Workflow webhook rate limit exceeded for source ${source}.`)
    throw new WebhookHttpError(429, 'Too many workflow webhook requests. Try again later.')
  }
}

async function enforceWebhookAuthBackoff(scope: string, nowMs: number) {
  const accepted = await webhookSecurityStore.checkAuthBackoff({
    scope,
    nowMs,
  })
  if (!accepted) {
    throw new WebhookHttpError(429, 'Too many rejected workflow webhook requests. Try again later.')
  }
}

async function recordWebhookAuthFailure(scope: string, source: string, nowMs: number) {
  const record = await webhookSecurityStore.recordAuthFailure({
    scope,
    source,
    nowMs,
    windowMs: WEBHOOK_AUTH_FAILURE_WINDOW_MS,
    limit: WEBHOOK_AUTH_FAILURE_LIMIT,
    backoffMs: WEBHOOK_AUTH_BACKOFF_MS,
  })
  log('warn', `Workflow webhook rejected unauthorized request from source ${source}; scope=${scope}; failures=${record.authFailureCount}.`)
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function signWorkflowWebhookPayload(secret: string, rawBody: string, timestamp: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

export function verifyWorkflowWebhookAuth(
  auth: WorkflowWebhookAuth,
  secret: string,
  now = new Date(),
) {
  if (!secret) return false
  if (auth.kind === 'secret') return safeEqual(auth.secret, secret)

  const timestampMs = Date.parse(auth.timestamp)
  if (!Number.isFinite(timestampMs)) return false
  const ageMs = Math.abs(now.getTime() - timestampMs)
  if (ageMs > 5 * 60 * 1000) return false

  const expected = signWorkflowWebhookPayload(secret, auth.rawBody, auth.timestamp)
  return safeEqual(auth.signature, expected)
}

function signatureReplayKey(auth: Extract<WorkflowWebhookAuth, { kind: 'signature' }>, workflowId: string) {
  return `${workflowScopeKey(workflowId)}:${auth.timestamp}:${auth.signature}`
}

export function claimWorkflowWebhookSignatureOnce(
  auth: WorkflowWebhookAuth,
  workflowId: string,
  now = new Date(),
): WorkflowWebhookReplayClaim | null | Promise<WorkflowWebhookReplayClaim | null> {
  if (auth.kind !== 'signature') {
    return {
      accept: () => {},
      release: () => {},
    }
  }
  const nowMs = now.getTime()
  const key = signatureReplayKey(auth, workflowId)
  return webhookSecurityStore.claimSignature({
    key,
    nowMs,
    windowMs: WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS,
    cacheLimit: WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT,
  })
}

async function handleWebhookRequest(req: IncomingMessage, res: ServerResponse) {
  const source = webhookSource(req)
  const startedAt = Date.now()
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed.' })
    return
  }
  const url = new URL(req.url || '/', `http://${WORKFLOW_WEBHOOK_BIND_HOST}`)
  const match = url.pathname.match(/^\/workflows\/([^/]+)$/)
  if (!match) {
    writeJson(res, 404, { ok: false, error: 'Webhook not found.' })
    return
  }
  if (!triggerHandler) {
    writeJson(res, 503, { ok: false, error: 'Workflow webhook handler is not ready.' })
    return
  }
  const encodedWorkflowId = match[1] || ''
  let authScope = webhookAuthScope(source, encodedWorkflowId)
  try {
    const workflowId = decodeURIComponent(encodedWorkflowId)
    authScope = webhookAuthScope(source, workflowId)
    await enforceWebhookRequestRateLimit(source, startedAt)
    await enforceWebhookAuthBackoff(authScope, startedAt)
    const { payload, rawBody } = await readJsonBody(req)
    const auth = extractWorkflowWebhookAuth(req, rawBody)
    if (requireSignatureAuth && auth.kind !== 'signature') {
      throw new WebhookHttpError(401, 'Workflow webhook signature authorization is required.')
    }
    await triggerHandler({
      workflowId,
      auth,
      payload,
    })
    writeJson(res, 202, { ok: true })
  } catch (error) {
    const status = error instanceof WebhookHttpError ? error.status : 400
    const message = error instanceof WebhookHttpError ? error.publicMessage : 'Workflow webhook request failed.'
    if (status === 401) await recordWebhookAuthFailure(authScope, source, Date.now())
    if (!(error instanceof WebhookHttpError)) {
      log('error', `Workflow webhook request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    writeJson(res, status, { ok: false, error: message })
  }
}

async function listenOn(port: number) {
  const next = createServer((req, res) => {
    void handleWebhookRequest(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(port, WORKFLOW_WEBHOOK_BIND_HOST, () => {
      next.off('error', reject)
      resolve()
    })
  })
  server = next
  const address = next.address()
  const resolvedHost = typeof address === 'object' && address ? address.address : WORKFLOW_WEBHOOK_BIND_HOST
  if (!isWorkflowWebhookLoopbackBindAddress(resolvedHost)) {
    next.close()
    server = null
    throw new Error(`Workflow webhook server must bind to ${WORKFLOW_WEBHOOK_BIND_HOST}; got ${resolvedHost}`)
  }
  const resolvedPort = typeof address === 'object' && address ? address.port : port
  baseUrl = `http://${WORKFLOW_WEBHOOK_BIND_HOST}:${resolvedPort}`
  log('workflow', `Workflow webhook server listening on ${baseUrl}`)
}

export function configureWorkflowWebhookServer(
  handler: typeof triggerHandler,
  options: {
    securityStore?: WorkflowWebhookSecurityStore
    requireSignatureAuth?: boolean
  } = {},
) {
  triggerHandler = handler
  if (options.securityStore) webhookSecurityStore = options.securityStore
  requireSignatureAuth = Boolean(options.requireSignatureAuth)
}

export async function ensureWorkflowWebhookServer() {
  if (server && baseUrl) return baseUrl
  if (serverStartPromise) return serverStartPromise
  serverStartPromise = (async () => {
    try {
      await listenOn(DEFAULT_WEBHOOK_PORT)
    } catch {
      await listenOn(0)
    }
    return baseUrl!
  })().finally(() => {
    serverStartPromise = null
  })
  return serverStartPromise
}

export function getWorkflowWebhookBaseUrl() {
  return baseUrl
}

export function stopWorkflowWebhookServer() {
  const current = server
  serverStartPromise = null
  server = null
  baseUrl = null
  requireSignatureAuth = false
  if (webhookSecurityStore.clearOnStop !== false) void webhookSecurityStore.clear()
  if (current) current.close()
}
