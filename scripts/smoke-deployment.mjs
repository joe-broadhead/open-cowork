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

async function main() {
  const results = []
  if (!skipCloud) {
    results.push({ check: 'cloud health', url: `${cloudUrl}/healthz`, result: await checkJson(`${cloudUrl}/healthz`) })
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
        result: await checkJson(`${gatewayUrl}/metrics`, { token: gatewayAdminToken }),
      })
    }
  }

  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[deploy-smoke] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
