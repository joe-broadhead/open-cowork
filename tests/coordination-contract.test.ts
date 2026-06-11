import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  COORDINATION_AUTHORITY_SUPPORT,
  COORDINATION_CAPABILITIES,
  COORDINATION_DELEGATION_MODES,
  COORDINATION_ENTITY_KINDS,
  COORDINATION_RUN_KINDS,
  COORDINATION_TASK_COLUMNS,
  COORDINATION_TASK_PRIORITIES,
  COORDINATION_WATCH_EVENTS,
  COORDINATION_WORKSPACE_SUPPORT_APIS,
  COORDINATION_WATCH_TARGETS,
  coordinationCapabilityFromWorkspaceApi,
  coordinationCapabilityStatus,
  coordinationSupportForAuthority,
} from '../packages/shared/src/coordination.ts'
import {
  WORKSPACE_EXECUTION_AUTHORITIES,
  WORKSPACE_SUPPORT_APIS,
} from '../packages/shared/src/workspace.ts'

const root = process.cwd()

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('coordination contract defines one shared noun set', () => {
  assert.deepEqual([...COORDINATION_ENTITY_KINDS], [
    'project',
    'task',
    'workflow',
    'run',
    'schedule',
    'watch',
    'delegation',
    'artifact',
    'question',
    'permission',
  ])
  assert.ok(COORDINATION_RUN_KINDS.includes('background'))
  assert.ok(COORDINATION_RUN_KINDS.includes('delegation'))
  assert.ok(COORDINATION_DELEGATION_MODES.includes('opencode_native'))
  assert.ok(COORDINATION_DELEGATION_MODES.includes('gateway_delegate'))
  assert.deepEqual([...COORDINATION_TASK_COLUMNS], ['backlog', 'planning', 'doing', 'review', 'done'])
  assert.deepEqual([...COORDINATION_TASK_PRIORITIES], ['high', 'med', 'low'])
  assert.ok(COORDINATION_WATCH_TARGETS.includes('project'))
  assert.ok(COORDINATION_WATCH_TARGETS.includes('playbook'))
  assert.ok(COORDINATION_WATCH_TARGETS.includes('session'))
  assert.deepEqual([...COORDINATION_WATCH_EVENTS], ['task.moved', 'task.review_ready', 'run.finished', 'needs_input', 'daily_summary'])
})

test('coordination support is explicit for every authority and capability', () => {
  assert.deepEqual(Object.keys(COORDINATION_AUTHORITY_SUPPORT).sort(), [...WORKSPACE_EXECUTION_AUTHORITIES].sort())

  for (const authority of WORKSPACE_EXECUTION_AUTHORITIES) {
    const support = coordinationSupportForAuthority(authority)
    assert.deepEqual(Object.keys(support).sort(), [...COORDINATION_CAPABILITIES].sort())
  }

  assert.equal(coordinationCapabilityStatus('gateway_standalone', 'projects'), 'supported')
  assert.equal(coordinationCapabilityStatus('gateway_standalone', 'delegation'), 'supported')
  assert.equal(coordinationCapabilityStatus('cloud_channel_gateway', 'watches'), 'supported')
  assert.equal(coordinationCapabilityStatus('cloud_channel_gateway', 'projects'), 'deferred')
  assert.equal(coordinationCapabilityStatus('desktop_local', 'workflows'), 'supported')
  assert.equal(coordinationCapabilityStatus('desktop_local', 'projects'), 'supported')
  assert.equal(coordinationCapabilityStatus('desktop_local', 'tasks'), 'supported')
  assert.equal(coordinationCapabilityStatus('desktop_local', 'watches'), 'supported')
  assert.equal(coordinationCapabilityStatus('desktop_paired', 'tasks'), 'read_only')
})

test('workspace support API list includes coordination capabilities', () => {
  assert.deepEqual(Object.keys(COORDINATION_WORKSPACE_SUPPORT_APIS).sort(), [
    'coordination.delegation',
    'coordination.projects',
    'coordination.runs',
    'coordination.schedules',
    'coordination.tasks',
    'coordination.watches',
  ])
  for (const api of [
    'coordination.projects',
    'coordination.tasks',
    'coordination.runs',
    'coordination.schedules',
    'coordination.watches',
    'coordination.delegation',
  ]) {
    assert.ok(WORKSPACE_SUPPORT_APIS.includes(api as never), `workspace support API missing ${api}`)
    assert.ok(coordinationCapabilityFromWorkspaceApi(api), `coordination API missing capability mapping ${api}`)
  }
  assert.equal(coordinationCapabilityFromWorkspaceApi('sessions.prompt'), null)
})

test('coordination docs and public contracts use the shared vocabulary', () => {
  const coordination = read('docs/coordination-model.md')
  const product = read('docs/product-contract.md')
  const workflows = read('docs/workflows.md')
  const standalone = read('docs/standalone-gateway.md')
  const gatewayAppliance = read('docs/gateway-appliance.md')
  const cloudGatewayRegistration = read('docs/cloud-gateway-registration.md')
  const roadmap = read('docs/roadmap.md')
  const mkdocs = read('mkdocs.yml')

  for (const source of [product, workflows, standalone, gatewayAppliance, cloudGatewayRegistration, roadmap, mkdocs]) {
    assert.match(source, /coordination-model\.md/, 'public docs must link the shared coordination model')
  }

  for (const noun of ['Project', 'Task', 'Workflow', 'Run', 'Schedule', 'Watch', 'Delegation', 'Artifact', 'Question', 'Permission']) {
    assert.match(coordination, new RegExp(`\\b${escapeRegex(noun)}\\b`), `coordination doc must mention ${noun}`)
    assert.match(product, new RegExp(`\\b${escapeRegex(noun)}\\b`), `product contract must mention ${noun}`)
  }

  for (const phrase of [
    '`CoordinationTask` is durable product work',
    'It is not `TaskRun`',
    '`CoordinationProject` is a product planning container',
    'It is not a local `projectDirectory`',
    'manager teams are Project/Task/Delegation',
    'cron jobs are Schedule plus Run',
    'background jobs are Runs',
    'native delegation hints are Delegations',
    '`/watch` subscriptions are Watches',
  ]) {
    assert.match(coordination, new RegExp(escapeRegex(phrase)), `coordination doc must preserve boundary: ${phrase}`)
  }
})
