import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKSPACE_API_SUPPORT_STATUSES,
  WORKSPACE_AUTHORITY_CONTRACTS,
  WORKSPACE_CONTRACT_REASON_CODES,
  WORKSPACE_EXECUTION_AUTHORITIES,
  WORKSPACE_PRODUCT_SURFACES,
  workspaceApiSupportContextForAuthority,
} from '../packages/shared/src/workspace.ts'

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const productContract = read('docs/product-contract.md')
const productContractFlat = productContract.replace(/\s+/g, ' ')

test('product contract is the canonical linked multi-authority contract', () => {
  for (const phrase of [
    'workspace-scoped product sync',
    'Desktop Local',
    'Desktop Cloud',
    'Cloud Web',
    'Cloud Channel Gateway',
    'Standalone Team Gateway',
    'Paired Desktop',
    'Active Workspace And Routing',
    'Cloud Offline And Degraded Behavior',
    'Artifacts',
    'Workflows',
    'Settings And Custom Content',
    'Local-To-Cloud Copy And Import',
    'Downstream Configuration Boundaries',
    'Cloud Channel Gateway can only participate in synced work through Cloud workspaces',
    'In this mode Gateway must not import `@opencode-ai/sdk`, spawn OpenCode',
    'Standalone Team Gateway is a separate Gateway product mode and execution authority',
    'Paired Desktop must not open a public Desktop or OpenCode port',
    'Local Desktop threads, host paths, local stdio MCPs, machine-native runtime',
  ]) {
    assert.match(productContractFlat, new RegExp(escapeRegex(phrase)), `Product Contract must document ${phrase}`)
  }

  const linkedDocs = [
    'docs/architecture.md',
    'docs/open-cowork-cloud.md',
    'docs/downstream.md',
    'docs/roadmap.md',
    'mkdocs.yml',
  ]
  for (const relativePath of linkedDocs) {
    assert.match(read(relativePath), /product-contract\.md/, `${relativePath} must link the canonical Product Contract`)
  }
})

test('product contract documents the shared workspace status and reason vocabulary', () => {
  for (const authority of WORKSPACE_EXECUTION_AUTHORITIES) {
    assert.match(productContract, new RegExp('`' + escapeRegex(authority) + '`'), `Product Contract must document authority ${authority}`)
  }
  for (const surface of WORKSPACE_PRODUCT_SURFACES) {
    assert.match(productContract, new RegExp('`' + escapeRegex(surface) + '`'), `Product Contract must document surface ${surface}`)
  }
  for (const status of WORKSPACE_API_SUPPORT_STATUSES) {
    assert.match(productContract, new RegExp('`' + escapeRegex(status) + '`'), `Product Contract must document status ${status}`)
  }
  for (const reasonCode of WORKSPACE_CONTRACT_REASON_CODES) {
    assert.match(productContract, new RegExp('`' + escapeRegex(reasonCode) + '`'), `Product Contract must document reason code ${reasonCode}`)
  }
})

test('workspace authority contracts answer execution, storage, mutation, and artifact ownership', () => {
  assert.deepEqual(Object.keys(WORKSPACE_AUTHORITY_CONTRACTS).sort(), [...WORKSPACE_EXECUTION_AUTHORITIES].sort())

  const cloudChannel = workspaceApiSupportContextForAuthority('cloud_channel_gateway')
  assert.equal(cloudChannel.runtimeAuthority, 'cloud_worker')
  assert.equal(cloudChannel.ownership.sessions, 'cloud_control_plane')
  assert.equal(cloudChannel.artifacts.body, 'channel_delivery')

  const standalone = workspaceApiSupportContextForAuthority('gateway_standalone')
  assert.equal(standalone.runtimeAuthority, 'gateway_standalone')
  assert.equal(standalone.ownership.sessions, 'gateway_control_plane')
  assert.equal(standalone.artifacts.body, 'gateway_artifact_store')

  const paired = workspaceApiSupportContextForAuthority('desktop_paired')
  assert.equal(paired.runtimeAuthority, 'desktop_local')
  assert.equal(paired.pairingState, 'pairing_required')
  assert.equal(paired.pathExposure, 'redacted_remote')

  const blocked = workspaceApiSupportContextForAuthority('cloud_worker', {
    status: 'blocked_by_policy',
    blockedReason: {
      allowed: false,
      reason: 'Policy disabled.',
      policyCode: 'workspace.policy_disabled',
    },
  })
  assert.equal(blocked.mutation, 'blocked')
  assert.equal(blocked.workflows, 'blocked')
  assert.equal(blocked.blockedReason?.policyCode, 'workspace.policy_disabled')
})

test('active roadmap points to multi-authority issues instead of the older launch roadmap', () => {
  const roadmap = read('docs/roadmap.md')

  assert.match(roadmap, /issue #575/)
  for (const issue of [576, 577, 578, 579, 580, 581, 582, 583, 584, 585, 586, 587]) {
    assert.match(roadmap, new RegExp(`#${issue}\\b`), `roadmap must reference #${issue}`)
    assert.match(roadmap, new RegExp(`/issues/${issue}\\)`), `roadmap must link #${issue}`)
  }

  for (const oldIssue of [448, 449, 456, 457, 458, 459, 460, 461, 462, 463, 464, 547, 548, 549, 550, 551, 552, 553, 554]) {
    assert.doesNotMatch(roadmap, new RegExp(`/issues/${oldIssue}\\)`), `roadmap must not point at older issue #${oldIssue}`)
    assert.doesNotMatch(roadmap, new RegExp(`#${oldIssue}\\b`), `roadmap must not list older issue #${oldIssue} as active`)
  }
})

test('product contract keeps local and cloud workspace ownership separate', () => {
  for (const phrase of [
    'A thread belongs to exactly one workspace.',
    'Cloud cache is a read-only fallback in v1.',
    'Local-to-Cloud movement is always explicit.',
    "Import does not change the original Local thread's ownership.",
    'no implicit local thread upload',
    'no raw secret sync through config',
    'no local host path execution in Cloud',
    'no local stdio MCP execution in Cloud',
    'no Gateway-owned OpenCode runtime in Cloud Channel Gateway mode',
    'no public Desktop or OpenCode port for pairing',
  ]) {
    assert.match(productContract, new RegExp(escapeRegex(phrase)), `Product Contract must preserve boundary: ${phrase}`)
  }
})
