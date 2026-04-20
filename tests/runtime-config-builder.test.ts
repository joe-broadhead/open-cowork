import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildProviderRuntimeConfig, buildRuntimeConfig } from '../apps/desktop/src/main/runtime-config-builder.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { loadSettings, saveSettings } from '../apps/desktop/src/main/settings.ts'
import { removeCustomAgent, removeCustomMcp, saveCustomAgent, saveCustomMcp } from '../apps/desktop/src/main/native-customizations.ts'
import { getMachineSkillsDir } from '../apps/desktop/src/main/runtime-paths.ts'

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

test('buildRuntimeConfig only advertises skills that match OpenCode bundle rules', () => {
  const tempUserData = mkdtempSync(join(tmpdir(), 'opencowork-runtime-skills-'))
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

test('buildRuntimeConfig still registers custom agents whose app-owned skills need frontmatter healing', () => {
  const tempUserData = mkdtempSync(join(tmpdir(), 'opencowork-runtime-skill-heal-'))
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-cred-bridge-'))
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-cred-noenvleak-'))
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
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-mixed-placeholders-'))
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

test('buildRuntimeConfig points the SDK at the curated runtime skill catalog only', () => {
  // Isolation check. OpenCode's `skill` tool should only see the
  // runtime catalog that Cowork assembles, not the raw storage roots.
  // That keeps discovery deterministic and lets the product layer
  // rewrite supporting-file paths into the workspace-local mirror that
  // project-scoped sessions can actually read.
  const originalSettings = loadSettings()
  try {
    saveSettings({
      selectedProviderId: 'openrouter',
      selectedModelId: 'anthropic/claude-sonnet-4',
      providerCredentials: { openrouter: { apiKey: 'sk-or-test' } },
    })
    const runtimeConfig = buildRuntimeConfig() as Record<string, any>
    const paths: string[] = runtimeConfig.skills?.paths || []
    assert.equal(paths.length, 1, `expected 1 skill path, got: ${JSON.stringify(paths)}`)
    assert.ok(paths[0].endsWith('/runtime-skill-catalog'), `skill path should be the runtime catalog, got: ${paths[0]}`)
    assert.ok(paths[0].includes('runtime-home'), `skill path must live inside runtime-home, got: ${paths[0]}`)
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
    assert.equal(runtimeConfig.small_model, 'openrouter/openai/gpt-5-mini')
    assert.equal(runtimeConfig.provider.openrouter.name, 'OpenRouter')
    assert.equal(runtimeConfig.provider.openrouter.options.apiKey, 'sk-or-test')
  } finally {
    saveSettings(originalSettings)
  }
})
