#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const env = process.env

function value(...names) {
  for (const name of names) {
    const raw = env[name]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return ''
}

function boolValue(name) {
  const raw = (env[name] || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function requireValue(label, ...names) {
  const resolved = value(...names)
  if (!resolved) {
    throw new Error(`Strict deployment smoke requires ${label}: set one of ${names.join(', ')}.`)
  }
  return resolved
}

function rejectWeakeningEnv(name, reason) {
  if (boolValue(name)) throw new Error(`Strict deployment smoke does not allow ${name}=true: ${reason}.`)
}

function commandEnv(overrides) {
  return {
    ...env,
    ...overrides,
  }
}

function parseJsonOutput(step, stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error(`${step} did not emit JSON evidence.`)
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`${step} emitted invalid JSON evidence: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function runStep(step, command, args, overrides) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: commandEnv(overrides),
  })
  if (result.error) {
    throw new Error(`${step} failed to start ${command}: ${result.error.message}`, {
      cause: result.error,
    })
  }
  if (result.status !== 0) {
    throw new Error(`${step} failed:\n${result.stderr || result.stdout}`)
  }
  const body = parseJsonOutput(step, result.stdout)
  if (body?.ok !== true) throw new Error(`${step} did not report ok: true.`)
  return body
}

function assertCheckNames(step, body, names) {
  const checks = new Set((body?.results || []).map((entry) => entry?.check))
  for (const name of names) {
    if (!checks.has(name)) throw new Error(`${step} evidence is missing check: ${name}`)
  }
}

function requirePath(object, path, expected) {
  const actual = path.split('.').reduce((current, key) => current?.[key], object)
  if (expected instanceof Set) {
    if (!expected.has(actual)) throw new Error(`Strict smoke evidence ${path} was ${String(actual)}, expected one of ${[...expected].join(', ')}.`)
    return actual
  }
  if (actual !== expected) {
    throw new Error(`Strict smoke evidence ${path} was ${String(actual)}, expected ${String(expected)}.`)
  }
  return actual
}

function assertStrictUrl(name, raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Strict deployment smoke ${name} must be a valid URL.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Strict deployment smoke ${name} must use HTTP or HTTPS.`)
  }
  const hostname = parsed.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error(`Strict deployment smoke ${name} must use HTTPS unless it points at loopback.`)
  }
}

function assertAllRevoked(body) {
  const revoked = body?.results?.tokens?.revoked
  for (const name of ['web', 'desktop', 'gateway']) {
    if (revoked?.[name] !== true) throw new Error(`Continuation smoke did not revoke ${name} token.`)
  }
}

function validateInputs() {
  rejectWeakeningEnv('OPEN_COWORK_SMOKE_SKIP_CLOUD', 'strict smoke must include Cloud health, workbench, runtime, heartbeat, and metrics checks')
  rejectWeakeningEnv('OPEN_COWORK_SMOKE_SKIP_GATEWAY', 'strict smoke must include Gateway health, readiness, and operator metrics checks')
  rejectWeakeningEnv('OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT', 'strict smoke must include Desktop/Web mutation and cache checks')
  rejectWeakeningEnv('OPEN_COWORK_GATEWAY_SMOKE_ALLOW_INSECURE_HTTP', 'strict smoke must use HTTPS unless each deep smoke is run explicitly outside the strict wrapper')

  const inputs = {
    cloudUrl: requireValue('Cloud URL', 'OPEN_COWORK_SMOKE_CLOUD_URL'),
    adminToken: requireValue(
      'Cloud admin token',
      'OPEN_COWORK_SMOKE_ADMIN_TOKEN',
      'OPEN_COWORK_SMOKE_CLOUD_TOKEN',
      'OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN',
      'OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN',
      'OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN',
    ),
    gatewayUrl: requireValue('managed Gateway URL', 'OPEN_COWORK_SMOKE_GATEWAY_URL', 'OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL'),
    gatewayAdminToken: requireValue(
      'managed Gateway admin token',
      'OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN',
      'OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN',
    ),
  }
  assertStrictUrl('Cloud URL', inputs.cloudUrl)
  assertStrictUrl('managed Gateway URL', inputs.gatewayUrl)
  return inputs
}

