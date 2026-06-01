import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOUD_GATEWAY_ALLOWED_SYNC_SCOPES,
  CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES,
  CLOUD_GATEWAY_REGISTRATION_CREDENTIAL_SCOPES,
  CLOUD_GATEWAY_REGISTRATION_KINDS,
  CLOUD_GATEWAY_REGISTRATION_TRUST_MODELS,
  cloudGatewayRegistrationAllowsEdgeWork,
  cloudGatewayRegistrationContract,
} from '../packages/shared/src/cloud-gateway-registration.ts'

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('Cloud Gateway registration modes keep external workspace and edge work semantics separate', () => {
  assert.deepEqual([...CLOUD_GATEWAY_REGISTRATION_KINDS].sort(), [
    'edge_worker',
    'external_workspace',
    'external_workspace_edge_worker',
  ])

  const external = cloudGatewayRegistrationContract('external_workspace')
  assert.equal(external.workspaceAuthority, 'gateway_standalone')
  assert.equal(external.runtimeAuthority, 'gateway_standalone')
  assert.equal(external.gatewayOwnsStandaloneSessions, true)
  assert.equal(external.cloudOwnsCloudSessions, false)
  assert.equal(external.cloudCanRouteEligibleWorkToGateway, false)
  assert.equal(external.requiresManagedWorkerLeaseFencing, false)
  assert.equal(external.customerHostedManagedSaasAllowed, true)
  assert.equal(external.artifactOwnership, 'gateway_retained')

  const edge = cloudGatewayRegistrationContract('edge_worker')
  assert.equal(edge.workspaceAuthority, 'cloud_worker')
  assert.equal(edge.runtimeAuthority, 'cloud_worker')
  assert.equal(edge.gatewayOwnsStandaloneSessions, false)
  assert.equal(edge.cloudOwnsCloudSessions, true)
  assert.equal(edge.cloudCanRouteEligibleWorkToGateway, true)
  assert.equal(edge.requiresManagedWorkerLeaseFencing, true)
  assert.equal(edge.customerHostedManagedSaasAllowed, false)
  assert.equal(edge.artifactOwnership, 'cloud_owned')
  assert.ok(edge.requiredCredentialScopes.includes('gateway.edge.claim'))
  assert.ok(edge.requiredCredentialScopes.includes('gateway.edge.lease_renew'))
  assert.ok(edge.requiredCredentialScopes.includes('gateway.edge.write_fenced_output'))

  const combined = cloudGatewayRegistrationContract('external_workspace_edge_worker')
  assert.equal(combined.workspaceAuthority, 'split_by_work_owner')
  assert.equal(combined.runtimeAuthority, 'split_by_work_owner')
  assert.equal(combined.gatewayOwnsStandaloneSessions, true)
  assert.equal(combined.cloudOwnsCloudSessions, true)
  assert.equal(combined.cloudCanRouteEligibleWorkToGateway, true)
  assert.equal(combined.artifactOwnership, 'split_by_work_owner')
})

test('Cloud Gateway registration trust model defers customer-hosted managed SaaS edge work', () => {
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('external_workspace', 'self_hosted_same_operator'), false)
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('edge_worker', 'self_hosted_same_operator'), true)
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('edge_worker', 'saas_operator_managed'), true)
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('edge_worker', 'customer_hosted_managed_saas_deferred'), false)
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('external_workspace_edge_worker', 'customer_hosted_managed_saas_deferred'), false)
})

test('Cloud Gateway registration contracts include every forbidden sync scope', () => {
  for (const kind of CLOUD_GATEWAY_REGISTRATION_KINDS) {
    const contract = cloudGatewayRegistrationContract(kind)
    assert.deepEqual([...contract.forbiddenSyncScopes].sort(), [...CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES].sort())
    assert.doesNotMatch(contract.allowedSyncScopes.join('\n'), /raw_|plaintext|private_files|unfenced/)
  }
})

test('Cloud Gateway registration docs and validators cover the public contract', () => {
  const doc = read('docs/cloud-gateway-registration.md')
  const managedWorkers = read('docs/managed-workers.md')
  const productContract = read('docs/product-contract.md')
  const security = read('docs/security-model.md')
  const readiness = read('docs/deployment-readiness.md')
  const mkdocs = read('mkdocs.yml')
  const opsValidator = read('scripts/validate-ops-readiness.mjs')

  for (const source of [managedWorkers, productContract, security, readiness, mkdocs]) {
    assert.match(source, /cloud-gateway-registration\.md/)
  }

  for (const kind of CLOUD_GATEWAY_REGISTRATION_KINDS) {
    assert.match(doc, new RegExp('`' + escapeRegex(kind) + '`'), `doc must mention ${kind}`)
    assert.match(productContract, new RegExp('`' + escapeRegex(kind) + '`'), `Product Contract must mention ${kind}`)
  }
  for (const trustModel of CLOUD_GATEWAY_REGISTRATION_TRUST_MODELS) {
    assert.match(doc, new RegExp('`' + escapeRegex(trustModel) + '`'), `doc must mention ${trustModel}`)
  }
  for (const scope of CLOUD_GATEWAY_REGISTRATION_CREDENTIAL_SCOPES) {
    assert.match(doc, new RegExp('`' + escapeRegex(scope) + '`'), `doc must mention credential scope ${scope}`)
  }
  for (const scope of CLOUD_GATEWAY_ALLOWED_SYNC_SCOPES) {
    assert.match(doc, new RegExp('`' + escapeRegex(scope) + '`'), `doc must mention allowed sync scope ${scope}`)
  }
  for (const scope of CLOUD_GATEWAY_FORBIDDEN_SYNC_SCOPES) {
    assert.match(doc, new RegExp('`' + escapeRegex(scope) + '`'), `doc must mention forbidden sync scope ${scope}`)
    assert.match(opsValidator, new RegExp(escapeRegex(scope)), `ops validator must pin forbidden sync scope ${scope}`)
  }
})
