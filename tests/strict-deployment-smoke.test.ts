import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const scriptPath = 'scripts/strict-deployment-smoke.mjs'

function stubPnpmSource() {
  return `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const argv = process.argv.slice(2)
appendFileSync(process.env.SMOKE_STUB_LOG, JSON.stringify({
  argv,
  env: {
    OPEN_COWORK_SMOKE_STRICT: process.env.OPEN_COWORK_SMOKE_STRICT,
    OPEN_COWORK_SMOKE_OPERATOR_CHECKS: process.env.OPEN_COWORK_SMOKE_OPERATOR_CHECKS,
    OPEN_COWORK_SMOKE_CLOUD_URL: process.env.OPEN_COWORK_SMOKE_CLOUD_URL,
    OPEN_COWORK_SMOKE_GATEWAY_URL: process.env.OPEN_COWORK_SMOKE_GATEWAY_URL,
    OPEN_COWORK_SMOKE_CLOUD_TOKEN: process.env.OPEN_COWORK_SMOKE_CLOUD_TOKEN,
    OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN: process.env.OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN,
    OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL: process.env.OPEN_COWORK_DESKTOP_SMOKE_CLOUD_URL,
    OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN: process.env.OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN,
    OPEN_COWORK_DESKTOP_SMOKE_REQUIRE_REVOCATION: process.env.OPEN_COWORK_DESKTOP_SMOKE_REQUIRE_REVOCATION,
    OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT: process.env.OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT,
    OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL: process.env.OPEN_COWORK_GATEWAY_SMOKE_CLOUD_URL,
    OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL: process.env.OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_URL,
    OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN: process.env.OPEN_COWORK_GATEWAY_SMOKE_ADMIN_TOKEN,
    OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN: process.env.OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN,
    OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED: process.env.OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED,
    OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL: process.env.OPEN_COWORK_CONTINUATION_SMOKE_CLOUD_URL,
    OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN: process.env.OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN,
    OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION: process.env.OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION,
  },
}) + '\\n')
const command = argv.find((entry) => entry !== '--silent')
if (command === 'deploy:smoke') {
  process.stdout.write(JSON.stringify({ ok: true, strict: true, results: [
    { check: 'cloud runtime status' },
    { check: 'cloud worker heartbeats' },
    { check: 'cloud metrics' },
    { check: 'gateway metrics' },
  ] }) + '\\n')
} else if (command === 'deploy:desktop:smoke') {
  process.stdout.write(JSON.stringify({ ok: true, results: {
    prompt: { skipped: false },
    cache: { offlineMutationsBlocked: true },
    tokenRevocation: { rejected: process.env.SMOKE_STUB_BAD_DESKTOP !== 'true' },
  } }) + '\\n')
} else if (command === 'deploy:gateway:smoke') {
  process.stdout.write(JSON.stringify({ ok: true, results: {
    managed: { health: { ok: true }, ready: { ok: true }, operator: { metrics: { status: 200 } } },
    selfHost: {
      prompt: { commandAccepted: true },
      interaction: { acknowledged: true },
      delivery: { retryStatus: 'sent', deadLetterStatus: 'dead' },
    },
    tokenRevocation: { rejected: true },
  } }) + '\\n')
} else if (command === 'deploy:continuation:smoke') {
  process.stdout.write(JSON.stringify({ ok: true, results: {
    workspace: { gatewayTenantMatches: true },
    sessions: { webCreated: { permissionResolvedByWeb: true, questionResolvedByGateway: true } },
    replay: { hydrated: true },
    tokens: { revoked: { web: true, desktop: true, gateway: true } },
  } }) + '\\n')
} else {
  console.error('unexpected pnpm command ' + argv.join(' '))
  process.exit(1)
}
`
}

function withStubPnpm(callback: (context: { path: string, logPath: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-strict-smoke-'))
  try {
    const pnpmPath = join(root, 'pnpm')
    const logPath = join(root, 'pnpm-log.jsonl')
    writeFileSync(pnpmPath, stubPnpmSource())
    chmodSync(pnpmPath, 0o755)
    callback({ path: root, logPath })
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function runWrapper(env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPEN_COWORK_SMOKE_SKIP_CLOUD: 'false',
      OPEN_COWORK_SMOKE_SKIP_GATEWAY: 'false',
      OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT: 'false',
      OPEN_COWORK_GATEWAY_SMOKE_ALLOW_INSECURE_HTTP: 'false',
      ...env,
    },
  })
}

function strictEnv(extra: NodeJS.ProcessEnv = {}) {
  return {
    OPEN_COWORK_SMOKE_CLOUD_URL: 'https://cowork.example.com',
    OPEN_COWORK_SMOKE_GATEWAY_URL: 'https://gateway.example.com',
    OPEN_COWORK_SMOKE_ADMIN_TOKEN: 'cloud-admin-token',
    OPEN_COWORK_SMOKE_GATEWAY_ADMIN_TOKEN: 'gateway-admin-token',
    ...extra,
  }
}

test('strict deployment smoke wrapper fails closed without required inputs', () => {
  const result = runWrapper()

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Strict deployment smoke requires Cloud URL/)
})

