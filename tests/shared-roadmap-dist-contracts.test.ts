import { applyCapabilityBundleInstall, applyCapabilityBundleUninstall, applyCapabilityBundleUpdate, createEmptyCapabilityBundleLifecycleState, normalizeCapabilityBundleManifest, planCapabilityBundleInstall, planCapabilityBundleUninstall, planCapabilityBundleUpdate, validateCapabilityBundleRuntimeSupport } from '@open-cowork/runtime-host/capability-bundle-engine'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cloudArtifactFilePath,
  cloudArtifactIdFromFilePath,
} from '../packages/shared/dist/artifacts.js'
import {
  assertCloudChannelGatewayProductMode,
  assertStandaloneGatewayProductMode,
  parseGatewayProductMode,
  resolveGatewayProductMode,
  resolveStandaloneGatewayProductMode,
} from '../packages/shared/dist/app-config.js'
import {
  CAPABILITY_BUNDLE_FORMAT,
  type CapabilityBundleManifest,
} from '../packages/shared/dist/capabilities.js'
import {
  cloudGatewayRegistrationAllowsEdgeWork,
  cloudGatewayRegistrationContract,
} from '../packages/shared/dist/cloud-gateway-registration.js'
import {
  CLOUD_AUTOMATION_EVENT_STREAM_VERSION,
  CLOUD_PROJECTION_SYNC_CONTRACT_VERSION,
  CLOUD_SESSION_EVENT_CONTRACT,
  CLOUD_SESSION_PROJECTION_CONTRACT_VERSION,
  cloudProjectionFenceIdentityKey,
  cloudProjectionFenceObserved,
  cloudSessionEventContractFor,
  cloudSessionEventHasFacet,
  cloudSessionEventIsChannelRenderable,
  createCloudAutomationEventEnvelope,
  createCloudProjectionCheckpoint,
  createCloudProjectionFenceToken,
  evaluateCloudProjectionFenceCheckpoint,
  formatCloudAutomationTerminalStatusLine,
  isCloudProjectedSessionEventType,
  isCloudSessionEventType,
  parseCloudAutomationTerminalStatusLine,
  waitForCloudProjectionFence,
} from '../packages/shared/dist/cloud-session-contract.js'
import {
  resolveHttpClientSource,
  splitTrustedProxyCidrs,
} from '../packages/shared/dist/http-client-source.js'
import {
  jsonConfigCandidates,
  parseJsoncText,
  stripJsonComments,
  stripTrailingCommas,
} from '../packages/shared/dist/jsonc.js'
import { evaluateRemoteApprovalPolicy } from '../packages/shared/dist/remote-approval-policy.js'
import {
  createResourceDeepLink,
  createResourceIdentity,
  createResourceLookupResult,
  createResourceOpenAction,
  parseResourceDeepLink,
  parseResourceIdentity,
  resolveResourceDeepLinkOpenAction,
} from '../packages/shared/dist/resource-identity.js'
import {
  authorizeSemanticUiTool,
  createSemanticUiActionList,
  createSemanticUiActionResult,
  createSemanticUiSnapshot,
  createSemanticUiStatus,
} from '../packages/shared/dist/semantic-ui.js'
import {
  computeNextWorkflowRunAt,
  computeNextWorkflowScheduleRunAt,
  validateWorkflowSchedule,
} from '../packages/shared/dist/workflow.js'
import * as sourceGatewayModes from '../packages/shared/src/app-config.ts'
import * as sourceCloudSessionContract from '../packages/shared/src/cloud-session-contract.ts'

function bundle(overrides: Partial<CapabilityBundleManifest> = {}): CapabilityBundleManifest {
  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    name: 'dist-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    compatibility: {
      productModes: {
        'desktop-local': 'supported',
        'desktop-cloud': 'supported',
      },
    },
    resources: [
      { kind: 'skill', id: 'dist-skill', ownedByBundle: true },
    ],
    permissions: [],
    uninstall: { removes: [{ kind: 'skill', id: 'dist-skill' }], preserves: [] },
    ...overrides,
  }
}

