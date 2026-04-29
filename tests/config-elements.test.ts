import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
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
  getProviderDescriptors,
} from '../apps/desktop/src/main/config-loader.ts'

test('open core ships with built-in tools, skills, mcps, and agents configured by default', () => {
  const tools = getConfiguredToolsFromConfig()
  const skills = getConfiguredSkillsFromConfig()
  const mcps = getConfiguredMcpsFromConfig()
  const agents = getConfiguredAgentsFromConfig()

  assert.equal(tools.map((tool) => tool.id).join(','), 'charts,skills')
  assert.equal(skills.map((skill) => skill.sourceName).join(','), 'chart-creator,skill-creator')
  assert.equal(mcps.map((mcp) => mcp.name).join(','), 'charts,skills')
  assert.equal(agents.map((agent) => agent.name).join(','), 'charts,skill-builder,research')
  assert.equal(getConfiguredToolAskPatterns(tools.find((tool) => tool.id === 'skills')!).includes('mcp__skills__save_skill_bundle'), true)
  assert.equal(getProviderDescriptors().map((provider) => provider.id).join(','), 'openrouter,openai')
  assert.equal(getAppConfig().permissions.webSearch, true)
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
