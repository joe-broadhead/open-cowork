import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import { createCloudGateway, type CloudGateway } from './cloud-gateway.js'
import { type GatewayConfig, redactGatewayConfig, redactGatewayDiagnosticText } from './config.js'
import { createGatewayRuntime, type GatewayRuntime } from './gateway-runtime.js'
import { renderPrometheusMetrics } from './metrics.js'

export type GatewayHttpServer = {
  server: Server
  listen(): Promise<string>
  close(): Promise<void>
}

export type GatewayDaemon = {
  config: GatewayConfig
  runtime: GatewayRuntime
  http: GatewayHttpServer
  start(): Promise<string>
  stop(): Promise<void>
}

export function createGatewayDaemon(config: GatewayConfig, cloud: CloudGateway = createCloudGateway(config)): GatewayDaemon {
  const runtime = createGatewayRuntime(config, cloud)
  const http = createGatewayHttpServer(config, runtime, cloud)

  return {
    config,
    runtime,
    http,
    async start() {
      await runtime.start()
      return http.listen()
    },
    async stop() {
      await http.close()
      await runtime.stop()
    },
  }
}

export function createGatewayHttpServer(config: GatewayConfig, runtime: GatewayRuntime, cloud?: CloudGateway): GatewayHttpServer {
  const server = createServer((req, res) => {
    void handleRequest(config, runtime, req, res, cloud).catch((error) => {
      runtime.metrics.errors += 1
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.server.port, config.server.host, () => {
          server.off('error', reject)
          const address = server.address()
          const port = typeof address === 'object' && address ? address.port : config.server.port
          resolve(`http://${config.server.host}:${port}`)
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

async function handleRequest(
  config: GatewayConfig,
  runtime: GatewayRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  cloud?: CloudGateway,
) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      status: 'ok',
      mode: config.mode,
      branding: config.branding,
      cloudBaseUrl: config.cloud.baseUrl,
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const ready = runtime.ready()
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      branding: config.branding,
      cloudBaseUrl: config.cloud.baseUrl,
      providers: providerStatus(runtime),
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/metrics') {
    if (!config.metrics.enabled) {
      writeJson(res, 404, { ok: false, error: 'Metrics are disabled.' })
      return
    }
    if (!isAdminRequest(config, req)) {
      writeJson(res, 401, { ok: false, error: 'Gateway admin authorization is required.' })
      return
    }
    const body = renderPrometheusMetrics(runtime.metrics, runtime.providers.registrations.length, runtime.streams.activeCount())
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(body)
    return
  }

  if (req.method === 'GET' && url.pathname === '/diagnostics') {
    if (!config.diagnostics.enabled) {
      writeJson(res, 404, { ok: false, error: 'Diagnostics are disabled.' })
      return
    }
    if (!isAdminRequest(config, req)) {
      writeJson(res, 401, { ok: false, error: 'Gateway admin authorization is required.' })
      return
    }
    writeJson(res, 200, {
      ok: true,
      config: redactGatewayConfig(config),
      ready: runtime.ready(),
      providers: providerStatus(runtime),
      metrics: runtime.metrics,
    })
    return
  }

  if (url.pathname === '/deliveries' && req.method === 'GET') {
    if (!isAdminRequest(config, req)) {
      writeJson(res, 401, { ok: false, error: 'Gateway admin authorization is required.' })
      return
    }
    if (!cloud?.listDeliveries) {
      writeJson(res, 503, { ok: false, error: 'Cloud delivery listing is not available.' })
      return
    }
    const deliveries = await cloud.listDeliveries({
      status: readDeliveryStatus(url.searchParams.get('status')),
      channelBindingId: url.searchParams.get('channelBindingId'),
      limit: readLimit(url.searchParams.get('limit'), 50),
    })
    writeJson(res, 200, { ok: true, deliveries })
    return
  }

  const deliveryActionMatch = /^\/deliveries\/([^/]+)\/(retry|dead-letter)$/.exec(url.pathname)
  if (deliveryActionMatch && req.method === 'POST') {
    if (!isAdminRequest(config, req)) {
      writeJson(res, 401, { ok: false, error: 'Gateway admin authorization is required.' })
      return
    }
    const deliveryId = decodeURIComponent(deliveryActionMatch[1] || '')
    const action = deliveryActionMatch[2]
    if (action === 'retry') {
      if (!cloud?.retryDelivery) {
        writeJson(res, 503, { ok: false, error: 'Cloud delivery retry is not available.' })
        return
      }
      const delivery = await cloud.retryDelivery(deliveryId)
      writeJson(res, delivery ? 200 : 404, delivery ? { ok: true, delivery } : { ok: false, error: 'Delivery not found.' })
      return
    }
    if (!cloud?.deadLetterDelivery) {
      writeJson(res, 503, { ok: false, error: 'Cloud delivery dead-letter is not available.' })
      return
    }
    const body = await readRequestBody(req)
    const payload = parseRequestBody(body.raw, req.headers['content-type'])
    const lastError = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? stringField((payload as Record<string, unknown>).lastError)
      : null
    const delivery = await cloud.deadLetterDelivery(deliveryId, { lastError })
    writeJson(res, delivery ? 200 : 404, delivery ? { ok: true, delivery } : { ok: false, error: 'Delivery not found.' })
    return
  }

  const webhookMatch = /^\/webhooks\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'POST' && webhookMatch) {
    runtime.metrics.webhookRequests += 1
    const body = await readRequestBody(req)
    const payload = parseRequestBody(body.raw, req.headers['content-type'])
    const result = await runtime.providers.handleWebhook(decodeURIComponent(webhookMatch[1]), payload, req.headers, body.raw)
    writeJson(res, result?.challenge ? 200 : 202, result?.challenge ? { challenge: result.challenge } : { ok: true })
    return
  }

  writeJson(res, 404, { ok: false, error: 'Not found.' })
}

function providerStatus(runtime: GatewayRuntime) {
  return runtime.providers.registrations.map((registration) => ({
    id: registration.config.id,
    kind: registration.config.kind,
    provider: registration.provider.id,
    started: registration.started,
    healthy: registration.healthy,
    error: registration.lastError ? redactGatewayDiagnosticText(registration.lastError) : null,
  }))
}

function isAdminRequest(config: GatewayConfig, req: IncomingMessage) {
  if (!config.server.adminToken) return isLoopbackHost(config.server.host)
  const bearer = readBearer(req.headers.authorization)
  const header = firstHeader(req.headers['x-open-cowork-gateway-admin-token'])
  return constantTimeStringEqual(bearer || header, config.server.adminToken)
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || ''
}

function readBearer(value: string | string[] | undefined) {
  const raw = firstHeader(value).trim()
  return raw.toLowerCase().startsWith('bearer ') ? raw.slice('bearer '.length).trim() : ''
}

function isLoopbackHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

function constantTimeStringEqual(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function readRequestBody(req: IncomingMessage, maxBytes = 1024 * 1024) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Request body is too large.')
  }
  return { raw }
}

function parseRequestBody(raw: string, contentType: string | string[] | undefined) {
  if (!raw) return {}
  const type = firstHeader(contentType).toLowerCase()
  if (type.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw)
    const payload = params.get('payload')
    if (payload) return JSON.parse(payload) as unknown
    return Object.fromEntries(params.entries())
  }
  return JSON.parse(raw) as unknown
}

function readDeliveryStatus(value: string | null) {
  return value === 'pending'
    || value === 'claimed'
    || value === 'sent'
    || value === 'failed'
    || value === 'dead'
    ? value
    : null
}

function readLimit(value: string | null, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(200, parsed) : fallback
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