test('dist capability manifest normalization reports invalid object, resource, and permission shapes', () => {
  assert.deepEqual(normalizeCapabilityBundleManifest(null), {
    ok: false,
    issues: [{ code: 'invalid_manifest', message: 'Capability bundle manifest must be a JSON object.' }],
  })

  const result = normalizeCapabilityBundleManifest({
    format: 'wrong',
    name: '',
    version: '',
    owner: '',
    resources: [
      { kind: 'unknown', id: 'bad' },
      { kind: 'skill', id: 'bad id with spaces' },
      { kind: 'opencode-plugin', id: 'plugin-without-tier' },
    ],
    permissions: [
      { kind: 'shell', id: 'run-tests', reason: '' },
      { kind: 'bogus', id: 'bad-permission', reason: 'bad' },
      { kind: 'mcp', id: 'bad permission id', reason: 'bad' },
    ],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set([
    'invalid_format',
    'name_required',
    'version_required',
    'owner_required',
    'invalid_resource_kind',
    'invalid_resource_id',
    'plugin_compatibility_required',
    'permission_reason_required',
    'invalid_permission_kind',
    'invalid_permission_id',
  ]))
})

test('dist capability manifest normalization requires schema collections unless legacy defaults are explicit', () => {
  const result = normalizeCapabilityBundleManifest({
    format: CAPABILITY_BUNDLE_FORMAT,
    name: 'dist-schema-pack',
    version: '1.0.0',
    owner: 'open-cowork',
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.issues.some((issue) => issue.code === 'resources_required'), true)
  assert.equal(result.issues.some((issue) => issue.code === 'permissions_required'), true)
})

test('dist capability planning blocks unsafe remote resources and reviews native helpers', () => {
  const installPlan = planCapabilityBundleInstall(bundle({
    resources: [
      { kind: 'mcp', id: 'public-mcp', url: 'https://mcp.example.com/api', ownedByBundle: true },
      { kind: 'mcp', id: 'local-mcp', command: 'node server.js', ownedByBundle: true },
      { kind: 'native-helper', id: 'native-helper', ownedByBundle: true },
      { kind: 'opencode-plugin', id: 'blocked-plugin', compatibilityTier: 'blocked' },
    ],
    permissions: [
      { kind: 'workflow', id: 'trigger-workflow', reason: 'Create a workflow run.' },
      { kind: 'credential', id: 'api-token', reason: 'Use an API token.' },
    ],
  }), { productMode: 'desktop-cloud' })

  assert.equal(installPlan.blocked, true)
  assert.equal(installPlan.blockers.some((blocker) => blocker.code === 'mcp_stdio_unsupported_product_mode'), true)
  assert.equal(installPlan.blockers.some((blocker) => blocker.code === 'plugin_compatibility_blocked'), true)
  assert.equal(installPlan.actions.some((action) => action.action === 'install' && action.id === 'public-mcp'), true)
  assert.equal(installPlan.risk.reasons.some((reason) => reason.includes('Native helper')), true)
  assert.equal(installPlan.risk.reasons.some((reason) => reason.includes('credential permission')), true)

  const support = validateCapabilityBundleRuntimeSupport([bundle({
    resources: [
      { kind: 'native-helper', id: 'native-helper', productModes: ['desktop-cloud'] },
      { kind: 'mcp', id: 'remote-stdio', command: 'node server.js' },
      { kind: 'mcp', id: 'private-url', url: 'https://10.0.0.10/mcp' },
      { kind: 'opencode-plugin', id: 'experimental-plugin', compatibilityTier: 'experimental', productModes: ['desktop-cloud'] },
    ],
  })], { productMode: 'desktop-cloud' })

  assert.equal(support.runtimeStartAllowed, false)
  assert.equal(support.blockers.some((blocker) => blocker.code === 'mcp_stdio_unsupported_product_mode'), true)
  assert.equal(support.blockers.some((blocker) => blocker.code === 'mcp_url_blocked'), true)
  assert.equal(support.blockers.some((blocker) => blocker.code === 'plugin_remote_compatibility_required'), true)
  assert.equal(support.warnings.some((warning) => warning.code === 'native_helper_component_manifest_required'), true)
})

test('dist capability lifecycle applies install, update fallback, duplicate install, and missing uninstall outcomes', () => {
  const now = '2026-06-03T00:00:00.000Z'
  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), bundle(), {
    productMode: 'desktop-local',
    now,
  })

  assert.equal(installed.applied, true)
  assert.equal(installed.state.resources[0]?.owner, 'bundle')
  assert.equal(installed.audit[0]?.outcome, 'installed')

  const duplicate = applyCapabilityBundleInstall(installed.state, bundle(), {
    productMode: 'desktop-local',
    now,
  })
  assert.equal(duplicate.applied, false)
  assert.equal(duplicate.audit.some((event) => event.outcome === 'blocked'), true)

  const updatedFromMissing = applyCapabilityBundleUpdate(createEmptyCapabilityBundleLifecycleState(), bundle({
    name: 'new-pack',
  }), {
    productMode: 'desktop-local',
    now,
  })
  assert.equal(updatedFromMissing.applied, true)
  assert.equal(updatedFromMissing.plan.previousVersion, '')
  assert.equal(updatedFromMissing.audit.every((event) => event.action === 'update'), true)

  const missingUninstall = applyCapabilityBundleUninstall(createEmptyCapabilityBundleLifecycleState(), 'missing-pack')
  assert.equal(missingUninstall.applied, false)
  assert.equal(missingUninstall.plan.blockers[0]?.code, 'bundle_not_installed')
})

