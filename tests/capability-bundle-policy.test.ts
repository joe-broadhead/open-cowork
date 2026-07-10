import { applyCapabilityBundleInstall, applyCapabilityBundleUninstall, applyCapabilityBundleUpdate, createEmptyCapabilityBundleLifecycleState, normalizeCapabilityBundleManifest, planCapabilityBundleInstall, planCapabilityBundleUninstall, planCapabilityBundleUpdate, validateCapabilityBundleRuntimeSupport } from '@open-cowork/runtime-host/capability-bundle-engine'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITY_BUNDLE_FORMAT,
  type CapabilityBundleManifest,
} from '../packages/shared/dist/capabilities.js'
function manifest(overrides: Partial<CapabilityBundleManifest> = {}): CapabilityBundleManifest {
  return {
    format: CAPABILITY_BUNDLE_FORMAT,
    name: 'review-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    compatibility: {
      opencode: 'qualified',
      productModes: {
        'desktop-local': 'supported',
        'cloud-web': 'unsupported',
      },
    },
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
    ],
    permissions: [],
    uninstall: {
      removes: [{ kind: 'skill', id: 'review-skill' }],
      preserves: [],
    },
    ...overrides,
  }
}

test('capability bundle manifests normalize valid resources and permissions', () => {
  const result = normalizeCapabilityBundleManifest({
    format: CAPABILITY_BUNDLE_FORMAT,
    name: 'review-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    compatibility: {
      productModes: {
        'desktop-local': 'supported',
        'cloud-web': 'unsupported',
      },
    },
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'opencode-plugin', id: 'plugin.safe', compatibilityTier: 'supported' },
    ],
    permissions: [
      { kind: 'filesystem', id: 'workspace-write', reason: 'Writes reviewed files.' },
    ],
    uninstall: {
      removes: [{ kind: 'skill', id: 'review-skill' }],
      preserves: [{ kind: 'command', id: 'user-notes' }],
    },
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.manifest.resources.length, 2)
  assert.equal(result.manifest.permissions[0]?.required, true)
  assert.deepEqual(result.manifest.uninstall?.preserves, [{ kind: 'command', id: 'user-notes' }])
})

test('capability bundle validation requires explicit plugin compatibility', () => {
  const result = normalizeCapabilityBundleManifest({
    format: CAPABILITY_BUNDLE_FORMAT,
    name: 'plugin-pack',
    version: '1.0.0',
    owner: 'open-cowork',
    resources: [
      { kind: 'opencode-plugin', id: 'raw-plugin' },
    ],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.issues.some((issue) => issue.code === 'plugin_compatibility_required'), true)
})

test('capability bundle validation aligns required collections with the public schema', () => {
  const result = normalizeCapabilityBundleManifest({
    format: CAPABILITY_BUNDLE_FORMAT,
    name: 'schema-pack',
    version: '1.0.0',
    owner: 'open-cowork',
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.issues.some((issue) => issue.code === 'resources_required'), true)
  assert.equal(result.issues.some((issue) => issue.code === 'permissions_required'), true)
})

test('capability bundle plan fails closed for unsupported product modes and remote plugin tiers', () => {
  const localOnly = manifest({
    resources: [
      { kind: 'opencode-plugin', id: 'desktop-plugin', compatibilityTier: 'experimental' },
    ],
  })

  const plan = planCapabilityBundleInstall(localOnly, { productMode: 'cloud-web' })

  assert.equal(plan.blocked, true)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'product_mode_unsupported'), true)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'plugin_compatibility_blocked'), true)
  assert.equal(plan.risk.level, 'high')
})

test('capability bundle plan blocks local/private MCP URLs and hazardous stdio commands', () => {
  const plan = planCapabilityBundleInstall(manifest({
    resources: [
      { kind: 'mcp', id: 'local-mcp', url: 'http://127.0.0.1:9000/mcp', ownedByBundle: true },
      // Cloud metadata: the old hand-rolled regex classifier (audit P2-4) wrongly allowed this; the
      // shared SSRF policy blocks it.
      { kind: 'mcp', id: 'metadata-mcp', url: 'http://169.254.169.254/latest/meta-data/', ownedByBundle: true },
      { kind: 'mcp', id: 'shell-mcp', command: 'node server.js | sh', ownedByBundle: true },
    ],
  }), { productMode: 'desktop-local' })

  assert.equal(plan.blocked, true)
  assert.equal(plan.blockers.filter((blocker) => blocker.code === 'mcp_url_blocked').length, 2)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'mcp_stdio_blocked'), true)
})

