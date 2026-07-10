import { clearSettingsCache, loadSettings, saveSettings } from '@open-cowork/runtime-host/settings'
import { getMachineSkillsDir, getProjectCoworkAgentsDir, getRuntimeSkillCatalogDir } from '@open-cowork/runtime-host/runtime-paths'
import { copySkillsAndAgents } from '@open-cowork/runtime-host/runtime-content'
import { buildProviderRuntimeConfig, buildRuntimeConfig, buildRuntimeConfigForRuntime } from '@open-cowork/runtime-host/runtime-config-builder'
import { removeCustomAgent, removeCustomMcp, removeCustomSkill, saveCustomAgent, saveCustomMcp, saveCustomSkill } from '@open-cowork/runtime-host/native-customizations'
import { buildCustomAgentCatalog, buildCustomAgentPermissionFromCatalog } from '@open-cowork/runtime-host/custom-agents-utils'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches, getSidecarJsonSuffix } from '@open-cowork/runtime-host/config'
import {
  setActiveManagedPolicy,
  resetActiveManagedPolicyCache,
  EMPTY_MANAGED_POLICY,
} from '@open-cowork/runtime-host/managed-policy'
import type { ManagedDesktopPolicy } from '@open-cowork/shared'
function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

function writeSkillBundle(root: string, name: string, description: string) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${description}\n`,
  )
}

test('buildRuntimeConfig resolves env-backed custom providers and project custom MCP permissions', () => {
  const tempRoot = testTempDir('open-cowork-runtime-config-')
  const configDir = join(tempRoot, 'downstream')
  const projectRoot = join(tempRoot, 'project')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousBaseUrl = process.env.TEST_RUNTIME_BASE_URL
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })

  writeFileSync(join(configDir, 'config.jsonc'), `{
  "allowedEnvPlaceholders": ["TEST_RUNTIME_BASE_URL"],
  "providers": {
    "available": ["test-provider"],
    "defaultProvider": "test-provider",
    "defaultModel": "fast",
    "descriptors": {
      "test-provider": {
        "name": "Test Provider",
        "description": "Env-backed provider",
        "smallModel": "small",
        "credentials": [],
        "models": [
          { "id": "fast", "name": "Fast" },
          { "id": "small", "name": "Small" }
        ]
      }
    },
    "custom": {
      "test-provider": {
        "npm": "@scope/provider",
        "name": "Test Provider",
        "options": {
          "baseUrl": "{env:TEST_RUNTIME_BASE_URL}"
        },
        "models": {
          "fast": {},
          "small": {}
        }
      }
    }
  },
  "permissions": {
    "bash": "allow",
    "fileWrite": "allow",
    "task": "allow",
    "web": "allow",
    "webSearch": true
  }
}
`)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.TEST_RUNTIME_BASE_URL = 'https://runtime.example.test'
  clearConfigCaches()

  saveSettings({
    selectedProviderId: 'test-provider',
    selectedModelId: 'fast',
    bashPermission: 'allow',
    fileWritePermission: 'deny',
  })

  saveCustomMcp({
    scope: 'project',
    directory: projectRoot,
    name: 'warehouse',
    type: 'http',
    url: 'https://warehouse.example.test/mcp',
  })
  saveCustomMcp({
    scope: 'project',
    directory: projectRoot,
    name: 'analytics',
    type: 'http',
    url: 'https://analytics.example.test/mcp',
    permissionMode: 'allow',
  })

  try {
    const runtimeConfig = buildRuntimeConfig(projectRoot) as Record<string, any>

    assert.equal(runtimeConfig.model, 'test-provider/fast')
    assert.equal(runtimeConfig.small_model, 'test-provider/small')
    assert.deepEqual(runtimeConfig.enabled_providers, ['test-provider'])
    assert.equal(runtimeConfig.provider['test-provider'].options.baseUrl, 'https://runtime.example.test')
    assert.equal(runtimeConfig.mcp.warehouse.url, 'https://warehouse.example.test/mcp')
    assert.equal(runtimeConfig.mcp.analytics.url, 'https://analytics.example.test/mcp')
    assert.equal(runtimeConfig.permission['mcp__warehouse__*'], 'ask')
    assert.equal(runtimeConfig.permission['warehouse_*'], 'ask')
    assert.equal(runtimeConfig.permission['mcp__analytics__*'], 'allow')
    assert.equal(runtimeConfig.permission['analytics_*'], 'allow')
    assert.equal(runtimeConfig.agent.build.permission['mcp__warehouse__*'], 'ask')
    assert.equal(runtimeConfig.agent.build.permission['warehouse_*'], 'ask')
    assert.equal(runtimeConfig.agent.build.permission['mcp__analytics__*'], 'allow')
    assert.equal(runtimeConfig.agent.build.permission['analytics_*'], 'allow')
    assert.equal(runtimeConfig.permission.bash, 'allow')
    assert.equal(runtimeConfig.permission.write, 'deny')

    saveSettings({ mcpPermission: 'ask' })
    const askMcpConfig = buildRuntimeConfig(projectRoot) as Record<string, any>
    assert.equal(askMcpConfig.permission['mcp__analytics__*'], 'ask')
    assert.equal(askMcpConfig.permission['analytics_*'], 'ask')
    assert.equal(askMcpConfig.permission['mcp__warehouse__*'], 'ask')
    assert.equal(askMcpConfig.permission['warehouse_*'], 'ask')
    assert.equal(askMcpConfig.permission['mcp__clock__*'], 'ask')
    assert.equal(askMcpConfig.permission['clock_*'], 'ask')
    assert.equal(askMcpConfig.agent.build.permission['mcp__clock__*'], 'ask')
    assert.equal(askMcpConfig.agent.build.permission['clock_*'], 'ask')
    assert.equal(askMcpConfig.agent.build.permission['mcp__analytics__*'], 'ask')
    assert.equal(askMcpConfig.agent.build.permission['analytics_*'], 'ask')

    saveSettings({ mcpPermission: 'deny' })
    const denyMcpConfig = buildRuntimeConfig(projectRoot) as Record<string, any>
    assert.equal(denyMcpConfig.mcp.analytics, undefined)
    assert.equal(denyMcpConfig.mcp.warehouse, undefined)
    assert.equal(denyMcpConfig.permission['mcp__analytics__*'], 'deny')
    assert.equal(denyMcpConfig.permission['analytics_*'], 'deny')
    assert.equal(denyMcpConfig.permission['mcp__warehouse__*'], 'deny')
    assert.equal(denyMcpConfig.permission['warehouse_*'], 'deny')
    assert.equal(denyMcpConfig.agent.build.permission['mcp__analytics__*'], 'deny')
    assert.equal(denyMcpConfig.agent.build.permission['analytics_*'], 'deny')
  } finally {
    removeCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'warehouse',
    })
    removeCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'analytics',
    })
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousBaseUrl === undefined) delete process.env.TEST_RUNTIME_BASE_URL
    else process.env.TEST_RUNTIME_BASE_URL = previousBaseUrl
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig applies the org managed policy: tightens permissions and disables extension classes', () => {
  const tempRoot = testTempDir('open-cowork-runtime-policy-')
  const configDir = join(tempRoot, 'downstream')
  const downstreamRoot = join(tempRoot, 'downstream-root')
  const downstreamSkills = join(downstreamRoot, 'skills')
  const projectRoot = join(tempRoot, 'project')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const originalSettings = loadSettings()
  mkdirSync(configDir, { recursive: true })
  mkdirSync(downstreamSkills, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  // App-config ceiling leaves bash + custom extensions fully enabled.
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "providers": { "available": ["openrouter"], "defaultProvider": "openrouter", "defaultModel": "auto" },
  "skills": [
    { "name": "Managed Skill", "description": "Managed bundle", "badge": "Skill", "sourceName": "managed-skill", "toolIds": [] }
  ],
  "permissions": { "bash": "allow", "fileWrite": "allow", "task": "allow", "web": "allow", "webSearch": true }
}
`)
  writeSkillBundle(downstreamSkills, 'managed-skill', 'Managed bundle')
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  clearConfigCaches()
  saveSettings({ selectedProviderId: 'openrouter', selectedModelId: 'auto', bashPermission: 'allow' })
  saveCustomMcp({ scope: 'project', directory: projectRoot, name: 'warehouse', type: 'http', url: 'https://warehouse.example.test/mcp' })
  saveCustomSkill({
    scope: 'project',
    directory: projectRoot,
    name: 'custom-review',
    content: `---\ndescription: Custom review\n---\n# Custom review\n`,
  })
  try {
    // Baseline (no policy): bash allowed, custom MCP/skill are registered through
    // Cowork-owned config and skill catalog. Native ambient skill discovery stays off.
    setActiveManagedPolicy(null)
    resetActiveManagedPolicyCache()
    copySkillsAndAgents(projectRoot)
    const baseline = buildRuntimeConfig(projectRoot) as Record<string, any>
    assert.equal(baseline.permission.bash, 'allow')
    assert.equal(baseline.mcp.warehouse?.url, 'https://warehouse.example.test/mcp')
    assert.equal(baseline.skills.customSkills, false)
    assert.equal(baseline.permission.skill['managed-skill'], 'allow')
    assert.equal(baseline.permission.skill['custom-review'], 'allow')
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'managed-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'custom-review', 'SKILL.md')), true)
    assert.equal(existsSync(join(getMachineSkillsDir(), 'custom-review', 'SKILL.md')), false)

    // Org policy TIGHTENS bash to deny (never loosens) and disables custom MCPs/skills.
    const policy: ManagedDesktopPolicy = {
      ...EMPTY_MANAGED_POLICY,
      allowedProviders: ['openrouter'],
      extensions: { customProviders: true, customMcps: false, customSkills: false },
      permissionCeilings: { ...EMPTY_MANAGED_POLICY.permissionCeilings, bash: 'deny' },
    }
    setActiveManagedPolicy(policy)
    copySkillsAndAgents(projectRoot)
    const governed = buildRuntimeConfig(projectRoot) as Record<string, any>
    assert.equal(governed.permission.bash, 'deny')
    // The custom MCP is dropped entirely by the extension-class gate.
    assert.equal(governed.mcp.warehouse, undefined)
    assert.equal(governed.skills.customSkills, false)
    assert.equal(governed.permission.skill['managed-skill'], 'allow')
    assert.equal(governed.permission.skill['custom-review'], undefined)
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'managed-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'custom-review', 'SKILL.md')), false)
    assert.equal(existsSync(join(getMachineSkillsDir(), 'custom-review', 'SKILL.md')), false)
    // The provider allow-list still permits the configured provider.
    assert.deepEqual(governed.enabled_providers, ['openrouter'])
  } finally {
    setActiveManagedPolicy(null)
    resetActiveManagedPolicyCache()
    removeCustomMcp({ scope: 'project', directory: projectRoot, name: 'warehouse' })
    removeCustomSkill({ scope: 'project', directory: projectRoot, name: 'custom-review' })
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfigForRuntime omits HTTP MCPs rejected by the runtime DNS policy', async () => {
  const tempRoot = testTempDir('open-cowork-runtime-mcp-policy-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  clearConfigCaches()

  saveCustomMcp({
    scope: 'machine',
    directory: null,
    name: 'metadata-service',
    type: 'http',
    url: 'http://169.254.169.254/mcp',
  })

  try {
    const runtimeConfig = await buildRuntimeConfigForRuntime() as Record<string, any>
    assert.equal(runtimeConfig.mcp?.['metadata-service'], undefined)
  } finally {
    removeCustomMcp({
      scope: 'machine',
      directory: null,
      name: 'metadata-service',
    })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig treats disabled bash and file-write toggles as hard denies', () => {
  const tempRoot = testTempDir('open-cowork-runtime-permission-toggle-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "permissions": {
    "bash": "ask",
    "fileWrite": "ask",
    "task": "allow",
    "web": "allow",
    "webSearch": true
  }
}
`)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()

  try {
    saveSettings({ bashPermission: 'deny', fileWritePermission: 'deny' })
    const disabledConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(disabledConfig.permission.bash, 'deny')
    assert.equal(disabledConfig.permission.write, 'deny')
    assert.equal(disabledConfig.permission.edit, 'deny')
    assert.equal(disabledConfig.permission.apply_patch, 'deny')

    saveSettings({ bashPermission: 'ask', fileWritePermission: 'ask' })
    const enabledConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(enabledConfig.permission.bash, 'ask')
    assert.equal(enabledConfig.permission.write, 'ask')
    assert.equal(enabledConfig.permission.edit, 'ask')
    assert.equal(enabledConfig.permission.apply_patch, 'ask')
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildProviderRuntimeConfig preserves configured custom provider options', () => {
  const providerConfig = buildProviderRuntimeConfig(
    'custom-provider',
    {
      npm: '@scope/custom-provider',
      name: 'Custom Provider',
      options: {
        baseUrl: 'https://provider.example.test',
        workspace: 'analytics',
      },
      models: {
        fast: {},
      },
    },
    {
      selectedProviderId: 'custom-provider',
      selectedModelId: 'fast',
      effectiveProviderId: 'custom-provider',
      effectiveModel: 'fast',
      providerCredentials: {},
      integrationCredentials: {},
      integrationEnabled: {},
      bashPermission: 'deny',
      fileWritePermission: 'deny',
    },
    'custom-provider',
  ) as Record<string, any>

  assert.equal(providerConfig.options.baseUrl, 'https://provider.example.test')
  assert.equal(providerConfig.options.workspace, 'analytics')
})

test('buildRuntimeConfig uses a custom provider local default when the saved model is stale', () => {
  const tempRoot = testTempDir('open-cowork-runtime-provider-default-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    providers: {
      available: ['acme-provider'],
      defaultProvider: 'acme-provider',
      defaultModel: null,
      custom: {
        'acme-provider': {
          npm: '@acme/opencode-provider',
          name: 'Acme Provider',
          defaultModel: 'balanced',
          smallModel: 'fast',
          models: {
            fast: { name: 'Fast' },
            balanced: { name: 'Balanced' },
          },
        },
      },
    },
  }))

  try {
    process.env.OPEN_COWORK_CONFIG_DIR = configDir
    clearConfigCaches()
    saveSettings({
      selectedProviderId: 'acme-provider',
      selectedModelId: 'other-provider/old-model',
      providerCredentials: {},
    })

    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.model, 'acme-provider/balanced')
    assert.equal(runtimeConfig.small_model, 'acme-provider/fast')
    assert.equal(runtimeConfig.provider['acme-provider'].npm, '@acme/opencode-provider')
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig delegates to project-scoped custom agents without duplicating native agent files in config.agent', () => {
  const projectRoot = testTempDir('open-cowork-custom-agent-')
  const originalSettings = loadSettings()

  saveCustomAgent(
    {
      scope: 'project',
      directory: projectRoot,
      name: 'code-reviewer',
      description: 'Review code diffs and flag risky changes.',
      instructions: 'Read the diff carefully and report any regressions, security issues, or unclear intent.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent',
    },
    { edit: 'deny', bash: 'deny', webfetch: 'allow' },
  )

  try {
    const runtimeConfig = buildRuntimeConfig(projectRoot) as Record<string, any>
    assert.ok(runtimeConfig.agent, 'agent config should exist')
    assert.equal(
      runtimeConfig.agent['code-reviewer'],
      undefined,
      'custom agents are discovered from native OpenCode markdown files, not duplicated in config.agent',
    )
    assert.equal(runtimeConfig.agent.build.permission.task['code-reviewer'], 'allow')
    assert.match(runtimeConfig.agent.build.prompt, /code-reviewer \(custom\): Review code diffs and flag risky changes\./)
  } finally {
    removeCustomAgent({ scope: 'project', directory: projectRoot, name: 'code-reviewer' })
    saveSettings(originalSettings)
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('runtime custom-agent markdown is capped by effective global permissions before OpenCode discovery', () => {
  const tempRoot = testTempDir('open-cowork-custom-agent-ceiling-')
  const projectRoot = join(tempRoot, 'project')
  const userDataDir = join(tempRoot, 'user-data')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearSettingsCache()

  saveCustomMcp({
    scope: 'project',
    directory: projectRoot,
    name: 'analytics',
    type: 'http',
    url: 'https://analytics.example.test/mcp',
    permissionMode: 'allow',
  })
  saveCustomAgent(
    {
      scope: 'project',
      directory: projectRoot,
      name: 'analytics-runner',
      description: 'Runs analytics workflows.',
      instructions: 'Use the analytics MCP carefully.',
      skillNames: [],
      toolIds: ['analytics'],
      enabled: true,
      color: 'accent',
      model: 'openrouter/deepseek/deepseek-v4-pro',
      variant: 'draft',
      temperature: 0.2,
      top_p: 0.8,
      steps: 8,
      options: { reasoningEffort: 'low' },
      permissionOverrides: [
        { key: 'web', action: 'allow' },
        { key: 'edit', action: 'allow' },
        { key: 'task', action: 'allow' },
        { key: 'external_directory', action: 'allow', rules: [{ pattern: '/tmp/analytics/*', action: 'allow' }] },
        { key: 'mcp', action: 'allow' },
      ],
    },
    {
      'mcp__analytics__*': 'allow',
      'analytics_*': 'allow',
      webfetch: 'ask',
      websearch: 'allow',
      write: 'ask',
      apply_patch: 'allow',
      task: 'allow',
      external_directory: {
        '/tmp/analytics/*': 'allow',
      },
    },
  )
  const sidecarPath = join(getProjectCoworkAgentsDir(projectRoot), `analytics-runner${getSidecarJsonSuffix()}`)
  rmSync(sidecarPath, { force: true })
  saveSettings({
    webPermission: 'deny',
    fileWritePermission: 'deny',
    taskPermission: 'deny',
    externalDirectoryPermission: 'deny',
    mcpPermission: 'deny',
  })

  try {
    copySkillsAndAgents(projectRoot)
    const markdown = readFileSync(join(getProjectCoworkAgentsDir(projectRoot), 'analytics-runner.md'), 'utf8')
    assert.match(markdown, /webfetch: deny/)
    assert.match(markdown, /websearch: deny/)
    assert.match(markdown, /write: deny/)
    assert.match(markdown, /apply_patch: deny/)
    assert.match(markdown, /task: deny/)
    assert.match(markdown, /external_directory:\n[ ]{4}"\*": deny\n[ ]{4}"\/tmp\/analytics\/\*": deny/)
    assert.match(markdown, /"mcp__analytics__\*": deny/)
    assert.match(markdown, /"analytics_\*": deny/)
    assert.match(markdown, /model: "openrouter\/deepseek\/deepseek-v4-pro"/)
    assert.match(markdown, /variant: "draft"/)
    assert.match(markdown, /temperature: 0.2/)
    assert.match(markdown, /top_p: 0.8/)
    assert.match(markdown, /steps: 8/)
    assert.match(markdown, /options: {"reasoningEffort":"low"}/)
    assert.equal(existsSync(sidecarPath), true)

    saveSettings({
      webPermission: 'allow',
      webSearchEnabled: true,
      fileWritePermission: 'allow',
      taskPermission: 'allow',
      externalDirectoryPermission: 'allow',
      mcpPermission: 'allow',
    })
    copySkillsAndAgents(projectRoot)
    const restoredMarkdown = readFileSync(join(getProjectCoworkAgentsDir(projectRoot), 'analytics-runner.md'), 'utf8')
    assert.match(restoredMarkdown, /webfetch: ask/)
    assert.match(restoredMarkdown, /websearch: allow/)
    assert.match(restoredMarkdown, /write: ask/)
    assert.match(restoredMarkdown, /apply_patch: allow/)
    assert.match(restoredMarkdown, /task: allow/)
    assert.match(restoredMarkdown, /external_directory:\n[ ]{4}"\*": deny\n[ ]{4}"\/tmp\/analytics\/\*": allow/)
    assert.match(restoredMarkdown, /"mcp__analytics__\*": allow/)
    assert.match(restoredMarkdown, /"analytics_\*": allow/)
    assert.match(restoredMarkdown, /model: "openrouter\/deepseek\/deepseek-v4-pro"/)
    assert.match(restoredMarkdown, /variant: "draft"/)
    assert.match(restoredMarkdown, /temperature: 0.2/)
    assert.match(restoredMarkdown, /top_p: 0.8/)
    assert.match(restoredMarkdown, /steps: 8/)
    assert.match(restoredMarkdown, /options: {"reasoningEffort":"low"}/)
  } finally {
    removeCustomAgent({ scope: 'project', directory: projectRoot, name: 'analytics-runner' })
    removeCustomMcp({ scope: 'project', directory: projectRoot, name: 'analytics' })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearSettingsCache()
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('custom agent permission overrides preserve nested guardrails and exact legacy tool rules', () => {
  const tempRoot = testTempDir('open-cowork-custom-agent-permission-rules-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = tempRoot
  clearSettingsCache()
  saveSettings({
    bashPermission: 'allow',
    fileWritePermission: 'allow',
    webPermission: 'allow',
    webSearchEnabled: true,
  })

  try {
    const catalog = buildCustomAgentCatalog({
      builtinTools: [],
      builtinSkills: [],
      customMcps: [],
      customSkills: [],
      state: {
        customMcps: [],
        customSkills: [],
        customAgents: [],
      },
    })
    const permission = buildCustomAgentPermissionFromCatalog({
      scope: 'machine',
      directory: null,
      name: 'guarded-agent',
      description: 'Uses guarded tools.',
      instructions: 'Respect narrowed tool rules.',
      skillNames: [],
      toolIds: [],
      enabled: true,
      color: 'accent',
      permissionOverrides: [
        { key: 'edit', action: 'allow', rules: [{ pattern: '*.env', action: 'deny' }] },
        { key: 'bash', action: 'allow', rules: [{ pattern: 'rm *', action: 'deny' }] },
        { key: 'web', action: 'deny', rules: [{ pattern: 'webfetch', action: 'ask' }, { pattern: 'websearch', action: 'allow' }] },
        { key: 'mcp', action: 'deny', rules: [{ pattern: 'mcp__github__pull_request_read', action: 'allow' }] },
      ],
    }, catalog) as Record<string, unknown>

    assert.deepEqual(permission.edit, { '*': 'allow', '*.env': 'deny' })
    assert.deepEqual(permission.write, { '*': 'allow', '*.env': 'deny' })
    assert.deepEqual(permission.apply_patch, { '*': 'allow', '*.env': 'deny' })
    assert.deepEqual(permission.bash, { '*': 'allow', 'rm *': 'deny' })
    assert.equal(permission.codesearch, 'deny')
    assert.equal(permission.webfetch, 'ask')
    assert.equal(permission.websearch, 'allow')
    assert.equal(permission['mcp__*'], 'deny')
    assert.equal(permission.mcp__github__pull_request_read, 'allow')
    assert.equal(permission.github_pull_request_read, 'allow')
  } finally {
    clearSettingsCache()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig only advertises skills that match OpenCode bundle rules', () => {
  const tempUserData = testTempDir('open-cowork-runtime-skills-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  clearConfigCaches()

  const invalidRoot = join(getMachineSkillsDir(), 'Bad_Skill')
  mkdirSync(invalidRoot, { recursive: true })
  writeFileSync(join(invalidRoot, 'SKILL.md'), '---\nname: Bad_Skill\ndescription: "Invalid"\n---\n# Bad Skill')

  try {
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.permission.skill['Bad_Skill'], undefined)
    assert.equal(runtimeConfig.permission.skill['chart-creator'], 'allow')
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempUserData, { recursive: true, force: true })
  }
})

test('built-in all-skill permission is bounded by the managed runtime skill catalog', () => {
  const tempRoot = testTempDir('open-cowork-runtime-skill-boundary-')
  const tempUserData = join(tempRoot, 'user-data')
  const downstreamRoot = join(tempRoot, 'downstream')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT

  const configuredSkillRoot = join(downstreamRoot, 'skills', 'chart-creator')
  const unconfiguredSkillRoot = join(downstreamRoot, 'skills', 'unconfigured-native')
  mkdirSync(configuredSkillRoot, { recursive: true })
  mkdirSync(unconfiguredSkillRoot, { recursive: true })
  writeFileSync(
    join(configuredSkillRoot, 'SKILL.md'),
    '---\nname: chart-creator\ndescription: "Create product-ready charts."\n---\n# Chart Creator\n',
  )
  writeFileSync(
    join(unconfiguredSkillRoot, 'SKILL.md'),
    '---\nname: unconfigured-native\ndescription: "Should not be visible to OpenCode."\n---\n# Unconfigured\n',
  )

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  clearConfigCaches()

  try {
    copySkillsAndAgents()
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>

    assert.deepEqual(runtimeConfig.skills.paths, [getRuntimeSkillCatalogDir()])
    assert.equal(runtimeConfig.agent.build.permission.skill, 'allow')
    assert.equal(runtimeConfig.agent.plan.permission.skill, 'allow')
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'chart-creator', 'SKILL.md')), true)
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'unconfigured-native', 'SKILL.md')), false)
    assert.equal(existsSync(join(getMachineSkillsDir(), 'unconfigured-native', 'SKILL.md')), false)
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig gives the charts agent explicit access to the managed chart skill directory', () => {
  const projectRoot = join(process.cwd(), '.open-cowork-test', 'open-cowork-charts-project')
  const runtimeConfig = buildRuntimeConfig(projectRoot) as Record<string, any>

  assert.equal(
    runtimeConfig.agent?.charts?.permission?.external_directory?.[`${projectRoot}/.opencowork/skill-bundles/*`],
    'allow',
  )
  assert.equal(
    runtimeConfig.agent?.charts?.permission?.external_directory?.['*'],
    'deny',
  )
})

test('buildRuntimeConfig delegates to custom agents whose app-owned skills need frontmatter healing', () => {
  const tempUserData = testTempDir('open-cowork-runtime-skill-heal-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  process.env.OPEN_COWORK_USER_DATA_DIR = tempUserData
  clearConfigCaches()

  const skillRoot = join(getMachineSkillsDir(), 'analyst')
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    '---\nname: mcp-analyst\ndescription: "Analyze metrics and answer business questions."\n---\n# Analyst\n',
  )

  saveCustomAgent(
    {
      scope: 'machine',
      directory: null,
      name: 'data-analyst',
      description: 'Answer business questions with data.',
      instructions: 'Use the analyst skill before answering.',
      skillNames: ['analyst'],
      toolIds: [],
      enabled: true,
      color: 'info',
    },
    {
      skill: { analyst: 'allow' },
      question: 'allow',
      edit: 'deny',
      bash: 'deny',
    },
  )

  try {
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>

    assert.equal(runtimeConfig.permission.skill.analyst, 'allow')
    assert.equal(
      runtimeConfig.agent['data-analyst'],
      undefined,
      'custom agent definitions stay native-file backed to avoid duplicate OpenCode registration',
    )
    assert.equal(runtimeConfig.agent.build.permission.task['data-analyst'], 'allow')
    assert.equal(runtimeConfig.agent.plan.permission.task['data-analyst'], 'allow')
  } finally {
    removeCustomAgent({ scope: 'machine', directory: null, name: 'data-analyst' })
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempUserData, { recursive: true, force: true })
  }
})

test('buildProviderRuntimeConfig bridges custom provider credentials into env placeholders', () => {
  // A custom provider whose options reference `{env:FOO}` should receive
  // the value the user stored in Settings — not whatever the shell's
  // `process.env.FOO` happens to be at main-process boot. This pins the
  // bridge that was missing before: custom providers ignored credentials
  // entirely and only saw `process.env`, which broke the Settings UI for
  // GUI-launched apps.
  const tempRoot = testTempDir('open-cowork-cred-bridge-')
  const configDir = join(tempRoot, 'downstream')
  mkdirSync(configDir, { recursive: true })
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousShellToken = process.env.BRIDGE_TEST_TOKEN
  const originalSettings = loadSettings()

  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    allowedEnvPlaceholders: ['BRIDGE_TEST_TOKEN'],
    providers: {
      available: ['bridge-provider'],
      defaultProvider: 'bridge-provider',
      defaultModel: 'fast',
      custom: {
        'bridge-provider': {
          npm: '@scope/bridge-provider',
          name: 'Bridge Test',
          credentials: [
            { key: 'token', label: 'Token', description: '', env: 'BRIDGE_TEST_TOKEN' },
          ],
          options: { apiKey: '{env:BRIDGE_TEST_TOKEN}' },
          models: { fast: {} },
        },
      },
    },
  }, null, 2))

  // Shell env holds a stale token. If the bridge wasn't there, this
  // would leak through to the provider.
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.BRIDGE_TEST_TOKEN = 'shell-token-stale'
  clearConfigCaches()

  // Settings holds the token the user actually entered in the UI.
  const storedToken = 'ui-token-fresh-sensitive-tail'
  saveSettings({
    providerCredentials: {
      'bridge-provider': { token: storedToken },
    },
  })

  try {
    const capturedLogs: string[] = []
    const originalConsoleLog = console.log
    let runtimeConfig: Record<string, any> | null = null
    try {
      console.log = (...args: unknown[]) => {
        capturedLogs.push(args.map(String).join(' '))
      }
      runtimeConfig = buildRuntimeConfig() as Record<string, any>
    } finally {
      console.log = originalConsoleLog
    }
    assert.ok(runtimeConfig)
    assert.equal(
      runtimeConfig.provider['bridge-provider'].options.apiKey,
      storedToken,
      'stored credential must win over process.env',
    )
    const runtimeLogs = capturedLogs.join('\n')
    assert.match(runtimeLogs, new RegExp(`apiKey=<len=${storedToken.length} redacted>`))
    assert.doesNotMatch(runtimeLogs, /ui-token/)
    assert.doesNotMatch(runtimeLogs, /tail/)
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousShellToken === undefined) delete process.env.BRIDGE_TEST_TOKEN
    else process.env.BRIDGE_TEST_TOKEN = previousShellToken
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig does NOT fall back to process.env for custom provider credential placeholders', () => {
  // Non-technical users don't export tokens into their shell. If the
  // user hasn't entered a credential in Settings, the placeholder
  // resolves to empty string — never to a matching shell env var. A
  // stale `DATABRICKS_TOKEN` sitting in a teammate's shell must not
  // get picked up silently in place of the user's Settings entry.
  const tempRoot = testTempDir('open-cowork-cred-noenvleak-')
  const configDir = join(tempRoot, 'downstream')
  mkdirSync(configDir, { recursive: true })
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousShellToken = process.env.NOENVLEAK_TEST_TOKEN
  const originalSettings = loadSettings()

  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    allowedEnvPlaceholders: ['NOENVLEAK_TEST_TOKEN'],
    providers: {
      available: ['noenvleak-provider'],
      defaultProvider: 'noenvleak-provider',
      defaultModel: 'fast',
      custom: {
        'noenvleak-provider': {
          npm: '@scope/noenvleak-provider',
          name: 'NoEnvLeak Test',
          credentials: [
            { key: 'token', label: 'Token', description: '', env: 'NOENVLEAK_TEST_TOKEN' },
          ],
          options: { apiKey: '{env:NOENVLEAK_TEST_TOKEN}' },
          models: { fast: {} },
        },
      },
    },
  }, null, 2))

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.NOENVLEAK_TEST_TOKEN = 'shell-only-should-not-leak'
  clearConfigCaches()

  // No providerCredentials entry for the provider — placeholder must
  // resolve to empty, NOT to `shell-only-should-not-leak`.
  saveSettings({ providerCredentials: {} })

  try {
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(
      runtimeConfig.provider['noenvleak-provider'].options.apiKey,
      '',
      'missing credential must resolve to empty string — process.env must never fill in',
    )
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousShellToken === undefined) delete process.env.NOENVLEAK_TEST_TOKEN
    else process.env.NOENVLEAK_TEST_TOKEN = previousShellToken
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig mixes credential-scoped and non-credential placeholders correctly', () => {
  // A provider that references TWO env vars in options:
  //   - `apiKey` backed by a declared credential (must resolve to
  //     empty when no stored value — process.env is blocked).
  //   - `baseUrl` NOT in credentials[] (the shell export is a
  //     legitimate escape hatch for power users tweaking endpoints).
  // Asserts the two rules coexist in the same provider.
  const tempRoot = testTempDir('open-cowork-mixed-placeholders-')
  const configDir = join(tempRoot, 'downstream')
  mkdirSync(configDir, { recursive: true })
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousToken = process.env.MIX_TEST_TOKEN
  const previousBaseUrl = process.env.MIX_TEST_BASE_URL
  const originalSettings = loadSettings()

  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    allowedEnvPlaceholders: ['MIX_TEST_TOKEN', 'MIX_TEST_BASE_URL'],
    providers: {
      available: ['mix-provider'],
      defaultProvider: 'mix-provider',
      defaultModel: 'fast',
      custom: {
        'mix-provider': {
          npm: '@scope/mix-provider',
          name: 'Mix Test',
          credentials: [
            { key: 'token', label: 'Token', description: '', env: 'MIX_TEST_TOKEN' },
          ],
          options: {
            apiKey: '{env:MIX_TEST_TOKEN}',
            baseUrl: '{env:MIX_TEST_BASE_URL}',
          },
          models: { fast: {} },
        },
      },
    },
  }, null, 2))

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.MIX_TEST_TOKEN = 'shell-token-must-not-leak'
  process.env.MIX_TEST_BASE_URL = 'https://runtime.example.test'
  clearConfigCaches()

  // No stored credential; no stored baseUrl override either.
  saveSettings({ providerCredentials: {} })

  try {
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(
      runtimeConfig.provider['mix-provider'].options.apiKey,
      '',
      'credential-scoped env must NOT fall back to process.env',
    )
    assert.equal(
      runtimeConfig.provider['mix-provider'].options.baseUrl,
      'https://runtime.example.test',
      'non-credential env still resolves from process.env',
    )
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousToken === undefined) delete process.env.MIX_TEST_TOKEN
    else process.env.MIX_TEST_TOKEN = previousToken
    if (previousBaseUrl === undefined) delete process.env.MIX_TEST_BASE_URL
    else process.env.MIX_TEST_BASE_URL = previousBaseUrl
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig passes the Cowork skill catalog through SDK-native skills.paths', () => {
  // OpenCode v2 exposes Config.skills.paths. Cowork keeps bundled skills
  // behind that SDK-native path so the XDG skills dir can remain reserved
  // for user-authored custom skills.
  const originalSettings = loadSettings()
  try {
    saveSettings({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: { openrouter: { apiKey: 'sk-or-test' } },
    })
    const runtimeConfig = buildRuntimeConfig()
    assert.deepEqual(runtimeConfig.skills?.paths, [getRuntimeSkillCatalogDir()])
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig provisions selected built-in providers with stored credentials', () => {
  const originalSettings = loadSettings()

  saveSettings({
    selectedProviderId: 'openrouter',
    selectedModelId: 'anthropic/claude-sonnet-4',
    providerCredentials: {
      openrouter: {
        apiKey: 'sk-or-test',
      },
    },
  })

  try {
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>

    assert.equal(runtimeConfig.model, 'openrouter/anthropic/claude-sonnet-4')
    assert.equal(runtimeConfig.small_model, 'openrouter/anthropic/claude-sonnet-4')
    assert.equal(runtimeConfig.provider.openrouter.name, 'OpenRouter')
    assert.equal(runtimeConfig.provider.openrouter.options.apiKey, 'sk-or-test')
    assert.equal(runtimeConfig.provider.openrouter.models['deepseek/deepseek-v4-flash:free'].name, 'DeepSeek V4 Flash (free) via OpenRouter')
    assert.equal(runtimeConfig.provider.openrouter.models['anthropic/claude-sonnet-4'].name, 'Claude Sonnet 4 via OpenRouter')
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig uses the user-selected small model for OpenCode lightweight calls', () => {
  const originalSettings = loadSettings()

  saveSettings({
    selectedProviderId: 'openrouter',
    selectedModelId: 'anthropic/claude-sonnet-4',
    selectedSmallModelId: 'deepseek/deepseek-v4-flash:free',
    providerCredentials: {
      openrouter: {
        apiKey: 'sk-or-test',
      },
    },
  })

  try {
    const runtimeConfig = buildRuntimeConfig()

    assert.equal(runtimeConfig.model, 'openrouter/anthropic/claude-sonnet-4')
    assert.equal(runtimeConfig.small_model, 'openrouter/deepseek/deepseek-v4-flash:free')
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig supports OpenCode-native providers without required app-stored API keys', () => {
  const tempRoot = testTempDir('open-cowork-runtime-native-provider-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    providers: {
      available: ['openai', 'anthropic'],
      defaultProvider: 'openai',
      defaultModel: null,
      descriptors: {
        openai: {
          runtime: 'builtin',
          name: 'OpenAI Codex',
          description: 'Use OpenAI through OpenCode.',
          credentials: [
            {
              key: 'apiKey',
              runtimeKey: 'apiKey',
              label: 'OpenAI API Key',
              description: 'Optional API key.',
              required: false,
            },
          ],
          models: [],
        },
        anthropic: {
          runtime: 'builtin',
          name: 'Anthropic Claude',
          description: 'Use Anthropic through OpenCode.',
          credentials: [
            {
              key: 'apiKey',
              runtimeKey: 'apiKey',
              label: 'Anthropic API Key',
              description: 'Optional API key.',
              required: false,
            },
          ],
          models: [],
        },
      },
    },
  }))

  try {
    process.env.OPEN_COWORK_CONFIG_DIR = configDir
    clearConfigCaches()
    saveSettings({
      selectedProviderId: 'openai',
      selectedModelId: 'codex-live-model',
      providerCredentials: {
        openai: {
          apiKey: '',
        },
        anthropic: {
          apiKey: '',
        },
      },
    })

    const openaiRuntimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(openaiRuntimeConfig.model, 'openai/codex-live-model')
    assert.equal(openaiRuntimeConfig.small_model, 'openai/codex-live-model')
    assert.equal(
      openaiRuntimeConfig.provider?.openai,
      undefined,
      'name-only built-in provider overrides must be omitted so OpenCode owns browser auth',
    )

    saveSettings({
      selectedProviderId: 'anthropic',
      selectedModelId: 'claude-live-model',
      providerCredentials: {
        openai: {
          apiKey: '',
        },
        anthropic: {
          apiKey: '',
        },
      },
    })

    const anthropicRuntimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(anthropicRuntimeConfig.model, 'anthropic/claude-live-model')
    assert.equal(anthropicRuntimeConfig.small_model, 'anthropic/claude-live-model')
    assert.equal(
      anthropicRuntimeConfig.provider?.anthropic,
      undefined,
      'name-only built-in provider overrides must be omitted so OpenCode owns browser auth',
    )
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig still passes API keys for direct built-in providers when users enter them', () => {
  const originalSettings = loadSettings()

  try {
    saveSettings({
      selectedProviderId: 'openai',
      selectedModelId: 'codex-live-model',
      providerCredentials: {
        openai: {
          apiKey: 'openai-api-key-test',
        },
      },
    })

    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.model, 'openai/codex-live-model')
    assert.equal(runtimeConfig.provider.openai.name, 'OpenAI Codex')
    assert.equal(runtimeConfig.provider.openai.options.apiKey, 'openai-api-key-test')
    assert.equal(runtimeConfig.provider.openai.models, undefined)
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig drops a stale cross-provider model when switching to a live built-in provider', () => {
  const originalSettings = loadSettings()

  try {
    saveSettings({
      selectedProviderId: 'openai',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: {
        openai: {
          apiKey: '',
        },
      },
    })

    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(
      runtimeConfig.model,
      'openai',
      'a model id from another provider must not be prefixed into the selected provider',
    )
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig accepts already-prefixed direct built-in model ids without double-prefixing', () => {
  const originalSettings = loadSettings()

  try {
    saveSettings({
      selectedProviderId: 'openai',
      selectedModelId: 'openai/gpt-5.4',
      providerCredentials: {
        openai: {
          apiKey: '',
        },
      },
    })

    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.model, 'openai/gpt-5.4')
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig supports downstream OpenCode-native providers with runtime-owned model catalogs', () => {
  const tempRoot = testTempDir('open-cowork-runtime-builtin-provider-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    providers: {
      available: ['github-copilot'],
      defaultProvider: 'github-copilot',
      defaultModel: null,
      descriptors: {
        'github-copilot': {
          runtime: 'builtin',
          runtimeActivation: 'implicit',
          name: 'GitHub Copilot',
          description: 'Use GitHub Copilot through OpenCode.',
          credentials: [],
          models: [],
        },
      },
    },
  }))

  try {
    process.env.OPEN_COWORK_CONFIG_DIR = configDir
    clearConfigCaches()
    saveSettings({
      selectedProviderId: 'github-copilot',
      selectedModelId: 'copilot-live-model',
      providerCredentials: {},
    })

    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.model, 'github-copilot/copilot-live-model')
    assert.equal(runtimeConfig.small_model, 'github-copilot/copilot-live-model')
    assert.equal(
      runtimeConfig.provider?.['github-copilot'],
      undefined,
      'downstream OpenCode-native providers should keep OpenCode-owned auth/model metadata intact',
    )
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('buildRuntimeConfig can activate dormant OpenCode-native providers without credentials', () => {
  const tempRoot = testTempDir('open-cowork-runtime-activated-provider-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const originalSettings = loadSettings()

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    providers: {
      available: ['github-copilot'],
      defaultProvider: 'github-copilot',
      defaultModel: null,
      descriptors: {
        'github-copilot': {
          runtime: 'builtin',
          runtimeActivation: 'config',
          name: 'GitHub Copilot',
          description: 'Use GitHub Copilot through OpenCode.',
          credentials: [],
          models: [],
        },
      },
    },
  }))

  try {
    process.env.OPEN_COWORK_CONFIG_DIR = configDir
    clearConfigCaches()
    saveSettings({
      selectedProviderId: 'github-copilot',
      selectedModelId: '',
      providerCredentials: {},
    })

    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.model, 'github-copilot')
    assert.equal(runtimeConfig.small_model, 'github-copilot')
    assert.deepEqual(runtimeConfig.provider?.['github-copilot'], {
      name: 'GitHub Copilot',
    })
    assert.equal(
      JSON.stringify(runtimeConfig).includes('apiKey'),
      false,
      'GitHub Copilot activation must not invent an API-key credential path',
    )
  } finally {
    saveSettings(originalSettings)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
