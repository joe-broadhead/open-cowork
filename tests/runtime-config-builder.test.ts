import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  buildProviderRuntimeConfig,
  buildRuntimeConfig,
  buildRuntimeConfigForRuntime,
} from '../apps/desktop/src/main/runtime-config-builder.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { loadSettings, saveSettings } from '../apps/desktop/src/main/settings.ts'
import { removeCustomAgent, removeCustomMcp, saveCustomAgent, saveCustomMcp } from '../apps/desktop/src/main/native-customizations.ts'
import { getMachineSkillsDir } from '../apps/desktop/src/main/runtime-paths.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

test('buildRuntimeConfig resolves env-backed custom providers and project custom MCP permissions', () => {
  const tempRoot = testTempDir('opencowork-runtime-config-')
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
    assert.equal(runtimeConfig.permission['warehouse_*'], 'ask')
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

test('buildRuntimeConfigForRuntime omits HTTP MCPs rejected by the runtime DNS policy', async () => {
  const tempRoot = testTempDir('opencowork-runtime-mcp-policy-')
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
  const tempRoot = testTempDir('opencowork-runtime-permission-toggle-')
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
    saveSettings({ enableBash: false, enableFileWrite: false })
    const disabledConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(disabledConfig.permission.bash, 'deny')
    assert.equal(disabledConfig.permission.write, 'deny')
    assert.equal(disabledConfig.permission.edit, 'deny')
    assert.equal(disabledConfig.permission.apply_patch, 'deny')

    saveSettings({ enableBash: true, enableFileWrite: true })
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
      enableBash: false,
      enableFileWrite: false,
    },
    'custom-provider',
  ) as Record<string, any>

  assert.equal(providerConfig.options.baseUrl, 'https://provider.example.test')
  assert.equal(providerConfig.options.workspace, 'analytics')
})

test('buildRuntimeConfig registers project-scoped custom agents in config.agent so the primary can delegate to them', () => {
  const projectRoot = testTempDir('opencowork-custom-agent-')
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

test('buildRuntimeConfig only advertises skills that match OpenCode bundle rules', () => {
  const tempUserData = testTempDir('opencowork-runtime-skills-')
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

test('buildRuntimeConfig gives the charts agent explicit access to the managed chart skill directory', () => {
  const projectRoot = join(process.cwd(), '.open-cowork-test', 'open-cowork-charts-project')
  const runtimeConfig = buildRuntimeConfig(projectRoot) as Record<string, any>

  assert.equal(
    runtimeConfig.agent?.charts?.permission?.external_directory?.[`${projectRoot}/.opencowork/skill-bundles/chart-creator/*`],
    'allow',
  )
  assert.equal(
    runtimeConfig.agent?.charts?.permission?.external_directory?.['*'],
    'deny',
  )
})

test('buildRuntimeConfig still registers custom agents whose app-owned skills need frontmatter healing', () => {
  const tempUserData = testTempDir('opencowork-runtime-skill-heal-')
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
    assert.ok(
      runtimeConfig.agent['data-analyst'],
      'custom agent should be registered once the managed skill bundle is healed',
    )
    assert.equal(runtimeConfig.agent['data-analyst'].permission.skill.analyst, 'allow')
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
  const tempRoot = testTempDir('opencowork-cred-bridge-')
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
  saveSettings({
    providerCredentials: {
      'bridge-provider': { token: 'ui-token-fresh' },
    },
  })

  try {
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(
      runtimeConfig.provider['bridge-provider'].options.apiKey,
      'ui-token-fresh',
      'stored credential must win over process.env',
    )
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
  const tempRoot = testTempDir('opencowork-cred-noenvleak-')
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
  const tempRoot = testTempDir('opencowork-mixed-placeholders-')
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

test('buildRuntimeConfig does not rely on unsupported skill path overrides', () => {
  // OpenCode's native skill tool discovers from documented config/home
  // directories. `copySkillsAndAgents` mirrors Cowork-managed bundles
  // into the isolated runtime XDG config dir before launch, so runtime
  // config should not depend on a non-native `skills.paths` override.
  const originalSettings = loadSettings()
  try {
    saveSettings({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: { openrouter: { apiKey: 'sk-or-test' } },
    })
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    assert.equal(runtimeConfig.skills, undefined)
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
    assert.equal(runtimeConfig.small_model, 'openrouter/openai/gpt-5.5')
    assert.equal(runtimeConfig.provider.openrouter.name, 'OpenRouter')
    assert.equal(runtimeConfig.provider.openrouter.options.apiKey, 'sk-or-test')
    assert.equal(runtimeConfig.provider.openrouter.models['anthropic/claude-sonnet-4'].name, 'Claude Sonnet 4 via OpenRouter')
  } finally {
    saveSettings(originalSettings)
  }
})

test('buildRuntimeConfig supports OpenCode-native providers without required app-stored API keys', () => {
  const tempRoot = testTempDir('opencowork-runtime-native-provider-')
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
  const tempRoot = testTempDir('opencowork-runtime-builtin-provider-')
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
