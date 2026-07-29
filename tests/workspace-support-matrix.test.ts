import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKSPACE_API_SUPPORT_STATUSES,
  WORKSPACE_SUPPORT_APIS,
  type WorkspaceApiSupport,
  type WorkspaceApiSupportStatus,
  type WorkspacePolicy,
  type WorkspaceSupportApi,
} from '@open-cowork/shared'
import type { WorkspaceRegistration } from '../apps/desktop/src/main/workspace/workspace-gateway-credential-state.ts'
import {
  workspacePolicyForKind,
  workspaceSupportMatrix,
} from '../apps/desktop/src/main/workspace/workspace-support-matrix.ts'

const REMOTE_DEFERRED_APIS = [
  'sessions.list',
  'sessions.create',
  'sessions.activate',
  'sessions.get',
  'sessions.prompt',
  'sessions.abort',
  'threads.search',
  'threads.tags',
  'threads.smartFilters',
  'workflows.list',
  'workflows.run',
  'coordination.projects',
  'coordination.tasks',
  'coordination.runs',
  'coordination.schedules',
  'coordination.watches',
  'coordination.delegation',
  'artifacts.list',
  'artifacts.index',
  'artifacts.status',
  'artifacts.upload',
  'artifacts.download',
  'capabilities.catalog',
] as const satisfies readonly WorkspaceSupportApi[]

const REMOTE_UNSUPPORTED_APIS = [
  'sessions.fileSnippet',
  'sessions.diff',
  'artifacts.reveal',
  'settings.portable',
  'customContent.agents',
  'customContent.skills',
  'customContent.mcps',
  'localFiles',
  'localStdioMcps',
  'machineRuntimeConfig',
  'voice.capture',
  'voice.stt',
  'voice.tts',
  'voice.conversation',
] as const satisfies readonly WorkspaceSupportApi[]

const CLOUD_FEATURE_APIS = [
  'sessions.list',
  'sessions.create',
  'sessions.activate',
  'sessions.get',
  'sessions.prompt',
  'sessions.abort',
  'threads.search',
  'threads.tags',
  'threads.smartFilters',
  'workflows.list',
  'workflows.run',
  'coordination.runs',
  'coordination.schedules',
  'artifacts.list',
  'artifacts.index',
  'artifacts.status',
  'artifacts.upload',
  'artifacts.download',
  'settings.portable',
  'customContent.agents',
  'customContent.skills',
  'customContent.mcps',
  'capabilities.catalog',
] as const satisfies readonly WorkspaceSupportApi[]

const CLOUD_DEFERRED_APIS = [
  'coordination.projects',
  'coordination.tasks',
  'coordination.watches',
  'coordination.delegation',
] as const satisfies readonly WorkspaceSupportApi[]

const CLOUD_UNSUPPORTED_APIS = [
  'sessions.fileSnippet',
  'sessions.diff',
  'artifacts.reveal',
  'localFiles',
  'localStdioMcps',
  'machineRuntimeConfig',
  'voice.capture',
  'voice.stt',
  'voice.tts',
  'voice.conversation',
] as const satisfies readonly WorkspaceSupportApi[]

function registration(
  kind: WorkspaceRegistration['kind'],
  status: WorkspaceRegistration['status'] = 'online',
): WorkspaceRegistration {
  const authority = kind === 'local'
    ? 'desktop_local'
    : kind === 'cloud'
      ? 'cloud_worker'
      : kind === 'gateway'
        ? 'gateway_standalone'
        : 'desktop_paired'
  return {
    id: kind === 'local' ? 'local' : `${kind}:test`,
    kind,
    authority,
    label: `Test ${kind}`,
    status,
    lastSyncedAt: null,
  }
}

function supportEntry(matrix: WorkspaceApiSupport[], api: WorkspaceSupportApi) {
  const entry = matrix.find((candidate) => candidate.api === api)
  assert.ok(entry, `missing support entry for ${api}`)
  return entry
}

function assertStatusPartition(
  matrix: WorkspaceApiSupport[],
  expected: Partial<Record<WorkspaceApiSupportStatus, readonly WorkspaceSupportApi[]>>,
) {
  assert.deepEqual(matrix.map((entry) => entry.api), [...WORKSPACE_SUPPORT_APIS])
  for (const status of WORKSPACE_API_SUPPORT_STATUSES) {
    assert.deepEqual(
      matrix.filter((entry) => entry.status === status).map((entry) => entry.api),
      [...(expected[status] || [])],
      `${status} partition`,
    )
  }
}

