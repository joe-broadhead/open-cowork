import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  assert.ok(address)
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  }
}

test('launch readiness harness produces strict load report against cloud and gateway routes', async () => {
  let sessionCounter = 0
  const cloud = await listen(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/healthz') return writeJson(res, 200, { ok: true })
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end('<!doctype html><title>Open Cowork Cloud</title>')
      return
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      })
      res.write('event: ping\ndata: {"ok":true}\n\n')
      setTimeout(() => res.end(), 40)
      return
    }
    if (url.pathname === '/api/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end([
        'open_cowork_cloud_command_queue_depth_estimate 0',
        'open_cowork_cloud_command_oldest_age_ms 0',
        'open_cowork_cloud_projection_lag_events 0',
        'open_cowork_cloud_sse_connections 1',
        'open_cowork_cloud_quota_rejections_total 0',
        'open_cowork_cloud_worker_stale_owner_rejections_total 0',
      ].join('\n'))
      return
    }
    if (url.pathname === '/api/config') return writeJson(res, 200, { role: 'web', features: {} })
    if (url.pathname === '/api/workspace') return writeJson(res, 200, { tenantId: 'tenant-1', userId: 'user-1' })
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      return writeJson(res, 200, { sessions: [{ sessionId: 'session-existing' }] })
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      await readBody(req)
      sessionCounter += 1
      return writeJson(res, 201, { session: { sessionId: `session-${sessionCounter}` }, projection: null })
    }
    const promptMatch = /^\/api\/sessions\/([^/]+)\/prompt$/.exec(url.pathname)
    if (promptMatch && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 202, {
        command: { commandId: `command-${promptMatch[1]}` },
        processed: 1,
        view: { session: { sessionId: promptMatch[1] }, projection: null },
      })
    }
    const artifactCollectionMatch = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(url.pathname)
    if (artifactCollectionMatch && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 201, { artifact: { id: `artifact-${artifactCollectionMatch[1]}` } })
    }
    const artifactReadMatch = /^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname)
    if (artifactReadMatch && req.method === 'GET') {
      return writeJson(res, 200, { artifact: { id: artifactReadMatch[2], dataBase64: 'b2s=' } })
    }
    if (url.pathname === '/api/workflows' && req.method === 'GET') return writeJson(res, 200, { workflows: [] })
    if (url.pathname === '/api/workflows' && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 201, { workflow: { id: 'workflow-1' } })
    }
    if (url.pathname === '/api/workflows/workflow-1/run' && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 202, { workflow: { id: 'workflow-1' }, run: { id: 'run-1' }, processed: 1 })
    }
    if (url.pathname === '/api/byok') return writeJson(res, 200, { secrets: [] })
    if (url.pathname === '/api/byok/anthropic/validate' && req.method === 'POST') {
      await readBody(req)
      return writeJson(res, 200, { secret: { providerId: 'anthropic', status: 'active' }, validated: true })
    }
    if (url.pathname === '/api/threads') return writeJson(res, 200, { threads: [] })
    if (url.pathname === '/api/threads/tags') return writeJson(res, 200, { tags: [] })
    if (url.pathname === '/api/threads/smart-filters') return writeJson(res, 200, { filters: [] })
    if (url.pathname === '/api/usage/summary') return writeJson(res, 200, { events: [] })
    if (url.pathname === '/api/channels/deliveries') return writeJson(res, 200, { deliveries: [] })
    if (url.pathname === '/api/admin/policy') return writeJson(res, 200, { policy: {} })
    if (url.pathname === '/api/workers/heartbeats') return writeJson(res, 200, { heartbeats: [] })
    if (url.pathname === '/api/runtime/status') return writeJson(res, 200, { role: 'web', canExecute: false })
    return writeJson(res, 404, { error: 'not found' })
  })

  const gateway = await listen((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') return writeJson(res, 200, { ok: true })
    if (url.pathname === '/ready') return writeJson(res, 200, { ok: true, status: 'ready' })
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end([
        'open_cowork_gateway_providers 1',
        'open_cowork_gateway_delivery_retries_total 0',
        'open_cowork_gateway_delivery_dead_letters_total 0',
        'open_cowork_gateway_stream_reconnects_total 0',
        'open_cowork_gateway_session_streams 1',
      ].join('\n'))
      return
    }
    return writeJson(res, 404, { error: 'not found' })
  })

  const outputDir = mkdtempSync(join(tmpdir(), 'open-cowork-launch-readiness-'))
  try {
    const { stdout: output } = await execFileAsync(process.execPath, [
      'scripts/launch-readiness.mjs',
      '--mode',
      'load',
      '--profile',
      'private-beta',
      '--duration-ms',
      '1400',
      '--concurrency',
      '4',
      '--request-rate',
      '80',
      '--cloud-url',
      cloud.url,
      '--gateway-url',
      gateway.url,
      '--cloud-token',
      'cloud-token',
      '--gateway-admin-token',
      'gateway-admin-token',
      '--byok-provider',
      'anthropic',
      '--include-mutations',
      '--include-sse',
      '--operator',
      '--strict',
      '--output-dir',
      outputDir,
    ], { encoding: 'utf8' })
    const parsed = JSON.parse(output)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.result, 'go')
    assert.equal(parsed.failedChecks.length, 0)

    const files = readdirSync(outputDir)
    const jsonReport = files.find((file) => file.endsWith('-private-beta-load-report.json'))
    const markdownReport = files.find((file) => file.endsWith('-private-beta-load-report.md'))
    assert.ok(jsonReport)
    assert.ok(markdownReport)
    const report = JSON.parse(readFileSync(join(outputDir, jsonReport), 'utf8'))
    assert.equal(report.gates.overall, 'go')
    assert.equal(report.summary.operations['cloud-session-create'].failures, 0)
    assert.equal(report.summary.operations['cloud-prompt-enqueue'].failures, 0)
    assert.equal(report.summary.operations['cloud-workspace-sse'].failures, 0)
    assert.equal(report.summary.operations['cloud-artifact-upload'].failures, 0)
    assert.equal(report.summary.operations['cloud-artifact-download'].failures, 0)
    assert.equal(report.summary.operations['cloud-workflow-run'].failures, 0)
    assert.equal(report.summary.operations['cloud-byok-provider-validate'].failures, 0)
    assert.equal(report.metrics.delta.open_cowork_gateway_delivery_dead_letters_total, 0)
    assert.equal(report.metrics.delta.open_cowork_gateway_stream_reconnects_total, 0)
    assert.match(readFileSync(join(outputDir, markdownReport), 'utf8'), /Open Cowork Launch Readiness Report/)
  } finally {
    await new Promise<void>((resolve) => cloud.server.close(() => resolve()))
    await new Promise<void>((resolve) => gateway.server.close(() => resolve()))
    rmSync(outputDir, { recursive: true, force: true })
  }
})
