import { normalizeConfigLayers } from '@open-cowork/runtime-host'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertConfigValid,
  clearConfigCaches,
  getBranding,
  getConfiguredAgentsFromConfig,
  getConfiguredMcpsFromConfig,
  getConfiguredModelFallbacks,
  getConfiguredSkillsFromConfig,
  getConfiguredToolsFromConfig,
  getConfigError,
  getAppConfig,
  getConfiguredToolAskPatterns,
  getPublicAppConfig,
  getProviderDescriptors,
} from '../apps/desktop/src/main/config-loader.ts'
test('open core ships with built-in tools, skills, mcps, and agents configured by default', () => {
  const tools = getConfiguredToolsFromConfig()
  const skills = getConfiguredSkillsFromConfig()
  const mcps = getConfiguredMcpsFromConfig()
  const agents = getConfiguredAgentsFromConfig()

  assert.equal(tools.map((tool) => tool.id).join(','), 'clock,charts,skills,agents,workflows,knowledge,semantic-ui,openwiki')
  assert.equal(skills.map((skill) => skill.sourceName).join(','), 'clock,autoresearch,chart-creator,skill-creator,agent-creator,workflow-creator,openwiki-research,openwiki-edit-review,openwiki-ingest')
  assert.equal(mcps.map((mcp) => mcp.name).join(','), 'clock,charts,skills,agents,workflows,knowledge,semantic-ui,openwiki')
  assert.equal(agents.map((agent) => agent.name).join(','), 'charts,skill-builder,agent-builder,workflow-designer,research')
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'skills')!).includes('mcp__skills__save_skill_bundle'), true)
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'agents')!).includes('mcp__agents__save_agent'), true)
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'workflows')!).includes('mcp__workflows__create_workflow'), true)
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'knowledge')!).includes('mcp__knowledge__propose_knowledge_edit'), true)
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'semantic-ui')!).includes('mcp__semantic-ui__ui_execute_action'), true)
  // OpenWiki ships the pack's trust posture: read tier auto-allowed, proposal
  // tier asks, write tier structurally absent (the MCP runs --tools proposal).
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'openwiki')!).includes('mcp__openwiki__wiki.propose_edit'), true)
  assert.equal(tools.find((tool) => tool.id === 'openwiki')?.allowPatterns?.includes('mcp__openwiki__wiki.search'), true)
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'clock')!).length, 0)
  assert.equal(tools.find((tool) => tool.id === 'clock')?.defaultAccess, true)
  const providers = getProviderDescriptors()
  assert.equal(providers.map((provider) => provider.id).join(','), 'openrouter,openai,github-copilot')
  assert.equal(providers.find((provider) => provider.id === 'openrouter')?.defaultModel, 'deepseek/deepseek-v4-flash:free')
  const copilot = providers.find((provider) => provider.id === 'github-copilot')
  assert.equal(copilot?.credentials.length, 0)
  assert.equal(copilot?.models.length, 0)
  assert.equal(getAppConfig().permissions.bash, 'allow')
  assert.equal(getAppConfig().permissions.fileWrite, 'allow')
  assert.equal(getAppConfig().permissions.webSearch, true)
})

test('GitHub Copilot provider descriptor matches pinned OpenCode runtime discovery fixture', () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/opencode-provider-auth.github-copilot.json', 'utf-8'))
  const descriptor = getAppConfig().providers.descriptors?.['github-copilot']

  assert.equal(fixture.providerId, 'github-copilot')
  assert.equal(fixture.activation.required, true)
  assert.equal(descriptor?.runtime, 'builtin')
  assert.equal(descriptor?.runtimeActivation, 'config')
  assert.deepEqual(descriptor?.credentials, [])
  assert.deepEqual(descriptor?.models, [])
  assert.equal(fixture.authMethods[0]?.type, 'oauth')
  assert.equal(fixture.models.hardcodedInOpenCowork, false)
  assert.equal(fixture.models.defaultModel, 'claude-sonnet-4.6')
  assert.equal(fixture.models.discoveredCount > 0, true)
  assert.equal(fixture.secretBoundary.openCoworkCredentials.length, 0)
  assert.equal(fixture.secretBoundary.cloudByokDefault, 'blocked')
})