function fullCloudPolicy(): WorkspacePolicy {
  return {
    features: {
      sessions: true,
      threadIndex: true,
      workflows: true,
      artifacts: true,
      settings: true,
      customAgents: true,
      customSkills: true,
      customMcps: true,
      agents: true,
    },
    allowedAgents: null,
    allowedTools: null,
    allowedMcps: null,
    localFiles: 'enabled',
    localStdioMcps: 'enabled',
    machineRuntimeConfig: 'enabled',
  }
}

test('default workspace policies are exact and fail closed for every remote kind', () => {
  assert.deepEqual(workspacePolicyForKind('local'), {
    features: {
      sessions: true,
      threads: true,
      workflows: true,
      artifacts: true,
      settings: true,
      customContent: true,
      capabilities: true,
    },
    allowedAgents: null,
    allowedTools: null,
    allowedMcps: null,
    localFiles: 'enabled',
    localStdioMcps: 'enabled',
    machineRuntimeConfig: 'allowlisted',
  })
  const disabledCloud = {
    features: {
      sessions: false,
      threads: false,
      workflows: false,
      artifacts: false,
      settings: false,
      customContent: false,
      capabilities: false,
    },
    allowedAgents: [],
    allowedTools: [],
    allowedMcps: [],
    localFiles: 'disabled',
    localStdioMcps: 'disabled',
    machineRuntimeConfig: 'disabled',
  }
  assert.deepEqual(workspacePolicyForKind('cloud'), disabledCloud)
  assert.deepEqual(workspacePolicyForKind('gateway'), disabledCloud)
  assert.deepEqual(workspacePolicyForKind('paired_desktop'), disabledCloud)
})

test('local support matrix contains every API as an allowed Desktop Local capability', () => {
  const matrix = workspaceSupportMatrix(registration('local'))
  assertStatusPartition(matrix, { supported: WORKSPACE_SUPPORT_APIS })
  assert.equal(matrix.every((entry) => entry.verdict?.allowed === true), true)
  assert.equal(matrix.every((entry) => entry.verdict?.reason === null), true)
  assert.deepEqual(supportEntry(matrix, 'artifacts.reveal').context, {
    authority: 'desktop_local',
    runtimeAuthority: 'desktop_local',
    surface: 'desktop_local',
    durableStateOwner: 'desktop_local_store',
    ownership: {
      sessions: 'desktop_local_store',
      events: 'desktop_local_store',
      projections: 'desktop_local_store',
      workflows: 'desktop_local_store',
      artifacts: 'desktop_local_store',
      settings: 'desktop_local_store',
      credentials: 'desktop_local_store',
      approvals: 'desktop_local_store',
      questions: 'desktop_local_store',
      audit: 'desktop_local_store',
    },
    onlineState: 'online',
    mutation: 'supported',
    artifacts: {
      metadata: 'supported',
      body: 'local_filesystem',
      reveal: 'local_filesystem',
    },
    approvals: 'desktop_local',
    questions: 'desktop_local',
    workflows: 'supported',
    pathExposure: 'local_private',
    pairingState: 'not_applicable',
  })
})

test('Gateway and Paired Desktop matrices have exact remote status partitions and authority contexts', () => {
  const gateway = workspaceSupportMatrix(registration('gateway'))
  assertStatusPartition(gateway, {
    deferred: REMOTE_DEFERRED_APIS,
    not_supported: REMOTE_UNSUPPORTED_APIS,
  })
  assert.equal(supportEntry(gateway, 'sessions.list').context?.authority, 'gateway_standalone')
  assert.equal(supportEntry(gateway, 'sessions.list').context?.runtimeAuthority, 'gateway_standalone')
  assert.equal(supportEntry(gateway, 'artifacts.list').context?.artifacts.body, 'gateway_artifact_store')
  assert.equal(supportEntry(gateway, 'artifacts.reveal').context?.artifacts.reveal, 'none')
  assert.equal(supportEntry(gateway, 'localFiles').context?.pathExposure, 'redacted_remote')

  const paired = workspaceSupportMatrix(registration('paired_desktop'))
  assertStatusPartition(paired, {
    deferred: REMOTE_DEFERRED_APIS,
    not_supported: REMOTE_UNSUPPORTED_APIS,
  })
  assert.equal(supportEntry(paired, 'sessions.list').context?.authority, 'desktop_paired')
  assert.equal(supportEntry(paired, 'sessions.list').context?.runtimeAuthority, 'desktop_local')
  assert.equal(supportEntry(paired, 'sessions.list').context?.pairingState, 'paired_online')
  assert.equal(supportEntry(paired, 'artifacts.list').context?.artifacts.body, 'redacted_metadata_only')

  const offline = workspaceSupportMatrix(registration('paired_desktop', 'offline'))
  assert.equal(supportEntry(offline, 'sessions.list').context?.pairingState, 'paired_offline')
  assert.equal(
    supportEntry(offline, 'sessions.list').verdict?.reason,
    'Paired Desktop connector is offline or disabled.',
  )
})