test('dist capability lifecycle uses kind-qualified resource identity', () => {
  const installPlan = planCapabilityBundleInstall(bundle({
    resources: [
      { kind: 'skill', id: 'shared-id', ownedByBundle: true },
      { kind: 'workflow', id: 'shared-id', ownedByBundle: true },
    ],
  }), {
    productMode: 'desktop-local',
    existingResourceIds: [{ kind: 'workflow', id: 'shared-id' }],
  })

  assert.deepEqual(installPlan.actions.map((action) => `${action.action}:${action.kind}:${action.id}`), [
    'install:skill:shared-id',
    'preserve_user_resource:workflow:shared-id',
  ])

  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), bundle({
    resources: [
      { kind: 'skill', id: 'shared-id', ownedByBundle: true },
      { kind: 'workflow', id: 'shared-id', ownedByBundle: true },
    ],
    uninstall: {
      removes: [{ kind: 'skill', id: 'shared-id' }],
      preserves: [{ kind: 'workflow', id: 'shared-id' }],
    },
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T00:00:00.000Z',
  })
  const uninstalled = applyCapabilityBundleUninstall(installed.state, 'dist-pack')

  assert.deepEqual(uninstalled.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'user:workflow:shared-id',
  ])
})

test('dist capability lifecycle removes and preserves installed resources across uninstall and update', () => {
  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), bundle({
    resources: [
      { kind: 'skill', id: 'dist-skill', ownedByBundle: true },
      { kind: 'agent', id: 'old-agent', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
      { kind: 'command', id: 'operator-command', ownedByBundle: true },
    ],
    uninstall: {
      removes: [
        { kind: 'skill', id: 'dist-skill' },
        { kind: 'agent', id: 'old-agent' },
        { kind: 'workflow', id: 'operator-workflow' },
        { kind: 'command', id: 'missing-resource' },
      ],
      preserves: [{ kind: 'command', id: 'operator-command' }],
    },
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T00:00:00.000Z',
  })

  const uninstallPlan = planCapabilityBundleUninstall(installed.state.bundles[0]!.manifest, {
    installedResourceIds: installed.state.resources.map((resource) => ({ kind: resource.kind, id: resource.id })),
    userOwnedResourceIds: installed.state.resources
      .filter((resource) => resource.owner === 'user')
      .map((resource) => ({ kind: resource.kind, id: resource.id })),
  })

  assert.deepEqual(uninstallPlan.actions.map((action) => `${action.action}:${action.kind}:${action.id}`), [
    'remove_bundle_resource:skill:dist-skill',
    'remove_bundle_resource:agent:old-agent',
    'preserve_user_resource:command:operator-command',
    'preserve_user_resource:workflow:operator-workflow',
  ])

  const uninstalled = applyCapabilityBundleUninstall(installed.state, 'dist-pack')
  assert.equal(uninstalled.applied, true)
  assert.deepEqual(uninstalled.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'user:command:operator-command',
    'user:workflow:operator-workflow',
  ])
  assert.equal(uninstalled.audit.some((event) => event.outcome === 'removed' && event.id === 'dist-skill'), true)
  assert.equal(uninstalled.audit.some((event) => event.outcome === 'preserved' && event.id === 'operator-workflow'), true)

  const next = bundle({
    version: '1.1.0',
    resources: [
      { kind: 'skill', id: 'dist-skill', ownedByBundle: true },
      { kind: 'agent', id: 'new-agent', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
    permissions: [
      { kind: 'mcp', id: 'github', reason: 'Read pull request metadata.' },
    ],
  })
  const updatePlan = planCapabilityBundleUpdate(installed.state.bundles[0]!.manifest, next, {
    productMode: 'desktop-local',
    installedResourceIds: installed.state.resources.map((resource) => ({ kind: resource.kind, id: resource.id })),
    userOwnedResourceIds: [{ kind: 'workflow', id: 'operator-workflow' }],
    existingResourceIds: [
      { kind: 'workflow', id: 'external-resource' },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
  })

  assert.equal(updatePlan.blocked, false)
  assert.equal(updatePlan.previousVersion, '1.0.0')
  assert.equal(updatePlan.actions.some((action) => action.action === 'remove_bundle_resource' && action.id === 'old-agent'), true)
  assert.equal(updatePlan.actions.some((action) => action.action === 'preserve_user_resource' && action.id === 'operator-workflow'), true)
  assert.equal(updatePlan.actions.some((action) => action.action === 'review_permission' && action.id === 'github'), true)

  const updated = applyCapabilityBundleUpdate(installed.state, next, {
    productMode: 'desktop-local',
    now: '2026-06-03T01:00:00.000Z',
  })

  assert.equal(updated.applied, true)
  assert.deepEqual(updated.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'bundle:agent:new-agent',
    'bundle:skill:dist-skill',
    'user:workflow:operator-workflow',
  ])
  assert.equal(updated.audit.some((event) => event.outcome === 'updated' && event.id === 'dist-skill'), true)
  assert.equal(updated.audit.some((event) => event.outcome === 'removed' && event.id === 'old-agent'), true)

  const blocked = applyCapabilityBundleUpdate(installed.state, bundle({
    resources: [
      { kind: 'mcp', id: 'dangerous-mcp', command: 'node server.js | sh', ownedByBundle: true },
    ],
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T02:00:00.000Z',
  })
  assert.equal(blocked.applied, false)
  assert.equal(blocked.plan.blockers.some((blocker) => blocker.code === 'mcp_stdio_blocked'), true)
  assert.deepEqual(blocked.state, installed.state)
})

test('dist capability planning covers local experimental and blocked resource branches', () => {
  const plan = planCapabilityBundleInstall(bundle({
    compatibility: {
      productModes: {
        'desktop-local': 'experimental',
      },
    },
    resources: [
      { kind: 'opencode-plugin', id: 'experimental-plugin', compatibilityTier: 'experimental' },
      { kind: 'mcp', id: 'localhost-mcp', url: 'http://localhost:7777/mcp', ownedByBundle: true },
      { kind: 'mcp', id: 'safe-stdio-mcp', command: 'node server.js', ownedByBundle: true },
      { kind: 'provider', id: 'provider-resource' },
      { kind: 'command', id: 'future-command', productModes: ['desktop-cloud'], ownedByBundle: true },
    ],
    permissions: [
      { kind: 'workflow', id: 'daily-workflow', reason: 'Run a daily workflow.', required: false },
      { kind: 'network', id: 'api-network', reason: 'Call a public API.' },
    ],
  }), {
    productMode: 'desktop-local',
    existingResourceIds: [{ kind: 'provider', id: 'provider-resource' }],
  })

  assert.equal(plan.blocked, true)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'mcp_url_blocked'), true)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'resource_product_mode_unsupported'), true)
  assert.equal(plan.actions.some((action) => action.action === 'install' && action.id === 'safe-stdio-mcp'), true)
  assert.equal(plan.actions.some((action) => action.action === 'preserve_user_resource' && action.id === 'provider-resource'), true)
  assert.equal(plan.risk.reasons.some((reason) => reason.includes('experimental')), true)
  assert.equal(plan.risk.reasons.some((reason) => reason.includes('network permission')), true)
})

