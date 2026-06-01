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

test('deployment topology profiles cover every supported product mode', () => {
  const profilesDocument = readJson('deploy/topologies/topology-profiles.json')
  assert.equal(profilesDocument.schemaVersion, 1)
  assert.equal(profilesDocument.purpose, 'open-cowork-deployment-topology-profiles')

  const profiles = new Map(profilesDocument.profiles.map((profile: { id: string }) => [profile.id, profile]))
  for (const id of [
    'desktop-only',
    'gateway-only',
    'cloud-only',
    'cloud-channel-gateway',
    'desktop-gateway',
    'cloud-gateway-edge',
    'full-hybrid',
  ]) {
    assert.ok(profiles.has(id), `missing topology profile ${id}`)
  }

  const gatewayOnly = profiles.get('gateway-only') as Record<string, unknown>
  assert.deepEqual(gatewayOnly.executionAuthorities, ['gateway_standalone'])
  assert.match(String(gatewayOnly.securityBoundary), /OpenCode stays loopback\/private/)
  assert.match((gatewayOnly.validationCommands as string[]).join('\n'), /deploy:standalone-gateway:validate/)

  const cloudGateway = profiles.get('cloud-channel-gateway') as Record<string, unknown>
  assert.deepEqual(cloudGateway.executionAuthorities, ['cloud_worker'])
  assert.match(String(cloudGateway.securityBoundary), /does not spawn OpenCode/)
  assert.match((cloudGateway.smokeCommands as string[]).join('\n'), /deploy:continuation:smoke/)

  const desktopGateway = profiles.get('desktop-gateway') as Record<string, unknown>
  assert.deepEqual(desktopGateway.executionAuthorities, ['desktop_local'])

  const fullHybrid = profiles.get('full-hybrid') as Record<string, unknown>
  assert.deepEqual(fullHybrid.executionAuthorities, ['desktop_local', 'cloud_worker', 'gateway_standalone'])
  assert.match(String(fullHybrid.securityBoundary), /one execution authority/)
  assert.match((fullHybrid.validationCommands as string[]).join('\n'), /pnpm test:e2e/)
})

test('deployment topology docs and validators expose the profile contract', () => {
  const deployReadme = read('deploy/README.md')
  const topologyReadme = read('deploy/topologies/README.md')
  const docs = read('docs/deployment-topologies.md')
  const readiness = read('docs/deployment-readiness.md')
  const validator = read('scripts/validate-deployment-configs.mjs')
  const mkdocs = read('mkdocs.yml')

  for (const profile of [
    'desktop-only',
    'gateway-only',
    'cloud-only',
    'cloud-channel-gateway',
    'desktop-gateway',
    'cloud-gateway-edge',
    'full-hybrid',
  ]) {
    assert.match(deployReadme, new RegExp(`\\\`${profile}\\\``))
    assert.match(topologyReadme, new RegExp(`\\\`${profile}\\\``))
    assert.match(docs, new RegExp(`\\\`${profile}\\\``))
    assert.match(readiness, new RegExp(`\\\`${profile}\\\``))
  }

  for (const phrase of [
    'Telegram-to-VPS OpenCode team',
    'systemd',
    'launchd',
    'docker-compose.gateway-remote.yml',
    'docker-compose.cloud-gateway.yml',
    'helm/open-cowork-cloud/',
    'helm/open-cowork-gateway/',
    'one execution authority',
    'fail closed',
  ]) {
    assert.match(topologyReadme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }

  assert.match(validator, /validateTopologyProfiles/)
  assert.match(validator, /references missing package script/)
  assert.match(mkdocs, /deployment-topologies\.md/)
})