test('capability bundle plan preserves existing user resources and orders actions deterministically', () => {
  const plan = planCapabilityBundleInstall(manifest({
    resources: [
      { kind: 'workflow', id: 'daily-review' },
      { kind: 'agent', id: 'reviewer-agent', ownedByBundle: true },
    ],
    permissions: [
      { kind: 'shell', id: 'run-tests', reason: 'Run project tests.' },
      { kind: 'mcp', id: 'github', reason: 'Read pull request metadata.' },
    ],
  }), {
    productMode: 'desktop-local',
    existingResourceIds: [{ kind: 'workflow', id: 'daily-review' }],
  })

  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.actions.map((action) => `${action.action}:${action.kind}:${action.id}`), [
    'install:agent:reviewer-agent',
    'preserve_user_resource:workflow:daily-review',
    'review_permission:mcp:github',
    'review_permission:shell:run-tests',
  ])
  assert.equal(plan.risk.level, 'high')
  assert.equal(plan.risk.reasons.some((reason) => reason.includes('shell permission')), true)
})

test('capability bundle plan uses kind-qualified resource identity for existing resources', () => {
  const plan = planCapabilityBundleInstall(manifest({
    resources: [
      { kind: 'skill', id: 'shared-id', ownedByBundle: true },
      { kind: 'workflow', id: 'shared-id', ownedByBundle: true },
    ],
  }), {
    productMode: 'desktop-local',
    existingResourceIds: [{ kind: 'workflow', id: 'shared-id' }],
  })

  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.actions.map((action) => `${action.action}:${action.kind}:${action.id}`), [
    'install:skill:shared-id',
    'preserve_user_resource:workflow:shared-id',
  ])
})

test('capability bundle uninstall plan removes only bundle-owned resources', () => {
  const plan = planCapabilityBundleUninstall(manifest({
    resources: [
      { kind: 'workflow', id: 'daily-review' },
      { kind: 'agent', id: 'reviewer-agent', ownedByBundle: true },
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
    ],
    uninstall: {
      removes: [
        { kind: 'agent', id: 'reviewer-agent' },
        { kind: 'skill', id: 'review-skill' },
        { kind: 'workflow', id: 'daily-review' },
      ],
      preserves: [{ kind: 'command', id: 'operator-notes' }],
    },
  }), {
    installedResourceIds: [
      { kind: 'agent', id: 'reviewer-agent' },
      { kind: 'skill', id: 'review-skill' },
      { kind: 'workflow', id: 'daily-review' },
      { kind: 'command', id: 'operator-notes' },
    ],
    userOwnedResourceIds: [{ kind: 'workflow', id: 'daily-review' }],
  })

  assert.equal(plan.blocked, false)
  assert.deepEqual(plan.actions.map((action) => `${action.action}:${action.kind}:${action.id}`), [
    'preserve_user_resource:workflow:daily-review',
    'preserve_user_resource:command:operator-notes',
    'remove_bundle_resource:skill:review-skill',
    'remove_bundle_resource:agent:reviewer-agent',
  ])
  assert.equal(plan.risk.level, 'medium')
  assert.equal(plan.risk.reasons.some((reason) => reason.includes('daily-review')), true)
})

