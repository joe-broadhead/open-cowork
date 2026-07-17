import {
  evaluateBuiltInMcp,
  pinHttpMcpRemoteEntry,
  resolveBundledMcpNodeCommand,
  resolveCustomMcpRuntimeEntry,
  resolveCustomMcpRuntimeEntryForRuntime,
} from '@open-cowork/runtime-host/runtime-mcp'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import type { AppSettings } from '../packages/shared/src/index.ts'
import type { BundleMcp } from '@open-cowork/runtime-host/config'

const BASE_SETTINGS: AppSettings = {
  selectedProviderId: null,
  selectedModelId: null,
  selectedSmallModelId: null,
  providerCredentials: {},
  integrationCredentials: {},
  integrationEnabled: {},
  bashPermission: 'deny',
  fileWritePermission: 'deny',
  webPermission: 'deny',
  webSearchEnabled: false,
  taskPermission: 'deny',
  externalDirectoryPermission: 'deny',
  mcpPermission: 'allow',
  requireApprovalBeforeSending: true,
  notificationVoiceReplies: true,
  notificationSmartSuggestions: true,
  notificationDailyDigest: false,
  notificationSounds: true,
  privacyKeepConversationHistory: true,
  privacyShareAnonymizedUsage: false,
  runtimeConfigSource: 'app',
  runtimeToolingBridgeEnabled: true,
  windowZoomFactor: 1,
  workflowLaunchAtLogin: false,
  workflowRunInBackground: false,
  workflowDesktopNotifications: true,
  workflowQuietHoursStart: '22:00',
  workflowQuietHoursEnd: '07:00',
}

