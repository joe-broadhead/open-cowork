import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { log } from './logger.ts'

const DEFAULT_WEBHOOK_PORT = 47839
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

let server: Server | null = null
let baseUrl: string | null = null
let triggerHandler: ((input: {
  workflowId: string
  auth: WorkflowWebhookAuth
  payload: Record<string, unknown>
}) => Promise<void>) | null = null

export type WorkflowWebhookAuth =
  | { kind: 'secret'; secret: string }
  | { kind: 'signature'; timestamp: string; signature: string; rawBody: string }

class WebhookHttpError extends Error {
  readonly status: number
  readonly publicMessage: string

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.publicMessage = message
  }
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

async function handleWebhookRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'Method not allowed.' })
    return
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const match = url.pathname.match(/^\/workflows\/([^/]+)$/)
  if (!match) {
    writeJson(res, 404, { ok: false, error: 'Webhook not found.' })
    return
  }
  if (!triggerHandler) {
    writeJson(res, 503, { ok: false, error: 'Workflow webhook handler is not ready.' })
    return
  }
  try {
    const { payload, rawBody } = await readJsonBody(req)
    await triggerHandler({
      workflowId: decodeURIComponent(match[1] || ''),
      auth: extractWorkflowWebhookAuth(req, rawBody),
      payload,
    })
    writeJson(res, 202, { ok: true })
  } catch (error) {
    const status = error instanceof WebhookHttpError ? error.status : 400
    const message = error instanceof WebhookHttpError ? error.publicMessage : 'Workflow webhook request failed.'
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
    next.listen(port, '127.0.0.1', () => {
      next.off('error', reject)
      resolve()
    })
  })
  server = next
  const address = next.address()
  const resolvedPort = typeof address === 'object' && address ? address.port : port
  baseUrl = `http://127.0.0.1:${resolvedPort}`
  log('workflow', `Workflow webhook server listening on ${baseUrl}`)
}

export function configureWorkflowWebhookServer(handler: typeof triggerHandler) {
  triggerHandler = handler
}

export async function ensureWorkflowWebhookServer() {
  if (server && baseUrl) return baseUrl
  try {
    await listenOn(DEFAULT_WEBHOOK_PORT)
  } catch {
    await listenOn(0)
  }
  return baseUrl!
}

export function getWorkflowWebhookBaseUrl() {
  return baseUrl
}

export function stopWorkflowWebhookServer() {
  const current = server
  server = null
  baseUrl = null
  if (current) current.close()
}