test('capability bundle update plan removes only obsolete bundle-owned resources', () => {
  const previous = manifest({
    version: '1.0.0',
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'agent', id: 'old-agent', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
  })
  const next = manifest({
    version: '1.1.0',
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'agent', id: 'new-agent', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
    permissions: [
      { kind: 'mcp', id: 'github', reason: 'Read pull request metadata.' },
    ],
  })

  const plan = planCapabilityBundleUpdate(previous, next, {
    productMode: 'desktop-local',
    installedResourceIds: [
      { kind: 'skill', id: 'review-skill' },
      { kind: 'agent', id: 'old-agent' },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
    userOwnedResourceIds: [{ kind: 'workflow', id: 'operator-workflow' }],
    existingResourceIds: [{ kind: 'workflow', id: 'operator-workflow' }],
  })

  assert.equal(plan.blocked, false)
  assert.equal(plan.previousVersion, '1.0.0')
  assert.equal(plan.nextVersion, '1.1.0')
  assert.deepEqual(plan.actions.map((action) => `${action.action}:${action.kind}:${action.id}`), [
    'remove_bundle_resource:agent:old-agent',
    'install:agent:new-agent',
    'install:skill:review-skill',
    'preserve_user_resource:workflow:operator-workflow',
    'review_permission:mcp:github',
  ])
  assert.equal(plan.risk.reasons.some((reason) => reason.includes('mcp permission')), true)
})

test('capability bundle update plan fails closed for mismatched bundle identity', () => {
  const plan = planCapabilityBundleUpdate(manifest({ name: 'old-pack' }), manifest({ name: 'new-pack' }), {
    productMode: 'desktop-local',
  })

  assert.equal(plan.blocked, true)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'bundle_name_mismatch'), true)
  assert.equal(plan.actions.some((action) => action.action === 'block'), true)
})

test('capability bundle runtime support blocks remote plugins without explicit supported mode', () => {
  const report = validateCapabilityBundleRuntimeSupport([manifest({
    compatibility: {
      productModes: {
        'desktop-cloud': 'supported',
      },
    },
    resources: [
      { kind: 'opencode-plugin', id: 'review-plugin', compatibilityTier: 'experimental' },
    ],
  })], { productMode: 'desktop-cloud' })

  assert.equal(report.runtimeStartAllowed, false)
  assert.equal(report.blockers.some((blocker) => blocker.code === 'resource_product_mode_required'), true)
  assert.equal(report.bundles[0]?.resources[0]?.status, 'blocked')
})

test('capability bundle runtime support allows explicitly supported remote plugins', () => {
  const report = validateCapabilityBundleRuntimeSupport([manifest({
    compatibility: {
      productModes: {
        'desktop-cloud': 'supported',
      },
    },
    resources: [
      {
        kind: 'opencode-plugin',
        id: 'review-plugin',
        compatibilityTier: 'supported',
        productModes: ['desktop-cloud'],
      },
    ],
  })], { productMode: 'desktop-cloud' })

  assert.equal(report.runtimeStartAllowed, true)
  assert.deepEqual(report.blockers, [])
  assert.equal(report.bundles[0]?.resources[0]?.status, 'supported')
})

test('capability bundle runtime support blocks local stdio MCPs before cloud runtime start', () => {
  const report = validateCapabilityBundleRuntimeSupport([manifest({
    compatibility: {
      productModes: {
        'cloud-web': 'supported',
      },
    },
    resources: [
      { kind: 'mcp', id: 'local-stdio', command: 'node ./server.js', productModes: ['cloud-web'] },
    ],
  })], { productMode: 'cloud-web' })

  assert.equal(report.runtimeStartAllowed, false)
  assert.equal(report.blockers.some((blocker) => blocker.code === 'mcp_stdio_unsupported_product_mode'), true)
})

test('capability bundle install planning blocks stdio MCPs outside desktop local', () => {
  const plan = planCapabilityBundleInstall(manifest({
    compatibility: {
      productModes: {
        'desktop-cloud': 'supported',
      },
    },
    resources: [
      { kind: 'mcp', id: 'local-stdio', command: 'node ./server.js', productModes: ['desktop-cloud'] },
    ],
  }), { productMode: 'desktop-cloud' })

  assert.equal(plan.blocked, true)
  assert.equal(plan.blockers.some((blocker) => blocker.code === 'mcp_stdio_unsupported_product_mode'), true)
})

test('capability bundle lifecycle applies reviewed install plans deterministically', () => {
  const result = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), manifest({
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
    permissions: [
      { kind: 'mcp', id: 'github', reason: 'Read pull request metadata.' },
    ],
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T10:00:00.000Z',
  })

  assert.equal(result.applied, true)
  assert.deepEqual(result.state.bundles.map((bundle) => `${bundle.name}:${bundle.version}`), ['review-pack:1.0.0'])
  assert.deepEqual(result.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'bundle:skill:review-skill',
    'user:workflow:operator-workflow',
  ])
  assert.equal(result.audit.some((event) => event.outcome === 'reviewed' && event.kind === 'mcp'), true)
})