test('dist JSONC helpers preserve strings while removing comments and trailing commas', () => {
  const raw = `{
    // comment
    "url": "https://example.com/a//b",
    "escaped": "quote: \\" and slash: \\\\",
    "items": [1, 2,],
    /* block */
  }`

  assert.equal(stripJsonComments('"not // a comment" // comment'), '"not // a comment" ')
  assert.equal(stripTrailingCommas('{"a": [1, 2,], "b": "x,y," ,}'), '{"a": [1, 2], "b": "x,y," }')
  assert.deepEqual(parseJsoncText(raw), {
    url: 'https://example.com/a//b',
    escaped: 'quote: " and slash: \\',
    items: [1, 2],
  })
  assert.throws(() => parseJsoncText('[1, 2]'), /top-level object/)
  assert.deepEqual(jsonConfigCandidates('/tmp/config'), ['/tmp/config.jsonc', '/tmp/config.json'])
  assert.deepEqual(jsonConfigCandidates('/tmp/config.json'), ['/tmp/config.jsonc', '/tmp/config.json'])
})

test('dist artifact helpers encode and reject cloud artifact URI forms', () => {
  const uri = cloudArtifactFilePath('artifact/id with spaces', 'report name.md')

  assert.equal(uri, 'cloud-artifact://artifact%2Fid%20with%20spaces/report%20name.md')
  assert.equal(cloudArtifactIdFromFilePath(uri), 'artifact/id with spaces')
  assert.equal(cloudArtifactFilePath('artifact-1', '   '), 'cloud-artifact://artifact-1/artifact')
  assert.equal(cloudArtifactIdFromFilePath('/tmp/local.txt'), null)
  assert.equal(cloudArtifactIdFromFilePath('cloud-artifact://'), null)
  assert.equal(cloudArtifactIdFromFilePath('cloud-artifact://%E0%A4%A/file'), null)
})

test('dist gateway product mode helpers keep cloud and standalone apps separate', () => {
  assert.equal(parseGatewayProductMode(' cloud_channel '), 'cloud_channel')
  assert.equal(parseGatewayProductMode(''), null)
  assert.equal(resolveGatewayProductMode(undefined, undefined), 'cloud_channel')
  assert.equal(resolveGatewayProductMode('cloud_channel', 'standalone'), 'cloud_channel')
  assert.equal(resolveStandaloneGatewayProductMode(undefined, undefined), 'standalone')
  assert.equal(resolveStandaloneGatewayProductMode(undefined, 'standalone'), 'standalone')
  assert.doesNotThrow(() => assertCloudChannelGatewayProductMode('cloud_channel'))
  assert.doesNotThrow(() => assertStandaloneGatewayProductMode('standalone'))
  assert.throws(() => parseGatewayProductMode('public'), /Unsupported gateway productMode/)
  assert.throws(() => resolveGatewayProductMode('standalone', undefined), /apps\/standalone-gateway/)
  assert.throws(() => resolveGatewayProductMode('hybrid', undefined), /reserved/)
  assert.throws(() => resolveStandaloneGatewayProductMode('cloud_channel', undefined), /apps\/gateway/)
  assert.throws(() => resolveStandaloneGatewayProductMode('hybrid', undefined), /reserved/)
})

