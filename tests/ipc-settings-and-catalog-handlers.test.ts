import { runtimeState } from '@open-cowork/runtime-host/runtime-state'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CustomMcpConfig, type DesktopPairingPublicRecord } from '@open-cowork/shared'
import { registerAppHandlers } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
import { LOCAL_WORKSPACE_ID, createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { createIpcHandlerHarness as createBaseContext } from './support/ipc-handler-harness.ts'

function writeCredentialDescriptorConfig(
  configDir: string,
  options: { includeMissingRequiredCredential?: boolean } = {},
) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    providers: {
      available: ['acme'],
      defaultProvider: 'acme',
      defaultModel: 'acme/model',
      descriptors: {
        acme: {
          runtime: 'builtin',
          name: 'Acme',
          description: 'Acme provider',
          defaultModel: 'acme/model',
          credentials: [
            { key: 'apiKey', label: 'API key', description: 'Secret API key', secret: true },
            { key: 'projectId', label: 'Project', description: 'Visible project id', secret: false },
            ...(options.includeMissingRequiredCredential
              ? [{ key: 'accountId', label: 'Account', description: 'Required account id', secret: false, required: true }]
              : []),
          ],
          models: [{ id: 'acme/model', name: 'Acme Model' }],
        },
      },
    },
    mcps: [{
      name: 'github',
      type: 'remote',
      description: 'GitHub',
      authMode: 'api_token',
      url: 'https://mcp.example.test/github',
      credentials: [
        { key: 'token', label: 'Token', description: 'Secret token', secret: true },
        { key: 'host', label: 'Host', description: 'Visible host', secret: false },
      ],
    }],
  }))
}

test('custom:test-mcp reports OAuth guidance for remote MCP auth errors', async () => {
  const { context, handlers, errors } = createBaseContext()
  const mcp: CustomMcpConfig = {
    name: 'nova',
    type: 'http',
    url: 'https://93.184.216.34/mcp',
    scope: 'machine',
    directory: null,
  }

  context.listToolsFromMcpEntry = async () => {
    throw new Error('401 unauthorized')
  }
  context.isLikelyMcpAuthError = () => true

  registerCustomContentHandlers(context)
  const handler = handlers.get('custom:test-mcp')

  assert.ok(handler, 'expected custom:test-mcp handler to be registered')
  const result = await handler({}, mcp)

  assert.deepEqual(result.methods, [])
  assert.equal(result.ok, false)
  assert.equal(result.authRequired, true)
  assert.match(result.error || '', /require OAuth/i)
  assert.match(result.error || '', /authenticate.*status panel/i)
  assert.match(errors[0] || '', /custom:test-mcp nova/)
})

test('dialog:save-text rejects oversized renderer content before opening a save dialog', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('dialog:save-text')

  assert.ok(handler, 'expected dialog:save-text handler to be registered')
  await assert.rejects(
    () => handler({}, 'agent.cowork-agent.json', 'x'.repeat((2 * 1024 * 1024) + 1)),
    /Save content is too large/,
  )
})

test('chart:render-svg rejects non-object renderer payloads before rendering', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('chart:render-svg')

  assert.ok(handler, 'expected chart:render-svg handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-a-spec'),
    /chart specification to be an object/,
  )
})

test('tool:list rejects malformed options before runtime tool discovery', async () => {
  const { context, handlers } = createBaseContext()
  let runtimeToolListCalled = false
  context.listRuntimeTools = async () => {
    runtimeToolListCalled = true
    return []
  }

  registerCatalogHandlers(context)
  const handler = handlers.get('tool:list')

  assert.ok(handler, 'expected tool:list handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-options'),
    /tool list options to be an object/,
  )
  assert.equal(runtimeToolListCalled, false)
})