test('invalid config fails fast with a readable validation error', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    tools: [
      {
        id: 'broken-tool',
        description: 'Missing required fields should fail validation',
      },
    ],
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.throws(() => assertConfigValid(), /Invalid app config/)
    assert.match(getConfigError() || '', /tools\[0\].name|tools\[0\].kind/)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader lets downstreams disable native web search while keeping web fetch allowed', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-websearch-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    permissions: {
      web: 'allow',
      webSearch: false,
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    const permissions = getAppConfig().permissions
    assert.equal(permissions.web, 'allow')
    assert.equal(permissions.webSearch, false)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader normalizes cloud defaults and focused profile overrides', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-cloud-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    cloud: {
      role: 'worker',
      defaultProfile: 'focused-agent',
      profiles: {
        'focused-agent': {
          agents: ['data-analyst'],
          tools: ['warehouse'],
          mcps: ['warehouse'],
          features: {
            workflows: false,
            customMcps: false,
          },
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    const cloud = getAppConfig().cloud
    assert.equal(cloud.role, 'worker')
    assert.equal(cloud.defaultProfile, 'focused-agent')
    assert.equal(cloud.profiles['focused-agent']?.agents?.[0], 'data-analyst')
    assert.equal(cloud.profiles['focused-agent']?.features?.workflows, false)
    assert.equal(cloud.runtime.configSource, 'app')
    assert.equal(cloud.runtime.allowMachineRuntimeConfig, false)
    assert.equal(cloud.runtime.allowRemoteApprovalResponses, false)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader preserves every documented gateway provider kind', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-gateway-providers-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const providerKinds = ['fake', 'telegram', 'slack', 'email', 'webhook', 'discord', 'whatsapp', 'signal', 'cli'] as const

  writeFileSync(configPath, JSON.stringify({
    gateway: {
      server: {
        host: '127.0.0.1',
      },
      providers: providerKinds.map((kind) => ({
        kind,
        channelBindingId: `${kind}-binding`,
        credentials: kind === 'webhook'
          ? { sharedSecret: `${kind}-secret` }
          : kind === 'telegram'
            ? { botToken: `${kind}-token`, webhookSecret: `${kind}-secret` }
            : kind === 'slack'
              ? { botToken: `${kind}-token`, signingSecret: `${kind}-secret` }
              : kind === 'email'
                ? { inboundSecret: `${kind}-secret` }
                : kind === 'cli' || kind === 'fake'
                  ? {}
                  : { sharedSecret: `${kind}-secret` },
        settings: kind === 'telegram'
          ? { mode: 'polling' }
          : kind === 'email'
            ? { from: 'agent@example.test', smtpHost: 'smtp.example.test' }
            : kind === 'cli' || kind === 'fake'
              ? {}
              : { deliveryUrl: `https://channels.example.test/${kind}` },
      })),
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    assert.deepEqual(
      getAppConfig().gateway.providers.map((provider) => provider.kind).sort(),
      [...providerKinds].sort(),
    )
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader accepts select and radio credential metadata for bundled MCPs', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-mcp-credentials-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    mcps: [
      {
        name: 'multi-auth',
        type: 'local',
        description: 'Multi-mode auth MCP',
        authMode: 'api_token',
        command: ['node', '/tmp/multi-auth.js'],
        envSettings: [
          { env: 'AUTH_METHOD', key: 'authMethod' },
          { env: 'API_KEY', key: 'apiKey' },
          { env: 'RUNTIME_MODE', key: 'runtimeMode' },
        ],
        credentials: [
          {
            key: 'authMethod',
            label: 'Authentication method',
            description: 'How to authenticate with the service',
            type: 'select',
            options: [
              { label: 'API key', value: 'api_key', hint: 'Static API credentials' },
              { label: 'SSO', value: 'sso' },
            ],
            required: true,
          },
          {
            key: 'apiKey',
            label: 'API key',
            description: 'Your API key',
            secret: true,
            when: { key: 'authMethod', op: 'eq', value: 'api_key' },
          },
          {
            key: 'runtimeMode',
            label: 'Runtime mode',
            description: 'Where the MCP should run',
            type: 'radio',
            options: [
              { label: 'Local', value: 'local' },
              { label: 'Remote', value: 'remote', hint: 'Hosted MCP server' },
            ],
          },
        ],
      },
    ],
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    const mcp = getConfiguredMcpsFromConfig().find((entry) => entry.name === 'multi-auth')
    assert.equal(mcp?.credentials?.[0]?.type, 'select')
    assert.equal(mcp?.credentials?.[0]?.options?.[0]?.value, 'api_key')
    assert.deepEqual(mcp?.credentials?.[1]?.when, { key: 'authMethod', op: 'eq', value: 'api_key' })
    assert.equal(mcp?.credentials?.[2]?.type, 'radio')
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader accepts JSONC, file placeholders, and partial config directory overrides', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-dir-'))
  const configDir = join(tempRoot, 'downstream')
  const configPath = join(configDir, 'config.jsonc')
  const brandPath = join(configDir, 'brand.txt')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR

  mkdirSync(configDir, { recursive: true })
  writeFileSync(brandPath, 'Downstream Cowork')
  writeFileSync(configPath, `{
  "allowedEnvPlaceholders": [],
  // downstream company overrides
  "branding": {
    "name": "{file:./brand.txt}"
  },
  "tools": [
    {
      "id": "warehouse",
      "name": "Warehouse",
      "description": "Warehouse MCP",
      "kind": "mcp",
      "namespace": "warehouse",
    },
  ],
}
`)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    assert.equal(getBranding().name, 'Downstream Cowork')
    assert.equal(getConfiguredToolsFromConfig().some((tool) => tool.id === 'warehouse'), true)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_DIR
    } else {
      process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader applies per-user config after downstream env layers', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-merge-order-'))
  const tempHome = join(tempRoot, 'home')
  const configDir = join(tempRoot, 'downstream')
  const userConfigDir = join(tempHome, '.config', 'merge-order-data')
  const previousHome = process.env.HOME
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  mkdirSync(configDir, { recursive: true })
  mkdirSync(userConfigDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    branding: {
      dataDirName: 'merge-order-data',
      helpUrl: 'https://downstream.example/help',
    },
  }))
  writeFileSync(join(userConfigDir, 'config.json'), JSON.stringify({
    branding: {
      helpUrl: 'https://user.example/help',
    },
  }))

  process.env.HOME = tempHome
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  delete process.env.OPEN_COWORK_CONFIG_PATH
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    assert.equal(getAppConfig().branding.dataDirName, 'merge-order-data')
    assert.equal(getAppConfig().branding.helpUrl, 'https://user.example/help')
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
    if (previousConfigDir === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_DIR
    } else {
      process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    }
    if (previousDownstreamRoot === undefined) {
      delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    } else {
      process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    }
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config normalization applies layer precedence without loader state', () => {
  const config = normalizeConfigLayers([
    {
      branding: {
        dataDirName: 'calculation-data',
        helpUrl: 'https://downstream.example/help',
      },
      cloud: {
        role: 'worker',
        defaultProfile: 'focused-agent',
        publicBranding: {
          theme: {
            surface: '#ffffff',
            mutedSurface: '#ecefed',
            border: '#d8ddd7',
            mutedText: '#66736b',
            accent: '#0f6b4b',
            accentStrong: '#13845d',
          },
        },
        profiles: {
          'focused-agent': {
            agents: ['data-analyst'],
            features: {
              workflows: false,
            },
          },
        },
      },
      permissions: {
        webSearch: true,
      },
    },
    {
      branding: {
        helpUrl: 'https://user.example/help',
      },
      permissions: {
        webSearch: false,
      },
    },
  ])

  assert.equal(config.branding.dataDirName, 'calculation-data')
  assert.equal(config.branding.helpUrl, 'https://user.example/help')
  assert.equal(config.permissions.webSearch, false)
  assert.equal(config.cloud.role, 'worker')
  assert.equal(config.cloud.defaultProfile, 'focused-agent')
  assert.equal(config.cloud.profiles['focused-agent']?.agents?.[0], 'data-analyst')
  assert.equal(config.cloud.profiles['focused-agent']?.features?.workflows, false)
  assert.equal(config.cloud.runtime.configSource, 'app')
  assert.equal(config.cloud.publicBranding.theme?.elevated, '#ffffff')
  assert.equal(config.cloud.publicBranding.theme?.surfaceHover, '#ecefed')
  assert.equal(config.cloud.publicBranding.theme?.accentHover, '#13845d')
  assert.equal(config.cloud.publicBranding.theme?.accentForeground, '#ffffff')
  assert.equal(config.cloud.publicBranding.theme?.focus, 'rgba(45, 107, 86, 0.28)')
  assert.equal(config.cloud.publicBranding.theme?.amber, '#8a5a14')
  assert.equal(config.cloud.publicBranding.theme?.red, '#9d3630')
  assert.equal(config.cloud.publicBranding.theme?.green, '#1f6b46')
  assert.equal(config.cloud.publicBranding.theme?.bgImage, 'none')
})