test('source gateway product mode helpers reject cross-product configuration', () => {
  assert.equal(sourceGatewayModes.parseGatewayProductMode('standalone'), 'standalone')
  assert.equal(sourceGatewayModes.resolveGatewayProductMode(undefined, 'cloud_channel'), 'cloud_channel')
  assert.equal(sourceGatewayModes.resolveStandaloneGatewayProductMode(undefined, 'standalone'), 'standalone')
  assert.doesNotThrow(() => sourceGatewayModes.assertCloudChannelGatewayProductMode('cloud_channel'))
  assert.doesNotThrow(() => sourceGatewayModes.assertStandaloneGatewayProductMode('standalone'))
  assert.throws(() => sourceGatewayModes.parseGatewayProductMode('public'), /Unsupported gateway productMode/)
  assert.throws(() => sourceGatewayModes.resolveGatewayProductMode('standalone', undefined), /apps\/standalone-gateway/)
  assert.throws(() => sourceGatewayModes.resolveStandaloneGatewayProductMode('cloud_channel', undefined), /apps\/gateway/)
})

test('dist cloud gateway registration contracts distinguish external and edge authority', () => {
  const external = cloudGatewayRegistrationContract('external_workspace')
  const edge = cloudGatewayRegistrationContract('edge_worker')
  const split = cloudGatewayRegistrationContract('external_workspace_edge_worker')

  assert.equal(external.gatewayOwnsStandaloneSessions, true)
  assert.equal(external.cloudCanRouteEligibleWorkToGateway, false)
  assert.equal(edge.requiresManagedWorkerLeaseFencing, true)
  assert.equal(edge.artifactOwnership, 'cloud_owned')
  assert.equal(split.artifactOwnership, 'split_by_work_owner')
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('external_workspace', 'self_hosted_same_operator'), false)
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('edge_worker', 'self_hosted_same_operator'), true)
  assert.equal(cloudGatewayRegistrationAllowsEdgeWork('edge_worker', 'customer_hosted_managed_saas_deferred'), false)
})

test('dist workflow schedule helpers validate and compute next runs across trigger types', () => {
  const from = new Date('2026-06-03T10:30:00.000Z')

  assert.equal(validateWorkflowSchedule({ type: 'daily', timezone: 'UTC' }), null)
  assert.equal(validateWorkflowSchedule({ type: 'weekly', timezone: 'UTC', dayOfWeek: 7 }), 'Weekly schedules require dayOfWeek between 0 and 6.')
  assert.equal(validateWorkflowSchedule({ type: 'monthly', timezone: 'UTC', dayOfMonth: 32 }), 'Monthly schedules require dayOfMonth between 1 and 31.')
  assert.equal(validateWorkflowSchedule({ type: 'one_time', timezone: 'UTC' }), 'One-time schedules require startAt.')
  assert.equal(validateWorkflowSchedule({ type: 'daily', timezone: 'Not/AZone' }), 'Schedule timezone is invalid.')
  assert.equal(validateWorkflowSchedule({ type: 'daily', timezone: 'UTC', runAtHour: 24 }), 'Schedule runAtHour must be an integer between 0 and 23.')
  assert.equal(validateWorkflowSchedule({ type: 'daily', timezone: 'UTC', runAtMinute: 60 }), 'Schedule runAtMinute must be an integer between 0 and 59.')
  assert.equal(validateWorkflowSchedule({ type: 'one_time', timezone: 'UTC', startAt: 'not-a-date' }, from), 'Schedule startAt must be a valid ISO timestamp.')
  assert.equal(validateWorkflowSchedule({ type: 'one_time', timezone: 'UTC', startAt: '2026-06-03T09:00:00.000Z' }, from), 'Schedule startAt must be in the future.')
  assert.equal(validateWorkflowSchedule({ type: 'one_time', timezone: 'UTC', startAt: '2026-06-03T11:00:00.000Z' }, from), null)

  assert.equal(computeNextWorkflowScheduleRunAt({
    type: 'one_time',
    timezone: 'UTC',
    startAt: '2026-06-03T11:00:00.000Z',
  }, from), '2026-06-03T11:00:00.000Z')
  assert.equal(computeNextWorkflowScheduleRunAt({
    type: 'one_time',
    timezone: 'UTC',
    startAt: '2026-06-03T09:00:00.000Z',
  }, from), null)
  assert.equal(computeNextWorkflowScheduleRunAt({
    type: 'daily',
    timezone: 'UTC',
    runAtHour: 9,
    runAtMinute: 15,
  }, from), '2026-06-04T09:15:00.000Z')
  assert.equal(computeNextWorkflowScheduleRunAt({
    type: 'daily',
    timezone: 'UTC',
    startAt: '2026-06-05T10:00:00.000Z',
    runAtHour: 9,
    runAtMinute: 15,
  }, from), '2026-06-06T09:15:00.000Z')
  assert.equal(computeNextWorkflowScheduleRunAt({
    type: 'weekly',
    timezone: 'UTC',
    dayOfWeek: 3,
    runAtHour: 12,
    runAtMinute: 0,
  }, from), '2026-06-03T12:00:00.000Z')
  assert.equal(computeNextWorkflowScheduleRunAt({
    type: 'monthly',
    timezone: 'UTC',
    dayOfMonth: 31,
    runAtHour: 9,
    runAtMinute: 0,
  }, new Date('2026-02-15T10:00:00.000Z')), '2026-02-28T09:00:00.000Z')
  assert.equal(computeNextWorkflowRunAt([
    { id: 'disabled', type: 'schedule', enabled: false, schedule: { type: 'daily', timezone: 'UTC' } },
    { id: 'webhook', type: 'webhook', enabled: true },
    { id: 'daily', type: 'schedule', enabled: true, schedule: { type: 'daily', timezone: 'UTC', runAtHour: 11, runAtMinute: 0 } },
  ], from), '2026-06-03T11:00:00.000Z')
})

