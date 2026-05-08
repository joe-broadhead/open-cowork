import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerThreadHandlers } from '../apps/desktop/src/main/ipc/thread-handlers.ts'

function createThreadHandlerContext() {
  const handlers = new Map<string, (...args: any[]) => any>()
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
    logHandlerError: () => {},
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
  registerThreadHandlers(context)
  return handlers
}

test('thread IPC handlers register the full threads namespace', () => {
  const handlers = createThreadHandlerContext()
  for (const channel of [
    'threads:search',
    'threads:facets',
    'threads:tags:list',
    'threads:tags:create',
    'threads:tags:update',
    'threads:tags:delete',
    'threads:tags:apply',
    'threads:tags:remove',
    'threads:smart-filters:list',
    'threads:smart-filters:create',
    'threads:smart-filters:update',
    'threads:smart-filters:delete',
    'threads:suggestions:accept',
    'threads:suggestions:edit',
    'threads:suggestions:dismiss',
    'threads:reindex',
  ]) {
    assert.ok(handlers.has(channel), `${channel} should be registered`)
  }
})

test('thread IPC handlers reject malformed bulk and suggestion inputs before service dispatch', async () => {
  const handlers = createThreadHandlerContext()
  await assert.rejects(
    () => handlers.get('threads:tags:apply')!({}, 'not-array', ['tag-1']),
    /sessionIds must be an array/,
  )
  await assert.rejects(
    () => handlers.get('threads:suggestions:edit')!({}, 'suggestion-1', {}),
    /include a label/,
  )
  await assert.rejects(
    () => handlers.get('threads:smart-filters:update')!({}, 123, { name: 'x', query: {} }),
    /Smart filter id must be a string/,
  )
  await assert.rejects(
    () => handlers.get('threads:reindex')!({}, Array.from({ length: 501 }, (_, index) => `session-${index}`)),
    /sessionIds exceeds 500 values/,
  )
  await assert.rejects(
    () => handlers.get('threads:tags:apply')!({}, ['session-1'], Array.from({ length: 51 }, (_, index) => `tag-${index}`)),
    /tagIds exceeds 50 values/,
  )
})