test('Cloud support matrix exactly partitions enabled, policy-blocked, deferred, and host-only APIs', () => {
  const workspace = registration('cloud')
  const enabled = workspaceSupportMatrix(workspace, fullCloudPolicy())
  assertStatusPartition(enabled, {
    supported: CLOUD_FEATURE_APIS,
    deferred: CLOUD_DEFERRED_APIS,
    not_supported: CLOUD_UNSUPPORTED_APIS,
  })
  assert.equal(supportEntry(enabled, 'sessions.prompt').context?.authority, 'cloud_worker')
  assert.equal(supportEntry(enabled, 'sessions.prompt').context?.pathExposure, 'cloud_safe_refs')
  assert.equal(supportEntry(enabled, 'artifacts.reveal').context?.artifacts.reveal, 'none')
  assert.equal(supportEntry(enabled, 'localFiles').context?.pathExposure, 'not_exposed')

  const disabled = workspaceSupportMatrix(workspace, workspacePolicyForKind('cloud'))
  assertStatusPartition(disabled, {
    blocked_by_policy: CLOUD_FEATURE_APIS,
    deferred: CLOUD_DEFERRED_APIS,
    not_supported: CLOUD_UNSUPPORTED_APIS,
  })
  assert.deepEqual(supportEntry(disabled, 'sessions.prompt').context?.blockedReason, {
    allowed: false,
    reason: 'Cloud chat is disabled by this workspace policy.',
    policyCode: 'blocked_by_policy',
  })
})

test('explicit Cloud chat policy overrides the legacy sessions fallback', () => {
  const policy = fullCloudPolicy()
  policy.features.chat = false
  const matrix = workspaceSupportMatrix(registration('cloud'), policy)

  for (const api of [
    'sessions.list',
    'sessions.create',
    'sessions.activate',
    'sessions.get',
    'sessions.prompt',
    'sessions.abort',
  ] as const) {
    assert.equal(supportEntry(matrix, api).status, 'blocked_by_policy')
  }
  assert.equal(supportEntry(matrix, 'threads.search').status, 'supported')
})

test('Cloud support matrix keeps custom-content and catalog feature flags independent', () => {
  const customAgentsOnly: WorkspacePolicy = {
    ...workspacePolicyForKind('cloud'),
    features: { customAgents: true },
  }
  const customAgents = workspaceSupportMatrix(registration('cloud'), customAgentsOnly)
  assert.equal(supportEntry(customAgents, 'customContent.agents').status, 'supported')
  assert.equal(supportEntry(customAgents, 'customContent.skills').status, 'blocked_by_policy')
  assert.equal(supportEntry(customAgents, 'customContent.mcps').status, 'blocked_by_policy')
  assert.equal(supportEntry(customAgents, 'capabilities.catalog').status, 'blocked_by_policy')

  const agentsOnly: WorkspacePolicy = {
    ...workspacePolicyForKind('cloud'),
    features: { agents: true },
  }
  const agents = workspaceSupportMatrix(registration('cloud'), agentsOnly)
  assert.equal(supportEntry(agents, 'customContent.agents').status, 'blocked_by_policy')
  assert.equal(supportEntry(agents, 'capabilities.catalog').status, 'supported')

  const neighboringFlagsOnly: WorkspacePolicy = {
    ...workspacePolicyForKind('cloud'),
    features: {
      capabilities: true,
      customSkills: true,
      customMcps: true,
    },
  }
  const neighboringFlags = workspaceSupportMatrix(registration('cloud'), neighboringFlagsOnly)
  assert.equal(supportEntry(neighboringFlags, 'customContent.agents').status, 'blocked_by_policy')
  assert.equal(supportEntry(neighboringFlags, 'customContent.skills').status, 'supported')
  assert.equal(supportEntry(neighboringFlags, 'customContent.mcps').status, 'supported')
  assert.equal(supportEntry(neighboringFlags, 'capabilities.catalog').status, 'blocked_by_policy')
})
