import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { createCloudGateway, type CloudGateway } from './cloud-gateway.js'
import { type GatewayConfig, redactGatewayConfig } from './config.js'
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
  const http = createGatewayHttpServer(config, runtime)

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

export function createGatewayHttpServer(config: GatewayConfig, runtime: GatewayRuntime): GatewayHttpServer {
  const server = createServer((req, res) => {
    void handleRequest(config, runtime, req, res).catch((error) => {
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
) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      status: 'ok',
      mode: config.mode,
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const ready = runtime.ready()
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      status: ready ? 'ready' : 'not_ready',
      providers: providerStatus(runtime),
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/metrics') {
    if (!config.metrics.enabled) {
      writeJson(res, 404, { ok: false, error: 'Metrics are disabled.' })
      return
    }
    const body = renderPrometheusMetrics(runtime.metrics, runtime.providers.registrations.length)
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(body)
    return
  }

  if (req.method === 'GET' && url.pathname === '/diagnostics') {
    if (!config.diagnostics.enabled) {
      writeJson(res, 404, { ok: false, error: 'Diagnostics are disabled.' })
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

  const webhookMatch = /^\/webhooks\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'POST' && webhookMatch) {
    const payload = await readJsonBody(req)
    await runtime.providers.handleWebhook(decodeURIComponent(webhookMatch[1]), payload, req.headers)
    writeJson(res, 202, { ok: true })
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
  }))
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('Request body is too large.')
  }
  return raw ? JSON.parse(raw) as unknown : {}
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
