import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomMcpConfig } from '@open-cowork/shared'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerAppHandlers, resolveSafeSaveTextPath, saveTextExportFile } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerArtifactHandlers } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { normalizeFindTextPattern, registerExplorerHandlers } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'
import { registerWorkflowHandlers } from '../apps/desktop/src/main/ipc/workflow-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { sniffImageMime } from '../apps/desktop/src/main/ipc/app-handler-support.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { consumePendingPromptEcho } from '../apps/desktop/src/main/event-task-state.ts'
import { sessionEngine } from '../apps/desktop/src/main/session-engine.ts'
import { stopSessionStatusReconciliation } from '../apps/desktop/src/main/session-status-reconciler.ts'
import { clearSessionRegistryCache, toSessionRecord, upsertSessionRecord } from '../apps/desktop/src/main/session-registry.ts'

function createBaseContext() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const errors: string[] = []
  const context: IpcHandlerContext = {
    ipcMain: {
      handle(channel: string, handler: (...args: any[]) => any) {
        handlers.set(channel, handler)
      },
      on() {},
    },
    getMainWindow: () => null,
    normalizeDirectory: () => '/tmp',
    ensureSessionRecord: () => null,
    resolvePrivateArtifactPath: () => ({ root: '/tmp', source: '/tmp/file.txt' }),
    grantProjectDirectory: (directory) => directory,
    resolveGrantedProjectDirectory: (directory) => directory || null,
    resolveContextDirectory: () => null,
    resolveScopedTarget: (target) => ({ ...target, directory: target.directory || null }),
    buildCustomAgentPermission: async () => ({}),
    requestNativeConfirmation: async () => true,
    logHandlerError: (handler, err) => {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${handler}: ${message}`)
    },
    describeDestructiveRequest: () => 'test-target',
    consumeDestructiveConfirmation: () => true,
    reconcileIdleSession: () => {},
    getSessionClient: async () => {
      throw new Error('not stubbed')
    },
    getSessionV2Client: async () => {
      throw new Error('not stubbed')
    },
    listRuntimeTools: async () => [],
    withDiscoveredBuiltInTools: async (tools) => tools,
    listToolsFromMcpEntry: async () => [],
    isLikelyMcpAuthError: () => false,
    authenticateNewRemoteMcpIfNeeded: async () => {},
    approvedSkillImportDirectories: new Map(),
    capabilityToolMethodCache: new Map(),
  }

  return { context, handlers, errors }
}

function withPromptProviderConfig() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-prompt-provider-'))
  const configPath = join(tempRoot, 'open-cowork.config.json')
  const previousOverride = process.env.OPEN_COWORK_CONFIG_PATH
  const providerId = 'acme-provider'
  const modelId = 'live-model'

  writeFileSync(configPath, JSON.stringify({
    providers: {
      available: [providerId],
      defaultProvider: providerId,
      defaultModel: modelId,
      descriptors: {
        [providerId]: {
          runtime: 'builtin',
          name: 'Acme Provider',
          description: 'Acme provider',
          credentials: [],
          models: [
            { id: modelId, name: 'Live Model' },
          ],
        },
      },
    },
  }))

  process.env.OPEN_COWORK_CONFIG_PATH = configPath
  clearConfigCaches()

  return {
    providerId,
    modelId,
    cleanup() {
      if (previousOverride === undefined) delete process.env.OPEN_COWORK_CONFIG_PATH
      else process.env.OPEN_COWORK_CONFIG_PATH = previousOverride
      clearConfigCaches()
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

test('session:delete refuses to delete without a valid destructive confirmation', async () => {
  const { context, handlers, errors } = createBaseContext()
  let deleteCalled = false

  context.getSessionClient = async () => ({
    client: {
      session: {
        delete: async () => {
          deleteCalled = true
        },
      },
    } as any,
    record: null,
  })
  context.consumeDestructiveConfirmation = () => false

  registerSessionHandlers(context)
  const handler = handlers.get('session:delete')

  assert.ok(handler, 'expected session:delete handler to be registered')
  const result = await handler({}, 'session-1', null)

  assert.equal(result, false)
  assert.equal(deleteCalled, false)
  assert.match(errors[0] || '', /Confirmation required before deleting a thread/)
})

test('session id handlers reject malformed ids before session lookup', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = 0
  let registryRequested = 0

  context.getSessionClient = async () => {
    clientRequested += 1
    throw new Error('runtime should not be reached')
  }
  context.ensureSessionRecord = () => {
    registryRequested += 1
    return null
  }

  registerSessionHandlers(context)

  const cases: Array<{ channel: string; args: unknown[] }> = [
    { channel: 'session:activate', args: ['   '] },
    { channel: 'session:get', args: ['   '] },
    { channel: 'session:abort', args: ['   '] },
    { channel: 'session:abort-task', args: ['   ', 'child-session'] },
    { channel: 'session:abort-task', args: ['root-session', '   '] },
    { channel: 'session:fork', args: ['   '] },
    { channel: 'session:export', args: ['   '] },
    { channel: 'session:share', args: ['   '] },
    { channel: 'session:unshare', args: ['   '] },
    { channel: 'session:summarize', args: ['   '] },
    { channel: 'session:revert', args: ['   '] },
    { channel: 'session:unrevert', args: ['   '] },
    { channel: 'session:children', args: ['   '] },
    { channel: 'session:diff', args: ['   '] },
    { channel: 'session:delete', args: ['   ', 'token'] },
  ]

  for (const { channel, args } of cases) {
    const handler = handlers.get(channel)
    assert.ok(handler, `expected ${channel} handler to be registered`)
    await assert.rejects(async () => handler({}, ...args), /Session id/)
  }

  assert.equal(clientRequested, 0)
  assert.equal(registryRequested, 0)
})

test('session:prompt rejects oversized text before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-1', 'x'.repeat(1_000_001)),
    /Prompt text exceeds 1000000 bytes/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt rejects malformed argument tuples before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 123, 'hello'),
    /session id to be a string/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt rejects too many attachments before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }
  const attachments = Array.from({ length: 11 }, (_, index) => ({
    mime: 'image/png',
    url: `data:image/png;base64,${index}`,
    filename: `image-${index}.png`,
  }))

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-1', 'hello', attachments),
    /Prompt attachments exceed 10 files/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt rejects non-data attachment URLs before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-1', 'hello', [{
      mime: 'image/png',
      url: 'file:///Users/example/private.png',
      filename: 'private.png',
    }]),
    /URL must be a base64 data URL/,
  )
  assert.equal(clientRequested, false)
})

test('session:prompt clears pending prompt echo when dispatch fails', async () => {
  const { context, handlers } = createBaseContext()
  let promptCalled = false
  context.getSessionClient = async () => ({
    client: {
      provider: {
        list: async () => ({
          data: [],
        }),
        auth: async () => ({ data: {} }),
      },
      session: {
        promptAsync: async () => {
          promptCalled = true
          throw new Error('dispatch failed')
        },
      },
    } as any,
    record: null,
  })

  registerSessionHandlers(context)
  const handler = handlers.get('session:prompt')

  assert.ok(handler, 'expected session:prompt handler to be registered')
  await assert.rejects(
    () => handler({}, 'session-prompt-failure', 'hello from optimistic prompt'),
    /dispatch failed/i,
  )
  assert.equal(promptCalled, true)
  assert.equal(
    consumePendingPromptEcho('session-prompt-failure', 'hello from optimistic prompt'),
    'hello from optimistic prompt',
  )
})

test('session:prompt forwards an OpenCode model variant when the runtime catalog exposes it', async () => {
  const { providerId, modelId, cleanup } = withPromptProviderConfig()
  const { context, handlers } = createBaseContext()
  const sessionId = 'session-prompt-variant'
  const promptPayloads: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    context.getSessionClient = async () => ({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: providerId,
                name: 'Acme Provider',
                models: {
                  [modelId]: {
                    name: 'Live Model',
                    variants: {
                      xhigh: {},
                      low: {},
                    },
                  },
                },
              }],
              default: { [providerId]: modelId },
              connected: [providerId],
            },
          }),
          auth: async () => ({ data: {} }),
        },
        session: {
          promptAsync: async (payload: Record<string, unknown>) => {
            promptPayloads.push(payload)
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('session:prompt')
    assert.ok(handler, 'expected session:prompt handler to be registered')

    await handler({}, sessionId, 'analyze with more reasoning', undefined, 'build', { variant: 'xhigh' })

    assert.equal(promptPayloads.length, 1)
    assert.equal(promptPayloads[0]?.variant, 'xhigh')
    assert.deepEqual(promptPayloads[0]?.model, {
      providerID: providerId,
      modelID: modelId,
    })
  } finally {
    consumePendingPromptEcho(sessionId, 'analyze with more reasoning')
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
    cleanup()
  }
})

test('session:prompt ignores disabled model variants before runtime dispatch', async () => {
  const { providerId, modelId, cleanup } = withPromptProviderConfig()
  const { context, handlers } = createBaseContext()
  const sessionId = 'session-prompt-invalid-variant'
  const promptPayloads: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    context.getSessionClient = async () => ({
      client: {
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: providerId,
                name: 'Acme Provider',
                models: {
                  [modelId]: {
                    name: 'Live Model',
                    variants: {
                      low: {},
                      xhigh: { disabled: true },
                    },
                  },
                },
              }],
              default: { [providerId]: modelId },
              connected: [providerId],
            },
          }),
          auth: async () => ({ data: {} }),
        },
        session: {
          promptAsync: async (payload: Record<string, unknown>) => {
            promptPayloads.push(payload)
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('session:prompt')
    assert.ok(handler, 'expected session:prompt handler to be registered')

    await handler({}, sessionId, 'try a stale reasoning variant', undefined, 'build', { variant: 'xhigh' })

    assert.equal(promptPayloads.length, 1)
    assert.equal('variant' in promptPayloads[0]!, false)
  } finally {
    consumePendingPromptEcho(sessionId, 'try a stale reasoning variant')
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
    cleanup()
  }
})

test('session:create rejects renderer-supplied project directories without a native-picker grant', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.normalizeDirectory = () => {
    throw new Error('Project directory must be selected with the native directory picker before use.')
  }
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:create')

  assert.ok(handler, 'expected session:create handler to be registered')
  await assert.rejects(
    () => handler({}, '/etc'),
    /native directory picker/,
  )
  assert.equal(clientRequested, false)
})

test('workflow mutation handlers reject malformed workflow ids before service calls', async () => {
  const { context, handlers } = createBaseContext()

  registerWorkflowHandlers(context)
  const handler = handlers.get('workflows:run-now')

  assert.ok(handler, 'expected workflows:run-now handler to be registered')
  await assert.rejects(
    () => handler({}, { id: 'workflow-1' }),
    /workflow id to be a string/,
  )
})

test('settings:set rejects non-object payloads before saving settings', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('settings:set')

  assert.ok(handler, 'expected settings:set handler to be registered')
  await assert.rejects(
    () => handler({}, null),
    /settings update to be an object/,
  )
})

test('sniffImageMime accepts only image magic bytes', () => {
  assert.equal(sniffImageMime(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png')
  assert.equal(sniffImageMime(Buffer.from('ffd8ffe000104a464946', 'hex')), 'image/jpeg')
  assert.equal(sniffImageMime(Buffer.from('4749463839610000', 'hex')), 'image/gif')
  assert.equal(sniffImageMime(Buffer.from('524946460000000057454250', 'hex')), 'image/webp')
  assert.equal(sniffImageMime(Buffer.from('not really an image')), null)
})

test('custom content write handlers reject malformed objects before save paths', async () => {
  const { context, handlers } = createBaseContext()
  let confirmed = false
  context.requestNativeConfirmation = async () => {
    confirmed = true
    return true
  }

  registerCustomContentHandlers(context)
  const addSkill = handlers.get('custom:add-skill')
  const addMcp = handlers.get('custom:add-mcp')

  assert.ok(addSkill, 'expected custom:add-skill handler to be registered')
  assert.ok(addMcp, 'expected custom:add-mcp handler to be registered')
  await assert.rejects(
    () => addSkill({}, []),
    /custom skill to be an object/,
  )
  await assert.rejects(
    () => addMcp({}, 'not-an-object'),
    /custom MCP to be an object/,
  )
  assert.equal(confirmed, false)
})

test('explorer:file-read returns null for ungranted renderer-supplied directories', async () => {
  const { context, handlers, errors } = createBaseContext()
  context.resolveGrantedProjectDirectory = () => {
    throw new Error('Project directory must be selected with the native directory picker before use.')
  }

  registerExplorerHandlers(context)
  const handler = handlers.get('explorer:file-read')

  assert.ok(handler, 'expected explorer:file-read handler to be registered')
  const result = await handler({}, '/etc/passwd', '/etc')

  assert.equal(result, null)
  assert.match(errors[0] || '', /explorer:directory/)
  assert.match(errors[0] || '', /native directory picker/)
})

test('explorer find-text pattern validation caps costly regex input', () => {
  assert.equal(normalizeFindTextPattern('  TODO  '), 'TODO')
  assert.equal(normalizeFindTextPattern('   '), null)
  assert.throws(() => normalizeFindTextPattern('x'.repeat(513)), /exceeds 512 bytes/)
  assert.throws(() => normalizeFindTextPattern('(a+)+$'), /nested quantifier/)
})

test('artifact:read-attachment rejects private files that were not surfaced by the session', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-unsurfaced-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const handler = handlers.get('artifact:read-attachment')

    assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
    await assert.rejects(
      () => handler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/secret.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('artifact:read-attachment rejects non-object payloads before artifact resolution', async () => {
  const { context, handlers } = createBaseContext()
  let resolved = false
  context.resolvePrivateArtifactPath = () => {
    resolved = true
    throw new Error('artifact should not be resolved')
  }

  registerArtifactHandlers(context)
  const handler = handlers.get('artifact:read-attachment')

  assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
  await assert.rejects(
    () => handler({}, 'not-an-object'),
    /artifact request to be an object/,
  )
  assert.equal(resolved, false)
})

test('artifact:read-attachment authorizes the resolved artifact path, not a renderer-supplied alias', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'artifact-ipc-resolved-source-session'

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'tool_call',
        id: 'write-link',
        name: 'write',
        status: 'complete',
        input: { filePath: '/tmp/open-cowork-private-workspace/link.txt' },
      },
    })
    context.resolvePrivateArtifactPath = () => ({
      root: '/tmp/open-cowork-private-workspace',
      source: '/tmp/open-cowork-private-workspace/secret.txt',
    })

    registerArtifactHandlers(context)
    const handler = handlers.get('artifact:read-attachment')

    assert.ok(handler, 'expected artifact:read-attachment handler to be registered')
    await assert.rejects(
      () => handler({}, { sessionId, filePath: '/tmp/open-cowork-private-workspace/link.txt' }),
      /Only surfaced session artifacts/,
    )
  } finally {
    sessionEngine.removeSession(sessionId)
  }
})

test('permission:respond can answer a reopened approval using the hydrated session id', async () => {
  const { context, handlers } = createBaseContext()
  const replies: Array<Record<string, unknown>> = []
  let requestedSessionId: string | null = null

  context.getSessionV2Client = async (sessionId) => {
    requestedSessionId = sessionId
    return {
      client: {
        permission: {
          reply: async (payload: Record<string, unknown>) => {
            replies.push(payload)
          },
        },
      } as any,
      record: null,
    }
  }

  registerSessionHandlers(context)
  const handler = handlers.get('permission:respond')

  assert.ok(handler, 'expected permission:respond handler to be registered')
  await handler({}, 'perm-1', true, 'session-reopened')

  assert.equal(requestedSessionId, 'session-reopened')
  assert.deepEqual(replies, [{
    requestID: 'perm-1',
    reply: 'once',
  }])
})

test('question:reply clears the answered request locally so queued questions advance', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'question-ipc-reply-session'
  const replies: Array<Record<string, unknown>> = []
  const sentViews: unknown[] = []

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({ sessionId, data: { type: 'busy' } })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-1',
        questions: [{
          header: 'First',
          question: 'Pick the first answer',
          options: [{ label: 'A', description: 'Alpha' }],
        }],
      },
    })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-2',
        questions: [{
          header: 'Second',
          question: 'Pick the second answer',
          options: [{ label: 'B', description: 'Beta' }],
        }],
      },
    })

    context.getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        id: 101,
        send: (channel: string, payload: unknown) => {
          if (channel === 'session:view') sentViews.push(payload)
        },
      },
    } as any)
    context.getSessionV2Client = async () => ({
      client: {
        question: {
          reply: async (payload: Record<string, unknown>) => {
            replies.push(payload)
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('question:reply')
    assert.ok(handler, 'expected question:reply handler to be registered')

    await handler({}, sessionId, 'question-1', [['A']])

    const view = sessionEngine.getSessionView(sessionId)
    assert.deepEqual(replies, [{
      requestID: 'question-1',
      answers: [['A']],
    }])
    assert.equal(view.pendingQuestions.length, 1)
    assert.equal(view.pendingQuestions[0]?.id, 'question-2')
    assert.equal(view.isAwaitingQuestion, true)

    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(sentViews.length > 0, true)
  } finally {
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
  }
})

test('session:file-snippet rejects oversized files before reading snippet contents', async () => {
  const { context, handlers } = createBaseContext()
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-snippet-'))
  try {
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'))
    upsertSessionRecord(toSessionRecord({
      id: 'session-large-snippet',
      title: 'Large snippet',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      opencodeDirectory: root,
    }))

    registerSessionHandlers(context)
    const handler = handlers.get('session:file-snippet')

    assert.ok(handler, 'expected session:file-snippet handler to be registered')
    await assert.rejects(
      () => handler({}, {
        sessionId: 'session-large-snippet',
        filePath: 'large.txt',
        startLine: 1,
        endLine: 2,
      }),
      /too large/,
    )
  } finally {
    clearSessionRegistryCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('question:reply rejects malformed answers before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionV2Client = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('question:reply')
  assert.ok(handler, 'expected question:reply handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-question-bounds', 'question-1', 'not-an-array'),
    /Question answers must be an array/,
  )
  assert.equal(clientRequested, false)
})

test('command:run rejects oversized command names before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('command:run')
  assert.ok(handler, 'expected command:run handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-command-bounds', 'x'.repeat(257)),
    /Command name exceeds 256 bytes/,
  )
  assert.equal(clientRequested, false)
})

test('session:rename rejects empty titles before runtime dispatch', async () => {
  const { context, handlers } = createBaseContext()
  let clientRequested = false
  context.getSessionClient = async () => {
    clientRequested = true
    throw new Error('runtime should not be reached')
  }

  registerSessionHandlers(context)
  const handler = handlers.get('session:rename')
  assert.ok(handler, 'expected session:rename handler to be registered')

  await assert.rejects(
    () => handler({}, 'session-rename-bounds', '   '),
    /Session title is required/,
  )
  assert.equal(clientRequested, false)
})

test('question:reject clears the rejected request locally', async () => {
  const { context, handlers } = createBaseContext()
  const sessionId = 'question-ipc-reject-session'
  const rejects: Array<Record<string, unknown>> = []

  sessionEngine.removeSession(sessionId)
  try {
    sessionEngine.activateSession(sessionId)
    sessionEngine.applyStreamEvent({ sessionId, data: { type: 'busy' } })
    sessionEngine.applyStreamEvent({
      sessionId,
      data: {
        type: 'question_asked',
        id: 'question-reject',
        questions: [{
          header: 'Reject',
          question: 'Should this be dismissed?',
          options: [{ label: 'Dismiss', description: 'Dismiss it' }],
        }],
      },
    })

    context.getMainWindow = () => ({
      isDestroyed: () => false,
      webContents: {
        id: 102,
        send: () => {},
      },
    } as any)
    context.getSessionV2Client = async () => ({
      client: {
        question: {
          reject: async (payload: Record<string, unknown>) => {
            rejects.push(payload)
          },
        },
      } as any,
      record: null,
    })

    registerSessionHandlers(context)
    const handler = handlers.get('question:reject')
    assert.ok(handler, 'expected question:reject handler to be registered')

    await handler({}, sessionId, 'question-reject')

    const view = sessionEngine.getSessionView(sessionId)
    assert.deepEqual(rejects, [{ requestID: 'question-reject' }])
    assert.equal(view.pendingQuestions.length, 0)
    assert.equal(view.isAwaitingQuestion, false)

    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    stopSessionStatusReconciliation(sessionId)
    sessionEngine.removeSession(sessionId)
  }
})

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

test('chart:save-artifact rejects unknown sessions before writing chart bytes', async () => {
  const { context, handlers } = createBaseContext()

  registerAppHandlers(context)
  const handler = handlers.get('chart:save-artifact')

  assert.ok(handler, 'expected chart:save-artifact handler to be registered')
  await assert.rejects(
    () => handler({}, {
      sessionId: 'fake-session',
      toolCallId: 'tool-1',
      toolName: 'charts.create_bar',
      dataUrl: 'data:image/png;base64,AAAA',
    }),
    /existing session/,
  )
})

test('dialog:save-text path policy keeps exports as non-sensitive json files', () => {
  assert.equal(resolveSafeSaveTextPath('/tmp/agent'), '/tmp/agent.json')
  assert.equal(resolveSafeSaveTextPath('/tmp/agent.cowork-agent.json'), '/tmp/agent.cowork-agent.json')
  assert.throws(
    () => resolveSafeSaveTextPath('/tmp/agent.md'),
    /must use a \.json extension/,
  )
  assert.throws(
    () => resolveSafeSaveTextPath('/Users/example/.ssh/config'),
    /sensitive configuration path/,
  )
})

test('dialog:save-text writes private export files atomically', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'opencowork-save-text-'))
  try {
    const outputPath = join(tempRoot, 'agent.cowork-agent.json')
    saveTextExportFile(outputPath, '{"ok":true}\n')

    assert.equal(readFileSync(outputPath, 'utf-8'), '{"ok":true}\n')
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
