import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKSPACE_API_SUPPORT_STATUSES,
  WORKSPACE_CONTRACT_REASON_CODES,
  WORKSPACE_PRODUCT_SURFACES,
} from '../packages/shared/src/workspace.ts'

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const productContract = read('docs/product-contract.md')

test('product contract is the canonical linked three-surface contract', () => {
  for (const phrase of [
    'workspace-scoped product sync',
    'Desktop Local',
    'Desktop Cloud',
    'Cloud Web',
    'Gateway Channel',
    'Active Workspace And Routing',
    'Cloud Offline And Degraded Behavior',
    'Artifacts',
    'Workflows',
    'Settings And Custom Content',
    'Local-To-Cloud Copy And Import',
    'Downstream Configuration Boundaries',
    'Gateway can only participate in synced work through Cloud workspaces',
    'must not import `@opencode-ai/sdk`, spawn OpenCode',
    'Local Desktop threads, host paths, local stdio MCPs, machine-native runtime',
  ]) {
    assert.match(productContract, new RegExp(escapeRegex(phrase)), `Product Contract must document ${phrase}`)
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

test('active roadmap points to launch issues instead of the older completed roadmap', () => {
  const roadmap = read('docs/roadmap.md')

  assert.match(roadmap, /issue #547/)
  for (const issue of [548, 549, 550, 551, 552, 553, 554]) {
    assert.match(roadmap, new RegExp(`#${issue}\\b`), `roadmap must reference #${issue}`)
    assert.match(roadmap, new RegExp(`/issues/${issue}\\)`), `roadmap must link #${issue}`)
  }

  for (const oldIssue of [448, 449, 456, 457, 458, 459, 460, 461, 462, 463, 464]) {
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
    'no Gateway-owned OpenCode runtime',
  ]) {
    assert.match(productContract, new RegExp(escapeRegex(phrase)), `Product Contract must preserve boundary: ${phrase}`)
  }
})