test('strict deployment smoke wrapper rejects non-loopback HTTP URLs', () => {
  const result = runWrapper(strictEnv({
    OPEN_COWORK_SMOKE_CLOUD_URL: 'http://cowork.example.com',
  }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cloud URL must use HTTPS unless it points at loopback/)
})

test('strict deployment smoke wrapper rejects weakening env flags', () => {
  const result = runWrapper(strictEnv({
    OPEN_COWORK_SMOKE_SKIP_CLOUD: 'true',
  }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not allow OPEN_COWORK_SMOKE_SKIP_CLOUD=true/)
})

test('strict deployment smoke wrapper rejects skipped Desktop prompt checks', () => {
  const result = runWrapper(strictEnv({
    OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT: 'true',
  }))

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not allow OPEN_COWORK_DESKTOP_SMOKE_SKIP_PROMPT=true/)
})

test('strict deployment smoke wrapper maps generic env and validates evidence', () => {
  withStubPnpm(({ path, logPath }) => {
    const result = runWrapper(strictEnv({
      PATH: `${path}${delimiter}${process.env.PATH || ''}`,
      SMOKE_STUB_LOG: logPath,
    }))

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const summary = JSON.parse(result.stdout) as { ok: boolean, strict: boolean, checks: Record<string, unknown> }
    assert.equal(summary.ok, true)
    assert.equal(summary.strict, true)
    assert.ok(summary.checks.desktop)
    assert.ok(summary.checks.gateway)
    assert.ok(summary.checks.continuation)

    const entries = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[], env: Record<string, string | undefined> })
    assert.deepEqual(entries.map((entry) => entry.argv.find((part) => part !== '--silent')), [
      'deploy:smoke',
      'deploy:desktop:smoke',
      'deploy:gateway:smoke',
      'deploy:continuation:smoke',
    ])
    assert.deepEqual(entries[0].argv, ['--silent', 'deploy:smoke', '--', '--strict'])
    assert.deepEqual(entries[1].argv, ['--silent', 'deploy:desktop:smoke'])
    assert.deepEqual(entries[2].argv, ['--silent', 'deploy:gateway:smoke'])
    assert.deepEqual(entries[3].argv, ['--silent', 'deploy:continuation:smoke'])
    assert.equal(entries[0].env.OPEN_COWORK_SMOKE_STRICT, 'true')
    assert.equal(entries[0].env.OPEN_COWORK_SMOKE_CLOUD_TOKEN, 'cloud-admin-token')
    assert.equal(entries[1].env.OPEN_COWORK_DESKTOP_SMOKE_REQUIRE_REVOCATION, 'true')
    assert.equal(entries[1].env.OPEN_COWORK_DESKTOP_SMOKE_ADMIN_TOKEN, 'cloud-admin-token')
    assert.equal(entries[2].env.OPEN_COWORK_GATEWAY_SMOKE_REQUIRE_MANAGED, 'true')
    assert.equal(entries[2].env.OPEN_COWORK_GATEWAY_SMOKE_GATEWAY_ADMIN_TOKEN, 'gateway-admin-token')
    assert.equal(entries[3].env.OPEN_COWORK_CONTINUATION_SMOKE_REQUIRE_RICH_PROJECTION, 'true')
    assert.equal(entries[3].env.OPEN_COWORK_CONTINUATION_SMOKE_ADMIN_TOKEN, 'cloud-admin-token')
  })
})

test('strict deployment smoke wrapper rejects weak deep-smoke evidence', () => {
  withStubPnpm(({ path, logPath }) => {
    const result = runWrapper(strictEnv({
      PATH: `${path}${delimiter}${process.env.PATH || ''}`,
      SMOKE_STUB_LOG: logPath,
      SMOKE_STUB_BAD_DESKTOP: 'true',
    }))

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /results\.tokenRevocation\.rejected/)
  })
})
