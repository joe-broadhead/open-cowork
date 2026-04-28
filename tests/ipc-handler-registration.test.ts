import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerAppHandlers } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerArtifactHandlers } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerAutomationHandlers } from '../apps/desktop/src/main/ipc/automation-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { registerExplorerHandlers } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'

function createTestContext() {
  const handlers = new Map<string, unknown>()
  const listeners = new Map<string, unknown>()
  const context: IpcHandlerContext = {
    ipcMain: {
      handle(channel: string, handler: unknown) {
        handlers.set(channel, handler)
      },
      on(channel: string, listener: unknown) {
        // One-way channels (renderer uses `ipcRenderer.send`) — record
        // them separately so the test can assert on both surfaces.
        listeners.set(channel, listener)
      },
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
    logHandlerError: () => {},
    describeDestructiveRequest: () => 'test',
    consumeDestructiveConfirmation: () => true,
    reconcileIdleSession: () => {},
    getSessionClient: async () => {
      throw new Error('not used in registration test')
    },
    getSessionV2Client: async () => {
      throw new Error('not used in registration test')
    },
    listRuntimeTools: async () => [],
    withDiscoveredBuiltInTools: async (tools) => tools,
    listToolsFromMcpEntry: async () => [],
    isLikelyMcpAuthError: () => false,
    authenticateNewRemoteMcpIfNeeded: async () => {},
    approvedSkillImportDirectories: new Map(),
    capabilityToolMethodCache: new Map(),
  }
  return { context, handlers, listeners }
}

test('IPC handler modules register their core channels', () => {
  const { context, handlers, listeners } = createTestContext()

  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerAutomationHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
  context.ipcMain.handle('confirm:request-destructive', async () => ({ token: 'test' }))

  // One-way fire-and-forget channels (renderer uses `send`) must also
  // be registered. Guards against regressions like the renderer panic
  // reporter going missing.
  assert.equal(listeners.has('diagnostics:renderer-error'), true)

  assert.equal(handlers.has('auth:status'), true)
  assert.equal(handlers.has('settings:set'), true)
  assert.equal(handlers.has('provider:auth-methods'), true)
  assert.equal(handlers.has('provider:oauth-authorize'), true)
  assert.equal(handlers.has('provider:oauth-callback'), true)
  assert.equal(handlers.has('artifact:export'), true)
  assert.equal(handlers.has('artifact:read-attachment'), true)
  assert.equal(handlers.has('session:prompt'), true)
  assert.equal(handlers.has('session:delete'), true)
  assert.equal(handlers.has('mcp:auth'), true)
  assert.equal(handlers.has('agents:list'), true)
  assert.equal(handlers.has('capabilities:tools'), true)
  assert.equal(handlers.has('custom:add-mcp'), true)
  assert.equal(handlers.has('custom:import-skill-directory'), true)
})

test('preload invoke/send channels match registered main-process IPC channels', () => {
  const { context, handlers, listeners } = createTestContext()

  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerAutomationHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
  context.ipcMain.handle('confirm:request-destructive', async () => ({ token: 'test' }))

  const preloadSource = readFileSync('apps/desktop/src/preload/index.ts', 'utf-8')
  const exposedInvokes = new Set(
    Array.from(preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g), (match) => match[1]),
  )
  const exposedSends = new Set(
    Array.from(preloadSource.matchAll(/ipcRenderer\.send\('([^']+)'/g), (match) => match[1]),
  )

  const missingInvokeHandlers = [...exposedInvokes].filter((channel) => !handlers.has(channel)).sort()
  const unexposedInvokeHandlers = [...handlers.keys()].filter((channel) => !exposedInvokes.has(channel)).sort()
  const missingSendListeners = [...exposedSends].filter((channel) => !listeners.has(channel)).sort()
  const unexposedSendListeners = [...listeners.keys()].filter((channel) => !exposedSends.has(channel)).sort()

  assert.deepEqual(missingInvokeHandlers, [])
  assert.deepEqual(unexposedInvokeHandlers, [])
  assert.deepEqual(missingSendListeners, [])
  assert.deepEqual(unexposedSendListeners, [])
})

test('provider auth IPC fails closed for malformed renderer input before runtime access', async () => {
  const { context, handlers } = createTestContext()

  registerAppHandlers(context)

  const authorize = handlers.get('provider:oauth-authorize') as (
    event: unknown,
    providerId: unknown,
    method: unknown,
    inputs?: unknown,
  ) => Promise<unknown>
  const callback = handlers.get('provider:oauth-callback') as (
    event: unknown,
    providerId: unknown,
    method: unknown,
    code?: unknown,
  ) => Promise<unknown>

  await assert.rejects(
    authorize(null, 'not-a-provider', 0),
    /Unknown provider/,
  )
  await assert.rejects(
    authorize(null, 'openai', -1),
    /Invalid provider auth method/,
  )
  await assert.rejects(
    authorize(null, 'openai', 0, { token: 42 }),
    /Invalid provider auth input/,
  )
  await assert.rejects(
    callback(null, 'openai', 0, 'x'.repeat(16 * 1024 + 1)),
    /Provider auth code is too large/,
  )
})