test('capability bundle lifecycle blocks duplicate installs without mutating state', () => {
  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), manifest(), {
    productMode: 'desktop-local',
    now: '2026-06-03T10:00:00.000Z',
  })
  const duplicate = applyCapabilityBundleInstall(installed.state, manifest(), {
    productMode: 'desktop-local',
    now: '2026-06-03T10:05:00.000Z',
  })

  assert.equal(duplicate.applied, false)
  assert.equal(duplicate.plan.blockers.some((blocker) => blocker.code === 'bundle_already_installed'), true)
  assert.deepEqual(duplicate.state, installed.state)
})

test('capability bundle lifecycle uninstall removes bundle-owned resources and preserves user-owned resources', () => {
  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), manifest({
    resources: [
      { kind: 'command', id: 'operator-command', ownedByBundle: true },
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
    uninstall: {
      removes: [
        { kind: 'skill', id: 'review-skill' },
        { kind: 'workflow', id: 'operator-workflow' },
      ],
      preserves: [{ kind: 'command', id: 'operator-command' }],
    },
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T10:00:00.000Z',
  })

  const uninstalled = applyCapabilityBundleUninstall(installed.state, 'review-pack')

  assert.equal(uninstalled.applied, true)
  assert.deepEqual(uninstalled.state.bundles, [])
  assert.deepEqual(uninstalled.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'user:command:operator-command',
    'user:workflow:operator-workflow',
  ])
  assert.equal(uninstalled.audit.some((event) => event.outcome === 'removed' && event.id === 'review-skill'), true)
  assert.equal(uninstalled.audit.some((event) => event.outcome === 'preserved' && event.id === 'operator-command'), true)
  assert.equal(uninstalled.audit.some((event) => event.outcome === 'preserved' && event.id === 'operator-workflow'), true)
})

test('capability bundle lifecycle preserves mixed-kind resources with the same id', () => {
  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), manifest({
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
    now: '2026-06-03T10:00:00.000Z',
  })
  const uninstalled = applyCapabilityBundleUninstall(installed.state, 'review-pack')

  assert.equal(uninstalled.applied, true)
  assert.deepEqual(uninstalled.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'user:workflow:shared-id',
  ])

  const reinstalled = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), manifest({
    resources: [
      { kind: 'skill', id: 'shared-id', ownedByBundle: true },
      { kind: 'workflow', id: 'shared-id', ownedByBundle: true },
    ],
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T11:00:00.000Z',
  })
  const updated = applyCapabilityBundleUpdate(reinstalled.state, manifest({
    version: '1.1.0',
    resources: [
      { kind: 'workflow', id: 'shared-id', ownedByBundle: true },
    ],
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T12:00:00.000Z',
  })

  assert.equal(updated.applied, true)
  assert.deepEqual(updated.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'bundle:workflow:shared-id',
  ])
  assert.equal(updated.audit.some((event) => event.outcome === 'removed' && event.kind === 'skill' && event.id === 'shared-id'), true)
})

test('capability bundle lifecycle update preserves user resources and removes obsolete owned resources', () => {
  const installed = applyCapabilityBundleInstall(createEmptyCapabilityBundleLifecycleState(), manifest({
    version: '1.0.0',
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'agent', id: 'old-agent', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T10:00:00.000Z',
  })

  const updated = applyCapabilityBundleUpdate(installed.state, manifest({
    version: '1.1.0',
    resources: [
      { kind: 'skill', id: 'review-skill', ownedByBundle: true },
      { kind: 'agent', id: 'new-agent', ownedByBundle: true },
      { kind: 'workflow', id: 'operator-workflow' },
    ],
  }), {
    productMode: 'desktop-local',
    now: '2026-06-03T11:00:00.000Z',
  })

  assert.equal(updated.applied, true)
  assert.deepEqual(updated.state.bundles.map((bundle) => `${bundle.name}:${bundle.version}`), ['review-pack:1.1.0'])
  assert.deepEqual(updated.state.resources.map((resource) => `${resource.owner}:${resource.kind}:${resource.id}`), [
    'bundle:agent:new-agent',
    'bundle:skill:review-skill',
    'user:workflow:operator-workflow',
  ])
  assert.equal(updated.audit.some((event) => event.outcome === 'removed' && event.id === 'old-agent'), true)
})
