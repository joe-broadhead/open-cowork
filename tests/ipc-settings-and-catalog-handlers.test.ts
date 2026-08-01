import { runtimeState } from '@open-cowork/runtime-host/runtime-state'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CustomMcpConfig, type DesktopPairingPublicRecord, VOICE_PTT_SHORTCUT } from '@open-cowork/shared'
import { registerAppHandlers } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerProviderHandlers } from '../apps/desktop/src/main/ipc/provider-handlers.ts'
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
  await assert.rejects(
    () => handler({}, { voicePttShortcut: 'CmdOrCtrl+Shift+P' }),
    /Voice PTT shortcut conflicts with Command Palette/,
  )
  await assert.rejects(
    () => handler({}, { voicePttShortcut: 'V' }),
    /Voice PTT shortcut must include a modifier and a supported key/,
  )
})

test('settings:set refreshes the Electron menu immediately after a valid local Voice shortcut save', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-voice-shortcut-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const shortcuts: string[] = []
    const { context, handlers } = createBaseContext({
      refreshApplicationMenu: (shortcut) => shortcuts.push(shortcut),
    })
    registerAppHandlers(context)
    const result = await handlers.get('settings:set')?.({}, {
      selectedProviderId: null,
      voicePttShortcut: 'CmdOrCtrl+Alt+V',
    })

    assert.equal(result.voicePttShortcut, 'CmdOrCtrl+Alt+V')
    assert.deepEqual(shortcuts, ['CmdOrCtrl+Alt+V'])

    const resetResult = await handlers.get('settings:set')?.({}, {
      voicePttShortcut: null,
    })

    assert.equal(resetResult.voicePttShortcut, VOICE_PTT_SHORTCUT)
    assert.deepEqual(shortcuts, ['CmdOrCtrl+Alt+V', VOICE_PTT_SHORTCUT])
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
          // Legacy workspace-scoped consent must be ignored. Adoption consent
          // belongs to this desktop installation's Local settings.
          privacyShareAnonymizedUsage: true,
        },
        updatedAt: '2026-05-27T10:00:00.000Z',
      }
    },
    setSetting: async (key, value) => {
      calls.push(`set:${key}:${value.selectedProviderId}:${Object.keys(value).sort().join(',')}`)
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
  // Legacy Cloud overrides are ignored because notification delivery is owned
  // by this desktop installation's Local workspace.
  assert.equal(current.notificationVoiceReplies, true)
  assert.equal(current.privacyShareAnonymizedUsage, false)
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

  for (const privacyShareAnonymizedUsage of [false, true]) {
    await assert.rejects(
      () => handlers.get('settings:set')?.({}, {
        workspaceId: 'cloud:test',
        privacyShareAnonymizedUsage,
      }),
      /do not sync raw or local-only/,
    )
  }

  for (const localOnlyUpdate of [
    { notificationSounds: false },
    { workflowRunInBackground: false },
  ]) {
    await assert.rejects(
      () => handlers.get('settings:set')?.({}, {
        workspaceId: 'cloud:test',
        ...localOnlyUpdate,
      }),
      /do not sync raw or local-only/,
    )
  }

  const updated = await handlers.get('settings:set')?.({}, {
    workspaceId: 'cloud:test',
    selectedProviderId: 'openai',
    selectedModelId: 'gpt-test',
  })
  assert.equal(updated.selectedProviderId, 'openai')
  assert.equal(updated.notificationVoiceReplies, true)
  assert.equal(updated.privacyShareAnonymizedUsage, false)
  assert.deepEqual(updated.providerCredentials, {})

  assert.deepEqual(calls, [
    'get:portable-settings',
    'get:portable-settings',
    'set:portable-settings:openai:selectedModelId,selectedProviderId',
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
  const nativeCredentialSignals: AbortSignal[] = []
  const nativeCatalogSignals: AbortSignal[] = []
  const temporarySessionCalls: string[] = []
  const temporarySessionSignals: AbortSignal[] = []
  let nativeCredentialFailure: Error | null = null
  let nativeCatalogFailure: Error | null = null
  let promptFailure: Error | null = null
  let deleteFailure: Error | null = null
  const fakeClient = {
    session: {
      delete: async (input: unknown, options: unknown) => {
        temporarySessionCalls.push('delete')
        temporarySessionSignals.push((options as { signal: AbortSignal }).signal)
        assert.equal((input as { sessionID: string }).sessionID, 'connection-check-session')
        if (deleteFailure) throw deleteFailure
        return { data: true }
      },
    },
    v2: {
      session: {
        create: async (input: unknown, options: unknown) => {
          temporarySessionCalls.push('create')
          assert.equal((options as { throwOnError: boolean }).throwOnError, true)
          temporarySessionSignals.push((options as { signal: AbortSignal }).signal)
          assert.equal((input as { model: { id: string } }).model.id, 'model')
          return { data: { data: { id: 'connection-check-session' } } }
        },
        prompt: async (input: unknown, options: unknown) => {
          temporarySessionCalls.push('prompt')
          temporarySessionSignals.push((options as { signal: AbortSignal }).signal)
          assert.equal((input as { sessionID: string }).sessionID, 'connection-check-session')
          assert.equal((input as { prompt: { text: string } }).prompt.text, 'Reply with OK only. Do not use tools.')
          if (promptFailure) throw promptFailure
          return {
            data: {
              data: {
                id: 'connection-check-input',
                sessionID: 'connection-check-session',
              },
            },
          }
        },
        wait: async (input: unknown, options: unknown) => {
          temporarySessionCalls.push('wait')
          temporarySessionSignals.push((options as { signal: AbortSignal }).signal)
          assert.equal((input as { sessionID: string }).sessionID, 'connection-check-session')
        },
        messages: async (input: unknown, options: unknown) => {
          temporarySessionCalls.push('messages')
          temporarySessionSignals.push((options as { signal: AbortSignal }).signal)
          assert.deepEqual(input, {
            sessionID: 'connection-check-session',
            limit: 20,
            order: 'desc',
          })
          return {
            data: {
              data: [{
                id: 'connection-check-response',
                type: 'assistant',
                agent: 'build',
                model: { providerID: 'acme', id: 'model' },
                content: [{ type: 'text', text: 'OK' }],
                time: { created: Date.now(), completed: Date.now() },
                finish: 'stop',
              }],
              cursor: {},
            },
          }
        },
      },
      provider: {
        get: async (_input: unknown, options: unknown) => {
          nativeCredentialSignals.push((options as { signal: AbortSignal }).signal)
          if (nativeCredentialFailure) throw nativeCredentialFailure
          return {
          data: { data: { id: 'acme', name: 'Acme', integrationID: 'acme' } },
          }
        },
        list: async (_input: unknown, options: unknown) => {
          nativeCatalogSignals.push((options as { signal: AbortSignal }).signal)
          if (nativeCatalogFailure) throw nativeCatalogFailure
          return {
          data: { data: [{ id: 'acme', name: 'Acme', integrationID: 'acme' }] },
          }
        },
      },
      model: {
        list: async (_input: unknown, options: unknown) => {
          nativeCatalogSignals.push((options as { signal: AbortSignal }).signal)
          return {
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
          }
        },
      },
      integration: {
        get: async (_input: unknown, options: unknown) => {
          nativeCredentialSignals.push((options as { signal: AbortSignal }).signal)
          return {
          data: { data: { id: 'acme', methods: [{ type: 'key' }] } },
          }
        },
        connect: {
          key: async (input: unknown, options: unknown) => {
            nativeCredentialSignals.push((options as { signal: AbortSignal }).signal)
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
      getEffectiveSettings,
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
    assert.deepEqual((credentialConnectCalls[0] as { input: unknown }).input, {
      integrationID: 'acme',
      key: 'provider-secret',
      label: 'Open Cowork',
    })
    assert.equal((credentialConnectCalls[0] as { options: { throwOnError: boolean } }).options.throwOnError, true)
    assert.equal(nativeCredentialSignals.length, 3)
    assert.ok(nativeCredentialSignals.every((signal) => signal instanceof AbortSignal))
    assert.equal(new Set(nativeCredentialSignals).size, 1, 'native credential sync should share one phase deadline')
    assert.equal(nativeCatalogSignals.length, 2)
    assert.ok(nativeCatalogSignals.every((signal) => signal instanceof AbortSignal))
    assert.equal(new Set(nativeCatalogSignals).size, 1, 'native catalog loading should share one phase deadline')
    assert.notEqual(nativeCredentialSignals[0], nativeCatalogSignals[0])
    assert.deepEqual(temporarySessionCalls, ['create', 'prompt', 'wait', 'messages', 'delete'])
    assert.equal(new Set(temporarySessionSignals).size, 5, 'each connection-check operation needs an independent timeout')
    assert.equal(getEffectiveSettings().setupComplete, true)

    const credentialTimeout = new Error('credential sync timed out')
    credentialTimeout.name = 'TimeoutError'
    nativeCredentialFailure = credentialTimeout
    saveSettings({ providerCredentials: { acme: { apiKey: 'provider-secret-2' } } })
    await assert.rejects(
      () => handler({}, 'acme', 'acme/model'),
      /timed out while applying the saved credential/i,
    )
    nativeCredentialFailure = null

    const catalogTimeout = new Error('catalog timed out')
    catalogTimeout.name = 'AbortError'
    nativeCatalogFailure = catalogTimeout
    await assert.rejects(
      () => handler({}, 'acme', 'acme/model'),
      /timed out while loading its provider catalog/i,
    )
    nativeCatalogFailure = null

    const abortedPrompt = new Error('prompt timed out')
    abortedPrompt.name = 'AbortError'
    promptFailure = abortedPrompt
    deleteFailure = new Error('cleanup failed')
    temporarySessionCalls.length = 0
    saveSettings({ providerCredentials: { acme: { apiKey: 'provider-secret-3' } } })
    await assert.rejects(
      () => handler({}, 'acme', 'acme/model'),
      /model connection check failed/i,
    )
    assert.deepEqual(temporarySessionCalls, ['create', 'prompt', 'delete'])
    assert.equal(new Set(temporarySessionSignals.slice(-3)).size, 3)
    assert.equal(getEffectiveSettings().setupComplete, false)

    await assert.rejects(
      () => handler({}, 'acme', 'missing-model'),
      /Setup settings changed before the connection check/,
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

test('provider connection proof survives relaunch only after authoritative success', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-provider-proof-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const {
      clearSettingsCache,
      getEffectiveSettings,
      saveSettings,
    } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    saveSettings({
      selectedProviderId: 'acme',
      selectedModelId: 'acme/model',
      providerCredentials: {
        acme: { apiKey: 'invalid-key', projectId: 'project-visible' },
      },
    })

    const validationCalls: Array<{ providerId: string, modelId: string }> = []
    const lifecycle: string[] = []
    const { context, handlers } = createBaseContext({
      restartRuntime: async () => {
        lifecycle.push('promote')
      },
      restartRuntimeForSetupValidation: async () => {
        lifecycle.push('setup-restart')
      },
      suspendRuntimeForSetup: async () => {
        assert.equal(getEffectiveSettings().setupComplete, false)
        lifecycle.push('suspend')
      },
      validateSetupConnection: async (providerId, modelId) => {
        lifecycle.push('validate')
        validationCalls.push({ providerId, modelId })
        throw new Error('authoritative fixture rejected the credential')
      },
    })
    registerAppHandlers(context)
    const handler = handlers.get('provider:test-connection')
    assert.ok(handler, 'expected provider:test-connection handler to be registered')

    await assert.rejects(
      () => handler({}, 'acme', 'acme/model'),
      /authoritative fixture rejected the credential/,
    )
    assert.equal(getEffectiveSettings().setupComplete, false)
    clearSettingsCache()
    assert.equal(getEffectiveSettings().setupComplete, false)
    assert.deepEqual(lifecycle, ['setup-restart', 'validate', 'suspend'])

    context.validateSetupConnection = async (providerId, modelId) => {
      lifecycle.push('validate')
      validationCalls.push({ providerId, modelId })
      return { ok: true, providerId, modelId }
    }
    assert.deepEqual(await handler({}, 'acme', 'acme/model'), {
      ok: true,
      providerId: 'acme',
      modelId: 'acme/model',
    })
    assert.equal(getEffectiveSettings().setupComplete, true)
    clearSettingsCache()
    assert.equal(getEffectiveSettings().setupComplete, true)
    assert.deepEqual(lifecycle, [
      'setup-restart',
      'validate',
      'suspend',
      'setup-restart',
      'validate',
      'promote',
    ])
    assert.deepEqual(validationCalls, [
      { providerId: 'acme', modelId: 'acme/model' },
      { providerId: 'acme', modelId: 'acme/model' },
    ])

    context.validateSetupConnection = async () => {
      lifecycle.push('validate')
      throw new Error('revalidation rejected the credential')
    }
    await assert.rejects(
      () => handler({}, 'acme', 'acme/model'),
      /revalidation rejected the credential/,
    )
    assert.equal(getEffectiveSettings().setupComplete, false)
    assert.deepEqual(lifecycle.slice(-4), ['suspend', 'setup-restart', 'validate', 'suspend'])

    saveSettings({ providerCredentials: { acme: { apiKey: 'changed-key' } } })
    assert.equal(getEffectiveSettings().setupComplete, false)
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

test('successful OpenCode OAuth completion invalidates proof and suspends a validated runtime', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-provider-oauth-complete-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousClient = runtimeState.getClient()

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  const completedAttempts: string[] = []
  const cancelledAttempts: string[] = []
  runtimeState.setClient({
    v2: {
      provider: {
        get: async () => ({
          data: { data: { id: 'acme', name: 'Acme', integrationID: 'acme-oauth' } },
        }),
      },
      integration: {
        get: async () => ({
          data: {
            data: {
              id: 'acme-oauth',
              methods: [{ id: 'oauth', type: 'oauth', label: 'Sign in' }],
              connections: [],
            },
          },
        }),
        connect: {
          oauth: async () => {
            const { getEffectiveSettings } = await import('@open-cowork/runtime-host/settings')
            assert.equal(getEffectiveSettings().setupComplete, false, 'proof must be invalid before OAuth can mutate credentials')
            return {
            data: {
              data: {
                attemptID: 'attempt-1',
                url: 'https://auth.example.test',
                instructions: 'Finish signing in.',
                mode: 'code',
              },
            },
            }
          },
        },
        attempt: {
          cancel: async ({ attemptID }: { attemptID: string }) => {
            cancelledAttempts.push(attemptID)
            return { data: { data: true } }
          },
          status: async () => ({ data: { data: { status: 'pending' } } }),
          complete: async ({ attemptID }: { attemptID: string }) => {
            completedAttempts.push(attemptID)
            return { data: { data: true } }
          },
        },
      },
    },
  } as never)

  try {
    const {
      clearSettingsCache,
      getEffectiveSettings,
      getSetupValidationFingerprint,
      recordSuccessfulSetupValidation,
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
    const fingerprint = getSetupValidationFingerprint()
    assert.ok(fingerprint)
    assert.equal(recordSuccessfulSetupValidation(fingerprint).setupComplete, true)

    const lifecycle: string[] = []
    const { context, handlers } = createBaseContext({
      suspendRuntimeForSetup: async () => {
        assert.equal(getEffectiveSettings().setupComplete, false)
        lifecycle.push('suspend')
      },
    })
    registerProviderHandlers(context, {
      openExternal: async () => undefined,
    } as never)

    const authorize = handlers.get('provider:oauth-authorize')
    const callback = handlers.get('provider:oauth-callback')
    assert.ok(authorize)
    assert.ok(callback)
    await authorize({}, 'acme', 0)
    assert.equal(getEffectiveSettings().setupComplete, false)
    assert.deepEqual(lifecycle, [], 'the OpenCode daemon must stay available while the OAuth attempt is pending')
    assert.equal(await callback({}, 'acme', 0, 'authorization-code'), true)

    assert.deepEqual(completedAttempts, ['attempt-1'])
    assert.deepEqual(lifecycle, ['suspend'])
    assert.equal(getEffectiveSettings().setupComplete, false)
    clearSettingsCache()
    assert.equal(getEffectiveSettings().setupComplete, false, 'OAuth invalidation must survive relaunch')

    const nextFingerprint = getSetupValidationFingerprint()
    assert.ok(nextFingerprint)
    recordSuccessfulSetupValidation(nextFingerprint)
    lifecycle.length = 0
    context.oauthAttemptTimeoutMs = 5
    await authorize({}, 'acme', 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(lifecycle, ['suspend'], 'abandoned OAuth attempts must suspend their candidate runtime')
    assert.deepEqual(cancelledAttempts, ['attempt-1'])
    await assert.rejects(
      () => callback({}, 'acme', 0),
      /No pending OAuth attempt exists/,
    )
  } finally {
    const { clearSettingsCache } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    runtimeState.setClient(previousClient)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('OpenCode provider sign-out suspends an unvalidated candidate runtime', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-provider-sign-out-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousClient = runtimeState.getClient()

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  const removedCredentialIds: string[] = []
  runtimeState.setClient({
    v2: {
      provider: {
        get: async () => ({
          data: { data: { id: 'acme', name: 'Acme', integrationID: 'acme-oauth' } },
        }),
      },
      integration: {
        get: async () => ({
          data: {
            data: {
              id: 'acme-oauth',
              methods: [{ id: 'oauth', type: 'oauth', label: 'Sign in' }],
              connections: [{ id: 'credential-1', type: 'credential' }],
            },
          },
        }),
      },
      credential: {
        remove: async ({ credentialID }: { credentialID: string }) => {
          removedCredentialIds.push(credentialID)
          return { data: true }
        },
      },
    },
  } as never)

  try {
    const {
      clearSettingsCache,
      getEffectiveSettings,
      getSetupValidationFingerprint,
      invalidateSetupValidationProof,
      recordSuccessfulSetupValidation,
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
    const fingerprint = getSetupValidationFingerprint()
    assert.ok(fingerprint)
    assert.equal(recordSuccessfulSetupValidation(fingerprint).setupComplete, true)
    invalidateSetupValidationProof()
    assert.equal(getEffectiveSettings().setupComplete, false, 'candidate runtime fixture must be unvalidated')

    const lifecycle: string[] = []
    const { context, handlers } = createBaseContext({
      suspendRuntimeForSetup: async () => {
        assert.equal(getEffectiveSettings().setupComplete, false)
        lifecycle.push('suspend')
      },
    })
    registerAppHandlers(context)
    const handler = handlers.get('provider:auth-remove')
    assert.ok(handler, 'expected provider:auth-remove handler to be registered')

    assert.equal(await handler({}, 'acme'), true)
    assert.deepEqual(removedCredentialIds, ['credential-1'])
    assert.deepEqual(lifecycle, ['suspend'])
    assert.equal(getEffectiveSettings().setupComplete, false)
    clearSettingsCache()
    assert.equal(getEffectiveSettings().setupComplete, false, 'sign-out invalidation must survive relaunch')
  } finally {
    const { clearSettingsCache } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    runtimeState.setClient(previousClient)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('runtime-sensitive local settings suspend a stale runtime when they invalidate setup proof', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-runtime-proof-invalidation-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousClient = runtimeState.getClient()

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const {
      clearSettingsCache,
      getEffectiveSettings,
      getSetupValidationFingerprint,
      recordSuccessfulSetupValidation,
      saveSettings,
    } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    saveSettings({
      selectedProviderId: 'acme',
      selectedModelId: 'acme/model',
      providerCredentials: {
        acme: { apiKey: 'old-secret', projectId: 'project-visible' },
      },
    })
    const fingerprint = getSetupValidationFingerprint()
    assert.ok(fingerprint)
    assert.equal(recordSuccessfulSetupValidation(fingerprint).setupComplete, true)

    runtimeState.setClient({} as never)
    const lifecycle: string[] = []
    const { context, handlers } = createBaseContext()
    ;(context as typeof context & { suspendRuntimeForSetup?: () => Promise<void> }).suspendRuntimeForSetup = async () => {
      assert.equal(getEffectiveSettings().setupComplete, false, 'proof must be invalid before the runtime is suspended')
      lifecycle.push('suspend')
      runtimeState.setClient(null)
    }
    registerAppHandlers(context)
    const handler = handlers.get('settings:set')
    assert.ok(handler, 'expected settings:set handler to be registered')

    const updated = await handler({}, {
      providerCredentials: {
        acme: { apiKey: 'new-secret', projectId: 'project-visible' },
      },
    })
    assert.equal(updated.setupComplete, false)
    assert.deepEqual(lifecycle, ['suspend'])
    assert.equal(runtimeState.getClient(), null, 'the invalidated runtime must not remain available')

    await handler({}, {
      providerCredentials: {
        acme: { apiKey: 'new-secret', projectId: 'project-visible' },
      },
    })
    assert.deepEqual(lifecycle, ['suspend'], 'an idempotent save must not trigger a duplicate suspension')

    await handler({}, {
      providerCredentials: {
        acme: { apiKey: 'third-secret', projectId: 'project-visible' },
      },
    })
    assert.deepEqual(lifecycle, ['suspend', 'suspend'], 'a changed setting must cancel an in-flight boot even before a client is published')
  } finally {
    const { clearSettingsCache } = await import('@open-cowork/runtime-host/settings')
    clearSettingsCache()
    runtimeState.setClient(previousClient)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('runtime restart requires an explicit connection-validation purpose until setup is proven', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-ipc-runtime-restart-purpose-'))
  const configDir = join(tempRoot, 'downstream')
  const userDataDir = join(tempRoot, 'user-data')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  writeCredentialDescriptorConfig(configDir)
  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()

  try {
    const {
      clearSettingsCache,
      getSetupValidationFingerprint,
      recordSuccessfulSetupValidation,
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

    let restartCalls = 0
    let setupRestartCalls = 0
    const { context, handlers } = createBaseContext({
      restartRuntime: async () => {
        restartCalls += 1
      },
      restartRuntimeForSetupValidation: async () => {
        setupRestartCalls += 1
      },
    })
    registerAppHandlers(context)
    const handler = handlers.get('runtime:restart')
    assert.ok(handler)

    await assert.rejects(
      () => handler({}),
      /connection validation.*setup/i,
    )
    await assert.rejects(
      () => handler({}, { purpose: 'offline_retry' }),
      /runtime restart purpose/i,
    )
    assert.equal(restartCalls, 0)
    assert.equal(setupRestartCalls, 0)

    await handler({}, { purpose: 'setup_connection_validation' })
    assert.equal(setupRestartCalls, 1)
    assert.equal(restartCalls, 0)

    const fingerprint = getSetupValidationFingerprint()
    assert.ok(fingerprint)
    recordSuccessfulSetupValidation(fingerprint)
    await handler({})
    assert.equal(setupRestartCalls, 1)
    assert.equal(restartCalls, 1)
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
