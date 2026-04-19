import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerAppHandlers } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerArtifactHandlers } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'

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
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)

  // One-way fire-and-forget channels (renderer uses `send`) must also
  // be registered. Guards against regressions like the renderer panic
  // reporter going missing.
  assert.equal(listeners.has('diagnostics:renderer-error'), true)

  assert.equal(handlers.has('auth:status'), true)
  assert.equal(handlers.has('settings:set'), true)
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