function runStrictSmoke() {
  const inputs = validateInputs()

  const baseline = runStep('baseline operator deployment smoke', 'pnpm', ['--silent', 'deploy:smoke', '--', '--strict'], {
    OPEN_COWORK_SMOKE_STRICT: 'true',
    OPEN_COWORK_SMOKE_OPERATOR_CHECKS: 'true',
    OPEN_COWORK_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_SMOKE_GATEWAY_URL: inputs.gatewayUrl,
    OPEN_COWORK_SMOKE_CLOUD_TOKEN: inputs.adminToken,
    OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN: inputs.gatewayAdminToken,
  })
  if (baseline.strict !== true) throw new Error('Baseline deployment smoke did not run in strict mode.')
  assertCheckNames('baseline operator deployment smoke', baseline, [
    'cloud runtime status',
    'cloud worker heartbeats',
    'cloud metrics',
    'gateway metrics',
  ])

  const desktop = runStep('desktop cloud sync smoke', 'pnpm', ['--silent', 'deploy:desktop:smoke'], {
    OPEN_COWORK_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN: value('OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN') || inputs.adminToken,
    OPEN_COWORK_DESKTOP_SMOKE_REQUIRE_REVOCATION: 'true',
    OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT: 'false',
  })
  requirePath(desktop, 'results.prompt.skipped', false)
  requirePath(desktop, 'results.cache.offlineMutationsBlocked', true)
  requirePath(desktop, 'results.tokenRevocation.rejected', true)

  const gateway = runStep('gateway cloud smoke', 'pnpm', ['--silent', 'deploy:gateway:smoke'], {
    OPEN_COWORK_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_SMOKE_GATEWAY_URL: inputs.gatewayUrl,
    OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN: inputs.gatewayAdminToken,
    OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL: inputs.gatewayUrl,
    OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN: value('OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN') || inputs.adminToken,
    OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN: inputs.gatewayAdminToken,
    OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED: 'true',
  })
  requirePath(gateway, 'results.managed.health.ok', true)
  requirePath(gateway, 'results.managed.ready.ok', true)
  requirePath(gateway, 'results.managed.operator.metrics.status', new Set([200, 404]))
  requirePath(gateway, 'results.selfHost.prompt.commandAccepted', true)
  requirePath(gateway, 'results.selfHost.interaction.acknowledged', true)
  requirePath(gateway, 'results.selfHost.delivery.retryStatus', 'sent')
  requirePath(gateway, 'results.selfHost.delivery.deadLetterStatus', 'dead')
  requirePath(gateway, 'results.tokenRevocation.rejected', true)

  const continuation = runStep('continuation parity smoke', 'pnpm', ['--silent', 'deploy:continuation:smoke'], {
    OPEN_COWORK_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL: inputs.cloudUrl,
    OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN: value('OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN') || inputs.adminToken,
    OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION: 'true',
  })
  requirePath(continuation, 'results.workspace.gatewayTenantMatches', true)
  requirePath(continuation, 'results.sessions.webCreated.permissionResolvedByWeb', true)
  requirePath(continuation, 'results.sessions.webCreated.questionResolvedByGateway', true)
  requirePath(continuation, 'results.replay.hydrated', true)
  assertAllRevoked(continuation)

  return {
    ok: true,
    strict: true,
    checks: {
      baseline: {
        operatorChecks: true,
      },
      desktop: {
        mutations: true,
        revocationRejected: true,
      },
      gateway: {
        managedGateway: true,
        mutations: true,
        revocationRejected: true,
      },
      continuation: {
        richProjection: true,
        tokensRevoked: true,
      },
    },
  }
}

try {
  process.stdout.write(`${JSON.stringify(runStrictSmoke(), null, 2)}\n`)
} catch (error) {
  process.stderr.write(`[deploy-smoke-strict] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
