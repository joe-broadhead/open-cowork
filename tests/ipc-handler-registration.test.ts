import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerAppHandlers } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerArtifactHandlers } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerAutomationHandlers } from '../apps/desktop/src/main/ipc/automation-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { registerCrewHandlers } from '../apps/desktop/src/main/ipc/crew-handlers.ts'
import { registerImprovementHandlers } from '../apps/desktop/src/main/ipc/improvement-handlers.ts'
import { registerOperationHandlers } from '../apps/desktop/src/main/ipc/operation-handlers.ts'
import { registerChannelHandlers } from '../apps/desktop/src/main/ipc/channel-handlers.ts'
import { registerSopHandlers } from '../apps/desktop/src/main/ipc/sop-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { registerExplorerHandlers } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'
import { registerThreadHandlers } from '../apps/desktop/src/main/ipc/thread-handlers.ts'

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
    requestNativeConfirmation: async () => true,
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

function readPreloadChannelArray(source: string, constantName: string) {
  const match = source.match(new RegExp(`const ${constantName} = \\[([\\s\\S]*?)\\] as const`))
  assert.ok(match, `missing ${constantName} in preload`)
  return new Set(
    Array.from(match[1].matchAll(/'([^']+)'/g), (entry) => entry[1]),
  )
}

test('IPC handler modules register their core channels', () => {
  const { context, handlers, listeners } = createTestContext()

  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerAutomationHandlers(context)
  registerCrewHandlers(context)
  registerImprovementHandlers(context)
  registerOperationHandlers(context)
  registerChannelHandlers(context)
  registerSopHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
  registerThreadHandlers(context)
  context.ipcMain.handle('confirm:request-destructive', async () => ({ token: 'test' }))

  // One-way fire-and-forget channels (renderer uses `send`) must also
  // be registered. Guards against regressions like the renderer panic
  // reporter going missing.
  assert.equal(listeners.has('diagnostics:renderer-error'), true)

  assert.equal(handlers.has('auth:status'), true)
  assert.equal(handlers.has('settings:set'), true)
  assert.equal(handlers.has('settings:get-provider-credentials'), true)
  assert.equal(handlers.has('settings:get-integration-credentials'), true)
  assert.equal(handlers.has('settings:get-with-credentials'), false)
  assert.equal(handlers.has('updates:install-capability'), true)
  assert.equal(handlers.has('updates:check-installable'), true)
  assert.equal(handlers.has('updates:download'), true)
  assert.equal(handlers.has('updates:quit-and-install'), true)
  assert.equal(handlers.has('provider:auth-methods'), true)
  assert.equal(handlers.has('provider:oauth-authorize'), true)
  assert.equal(handlers.has('provider:oauth-callback'), true)
  assert.equal(handlers.has('provider:auth-remove'), true)
  assert.equal(handlers.has('artifact:export'), true)
  assert.equal(handlers.has('artifact:read-attachment'), true)
  assert.equal(handlers.has('session:prompt'), true)
  assert.equal(handlers.has('session:delete'), true)
  assert.equal(handlers.has('mcp:auth'), true)
  assert.equal(handlers.has('agents:list'), true)
  assert.equal(handlers.has('capabilities:tools'), true)
  assert.equal(handlers.has('custom:add-mcp'), true)
  assert.equal(handlers.has('custom:import-skill-directory'), true)
  assert.equal(handlers.has('threads:search'), true)
  assert.equal(handlers.has('crews:list'), true)
  assert.equal(handlers.has('crews:create'), true)
  assert.equal(handlers.has('crews:update'), true)
  assert.equal(handlers.has('crews:pause'), true)
  assert.equal(handlers.has('crews:retire'), true)
  assert.equal(handlers.has('crews:run'), true)
  assert.equal(handlers.has('crews:evaluate'), true)
  assert.equal(handlers.has('crews:export-trace'), true)
  assert.equal(handlers.has('operations:workspace-profiles'), true)
  assert.equal(handlers.has('operations:queue-items'), true)
  assert.equal(handlers.has('operations:queue-alerts'), true)
  assert.equal(handlers.has('operations:capability-risks'), true)
  assert.equal(handlers.has('operations:governance-registry'), true)
  assert.equal(handlers.has('operations:governance-audit-events'), true)
  assert.equal(handlers.has('channels:list'), true)
  assert.equal(handlers.has('channels:definitions'), true)
  assert.equal(handlers.has('channels:inbound-items'), true)
  assert.equal(handlers.has('channels:deliveries'), true)
  assert.equal(handlers.has('channels:local-webhook-status'), true)
  assert.equal(handlers.has('channels:local-webhook-pairings'), true)
  assert.equal(handlers.has('channels:create-local-webhook'), true)
  assert.equal(handlers.has('channels:rotate-local-webhook-token'), true)
  assert.equal(handlers.has('channels:approve-inbound-item'), true)
  assert.equal(handlers.has('channels:dismiss-inbound-item'), true)
  assert.equal(handlers.has('channels:create-delivery-draft'), true)
  assert.equal(handlers.has('channels:send-delivery'), true)
  assert.equal(handlers.has('channels:cancel-delivery'), true)
  assert.equal(handlers.has('improvements:summary'), true)
  assert.equal(handlers.has('improvements:inbox'), true)
  assert.equal(handlers.has('improvements:memory-approve'), true)
  assert.equal(handlers.has('improvements:proposal-update'), true)
  assert.equal(handlers.has('improvements:proposal-approve'), true)
  assert.equal(handlers.has('improvements:dream-start'), true)
  assert.equal(handlers.has('improvements:dream-cancel'), true)
  assert.equal(handlers.has('improvements:dream-archive'), true)
  assert.equal(handlers.has('sops:list'), true)
  assert.equal(handlers.has('sops:save-from-automation-run'), true)
  assert.equal(handlers.has('sops:run-now'), true)
  assert.equal(handlers.has('sops:run-trigger'), true)
  assert.equal(handlers.has('sops:run-detail'), true)
  assert.equal(handlers.has('threads:tags:apply'), true)
  assert.equal(handlers.has('threads:smart-filters:create'), true)
  assert.equal(handlers.has('threads:suggestions:accept'), true)
})

test('preload invoke/send channels match registered main-process IPC channels', () => {
  const { context, handlers, listeners } = createTestContext()

  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerAutomationHandlers(context)
  registerCrewHandlers(context)
  registerImprovementHandlers(context)
  registerOperationHandlers(context)
  registerChannelHandlers(context)
  registerSopHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
  registerThreadHandlers(context)
  context.ipcMain.handle('confirm:request-destructive', async () => ({ token: 'test' }))

  const preloadSource = readFileSync('apps/desktop/src/preload/index.ts', 'utf-8')
  const exposedInvokes = readPreloadChannelArray(preloadSource, 'PRELOAD_INVOKE_CHANNELS')
  const exposedSends = readPreloadChannelArray(preloadSource, 'PRELOAD_SEND_CHANNELS')

  assert.equal(/ipcRenderer\.invoke\('[^']+'/.test(preloadSource), false)
  assert.equal(/ipcRenderer\.send\('[^']+'/.test(preloadSource), false)

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