test('classic MCP transitions fail closed when the SDK returns an HTTP error response', async () => {
  const { context, handlers, errors } = createBaseContext()
  const previousClient = runtimeState.getClient()
  const optionsByMutation = new Map<string, Record<string, unknown> | undefined>()
  const failingMutation = (name: string) => async (
    _input: unknown,
    options?: Record<string, unknown>,
  ) => {
    optionsByMutation.set(name, options)
    if (options?.throwOnError === true) throw new Error(`${name} rejected`)
    return { error: { message: `${name} rejected` } }
  }

  runtimeState.setClient({
    mcp: {
      connect: failingMutation('connect'),
      disconnect: failingMutation('disconnect'),
    },
  } as never)
  try {
    registerCatalogHandlers(context)

    assert.equal(await handlers.get('mcp:connect')?.({}, 'nova'), false)
    assert.equal(await handlers.get('mcp:disconnect')?.({}, 'nova'), false)
    assert.deepEqual(Object.fromEntries(optionsByMutation), {
      connect: { throwOnError: true },
      disconnect: { throwOnError: true },
    })
    assert.equal(errors.filter((entry) => /rejected/.test(entry)).length, 2)
  } finally {
    runtimeState.setClient(previousClient)
  }
})

test('settings:set rejects unknown and malformed settings payloads before saving', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('settings:set')

  assert.ok(handler, 'expected settings:set handler to be registered')
  await assert.rejects(
    () => handler({}, { unknownSetting: true }),
    /Unknown settings key/,
  )
  await assert.rejects(
    () => handler({}, { providerCredentials: { openai: { apiKey: 42 } } }),
    /Provider credentials\.openai\.apiKey must be a string/,
  )
})

test('settings handlers sync only portable settings for cloud workspaces', async () => {
  const { context, handlers } = createBaseContext()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { settings: true },
      allowedAgents: null,
      allowedTools: null,
      allowedMcps: null,
      localFiles: 'disabled',
      localStdioMcps: 'disabled',
      machineRuntimeConfig: 'disabled',
    }),
    listSessions: async () => [],
    createSession: async () => {
      throw new Error('not used')
    },
    getSessionInfo: async () => null,
    getSessionView: async () => {
      throw new Error('not used')
    },
    promptSession: async () => {},
    abortSession: async () => {},
    getSetting: async (key) => {
      calls.push(`get:${key}`)
      return {
        key,
        value: {
          selectedProviderId: 'anthropic',
          selectedModelId: 'claude-test',
          notificationVoiceReplies: false,
          privacyShareAnonymizedUsage: true,
        },
        updatedAt: '2026-05-27T10:00:00.000Z',
      }
    },
    setSetting: async (key, value) => {
      calls.push(`set:${key}:${value.selectedProviderId}:${value.notificationVoiceReplies}:${value.privacyShareAnonymizedUsage}`)
      return {
        key,
        value,
        updatedAt: '2026-05-27T10:01:00.000Z',
      }
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: {
      get: () => null,
      getUsableAccessToken: () => 'cloud-access-token',
      listMetadata: () => [],
      save: () => {
        throw new Error('not used')
      },
      remove: () => true,
    },
    workspaces: [{
      id: 'cloud:test',
      kind: 'cloud',
      label: 'Test Cloud',
      status: 'online',
      baseUrl: 'https://cloud.example.test',
      lastSyncedAt: null,
    }],
    cloudAdapterFactory: () => adapter,
  })

  registerAppHandlers(context)
  const cloudEvent = { sender: { id: 1 } } as never
  context.workspaceGateway.activate(cloudEvent, 'cloud:test')
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(cloudEvent, 'openrouter'), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(cloudEvent, 'github'), {})
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(cloudEvent, 'openrouter', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(cloudEvent, 'github', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})

  const current = await handlers.get('settings:get')?.({}, { workspaceId: 'cloud:test' })
  assert.equal(current.selectedProviderId, 'anthropic')
  assert.equal(current.notificationVoiceReplies, false)
  assert.equal(current.privacyShareAnonymizedUsage, true)
  assert.deepEqual(current.providerCredentials, {})

  await assert.rejects(
    () => handlers.get('settings:set')?.({}, {
      workspaceId: 'cloud:test',
      providerCredentials: { openai: { apiKey: 'secret' } },
    }),
    /do not sync raw/,
  )

  await assert.rejects(
    () => handlers.get('settings:set')?.({}, {
      workspaceId: 'cloud:test',
      webPermission: 'deny',
    }),
    /do not sync raw or local-only/,
  )

  await assert.rejects(
    () => handlers.get('settings:set')?.({}, {
      workspaceId: 'cloud:test',
      runtimeConfigSource: 'machine',
    }),
    /do not sync raw or local-only/,
  )

  const updated = await handlers.get('settings:set')?.({}, {
    workspaceId: 'cloud:test',
    selectedProviderId: 'openai',
    selectedModelId: 'gpt-test',
    notificationVoiceReplies: true,
    privacyShareAnonymizedUsage: false,
  })
  assert.equal(updated.selectedProviderId, 'openai')
  assert.equal(updated.notificationVoiceReplies, true)
  assert.equal(updated.privacyShareAnonymizedUsage, false)
  assert.deepEqual(updated.providerCredentials, {})

  assert.deepEqual(calls, [
    'get:portable-settings',
    'get:portable-settings',
    'set:portable-settings:openai:true:false',
  ])
})

