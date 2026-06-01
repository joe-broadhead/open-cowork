import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function readJson(relativePath: string) {
  return JSON.parse(read(relativePath))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('hybrid security gate contract covers every production authority mode', () => {
  const contract = readJson('deploy/security/hybrid-security-gates.json')
  assert.equal(contract.schemaVersion, 1)
  assert.equal(contract.purpose, 'open-cowork-hybrid-security-gates')

  const gates = new Map(contract.gates.map((gate: { id: string }) => [gate.id, gate]))
  for (const id of [
    'desktop-local',
    'desktop-pairing',
    'standalone-gateway',
    'cloud-worker',
    'cloud-channel-gateway',
    'cloud-gateway-edge',
    'full-hybrid',
  ]) {
    assert.ok(gates.has(id), `missing hybrid security gate ${id}`)
  }

  const desktopPairing = gates.get('desktop-pairing') as Record<string, unknown>
  assert.equal(desktopPairing.authority, 'desktop_local')
  assert.match((desktopPairing.approvalPolicy as string[]).join('\n'), /local_confirmation/)
  assert.match((desktopPairing.approvalPolicy as string[]).join('\n'), /remote_allowed/)
  assert.match((desktopPairing.failClosedChecks as string[]).join('\n'), /HTTPS/)
  assert.match((desktopPairing.auditEvents as string[]).join('\n'), /command\.blocked/)

  const cloudGateway = gates.get('cloud-channel-gateway') as Record<string, unknown>
  assert.equal(cloudGateway.authority, 'cloud_worker')
  assert.match((cloudGateway.approvalPolicy as string[]).join('\n'), /service token does not grant actor approval authority/)
  assert.match((cloudGateway.failClosedChecks as string[]).join('\n'), /no @opencode-ai\/sdk/)
  assert.match((cloudGateway.failClosedChecks as string[]).join('\n'), /no direct Postgres access/)

  const fullHybrid = gates.get('full-hybrid') as Record<string, unknown>
  assert.match((fullHybrid.approvalPolicy as string[]).join('\n'), /one execution authority/)
  assert.match((fullHybrid.failClosedChecks as string[]).join('\n'), /All smaller gates must pass/)
})

test('hybrid security docs and validators expose the gate contract', () => {
  const contract = readJson('deploy/security/hybrid-security-gates.json')
  const docs = read('docs/hybrid-security-gates.md')
  const readiness = read('docs/deployment-readiness.md')
  const securityModel = read('docs/security-model.md')
  const deployReadme = read('deploy/README.md')
  const deployValidator = read('scripts/validate-deployment-configs.mjs')
  const opsValidator = read('scripts/validate-ops-readiness.mjs')
  const mkdocs = read('mkdocs.yml')

  for (const gate of contract.gates as Array<{ id: string }>) {
    assert.match(docs, new RegExp(`\\\`${escapeRegExp(gate.id)}\\\``))
    assert.match(readiness, new RegExp(`\\\`${escapeRegExp(gate.id)}\\\``))
  }

  for (const phrase of [
    'deploy/security/hybrid-security-gates.json',
    'local_confirmation',
    'remote_allowed',
    'requires_local_confirmation',
    'blocked_by_policy',
    'Retry-After',
    'provider signing',
    'HMAC',
    'customer_hosted_managed_saas_deferred',
    'one execution authority',
  ]) {
    assert.match(docs, new RegExp(escapeRegExp(phrase)))
  }

  assert.match(readiness, /hybrid-security-gates\.json/)
  assert.match(securityModel, /Hybrid Security Gates/)
  assert.match(deployReadme, /hybrid-security-gates\.json/)
  assert.match(mkdocs, /hybrid-security-gates\.md/)
  assert.match(deployValidator, /validateHybridSecurityGates/)
  assert.match(opsValidator, /hybridSecurityGatesPath/)
})

test('hybrid security gate validation evidence references package scripts', () => {
  const contract = readJson('deploy/security/hybrid-security-gates.json')
  const scripts = readJson('package.json').scripts ?? {}

  for (const gate of contract.gates as Array<{ id: string; validationEvidence: string[] }>) {
    assert.ok(gate.validationEvidence.length > 0, `${gate.id} needs validation evidence`)
    for (const command of gate.validationEvidence) {
      const match = /^pnpm\s+([^\s]+)/.exec(command)
      assert.ok(match, `${gate.id} command must start with pnpm: ${command}`)
      const scriptName = match[1]
      if (!scriptName.startsWith('--')) {
        assert.ok(scripts[scriptName], `${gate.id} references missing script ${scriptName}`)
      }
    }
  }
})

test('hybrid security contract is grounded in code-level fail-closed behavior', () => {
  const pairing = read('packages/shared/src/desktop-pairing.ts')
  assert.match(pairing, /remoteApprovals: 'local_confirmation'/)
  assert.match(pairing, /remoteQuestions: 'local_confirmation'/)
  assert.match(pairing, /requires_local_confirmation/)
  assert.match(pairing, /blocked_by_policy/)

  const workspace = read('packages/shared/src/workspace.ts')
  assert.match(workspace, /OPENCODE_RUNTIME_AUTHORITIES/)
  assert.match(workspace, /workspace\.remote_approval_required/)

  const gatewayConfig = read('apps/gateway/src/config.ts')
  assert.match(gatewayConfig, /Gateway operator endpoints require OPEN_COWORK_GATEWAY_ADMIN_TOKEN/)
  assert.match(gatewayConfig, /authenticated webhook ingress/)
  assert.match(gatewayConfig, /signingSecret/)
  assert.match(gatewayConfig, /webhookSecret/)

  const standaloneNetworkPolicy = read('apps/standalone-gateway/src/network-policy.ts')
  assert.match(standaloneNetworkPolicy, /public OpenCode endpoint/)

  const cloudHttpServer = read('apps/desktop/src/main/cloud/http-server.ts')
  assert.match(cloudHttpServer, /Retry-After/)
  assert.match(cloudHttpServer, /quota_rejections/)
})