test('dist cloud session contract exports a complete projected event vocabulary', () => {
  assert.equal(CLOUD_SESSION_PROJECTION_CONTRACT_VERSION, 1)
  assert.equal(CLOUD_PROJECTION_SYNC_CONTRACT_VERSION, 1)
  assert.equal(CLOUD_AUTOMATION_EVENT_STREAM_VERSION, 1)
  assert.equal(CLOUD_SESSION_EVENT_CONTRACT.length > 15, true)

  for (const entry of CLOUD_SESSION_EVENT_CONTRACT) {
    assert.equal(cloudSessionEventContractFor(entry.type)?.description, entry.description)
    assert.equal(cloudSessionEventHasFacet(entry.type, entry.facets[0]), true)
  }

  assert.equal(cloudSessionEventContractFor('not.real'), null)
  assert.equal(cloudSessionEventHasFacet('not.real', 'control'), false)
})

test('dist and source cloud projection helpers enforce durable fence and automation contracts', async () => {
  const issuedAt = '2026-06-03T00:00:00.000Z'
  const expiresAt = '2026-06-03T00:00:10.000Z'
  const fence = createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    commandId: 'command-1',
    sequence: 7,
    projectionVersion: 3,
    checkpointVersion: 2,
    issuedAt,
    expiresAt,
  })
  const checkpoint = createCloudProjectionCheckpoint({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 7,
    projectionVersion: 3,
    checkpointVersion: 2,
    updatedAt: issuedAt,
  })

  assert.equal(cloudProjectionFenceIdentityKey(fence), 'session:tenant-1:session-1')
  assert.equal(cloudProjectionFenceObserved(fence, checkpoint), true)
  assert.equal(evaluateCloudProjectionFenceCheckpoint({
    fence,
    checkpoint,
    nowMs: Date.parse(issuedAt),
  }).code, 'projection_fence_observed')
  assert.equal(evaluateCloudProjectionFenceCheckpoint({
    fence,
    checkpoint: null,
    nowMs: Date.parse(issuedAt),
  }).code, 'projection_fence_checkpoint_missing')
  assert.equal(evaluateCloudProjectionFenceCheckpoint({
    fence,
    checkpoint,
    nowMs: Date.parse('2026-06-03T00:00:11.000Z'),
  }).code, 'projection_fence_expired')

  const waitFence = createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 7,
    projectionVersion: 3,
    issuedAt,
  })
  const observed = await waitForCloudProjectionFence({
    fence: waitFence,
    readCheckpoint: async () => checkpoint,
    timeoutMs: 0,
  })
  assert.equal(observed.ok, true)

  const timeoutFence = createCloudProjectionFenceToken({
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 99,
    issuedAt,
  })
  const nowSequence = [0, 0, 0, 0, 2]
  const timedOut = await waitForCloudProjectionFence({
    fence: timeoutFence,
    readCheckpoint: async () => null,
    timeoutMs: 1,
    intervalMs: 1,
    nowMs: () => nowSequence.shift() ?? 2,
  })
  assert.equal(timedOut.code, 'projection_fence_timeout')

  const event = createCloudAutomationEventEnvelope({
    eventId: 'event-1',
    type: 'workflow.run',
    source: 'workflow',
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 8,
    projectionVersion: 4,
    fence,
    payload: { ok: true },
    createdAt: issuedAt,
  })
  const line = formatCloudAutomationTerminalStatusLine(event, issuedAt)
  const parsed = parseCloudAutomationTerminalStatusLine(line)

  assert.equal(parsed?.event.eventId, 'event-1')
  assert.equal(parseCloudAutomationTerminalStatusLine('not json'), null)
  assert.equal(parseCloudAutomationTerminalStatusLine('{"kind":"other"}'), null)
  assert.equal(isCloudProjectedSessionEventType('assistant.message'), true)
  assert.equal(isCloudSessionEventType('snapshot.required'), true)
  assert.equal(cloudSessionEventIsChannelRenderable('assistant.message'), true)
  assert.equal(cloudSessionEventIsChannelRenderable('session.created'), false)
  assert.throws(() => createCloudProjectionFenceToken({
    scope: 'client',
    tenantId: 'bad tenant',
    clientId: 'client-1',
    sequence: 1,
  }), /tenantId/)
  assert.throws(() => createCloudAutomationEventEnvelope({
    eventId: 'event-2',
    type: 'workflow.run',
    source: 'workflow',
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId: 'session-2',
    sequence: 9,
    fence,
    payload: {},
  }), /fence identity/)

  const sourceFence = sourceCloudSessionContract.createCloudProjectionFenceToken({
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    sequence: 5,
    projectionVersion: 2,
    issuedAt,
  })
  const sourceCheckpoint = sourceCloudSessionContract.createCloudProjectionCheckpoint({
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    sequence: 5,
    projectionVersion: 2,
    updatedAt: issuedAt,
  })
  const sourceEvent = sourceCloudSessionContract.createCloudAutomationEventEnvelope({
    eventId: 'source-event-1',
    type: 'workflow.run',
    source: 'workflow',
    scope: 'workflow-run',
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    sequence: 6,
    projectionVersion: 3,
    fence: sourceFence,
    payload: { ok: true },
    createdAt: issuedAt,
  })
  const sourceLine = sourceCloudSessionContract.formatCloudAutomationTerminalStatusLine(sourceEvent, issuedAt)

  assert.equal(sourceCloudSessionContract.cloudProjectionFenceIdentityKey(sourceFence), 'workflow-run:tenant-1:workflow-1:run-1')
  assert.equal(sourceCloudSessionContract.cloudProjectionFenceObserved(sourceFence, sourceCheckpoint), true)
  assert.equal(sourceCloudSessionContract.evaluateCloudProjectionFenceCheckpoint({
    fence: sourceFence,
    checkpoint: sourceCheckpoint,
    nowMs: Date.parse(issuedAt),
  }).ok, true)
  assert.equal((await sourceCloudSessionContract.waitForCloudProjectionFence({
    fence: sourceFence,
    readCheckpoint: async () => sourceCheckpoint,
    timeoutMs: 0,
  })).ok, true)
  assert.equal(sourceCloudSessionContract.parseCloudAutomationTerminalStatusLine(sourceLine)?.event.eventId, 'source-event-1')
  assert.equal(sourceCloudSessionContract.parseCloudAutomationTerminalStatusLine('{"kind":"open-cowork.automation.event","version":0}'), null)
  assert.equal(sourceCloudSessionContract.isCloudProjectedSessionEventType('assistant.message'), true)
  assert.equal(sourceCloudSessionContract.isCloudSessionEventType('channel.delivery'), true)
  assert.equal(sourceCloudSessionContract.cloudSessionEventContractFor('assistant.message')?.channelRenderable, true)
  assert.equal(sourceCloudSessionContract.cloudSessionEventHasFacet('assistant.message', 'messages'), true)
  assert.equal(sourceCloudSessionContract.cloudSessionEventIsChannelRenderable('assistant.message'), true)
})

