import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import {
  coerceCloudRuntimeSettings,
  evaluateCloudMcpPolicy,
  evaluateCloudProjectDirectoryPolicy,
  evaluateCloudProjectSourcePolicy,
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

test('cloud project source policy allows safe git sources and blocks disallowed hosts or raw credentials', () => {
  const policy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)

  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    ref: 'main',
  }, policy).allowed, true)
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://example.com/acme/repo.git',
  }, policy).policyCode, 'project_source.git.host_denied')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://token@example.com/acme/repo.git',
  }, policy).policyCode, 'project_source.git.raw_credentials')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    ref: '--upload-pack=/tmp/pwned',
  }, policy).policyCode, 'project_source.git.ref')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    ref: 'feature/cloud-project-context',
  }, policy).allowed, true)
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    credentialRef: 'ghp_raw_token',
  }, policy).policyCode, 'project_source.git.credential_ref')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    credentialRef: 'https://raw-token@example.com',
  }, policy).policyCode, 'project_source.git.credential_ref')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    credentialRef: 'env:GITHUB_TOKEN',
  }, policy).allowed, true)
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/repo.git',
    credentialRef: 'https://vault-name.vault.azure.net/secrets/github-token',
  }, policy).allowed, true)
})

test('cloud project source policy enforces repository and uploaded snapshot limits', () => {
  const config = {
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      projectSources: {
        ...DEFAULT_CONFIG.cloud.projectSources,
        git: {
          ...DEFAULT_CONFIG.cloud.projectSources.git,
          allowedRepositories: ['github.com/acme/allowed'],
        },
        uploadedSnapshots: {
          ...DEFAULT_CONFIG.cloud.projectSources.uploadedSnapshots,
          maxFiles: 2,
          maxBytes: 10,
        },
      },
    },
  }
  const policy = resolveCloudRuntimePolicy(config)

  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/allowed.git',
  }, policy).allowed, true)
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'git',
    repositoryUrl: 'https://github.com/acme/denied.git',
  }, policy).policyCode, 'project_source.git.repo_denied')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'snapshot',
    snapshotId: 'snapshot-1',
    objectKey: 'project-snapshots/t/s/snapshot.json',
    fileCount: 3,
    byteCount: 9,
  }, policy).policyCode, 'project_source.snapshot.too_many_files')
  assert.equal(evaluateCloudProjectSourcePolicy({
    kind: 'snapshot',
    snapshotId: 'snapshot-1',
    objectKey: 'project-snapshots/t/s/snapshot.json',
    fileCount: 1,
    byteCount: 11,
  }, policy).policyCode, 'project_source.snapshot.too_large')
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