function withConfigDir(configJson: Record<string, unknown>, fn: () => void) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-mcp-optin-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify(configJson))
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  try {
    fn()
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
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

test('evaluateBuiltInMcp — external-command MCP whose binary is missing is skipped, not spawned', () => {
  withConfigDir(baseConfig({}), () => {
    // External CLI MCPs the user may not have installed must skip cleanly
    // (install CTA), not reach the runtime and produce a confusing SDK spawn
    // failure.
    const mcp: BundleMcp = {
      name: 'external-search',
      type: 'local',
      description: 'External search MCP',
      authMode: 'none',
      command: ['definitely-not-an-installed-binary-open-cowork-test', 'mcp', '--stdio'],
    }
    const result = evaluateBuiltInMcp(mcp, { ...BASE_SETTINGS })
    assert.deepEqual(result, { status: 'skipped', reason: 'command-not-installed' })
  })
})

test('evaluateBuiltInMcp — external-command MCP resolves when the binary exists on PATH', () => {
  withConfigDir(baseConfig({}), () => {
    const binDir = mkdtempSync(join(tmpdir(), 'open-cowork-external-search-bin-'))
    const binary = join(binDir, 'external-search')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const previousPath = process.env.PATH
    process.env.PATH = `${binDir}:${previousPath || ''}`
    try {
      const mcp: BundleMcp = {
        name: 'external-search',
        type: 'local',
        description: 'External search MCP',
        authMode: 'none',
        command: ['external-search', 'server', '--stdio'],
      }
      const result = evaluateBuiltInMcp(mcp, { ...BASE_SETTINGS })
      assert.equal(result.status, 'ready')
      if (result.status !== 'ready') return
      assert.equal(result.entry.type, 'local')
      if (result.entry.type !== 'local') return
      assert.deepEqual(result.entry.command, ['external-search', 'server', '--stdio'])
    } finally {
      process.env.PATH = previousPath
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})

test('resolveBundledMcpNodeCommand uses Electron as Node in packaged builds', () => {
  assert.deepEqual(resolveBundledMcpNodeCommand('/tmp/charts.js', {
    isPackaged: false,
    executablePath: '/Applications/Open Cowork.app/Contents/MacOS/Open Cowork',
  }), {
    command: ['node', '/tmp/charts.js'],
    environment: {},
  })

  assert.deepEqual(resolveBundledMcpNodeCommand('/tmp/charts.js', {
    isPackaged: true,
    executablePath: '/Applications/Open Cowork.app/Contents/MacOS/Open Cowork',
  }), {
    command: ['/Applications/Open Cowork.app/Contents/MacOS/Open Cowork', '/tmp/charts.js'],
    environment: { ELECTRON_RUN_AS_NODE: '1' },
  })
})

test('JOE-837: static resolveCustomMcpRuntimeEntry throws for HTTP MCPs (fail closed)', () => {
  assert.throws(
    () => resolveCustomMcpRuntimeEntry({
      scope: 'machine',
      name: 'remote-http',
      type: 'http',
      url: 'https://mcp.example.com/api',
    }),
    /DNS-aware runtime path|JOE-837|stdio-only/,
  )
})

test('resolveCustomMcpRuntimeEntryForRuntime rejects public hostnames that resolve private', async () => {
  const entry = await resolveCustomMcpRuntimeEntryForRuntime({
    scope: 'machine',
    name: 'rebind',
    type: 'http',
    url: 'https://mcp.example.com/api',
  }, {
    resolveHostname: async () => [{ address: '169.254.169.254', family: 4 }],
  })

  assert.equal(entry, null)
})

test('resolveCustomMcpRuntimeEntryForRuntime pins cleartext HTTP MCP to resolved address (JOE-826)', async () => {
  const pinned = pinHttpMcpRemoteEntry({
    url: new URL('http://mcp.example.com:8080/api'),
    resolvedAddresses: ['203.0.113.10'],
    headers: { Authorization: 'Bearer t', Host: 'evil.example' },
  })
  assert.equal(pinned.url, 'http://203.0.113.10:8080/api')
  assert.equal(pinned.headers?.Host, 'mcp.example.com:8080')
  assert.equal(pinned.headers?.Authorization, 'Bearer t')

  // HTTPS is not IP-pinned (SNI/cert require the original hostname).
  const httpsPinned = pinHttpMcpRemoteEntry({
    url: new URL('https://mcp.example.com/api'),
    resolvedAddresses: ['203.0.113.10'],
  })
  assert.equal(httpsPinned.url, 'https://mcp.example.com/api')

  const entry = await resolveCustomMcpRuntimeEntryForRuntime({
    scope: 'machine',
    name: 'http-pin',
    type: 'http',
    url: 'http://mcp.example.com/tools',
    headers: { 'x-api-key': 'k' },
  }, {
    // Public unicast address that passes the non-routable/special-use blocks.
    resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
  })
  assert.ok(entry)
  assert.equal(entry?.type, 'remote')
  if (entry?.type === 'remote') {
    assert.equal(entry.url, 'http://8.8.8.8/tools')
    assert.equal(entry.headers?.Host, 'mcp.example.com')
    assert.equal(entry.headers?.['x-api-key'], 'k')
  }
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

test('evaluateBuiltInMcp — API-token MCPs fail closed until a required token file is configured', () => {
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'operator-mcp',
      type: 'local',
      description: 'Operator-scoped local MCP',
      authMode: 'api_token',
      command: ['node', '/tmp/operator-mcp.js'],
      credentials: [
        {
          key: 'operatorTokenFile',
          label: 'Operator token file',
          description: 'Owner-only operator token file.',
          required: true,
        },
      ],
      envSettings: [
        { env: 'OPERATOR_MCP_TOKEN_FILE', key: 'operatorTokenFile' },
      ],
    }

    assert.deepEqual(evaluateBuiltInMcp(mcp, BASE_SETTINGS), {
      status: 'skipped',
      reason: 'not-configured',
    })

    const result = evaluateBuiltInMcp(mcp, {
      ...BASE_SETTINGS,
      integrationCredentials: {
        'operator-mcp': {
          operatorTokenFile: '/secure/operator-mcp/operator-token',
        },
      },
    })
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') return
    assert.equal(result.entry.type, 'local')
    if (result.entry.type !== 'local') return
    assert.deepEqual(result.entry.environment, {
      OPERATOR_MCP_TOKEN_FILE: '/secure/operator-mcp/operator-token',
    })
    assert.equal('OPERATOR_MCP_ADMIN_TOKEN_FILE' in (result.entry.environment || {}), false)
  })
})

test('evaluateBuiltInMcp — required conditional credentials only apply when their when clause matches', () => {
  withConfigDir(baseConfig({}), () => {
    const mcp: BundleMcp = {
      name: 'multi-auth',
      type: 'local',
      description: 'Multi-mode auth MCP',
      authMode: 'api_token',
      command: ['node', '/tmp/multi-auth.js'],
      credentials: [
        {
          key: 'authMethod',
          label: 'Authentication method',
          description: 'How to authenticate.',
          type: 'select',
          options: [
            { label: 'API key', value: 'api_key' },
            { label: 'SSO', value: 'sso' },
          ],
          required: true,
        },
        {
          key: 'apiKey',
          label: 'API key',
          description: 'API token.',
          required: true,
          secret: true,
          when: { key: 'authMethod', op: 'eq', value: 'api_key' },
        },
        {
          key: 'ssoUser',
          label: 'SSO email',
          description: 'Single sign-on email.',
          required: true,
          when: { key: 'authMethod', op: 'eq', value: 'sso' },
        },
      ],
      envSettings: [
        { env: 'AUTH_METHOD', key: 'authMethod' },
        { env: 'API_KEY', key: 'apiKey' },
        { env: 'SSO_USER', key: 'ssoUser' },
      ],
    }
    const ssoSettings: AppSettings = {
      ...BASE_SETTINGS,
      integrationCredentials: {
        'multi-auth': {
          authMethod: 'sso',
          ssoUser: 'alice@example.com',
        },
      },
    }

    const ready = evaluateBuiltInMcp(mcp, ssoSettings)
    assert.equal(ready.status, 'ready')
    if (ready.status !== 'ready') return
    assert.equal(ready.entry.type, 'local')
    if (ready.entry.type !== 'local') return
    assert.equal(ready.entry.environment?.AUTH_METHOD, 'sso')
    assert.equal(ready.entry.environment?.SSO_USER, 'alice@example.com')
    assert.equal(ready.entry.environment?.API_KEY, undefined)

    const missingSso = evaluateBuiltInMcp(mcp, {
      ...BASE_SETTINGS,
      integrationCredentials: {
        'multi-auth': {
          authMethod: 'sso',
        },
      },
    })
    assert.equal(missingSso.status, 'skipped')
    if (missingSso.status !== 'skipped') return
    assert.equal(missingSso.reason, 'not-configured')
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
  // The helper points OPEN_COWORK_USER_DATA_DIR at a fresh temp directory,
  // so getAdcPathIfAvailable() returns null even when another test has
  // seeded the default `.open-cowork-test` data dir in parallel.
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