test('dist HTTP client source requires trusted, agreeing proxy chains', () => {
  assert.deepEqual(splitTrustedProxyCidrs(' 10.0.0.0/8, fd00::/8 ,, '), ['10.0.0.0/8', 'fd00::/8'])
  assert.equal(resolveHttpClientSource({
    socketAddress: '[fd00::1]:443',
    headers: {
      forwarded: 'for="[2001:db8::10]";proto=https, for="[fd00::2]"',
      'x-forwarded-for': '2001:db8::10, fd00::2',
    },
    policy: { trustProxyHeaders: true, trustedProxyCidrs: ['fd00::/8'] },
  }), '2001:db8::10')

  assert.equal(resolveHttpClientSource({
    socketAddress: '10.0.0.10',
    headers: {
      forwarded: 'for=198.51.100.10',
      'x-forwarded-for': '203.0.113.10',
    },
    policy: { trustProxyHeaders: true, trustedProxyCidrs: ['10.0.0.0/8'] },
  }), '10.0.0.10')
})

test('dist remote approval policy allows only explicit authenticated authorities', () => {
  assert.equal(evaluateRemoteApprovalPolicy({
    authority: 'cloud-web',
    interaction: 'permission-approval',
    actorAuthenticated: false,
    actorWorkspaceMember: true,
    explicitRemoteApprovalEnabled: true,
  }).reasonCode, 'actor-not-authenticated')

  assert.equal(evaluateRemoteApprovalPolicy({
    authority: 'desktop-local',
    interaction: 'question-reply',
    actorAuthenticated: true,
    localUserPresent: true,
  }).allowed, true)

  assert.equal(evaluateRemoteApprovalPolicy({
    authority: 'standalone-gateway',
    interaction: 'question-reject',
    actorAuthenticated: true,
    actorWorkspaceMember: false,
    explicitRemoteApprovalEnabled: true,
  }).allowed, false)
})

