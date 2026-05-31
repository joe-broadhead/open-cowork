#!/usr/bin/env node
const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (arg === '--') {
    continue
  }
  if (!arg.startsWith('--')) {
    continue
  }
  const key = arg.slice(2)
  const next = process.argv[index + 1]
  if (!next || next.startsWith('--')) {
    args.set(key, 'true')
  } else {
    args.set(key, next)
    index += 1
  }
}

const cloudUrl = normalizeUrl(args.get('cloud-url') ?? process.env.OPEN_COWORK_SMOKE_CLOUD_URL ?? 'http://127.0.0.1:8787')
const gatewayUrl = normalizeUrl(args.get('gateway-url') ?? process.env.OPEN_COWORK_SMOKE_GATEWAY_URL ?? 'http://127.0.0.1:8790')
const cloudToken = args.get('cloud-token') ?? process.env.OPEN_COWORK_SMOKE_CLOUD_TOKEN ?? ''
const gatewayAdminToken =
  args.get('gateway-admin-token') ?? process.env.OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN ?? ''
const skipCloud = args.has('skip-cloud') || process.env.OPEN_COWORK_SMOKE_SKIP_CLOUD === 'true'
const skipGateway = args.has('skip-gateway') || process.env.OPEN_COWORK_SMOKE_SKIP_GATEWAY === 'true'
const includeOperatorChecks =
  args.has('operator') || process.env.OPEN_COWORK_SMOKE_OPERATOR_CHECKS === 'true'

function normalizeUrl(value) {
  return value.replace(/\/+$/, '')
}

async function checkJson(url, options = {}) {
  const response = await fetch(url, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`)
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

async function checkReachableJson(url, options = {}) {
  const response = await fetch(url, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
  })
  const text = await response.text()
  const accepted = options.acceptedStatus || [200]
  if (!accepted.includes(response.status)) {
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`)
  }
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const contentType = response.headers.get('content-type') || ''
  if (response.status === 200 && !contentType.includes('application/json')) {
    throw new Error(`${url} must return JSON for successful bootstrap checks`)
  }
  return {
    status: response.status,
    contentType,
    bodyShape: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : typeof parsed,
  }
}

async function checkText(url, options = {}) {
  const response = await fetch(url, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`)
  }
  for (const marker of options.markers || []) {
    if (!text.includes(marker)) throw new Error(`${url} missing expected marker: ${marker}`)
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    markers: options.markers || [],
  }
}

async function checkHtml(url, options = {}) {
  const response = await fetch(url, {
    headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text.slice(0, 400)}`)
  }
  const contentType = response.headers.get('content-type') || ''
  const cacheControl = response.headers.get('cache-control') || ''
  const csp = response.headers.get('content-security-policy') || ''
  for (const expected of [
    'text/html',
    'open-cowork-cloud-bootstrap',
    'data-route-panel="threads"',
    'data-route-panel="chat"',
    'data-route-panel="byok"',
  ]) {
    const target = expected === 'text/html' ? contentType : text
    if (!target.includes(expected)) {
      throw new Error(`${url} missing expected Cloud Web Workbench marker: ${expected}`)
    }
  }
  if (!cacheControl.includes('no-store')) {
    throw new Error(`${url} must use cache-control: no-store`)
  }
  if (!csp.includes("default-src 'self'") || !csp.includes("connect-src 'self'") || !csp.includes("frame-ancestors 'none'")) {
    throw new Error(`${url} must send the Cloud Web Workbench CSP`)
  }
  const nonceMatch = csp.match(/'nonce-([^']+)'/)
  if (!nonceMatch || !text.includes(`nonce="${nonceMatch[1]}"`)) {
    throw new Error(`${url} must use matching CSP nonces for inline Cloud Web scripts`)
  }
  return {
    status: response.status,
    contentType,
    cacheControl,
    csp: 'present',
    bootstrap: 'present',
  }
}

async function main() {
  const results = []
  if (!skipCloud) {
    results.push({ check: 'cloud health', url: `${cloudUrl}/healthz`, result: await checkJson(`${cloudUrl}/healthz`) })
    results.push({ check: 'cloud liveness', url: `${cloudUrl}/livez`, result: await checkJson(`${cloudUrl}/livez`) })
    results.push({
      check: 'cloud web workbench',
      url: `${cloudUrl}/`,
      result: await checkHtml(`${cloudUrl}/`),
    })
    results.push({
      check: 'cloud web api config bootstrap',
      url: `${cloudUrl}/api/config`,
      result: await checkReachableJson(`${cloudUrl}/api/config`, {
        token: cloudToken,
        acceptedStatus: cloudToken ? [200] : [200, 401, 403],
      }),
    })
    results.push({
      check: 'cloud web api workspace bootstrap',
      url: `${cloudUrl}/api/workspace`,
      result: await checkReachableJson(`${cloudUrl}/api/workspace`, {
        token: cloudToken,
        acceptedStatus: cloudToken ? [200] : [200, 401, 403],
      }),
    })
    if (includeOperatorChecks) {
      results.push({
        check: 'cloud runtime status',
        url: `${cloudUrl}/api/runtime/status`,
        result: await checkJson(`${cloudUrl}/api/runtime/status`, { token: cloudToken }),
      })
      results.push({
        check: 'cloud worker heartbeats',
        url: `${cloudUrl}/api/workers/heartbeats`,
        result: await checkJson(`${cloudUrl}/api/workers/heartbeats`, { token: cloudToken }),
      })
      results.push({
        check: 'cloud metrics',
        url: `${cloudUrl}/api/metrics`,
        result: await checkText(`${cloudUrl}/api/metrics`, {
          token: cloudToken,
          markers: ['open_cowork_cloud_http_requests_total'],
        }),
      })
    }
  }

  if (!skipGateway) {
    results.push({
      check: 'gateway health',
      url: `${gatewayUrl}/health`,
      result: await checkJson(`${gatewayUrl}/health`),
    })
    results.push({
      check: 'gateway readiness',
      url: `${gatewayUrl}/ready`,
      result: await checkJson(`${gatewayUrl}/ready`),
    })
    if (includeOperatorChecks && gatewayAdminToken) {
      results.push({
        check: 'gateway metrics',
        url: `${gatewayUrl}/metrics`,
        result: await checkText(`${gatewayUrl}/metrics`, {
          token: gatewayAdminToken,
          markers: ['open_cowork_gateway_providers'],
        }),
      })
    }
  }

  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[deploy-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
