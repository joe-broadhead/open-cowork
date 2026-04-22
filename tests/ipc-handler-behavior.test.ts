import test from 'node:test'
import assert from 'node:assert/strict'
import type { CustomMcpConfig } from '@open-cowork/shared'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'

function createBaseContext() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const errors: string[] = []
  const context: IpcHandlerContext = {
    ipcMain: {
      handle(channel: string, handler: (...args: any[]) => any) {
        handlers.set(channel, handler)
      },
    },
    getMainWindow: () => null,
    normalizeDirectory: () => '/tmp',
    ensureSessionRecord: () => null,
    resolvePrivateArtifactPath: () => ({ root: '/tmp', source: '/tmp/file.txt' }),
    resolveContextDirectory: () => null,
    resolveScopedTarget: (target) => ({ ...target, directory: target.directory || null }),
    buildCustomAgentPermission: async () => ({}),
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

test('custom:test-mcp reports OAuth guidance for remote MCP auth errors', async () => {
  const { context, handlers, errors } = createBaseContext()
  const mcp: CustomMcpConfig = {
    name: 'nova',
    type: 'http',
    url: 'https://example.com/mcp',
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