test('local credential editor IPC masks secret fields and preserves them on save', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-masked-credentials-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir, { includeMissingRequiredCredential: true })
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const {
      CREDENTIAL_MASK,
      clearSettingsCache,
      loadSettings,
      saveSettings,
    } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    saveSettings({
      providerCredentials: {
        acme: { apiKey: 'provider-secret', projectId: 'project-visible' },
      },
      integrationCredentials: {
        github: { token: 'integration-secret', host: 'github.example.test' },
      },
    })

    const { context, handlers } = createBaseContext()
    registerAppHandlers(context)
    const localEvent = { sender: { id: 901 } } as never
    const setHandler = handlers.get('settings:set')
    assert.ok(setHandler, 'expected settings:set handler to be registered')

    assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(localEvent, 'acme', {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    }), {
      apiKey: CREDENTIAL_MASK,
      projectId: 'project-visible',
    })
    assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(localEvent, 'github', {
      workspaceId: LOCAL_WORKSPACE_ID,
      purpose: 'credential_editor',
    }), {
      token: CREDENTIAL_MASK,
      host: 'github.example.test',
    })

    await setHandler(localEvent, {
      workspaceId: LOCAL_WORKSPACE_ID,
      providerCredentials: {
        acme: { apiKey: CREDENTIAL_MASK, projectId: 'project-updated' },
      },
      integrationCredentials: {
        github: { token: CREDENTIAL_MASK, host: 'github-updated.example.test' },
      },
    })
    const persisted = loadSettings()
    assert.equal(persisted.providerCredentials.acme.apiKey, 'provider-secret')
    assert.equal(persisted.providerCredentials.acme.projectId, 'project-updated')
    assert.equal(persisted.integrationCredentials.github.token, 'integration-secret')
    assert.equal(persisted.integrationCredentials.github.host, 'github-updated.example.test')
  } finally {
    const { clearSettingsCache } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('provider connection test IPC syncs saved API auth and validates live models', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-provider-test-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  const credentialConnectCalls: unknown[] = []
  const fakeClient = {
    v2: {
      provider: {
        get: async () => ({
          data: { data: { id: 'acme', name: 'Acme', integrationID: 'acme' } },
        }),
        list: async () => ({
          data: { data: [{ id: 'acme', name: 'Acme', integrationID: 'acme' }] },
        }),
      },
      model: {
        list: async () => ({
          data: { data: [{
            id: 'acme/model',
            providerID: 'acme',
            name: 'Acme model',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            cost: [],
            variants: [],
            time: { released: 0 },
            status: 'active',
            enabled: true,
            limit: { context: 128_000, output: 16_000 },
          }] },
        }),
      },
      integration: {
        get: async () => ({
          data: { data: { id: 'acme', methods: [{ type: 'key' }] } },
        }),
        connect: {
          key: async (input: unknown, options: unknown) => {
            credentialConnectCalls.push({ input, options })
          },
        },
      },
    },
  }

  runtimeState.setClient(fakeClient as Parameters<typeof runtimeState.setClient>[0])
  try {
    const {
      clearSettingsCache,
      saveSettings,
    } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    saveSettings({
      selectedProviderId: 'acme',
      selectedModelId: 'acme/model',
      providerCredentials: {
        acme: { apiKey: 'provider-secret', projectId: 'project-visible' },
      },
    })

    const { context, handlers } = createBaseContext()
    registerAppHandlers(context)
    const handler = handlers.get('provider:test-connection')
    assert.ok(handler, 'expected provider:test-connection handler to be registered')

    assert.deepEqual(await handler({}, 'acme', 'acme/model'), {
      ok: true,
      providerId: 'acme',
      modelId: 'acme/model',
    })
    assert.deepEqual(credentialConnectCalls, [{
      input: {
        integrationID: 'acme',
        key: 'provider-secret',
        label: 'Open Cowork',
      },
      options: { throwOnError: true },
    }])

    await assert.rejects(
      () => handler({}, 'acme', 'missing-model'),
      /missing-model is not available from Acme/,
    )
  } finally {
    const { clearSettingsCache } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    runtimeState.resetAfterStop()
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('credential editor IPC is unavailable from Gateway and Paired Desktop workspaces', async () => {
  const { context, handlers } = createBaseContext()
  const pairing: DesktopPairingPublicRecord = {
    id: 'pairing-credentials',
    label: 'Paired Desktop',
    deviceName: 'Phone',
    status: 'paired_online',
    enabled: true,
    brokerUrl: 'https://gateway.example.test',
    allowedWorkspaceIds: ['local'],
    allowedSessionIds: [],
    policy: {
      allowRemotePrompts: true,
      allowRemoteAbort: true,
      remoteApprovals: 'local_confirmation',
      remoteQuestions: 'local_confirmation',
      exposeArtifactBodies: false,
      exposeLocalPaths: false,
      exposeLocalMcpDetails: false,
      allowRemoteAttachments: false,
    },
    lastConnectedAt: '2026-05-27T10:00:00.000Z',
    lastHeartbeatAt: '2026-05-27T10:01:00.000Z',
    lastCommandSequence: 1,
    error: null,
    createdAt: '2026-05-27T09:00:00.000Z',
    updatedAt: '2026-05-27T10:01:00.000Z',
    revokedAt: null,
    credential: {
      hasToken: true,
      deviceId: 'device-credentials',
      updatedAt: '2026-05-27T09:00:00.000Z',
    },
  }
  context.workspaceGateway = createWorkspaceGateway({
    cloudRegistry: null,
    cloudCredentialStore: null,
    gatewayRegistry: null,
    gatewayCredentialStore: null,
    desktopPairingProvider: () => [pairing],
    workspaces: [{
      id: 'gateway:test',
      kind: 'gateway',
      authority: 'gateway_standalone',
      label: 'Gateway',
      status: 'online',
      baseUrl: 'https://gateway.example.test/admin',
      lastSyncedAt: null,
    }],
  })

  registerAppHandlers(context)
  const gatewayEvent = { sender: { id: 701 } } as never
  context.workspaceGateway.activate(gatewayEvent, 'gateway:test')
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(gatewayEvent, 'openrouter', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(gatewayEvent, 'github', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})

  const pairedEvent = { sender: { id: 702 } } as never
  context.workspaceGateway.activate(pairedEvent, 'paired-desktop:pairing-credentials')
  assert.deepEqual(await handlers.get('settings:get-provider-credentials')?.(pairedEvent, 'openrouter', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
  assert.deepEqual(await handlers.get('settings:get-integration-credentials')?.(pairedEvent, 'github', {
    workspaceId: LOCAL_WORKSPACE_ID,
    purpose: 'credential_editor',
  }), {})
})

test('custom MCP IPC rejects malformed nested records before persistence', async () => {
  const { context, handlers } = createBaseContext()

  registerCustomContentHandlers(context)
  const handler = handlers.get('custom:add-mcp')

  assert.ok(handler, 'expected custom:add-mcp handler to be registered')
  await assert.rejects(
    () => handler({}, {
      scope: 'machine',
      name: 'local-tools',
      type: 'stdio',
      command: 'node',
      env: { OPEN_COWORK_TOKEN: 123 },
    }),
    /MCP env\.OPEN_COWORK_TOKEN must be a string/,
  )
})
