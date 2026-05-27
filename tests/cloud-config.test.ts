import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import {
  coerceCloudRuntimeSettings,
  evaluateCloudMcpPolicy,
  evaluateCloudProjectDirectoryPolicy,
  resolveCloudRuntimePolicy,
  resolveCloudRole,
} from '../apps/desktop/src/main/cloud/cloud-config.ts'

test('cloud role and profile resolve from deployment environment', () => {
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG, {
    OPEN_COWORK_CLOUD_ROLE: 'worker',
    OPEN_COWORK_CLOUD_PROFILE: 'focused-agent',
  })

  assert.equal(resolveCloudRole(DEFAULT_CONFIG, { OPEN_COWORK_CLOUD_ROLE: 'worker' }), 'worker')
  assert.equal(policy.role, 'worker')
  assert.equal(policy.profileName, 'focused-agent')
  assert.equal(policy.features.workflows, false)
  assert.equal(policy.features.customMcps, false)
})

test('cloud runtime policy rejects machine-native config by default', () => {
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)

  const coerced = coerceCloudRuntimeSettings({ runtimeConfigSource: 'machine' }, policy)
  assert.equal(coerced.runtimeConfigSource, 'app')
})

test('cloud MCP policy denies local stdio MCPs unless explicitly allowlisted', () => {
  const defaultPolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  assert.deepEqual(evaluateCloudMcpPolicy({ name: 'warehouse', type: 'stdio' }, defaultPolicy), {
    allowed: false,
    reason: 'Local stdio MCPs are disabled for this cloud profile.',
  })
  assert.deepEqual(evaluateCloudMcpPolicy({ name: 'github', type: 'http' }, defaultPolicy), {
    allowed: true,
    reason: null,
  })

  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      profiles: {
        ...DEFAULT_CONFIG.cloud.profiles,
        full: {
          ...DEFAULT_CONFIG.cloud.profiles.full,
          runtime: {
            ...DEFAULT_CONFIG.cloud.runtime,
            allowedLocalMcpNames: ['warehouse'],
          },
        },
      },
    },
  }
  const allowlistedPolicy = resolveCloudRuntimePolicy(config)
  assert.equal(evaluateCloudMcpPolicy({ name: 'warehouse', type: 'stdio' }, allowlistedPolicy).allowed, true)
})

test('cloud focused-agent profile uses explicit agent, tool, and MCP allowlists', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      defaultProfile: 'focused-agent',
      profiles: {
        ...DEFAULT_CONFIG.cloud.profiles,
        'focused-agent': {
          ...DEFAULT_CONFIG.cloud.profiles['focused-agent'],
          agents: ['data-analyst'],
          tools: ['warehouse'],
          mcps: ['warehouse'],
        },
      },
    },
  }

  const policy = resolveCloudRuntimePolicy(config)
  assert.deepEqual(policy.allowedAgents, ['data-analyst'])
  assert.deepEqual(policy.allowedTools, ['warehouse'])
  assert.deepEqual(policy.allowedMcps, ['warehouse'])
  assert.equal(evaluateCloudMcpPolicy({ name: 'github', type: 'http' }, policy).allowed, false)
})

test('cloud project directory policy defaults to app-managed workspaces', () => {
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)

  assert.equal(evaluateCloudProjectDirectoryPolicy('/home/user/project', policy).allowed, false)
  assert.equal(
    evaluateCloudProjectDirectoryPolicy('/srv/open-cowork/workspaces/session-1', policy, ['/srv/open-cowork/workspaces']).allowed,
    true,
  )
})
