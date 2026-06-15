import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, CapabilityToolEntry } from '@open-cowork/shared'
import { preflightConfiguredApiTokenMcp } from '../apps/desktop/src/main/mcp-preflight.ts'
import { clearConfigCaches, type BundleMcp } from '../apps/desktop/src/main/config-loader.ts'
import { clearSettingsCache, saveSettings } from '../apps/desktop/src/main/settings.ts'
import type { ResolvedRuntimeMcpEntry } from '../apps/desktop/src/main/runtime-mcp.ts'

const resolvePublicTestHost = async () => [{ address: '140.82.112.22', family: 4 }]

function baseSettings(): AppSettings {
  return {
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
    enableBash: false,
    enableFileWrite: false,
    runtimeConfigSource: 'app',
    runtimeToolingBridgeEnabled: true,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: '22:00',
    workflowQuietHoursEnd: '07:00',
  }
}

async function withRemoteMcpConfig(
  fn: () => Promise<void>,
  mcpOverrides: Partial<BundleMcp> = {},
) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-mcp-preflight-'))
  const configDir = join(tempRoot, 'config')
  const userDataDir = join(tempRoot, 'user-data')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    allowedEnvPlaceholders: [],
    providers: {
      available: ['test'],
      defaultProvider: 'test',
      defaultModel: 'fast',
      descriptors: {
        test: { name: 'Test', description: '', credentials: [], models: [{ id: 'fast', name: 'Fast' }] },
      },
    },
    mcps: [{
      name: 'github',
      type: 'remote',
      description: 'GitHub hosted MCP',
      authMode: 'api_token',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { 'X-MCP-Toolsets': 'repos,issues' },
      headerSettings: [{ header: 'Authorization', key: 'token', prefix: 'Bearer ' }],
      credentialHelp: 'Authorize fine-grained PATs for SSO and required repositories.',
      credentials: [{
        key: 'token',
        label: 'GitHub token',
        description: 'GitHub PAT',
        required: true,
        secret: true,
      }],
      ...mcpOverrides,
    }],
  }))
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearSettingsCache()
  try {
    await fn()
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    clearSettingsCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('preflightConfiguredApiTokenMcp reports missing required credentials without fetching', async () => {
  await withRemoteMcpConfig(async () => {
    saveSettings(baseSettings())
    let fetched = false
    let resolved = false

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: async () => {
        resolved = true
        throw new Error('should not resolve before credential validation')
      },
      fetchImpl: (async () => {
        fetched = true
        return new Response('', { status: 200 })
      }) as typeof fetch,
      listToolsFromMcpEntry: async () => [],
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'missing_credentials')
    assert.match(result.message, /GitHub token/)
    assert.equal(fetched, false)
    assert.equal(resolved, false)
  })
})

test('preflightConfiguredApiTokenMcp classifies rejected tokens with sanitized response bodies', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz', '123456'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: resolvePublicTestHost,
      fetchImpl: (async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>)?.Authorization, `Bearer ${fakeToken}`)
        return new Response(`token ${fakeToken} rejected`, { status: 401 })
      }) as typeof fetch,
      listToolsFromMcpEntry: async () => {
        throw new Error('should not list tools after auth rejection')
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'auth_rejected')
    assert.equal(result.httpStatus, 401)
    assert.match(result.responseBody || '', /\[REDACTED_TOKEN\]/)
    assert.match(result.helpText || '', /SSO/)
  })
})

test('preflightConfiguredApiTokenMcp classifies forbidden policy responses', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['ghp', '_', 'forbidden', 'token', 'value', '123456'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: resolvePublicTestHost,
      fetchImpl: (async () => new Response('SSO authorization required', { status: 403 })) as typeof fetch,
      listToolsFromMcpEntry: async () => {
        throw new Error('should not list tools after policy rejection')
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'forbidden')
    assert.equal(result.httpStatus, 403)
    assert.match(result.message, /SSO authorization/)
    assert.match(result.responseBody || '', /SSO authorization required/)
  })
})

