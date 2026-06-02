import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'

const scriptPath = 'scripts/smoke-deployment.mjs'

function runSmoke(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  })
}

async function runSmokeAsync(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const [status] = await once(child, 'close') as [number]
  return { status, stdout, stderr }
}

function requireBearer(request: IncomingMessage, expected: string) {
  assert.equal(request.headers.authorization, `Bearer ${expected}`)
}

function sendJson(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendText(response: ServerResponse, body: string) {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

function sendCloudWorkbench(response: ServerResponse) {
  const nonce = 'strict-smoke-nonce'
  response.writeHead(200, {
    'content-type': 'text/html',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'self'; connect-src 'self'; frame-ancestors 'none'; script-src 'nonce-${nonce}'`,
  })
  response.end(`<!doctype html>
    <meta name="open-cowork-cloud-bootstrap" content="true">
    <div data-route-panel="threads"></div>
    <div data-route-panel="chat"></div>
    <div data-route-panel="byok"></div>
    <script nonce="${nonce}"></script>`)
}

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  callback: (url: string) => void | Promise<void>,
) {
  const server = createServer(handler)
  try {
    const url = await listen(server)
    await callback(url)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
    })
  }
}

test('strict deployment smoke fails closed without operator tokens', () => {
  const result = runSmoke(['--strict'], {
    OPEN_COWORK_SMOKE_CLOUD_URL: 'http://127.0.0.1:1',
    OPEN_COWORK_SMOKE_GATEWAY_URL: 'http://127.0.0.1:2',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Strict deployment smoke requires OPEN_COWORK_SMOKE_CLOUD_TOKEN/)
})

test('operator deployment smoke requires gateway token when gateway is checked', () => {
  const result = runSmoke(['--operator', '--skip-cloud'], {
    OPEN_COWORK_SMOKE_GATEWAY_URL: 'http://127.0.0.1:2',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Operator deployment smoke requires OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN/)
})

test('strict deployment smoke rejects non-loopback HTTP before sending tokens', () => {
  const result = runSmoke(['--strict'], {
    OPEN_COWORK_SMOKE_CLOUD_URL: 'http://cowork.example.com',
    OPEN_COWORK_SMOKE_GATEWAY_URL: 'https://gateway.example.com',
    OPEN_COWORK_SMOKE_CLOUD_TOKEN: 'cloud-token',
    OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN: 'gateway-token',
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cloud URL must use HTTPS unless it points at loopback/)
})

test('strict deployment smoke checks authenticated cloud and gateway operator endpoints', async () => {
  const cloudToken = 'cloud-smoke-token'
  const gatewayToken = 'gateway-smoke-token'
  const requested = new Set<string>()

  await withServer((request, response) => {
    requested.add(`cloud:${request.url}`)
    switch (request.url) {
      case '/healthz':
      case '/livez':
        sendJson(response, { ok: true })
        return
      case '/':
        sendCloudWorkbench(response)
        return
      case '/api/config':
      case '/api/workspace':
      case '/api/runtime/status':
      case '/api/workers/heartbeats':
        requireBearer(request, cloudToken)
        sendJson(response, { ok: true })
        return
      case '/api/metrics':
        requireBearer(request, cloudToken)
        sendText(response, 'open_cowork_cloud_http_requests_total 1\n')
        return
      default:
        response.writeHead(404)
        response.end()
    }
  }, async (cloudUrl) => {
    await withServer((request, response) => {
      requested.add(`gateway:${request.url}`)
      switch (request.url) {
        case '/health':
        case '/ready':
          sendJson(response, { ok: true })
          return
        case '/metrics':
          requireBearer(request, gatewayToken)
          sendText(response, 'open_cowork_gateway_providers 1\n')
          return
        default:
          response.writeHead(404)
          response.end()
      }
    }, async (gatewayUrl) => {
      const result = await runSmokeAsync(['--strict'], {
        OPEN_COWORK_SMOKE_CLOUD_URL: cloudUrl,
        OPEN_COWORK_SMOKE_GATEWAY_URL: gatewayUrl,
        OPEN_COWORK_SMOKE_CLOUD_TOKEN: cloudToken,
        OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN: gatewayToken,
      })

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      const body = JSON.parse(result.stdout) as {
        ok: boolean
        strict: boolean
        results: Array<{ check: string }>
      }
      assert.equal(body.ok, true)
      assert.equal(body.strict, true)
      assert.deepEqual(body.results.map((entry) => entry.check), [
        'cloud health',
        'cloud liveness',
        'cloud web workbench',
        'cloud web api config bootstrap',
        'cloud web api workspace bootstrap',
        'cloud runtime status',
        'cloud worker heartbeats',
        'cloud metrics',
        'gateway health',
        'gateway readiness',
        'gateway metrics',
      ])
    })
  })

  assert.ok(requested.has('cloud:/api/runtime/status'))
  assert.ok(requested.has('cloud:/api/workers/heartbeats'))
  assert.ok(requested.has('gateway:/metrics'))
})
