import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { log } from '../logger.ts'

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

type WebhookRateRecord = {
  windowStartedAt: number
  count: number
}

type WebhookAuthFailureRecord = {
  authWindowStartedAt: number
  authFailureCount: number
  blockedUntil: number
}

type SeenWebhookSignature = {
  seenAt: number
  status: 'pending' | 'accepted'
}

export type WorkflowWebhookReplayClaim = {
  accept: () => void
  release: () => void
}

const webhookRateBySource = new Map<string, WebhookRateRecord>()
const webhookAuthFailureByScope = new Map<string, WebhookAuthFailureRecord>()
const seenWebhookSignatures = new Map<string, SeenWebhookSignature>()

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

function clearWebhookSecurityState() {
  webhookRateBySource.clear()
  webhookAuthFailureByScope.clear()
  seenWebhookSignatures.clear()
}

export function resetWorkflowWebhookSecurityStateForTests() {
  clearWebhookSecurityState()
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

function rateRecordForSource(source: string, nowMs: number) {
  const existing = webhookRateBySource.get(source)
  if (existing) return existing
  const record: WebhookRateRecord = {
    windowStartedAt: nowMs,
    count: 0,
  }
  webhookRateBySource.set(source, record)
  return record
}

function authFailureRecordForScope(scope: string, nowMs: number) {
  const existing = webhookAuthFailureByScope.get(scope)
  if (existing) return existing
  const record: WebhookAuthFailureRecord = {
    authWindowStartedAt: nowMs,
    authFailureCount: 0,
    blockedUntil: 0,
  }
  webhookAuthFailureByScope.set(scope, record)
  return record
}

function pruneWebhookRateRecords(nowMs: number) {
  for (const [source, record] of webhookRateBySource) {
    if (nowMs - record.windowStartedAt > WEBHOOK_REQUEST_WINDOW_MS) {
      webhookRateBySource.delete(source)
    }
  }
  for (const [scope, record] of webhookAuthFailureByScope) {
    const authWindowExpired = nowMs - record.authWindowStartedAt > WEBHOOK_AUTH_FAILURE_WINDOW_MS
    if (authWindowExpired && record.blockedUntil <= nowMs) webhookAuthFailureByScope.delete(scope)
  }
}

function enforceWebhookRequestRateLimit(source: string, nowMs: number) {
  pruneWebhookRateRecords(nowMs)
  const record = rateRecordForSource(source, nowMs)
  if (nowMs - record.windowStartedAt > WEBHOOK_REQUEST_WINDOW_MS) {
    record.windowStartedAt = nowMs
    record.count = 0
  }
  record.count += 1
  if (record.count > WEBHOOK_REQUEST_LIMIT) {
    log('warn', `Workflow webhook rate limit exceeded for source ${source}.`)
    throw new WebhookHttpError(429, 'Too many workflow webhook requests. Try again later.')
  }
}

function enforceWebhookAuthBackoff(scope: string, nowMs: number) {
  pruneWebhookRateRecords(nowMs)
  const record = authFailureRecordForScope(scope, nowMs)
  if (record.blockedUntil > nowMs) {
    throw new WebhookHttpError(429, 'Too many rejected workflow webhook requests. Try again later.')
  }
}

function recordWebhookAuthFailure(scope: string, source: string, nowMs: number) {
  const record = authFailureRecordForScope(scope, nowMs)
  if (nowMs - record.authWindowStartedAt > WEBHOOK_AUTH_FAILURE_WINDOW_MS) {
    record.authWindowStartedAt = nowMs
    record.authFailureCount = 0
  }
  record.authFailureCount += 1
  log('warn', `Workflow webhook rejected unauthorized request from source ${source}; scope=${scope}; failures=${record.authFailureCount}.`)
  if (record.authFailureCount >= WEBHOOK_AUTH_FAILURE_LIMIT) {
    record.blockedUntil = Math.max(record.blockedUntil, nowMs + WEBHOOK_AUTH_BACKOFF_MS)
  }
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

function pruneSeenWebhookSignatures(nowMs: number) {
  for (const [key, seen] of seenWebhookSignatures) {
    if (nowMs - seen.seenAt > WEBHOOK_SIGNATURE_REPLAY_WINDOW_MS) seenWebhookSignatures.delete(key)
  }
  while (seenWebhookSignatures.size > WEBHOOK_SIGNATURE_REPLAY_CACHE_LIMIT) {
    const oldest = seenWebhookSignatures.keys().next().value as string | undefined
    if (!oldest) break
    seenWebhookSignatures.delete(oldest)
  }
}

function signatureReplayKey(auth: Extract<WorkflowWebhookAuth, { kind: 'signature' }>, workflowId: string) {
  return `${workflowScopeKey(workflowId)}:${auth.timestamp}:${auth.signature}`
}

export function claimWorkflowWebhookSignatureOnce(
  auth: WorkflowWebhookAuth,
  workflowId: string,
  now = new Date(),
): WorkflowWebhookReplayClaim | null {
  if (auth.kind !== 'signature') {
    return {
      accept: () => {},
      release: () => {},
    }
  }
  const nowMs = now.getTime()
  pruneSeenWebhookSignatures(nowMs)
  const key = signatureReplayKey(auth, workflowId)
  if (seenWebhookSignatures.has(key)) return null
  seenWebhookSignatures.set(key, { seenAt: nowMs, status: 'pending' })
  let active = true
  return {
    accept: () => {
      if (!active) return
      active = false
      seenWebhookSignatures.set(key, { seenAt: nowMs, status: 'accepted' })
    },
    release: () => {
      if (!active) return
      active = false
      const current = seenWebhookSignatures.get(key)
      if (current?.status === 'pending') seenWebhookSignatures.delete(key)
    },
  }
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
    enforceWebhookRequestRateLimit(source, startedAt)
    enforceWebhookAuthBackoff(authScope, startedAt)
    const { payload, rawBody } = await readJsonBody(req)
    await triggerHandler({
      workflowId,
      auth: extractWorkflowWebhookAuth(req, rawBody),
      payload,
    })
    writeJson(res, 202, { ok: true })
  } catch (error) {
    const status = error instanceof WebhookHttpError ? error.status : 400
    const message = error instanceof WebhookHttpError ? error.publicMessage : 'Workflow webhook request failed.'
    if (status === 401) recordWebhookAuthFailure(authScope, source, Date.now())
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

export function configureWorkflowWebhookServer(handler: typeof triggerHandler) {
  triggerHandler = handler
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
  clearWebhookSecurityState()
  if (current) current.close()
}