test('preflightConfiguredApiTokenMcp classifies network authentication responses as network errors', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['ghp', '_', 'network', 'auth', 'token', '123456'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: resolvePublicTestHost,
      fetchImpl: (async () => new Response('Network Authentication Required', { status: 511 })) as typeof fetch,
      listToolsFromMcpEntry: async () => {
        throw new Error('should not list tools after network auth rejection')
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'network_error')
    assert.equal(result.httpStatus, 511)
    assert.match(result.message, /captive portal/)
    assert.match(result.responseBody || '', /Network Authentication Required/)
  })
})

test('preflightConfiguredApiTokenMcp confirms MCP tool-list connectivity', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['github', '_pat_', 'valid', 'token', 'value', '1234567890'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })
    const entries: ResolvedRuntimeMcpEntry[] = []
    const methods: CapabilityToolEntry[] = [{ id: 'list_repositories', description: 'List repositories.' }]

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: resolvePublicTestHost,
      fetchImpl: (async () => new Response('', { status: 405 })) as typeof fetch,
      listToolsFromMcpEntry: async (entry) => {
        entries.push(entry)
        return methods
      },
    })

    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.methodCount, 1)
    assert.equal(entries[0]?.type, 'remote')
    if (entries[0]?.type !== 'remote') return
    assert.equal(entries[0].headers?.Authorization, `Bearer ${fakeToken}`)
    assert.equal(entries[0].headers?.['X-MCP-Toolsets'], 'repos,issues')
  })
})

test('preflightConfiguredApiTokenMcp preserves bundled private-network opt-in', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['github', '_pat_', 'private', 'token', 'value', '1234567890'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })
    let resolvedHost = ''

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: async (hostname) => {
        resolvedHost = hostname
        return [{ address: '10.0.0.5', family: 4 }]
      },
      fetchImpl: (async () => new Response('', { status: 405 })) as typeof fetch,
      listToolsFromMcpEntry: async (entry) => {
        assert.equal(entry.type, 'remote')
        if (entry.type === 'remote') {
          assert.equal(entry.url, 'https://internal.example/mcp/')
        }
        return [{ id: 'internal_lookup', description: 'Look up internal resources.' }]
      },
    })

    assert.equal(resolvedHost, 'internal.example')
    assert.equal(result.ok, true)
    assert.equal(result.status, 'ok')
    assert.equal(result.methodCount, 1)
  }, {
    url: 'https://internal.example/mcp/',
    allowPrivateNetwork: true,
  })
})

test('preflightConfiguredApiTokenMcp sanitizes protocol error text before returning it', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['ghp', '_', 'protocol', 'secret', 'token', '1234567890'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: resolvePublicTestHost,
      fetchImpl: (async () => new Response('', { status: 405 })) as typeof fetch,
      listToolsFromMcpEntry: async () => {
        throw new Error(`handshake failed with Authorization: Bearer ${fakeToken}`)
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'protocol_error')
    assert.doesNotMatch(result.message, new RegExp(fakeToken))
    assert.match(result.message, /\[REDACTED_TOKEN\]/)
  })
})

test('preflightConfiguredApiTokenMcp classifies aborted tool-list probes as network errors', async () => {
  await withRemoteMcpConfig(async () => {
    const fakeToken = ['github', '_pat_', 'aborted', 'token', 'value', '1234567890'].join('')
    saveSettings({
      ...baseSettings(),
      integrationCredentials: { github: { token: fakeToken } },
    })

    const result = await preflightConfiguredApiTokenMcp('github', {
      resolveHostname: resolvePublicTestHost,
      fetchImpl: (async () => new Response('', { status: 405 })) as typeof fetch,
      listToolsFromMcpEntry: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError')
      },
    })

    assert.equal(result.ok, false)
    assert.equal(result.status, 'network_error')
    assert.match(result.message, /Could not reach/)
  })
})
