import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluateBuiltInMcp } from '../apps/desktop/src/main/runtime-mcp.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import type { AppSettings } from '../packages/shared/src/index.ts'
import type { BundleMcp } from '../apps/desktop/src/main/config-loader.ts'

const BASE_SETTINGS: AppSettings = {
  selectedProviderId: null,
  selectedModelId: null,
  providerCredentials: {},
  integrationCredentials: {},
  integrationEnabled: {},
  enableBash: false,
  enableFileWrite: false,
  automationLaunchAtLogin: false,
  automationDesktopNotifications: true,
  automationQuietHoursStart: '22:00',
  automationQuietHoursEnd: '07:00',
  defaultAutomationAutonomyPolicy: 'review-first',
  defaultAutomationExecutionMode: 'planning_only',
}

function withConfigDir(configJson: Record<string, unknown>, fn: () => void) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-mcp-optin-'))
  const configDir = join(tempRoot, 'downstream')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify(configJson))
  const previous = process.env.OPEN_COWORK_CONFIG_DIR
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previous
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

// Minimal valid config that the Cowork loader accepts. We layer a
// single `mcp` of interest on top via the caller's input.
function baseConfig(extra: Record<string, unknown>) {
  return {
    allowedEnvPlaceholders: [],
    providers: {
      available: ['test'],
      defaultProvider: 'test',
      defaultModel: 'fast',
      descriptors: {
        test: { name: 'Test', description: '', credentials: [], models: [{ id: 'fast', name: 'Fast' }] },
      },
    },
    ...extra,
  }
}

test('evaluateBuiltInMcp — local MCP with required credentials present is ready', () => {
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'perplexity',
      type: 'local',
      description: 'Perplexity search',
      authMode: 'api_token',
      command: ['node', '/tmp/perplexity.js'],
      credentials: [
        { key: 'apiKey', label: 'API key', description: '', required: true, secret: true },
      ],
      envSettings: [{ env: 'PERPLEXITY_API_KEY', key: 'apiKey' }],
    }
    const settings: AppSettings = {
      ...BASE_SETTINGS,
      integrationCredentials: { perplexity: { apiKey: 'sk-test' } },
    }
    const result = evaluateBuiltInMcp(mcp, settings)
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.equal(result.entry.type, 'local')
    if (result.entry.type !== 'local') return
    assert.equal(result.entry.environment?.PERPLEXITY_API_KEY, 'sk-test')
  })
})

test('evaluateBuiltInMcp — local MCP missing required credentials is skipped as not-configured', () => {
  // Perplexity's headline bug: the MCP would register in config.mcp,
  // fail to spawn because no key, and show up in the status log as
  // `perplexity=failed` for a user who simply hadn't added their key.
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'perplexity',
      type: 'local',
      description: 'Perplexity search',
      authMode: 'api_token',
      command: ['node', '/tmp/perplexity.js'],
      credentials: [
        { key: 'apiKey', label: 'API key', description: '', required: true, secret: true },
      ],
    }
    const result = evaluateBuiltInMcp(mcp, BASE_SETTINGS)
    assert.equal(result.status, 'skipped')
    if (result.status !== 'skipped') return
    assert.equal(result.reason, 'not-configured')
  })
})

test('evaluateBuiltInMcp — OAuth MCP is skipped until the user explicitly enables it', () => {
  // Atlassian / Amplitude / etc. — bundled but the user may never
  // intend to use them. Previously showed up as `needs_auth` in the
  // log just from being listed in the downstream config, reading as an
  // error to reviewers scanning the boot log.
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'atlassian',
      type: 'remote',
      description: 'Atlassian',
      authMode: 'oauth',
      url: 'https://mcp.atlassian.com/v1/mcp',
    }
    const result = evaluateBuiltInMcp(mcp, BASE_SETTINGS)
    assert.equal(result.status, 'skipped')
    if (result.status !== 'skipped') return
    assert.equal(result.reason, 'awaiting-oauth-opt-in')
  })
})

test('evaluateBuiltInMcp — OAuth MCP is registered once the user toggles integrationEnabled', () => {
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'atlassian',
      type: 'remote',
      description: 'Atlassian',
      authMode: 'oauth',
      url: 'https://mcp.atlassian.com/v1/mcp',
    }
    const settings: AppSettings = {
      ...BASE_SETTINGS,
      integrationEnabled: { atlassian: true },
    }
    const result = evaluateBuiltInMcp(mcp, settings)
    assert.equal(result.status, 'ready')
  })
})

test('evaluateBuiltInMcp — explicit disable wins over a credential-complete state', () => {
  // Some users want bundled integrations off even when credentials are
  // present (shared laptops, curiosity-by-default).
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'perplexity',
      type: 'local',
      description: 'Perplexity',
      authMode: 'api_token',
      command: ['node', '/tmp/perplexity.js'],
      credentials: [
        { key: 'apiKey', label: 'API key', description: '', required: true, secret: true },
      ],
    }
    const settings: AppSettings = {
      ...BASE_SETTINGS,
      integrationCredentials: { perplexity: { apiKey: 'sk-present' } },
      integrationEnabled: { perplexity: false },
    }
    const result = evaluateBuiltInMcp(mcp, settings)
    assert.equal(result.status, 'skipped')
    if (result.status !== 'skipped') return
    assert.equal(result.reason, 'disabled-by-user')
  })
})

test('evaluateBuiltInMcp — googleAuth MCP without ADC is skipped as not-signed-in-google', () => {
  // No `.open-cowork-test/application_default_credentials.json` file
  // exists, so getAdcPathIfAvailable() returns null.
  withConfigDir(baseConfig({
    auth: {
      mode: 'google-oauth',
      googleOAuth: { clientId: 'test.apps.googleusercontent.com', clientSecret: 's' },
    },
  }), () => {
    const mcp: BundleMcp = {
      name: 'sheets',
      type: 'local',
      description: 'Sheets',
      authMode: 'none',
      command: ['node', '/tmp/sheets.js'],
      googleAuth: true,
    }
    const result = evaluateBuiltInMcp(mcp, BASE_SETTINGS)
    assert.equal(result.status, 'skipped')
    if (result.status !== 'skipped') return
    assert.equal(result.reason, 'not-signed-in-google')
  })
})

test('evaluateBuiltInMcp — credential-less local MCP is ready without any user action', () => {
  // The skills MCP, chart renderer, etc. — bundled infrastructure that
  // every install should have by default.
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'skills',
      type: 'local',
      description: 'Custom skills',
      authMode: 'none',
      command: ['node', '/tmp/skills.js'],
    }
    const result = evaluateBuiltInMcp(mcp, BASE_SETTINGS)
    assert.equal(result.status, 'ready')
  })
})
