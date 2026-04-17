import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildProviderRuntimeConfig, buildRuntimeConfig } from '../apps/desktop/src/main/runtime-config-builder.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { loadSettings, saveSettings } from '../apps/desktop/src/main/settings.ts'
import { removeCustomAgent, removeCustomMcp, saveCustomAgent, saveCustomMcp } from '../apps/desktop/src/main/native-customizations.ts'

test('buildRuntimeConfig resolves env-backed custom providers and project custom MCP permissions', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-runtime-config-'))
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
  }
}
`)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.TEST_RUNTIME_BASE_URL = 'https://runtime.example.test'
  clearConfigCaches()

  saveSettings({
    selectedProviderId: 'test-provider',
    selectedModelId: 'fast',
    enableBash: true,
    enableFileWrite: false,
  })

  saveCustomMcp({
    scope: 'project',
    directory: projectRoot,
    name: 'warehouse',
    type: 'http',
    url: 'https://warehouse.example.test/mcp',
  })

  try {
    const runtimeConfig = buildRuntimeConfig(projectRoot) as Record<string, any>

    assert.equal(runtimeConfig.model, 'test-provider/fast')
    assert.equal(runtimeConfig.small_model, 'test-provider/small')
    assert.equal(runtimeConfig.provider['test-provider'].options.baseUrl, 'https://runtime.example.test')
    assert.equal(runtimeConfig.mcp.warehouse.url, 'https://warehouse.example.test/mcp')
    assert.equal(runtimeConfig.permission['mcp__warehouse__*'], 'ask')
    assert.equal(runtimeConfig.permission.bash, 'allow')
    assert.equal(runtimeConfig.permission.write, 'deny')
  } finally {
    removeCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'warehouse',
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
      enableBash: false,
      enableFileWrite: false,
    },
    'custom-provider',
  ) as Record<string, any>

  assert.equal(providerConfig.options.baseUrl, 'https://provider.example.test')
  assert.equal(providerConfig.options.workspace, 'analytics')
})

test('buildRuntimeConfig registers project-scoped custom agents in config.agent so the primary can delegate to them', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'opencowork-custom-agent-'))
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
    assert.ok(
      runtimeConfig.agent['code-reviewer'],
      'custom agent should be registered with the SDK so the primary can invoke it',
    )
    assert.equal(runtimeConfig.agent['code-reviewer'].mode, 'subagent')
  } finally {
    removeCustomAgent({ scope: 'project', directory: projectRoot, name: 'code-reviewer' })
    saveSettings(originalSettings)
    rmSync(projectRoot, { recursive: true, force: true })
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
    assert.equal(runtimeConfig.small_model, 'openrouter/openai/gpt-5-mini')
    assert.equal(runtimeConfig.provider.openrouter.name, 'OpenRouter')
    assert.equal(runtimeConfig.provider.openrouter.options.apiKey, 'sk-or-test')
  } finally {
    saveSettings(originalSettings)
  }
})