test('dist resource identities cover all route states without fuzzy fallback', () => {
  const artifact = createResourceIdentity({
    authority: 'desktop-cloud',
    kind: 'artifact',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    artifactId: 'artifact-1',
  })
  const unsupported = createResourceOpenAction(createResourceLookupResult(artifact, null, {
    unsupportedAuthority: true,
  }))

  assert.equal(unsupported.status, 'unsupported-authority')
  assert.deepEqual(unsupported.routeParams, {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    artifactId: 'artifact-1',
  })

  const settings = createResourceIdentity({
    authority: 'paired-desktop',
    kind: 'settings',
    workspaceId: 'workspace-1',
    settingsSurface: 'providers',
  })
  const deepLink = createResourceDeepLink(settings)
  assert.equal(resolveResourceDeepLinkOpenAction(deepLink, (identity) => createResourceLookupResult(identity, { ok: true })).status, 'open')
  assert.throws(() => parseResourceIdentity('open-cowork-resource/v1/desktop-local/session?workspaceId=w&sessionId=%E0%A4%A'), /URI encoding/)
  assert.throws(() => parseResourceDeepLink('open-cowork://resource/'), /missing/)
  assert.throws(() => createResourceIdentity({
    authority: 'desktop-local',
    kind: 'capability',
    workspaceId: 'workspace-1',
    capabilityId: 'capability-1',
  }), /capabilityKind/)
})

test('dist semantic UI redacts lists, snapshots, statuses, and action results', () => {
  const redactionFixture = 'abcdefghijklmnop'
  const workspace = createResourceIdentity({
    authority: 'desktop-local',
    kind: 'workspace',
    workspaceId: 'workspace-1',
  })
  const status = createSemanticUiStatus({
    capturedAt: '2026-06-03T00:00:00.000Z',
    authority: 'desktop-local',
    appReady: true,
    route: workspace,
    workspace,
    activeSession: null,
    runtime: {
      ready: false,
      phase: 'starting',
      error: 'Authorization: Bearer abcdef123456789012345678',
      updatedAt: '2026-06-03T00:00:00.000Z',
    },
    pending: { approvals: 2.9, questions: -10 },
  })
  const snapshot = createSemanticUiSnapshot({
    capturedAt: status.capturedAt,
    status,
    visibleSurface: '/home/alice/private',
    items: Array.from({ length: 205 }, (_, index) => ({
      id: `item-${index}`,
      kind: 'status' as const,
      label: index === 0 ? `token=${redactionFixture}` : `Item ${index}`,
      state: index === 1 ? '/Users/alice/private' : 'ok',
    })),
  })
  const actionList = createSemanticUiActionList({
    capturedAt: status.capturedAt,
    actions: Array.from({ length: 105 }, (_, index) => ({
      id: 'diagnostics.export' as const,
      label: `Action ${index}`,
      description: index === 0 ? `apiKey=${redactionFixture}` : 'Export diagnostics.',
      destructive: false,
      requiresAudit: true,
      enabled: true,
      reasonCode: index === 1 ? '/Users/alice/private' : undefined,
    })),
  })
  const result = createSemanticUiActionResult({
    capturedAt: status.capturedAt,
    actionId: 'diagnostics.export',
    ok: false,
    message: `secret=${redactionFixture}`,
  })

  assert.equal(authorizeSemanticUiTool({
    config: { enabled: true, authority: 'desktop-local', tokenHash: null },
    tool: 'ui_status',
  }).reasonCode, 'semantic-ui-token-required')
  assert.equal(status.pending.approvals, 2)
  assert.equal(status.pending.questions, 0)
  assert.equal(snapshot.items.length, 200)
  assert.equal(actionList.actions.length, 100)
  const serialized = JSON.stringify({ status, snapshot, actionList, result })
  assert.equal(serialized.includes('/home/alice'), false)
  assert.equal(serialized.includes('/Users/alice'), false)
  assert.equal(serialized.includes(redactionFixture), false)
})