test('public branding keeps logoDataUrl fallback when logoAsset cannot resolve', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-branding-fallback-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const logoDataUrl = 'data:image/png;base64,AAAA'

  writeFileSync(configPath, JSON.stringify({
    branding: {
      sidebar: {
        top: {
          variant: 'logo',
          logoAsset: 'branding/missing-logo.svg',
          logoDataUrl,
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    const top = getPublicAppConfig().branding.sidebar?.top
    assert.equal(top?.logoUrl, undefined)
    assert.equal(top?.logoDataUrl, logoDataUrl)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader accepts downstream model price and context overrides', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-model-info-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: ['github-copilot'],
      defaultProvider: 'github-copilot',
      defaultModel: 'claude-sonnet-4',
      descriptors: {
        'github-copilot': {
          runtime: 'builtin',
          name: 'GitHub Copilot',
          description: 'Copilot provider',
          credentials: [],
          models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }],
        },
      },
      modelInfo: {
        'github-copilot/claude-sonnet-4': {
          limit: { context: 200000 },
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    const fallbacks = getConfiguredModelFallbacks()
    assert.deepEqual(fallbacks.pricing['github-copilot/claude-sonnet-4'], {
      inputPer1M: 3,
      outputPer1M: 15,
      cachePer1M: 0.3,
      cacheWritePer1M: 3.75,
    })
    assert.equal(fallbacks.pricing['claude-sonnet-4'].inputPer1M, 3)
    assert.equal(fallbacks.contextLimits['github-copilot/claude-sonnet-4'], 200000)
    assert.equal(fallbacks.contextLimits['claude-sonnet-4'], 200000)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader exposes provider-local default models when present in the configured catalog', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-provider-default-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: ['acme-gateway', 'internal-gateway'],
      defaultProvider: 'acme-gateway',
      defaultModel: 'fallback-large',
      descriptors: {
        'acme-gateway': {
          runtime: 'builtin',
          name: 'Acme Gateway',
          description: 'Acme model gateway',
          defaultModel: 'acme-large',
          credentials: [],
          models: [
            { id: 'fallback-large', name: 'Fallback Large' },
            { id: 'acme-large', name: 'Acme Large' },
          ],
        },
      },
      custom: {
        'internal-gateway': {
          npm: '@acme/opencode-provider',
          name: 'Internal Gateway',
          defaultModel: 'internal-balanced',
          models: {
            'internal-balanced': { name: 'Internal Balanced' },
            'internal-fast': { name: 'Internal Fast' },
          },
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    const providers = getProviderDescriptors()
    assert.equal(providers.find((provider) => provider.id === 'acme-gateway')?.defaultModel, 'acme-large')
    assert.equal(providers.find((provider) => provider.id === 'internal-gateway')?.defaultModel, 'internal-balanced')
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader silently ignores provider-local defaults absent from the current catalog', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-provider-default-missing-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: ['acme-gateway'],
      defaultProvider: 'acme-gateway',
      defaultModel: null,
      descriptors: {
        'acme-gateway': {
          runtime: 'builtin',
          name: 'Acme Gateway',
          description: 'Acme model gateway',
          defaultModel: 'missing-model',
          credentials: [],
          models: [
            { id: 'acme-large', name: 'Acme Large' },
          ],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    assert.equal(getProviderDescriptors().find((provider) => provider.id === 'acme-gateway')?.defaultModel, undefined)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader resolves telemetry header env placeholders', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-telemetry-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const previousToken = process.env.ACME_TELEMETRY_TOKEN

  writeFileSync(configPath, JSON.stringify({
    allowedEnvPlaceholders: ['ACME_TELEMETRY_TOKEN'],
    telemetry: {
      enabled: true,
      endpoint: 'https://events.acme.example/ingest',
      headers: {
        Authorization: 'Bearer {env:ACME_TELEMETRY_TOKEN}',
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  process.env.ACME_TELEMETRY_TOKEN = 'telemetry-token'
  clearConfigCaches()

  try {
    assert.doesNotThrow(() => assertConfigValid())
    assert.equal(getAppConfig().telemetry?.headers?.Authorization, 'Bearer telemetry-token')
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    if (previousToken === undefined) {
      delete process.env.ACME_TELEMETRY_TOKEN
    } else {
      process.env.ACME_TELEMETRY_TOKEN = previousToken
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('config loader rejects env placeholders that are not explicitly allowlisted', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-config-env-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH

  writeFileSync(configPath, JSON.stringify({
    allowedEnvPlaceholders: [],
    providers: {
      available: ['custom-provider'],
      defaultProvider: 'custom-provider',
      defaultModel: 'fast',
      descriptors: {
        'custom-provider': {
          name: 'Custom Provider',
          description: 'Config test provider',
          credentials: [],
          models: [{ id: 'fast', name: 'Fast' }],
        },
      },
      custom: {
        'custom-provider': {
          npm: '@scope/provider',
          name: 'Custom Provider',
          options: {
            baseUrl: '{env:SECRET_BASE_URL}',
          },
          models: {
            fast: {},
          },
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  try {
    assert.throws(() => assertConfigValid(), /SECRET_BASE_URL is not allowlisted/)
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPEN_COWORK_CONFIG_PATH
    } else {
      process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
    }
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
