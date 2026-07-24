import { clearKnowledgeStoreCache } from '@open-cowork/runtime-host/knowledge/knowledge-store'
import { createCoordinationProject, createCoordinationTask, createCoordinationWatch, getCoordinationProject, getCoordinationTask, getCoordinationWatch, setCoordinationDatabaseForTests } from '@open-cowork/runtime-host/coordination/coordination-store'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcHandlerContext } from '../apps/desktop/src/main/ipc/context.ts'
import { registerAppHandlers } from '../apps/desktop/src/main/ipc/app-handlers.ts'
import { registerArtifactHandlers } from '../apps/desktop/src/main/ipc/artifact-handlers.ts'
import { registerLaunchpadHandlers } from '../apps/desktop/src/main/ipc/launchpad-handlers.ts'
import { registerSessionHandlers } from '../apps/desktop/src/main/ipc/session-handlers.ts'
import { registerCatalogHandlers } from '../apps/desktop/src/main/ipc/catalog-handlers.ts'
import { registerWorkflowHandlers } from '../apps/desktop/src/main/ipc/workflow-handlers.ts'
import { registerCustomContentHandlers } from '../apps/desktop/src/main/ipc/custom-content-handlers.ts'
import { registerExplorerHandlers } from '../apps/desktop/src/main/ipc/explorer-handlers.ts'
import { registerThreadHandlers } from '../apps/desktop/src/main/ipc/thread-handlers.ts'
import { registerAdminHandlers } from '../apps/desktop/src/main/ipc/admin-handlers.ts'
import { registerE2EEvalHandlers } from '../apps/desktop/src/main/ipc/e2e-eval-handlers.ts'
import { registerWorkspaceHandlers } from '../apps/desktop/src/main/ipc/workspace-handlers.ts'
import { registerDesktopPairingHandlers } from '../apps/desktop/src/main/ipc/desktop-pairing-handlers.ts'
import { registerCoordinationHandlers } from '../apps/desktop/src/main/ipc/coordination-handlers.ts'
import { registerChannelHandlers } from '../apps/desktop/src/main/ipc/channel-handlers.ts'
import { registerKnowledgeHandlers } from '../apps/desktop/src/main/ipc/knowledge-handlers.ts'
import { registerVoiceHandlers } from '../apps/desktop/src/main/ipc/voice-handlers.ts'
import { createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
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
    workspaceGateway: createWorkspaceGateway({ cloudRegistry: null, cloudCredentialStore: null }),
    desktopPairingService: {
      list: () => [],
      create: () => { throw new Error('not used in registration test') },
      update: () => { throw new Error('not used in registration test') },
      connect: async () => { throw new Error('not used in registration test') },
      disconnect: () => { throw new Error('not used in registration test') },
      revoke: async () => { throw new Error('not used in registration test') },
      pollOnce: async () => { throw new Error('not used in registration test') },
      auditLog: () => [],
      observeRuntimeEvent: () => {},
    } as never,
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

function readCoworkApiGroups(source: string) {
  const match = source.match(/export interface CoworkAPI \{([\s\S]*?)\n\}/)
  assert.ok(match, 'missing CoworkAPI interface')
  return Array.from(match[1].matchAll(/^ {2}([a-zA-Z][\w]*): /gm), (entry) => entry[1]).sort()
}

function readPreloadApiGroups(source: string) {
  const match = source.match(/const api: CoworkAPI = \{([\s\S]*?)\n\}/)
  assert.ok(match, 'missing preload CoworkAPI implementation')
  return Array.from(match[1].matchAll(/^ {2}([a-zA-Z][\w]*): \{/gm), (entry) => entry[1]).sort()
}

test('IPC handler modules register their core channels', () => {
  const { context, handlers, listeners } = createTestContext()

  registerWorkspaceHandlers(context)
  registerDesktopPairingHandlers(context)
  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerLaunchpadHandlers(context)
  registerWorkflowHandlers(context)
  registerCoordinationHandlers(context)
  registerChannelHandlers(context)
  registerKnowledgeHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
  registerThreadHandlers(context)
  registerAdminHandlers(context)
  context.ipcMain.handle('confirm:request-destructive', async () => ({ token: 'test' }))

  // One-way fire-and-forget channels (renderer uses `send`) must also
  // be registered. Guards against regressions like the renderer panic
  // reporter going missing.
  assert.equal(listeners.has('diagnostics:renderer-error'), true)

  assert.equal(handlers.has('workspace:list'), true)
  assert.equal(handlers.has('workspace:activate'), true)
  assert.equal(handlers.has('workspace:add-gateway'), true)
  assert.equal(handlers.has('workspace:policy'), true)
  assert.equal(handlers.has('workspace:support'), true)
  assert.equal(handlers.has('desktop-pairing:list'), true)
  assert.equal(handlers.has('desktop-pairing:create'), true)
  assert.equal(handlers.has('desktop-pairing:revoke'), true)
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
  assert.equal(handlers.has('artifact:open'), true)
  assert.equal(handlers.has('artifact:export'), true)
  assert.equal(handlers.has('artifact:index'), true)
  assert.equal(handlers.has('artifact:read-attachment'), true)
  assert.equal(handlers.has('artifact:update-status'), true)
  assert.equal(handlers.has('launchpad:feed'), true)
  assert.equal(handlers.has('session:prompt'), true)
  assert.equal(handlers.has('session:delete'), true)
  assert.equal(handlers.has('mcp:auth'), true)
  assert.equal(handlers.has('agents:list'), true)
  assert.equal(handlers.has('capabilities:tools'), true)
  assert.equal(handlers.has('custom:add-mcp'), true)
  assert.equal(handlers.has('custom:import-skill-directory'), true)
  assert.equal(handlers.has('custom:export-setup-bundle'), true)
  assert.equal(handlers.has('custom:import-setup-bundle'), true)
  assert.equal(handlers.has('threads:search'), true)
  assert.equal(handlers.has('workflows:list'), true)
  assert.equal(handlers.has('workflows:start-draft'), true)
  assert.equal(handlers.has('workflows:run-now'), true)
  assert.equal(handlers.has('workflows:archive'), true)
  assert.equal(handlers.has('workflows:regenerate-webhook-secret'), true)
  assert.equal(handlers.has('coordination:projects:plan-with-cleo'), true)
  assert.equal(handlers.has('channels:providers'), true)
  assert.equal(handlers.has('channels:bindings:connect'), true)
  assert.equal(handlers.has('channels:people:list'), true)
  assert.equal(handlers.has('channels:watches:create'), true)
  assert.equal(handlers.has('knowledge:snapshot'), true)
  assert.equal(handlers.has('knowledge:space:create'), true)
  assert.equal(handlers.has('knowledge:proposal:create'), true)
  assert.equal(handlers.has('knowledge:proposal:accept'), true)
  assert.equal(handlers.has('knowledge:proposal:decline'), true)
  assert.equal(handlers.has('knowledge:page:history'), true)
  assert.equal(handlers.has('knowledge:page:restore'), true)
  assert.equal(handlers.has('threads:tags:apply'), true)
  assert.equal(handlers.has('threads:smart-filters:create'), true)
  assert.equal(handlers.has('threads:suggestions:accept'), true)
})

test('preload invoke/send channels match registered main-process IPC channels', () => {
  const { context, handlers, listeners } = createTestContext()

  registerWorkspaceHandlers(context)
  registerDesktopPairingHandlers(context)
  registerAppHandlers(context)
  registerArtifactHandlers(context)
  registerLaunchpadHandlers(context)
  registerWorkflowHandlers(context)
  registerCoordinationHandlers(context)
  registerChannelHandlers(context)
  registerKnowledgeHandlers(context)
  registerVoiceHandlers(context)
  registerSessionHandlers(context)
  registerCatalogHandlers(context)
  registerCustomContentHandlers(context)
  registerExplorerHandlers(context)
  registerThreadHandlers(context)
  registerAdminHandlers(context)
  registerE2EEvalHandlers(context.ipcMain as import('electron').IpcMain, () => [])
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

test('shared CoworkAPI groups match the preload implementation surface', () => {
  const sharedSource = readFileSync('packages/shared/src/index.ts', 'utf-8')
  const preloadSource = readFileSync('apps/desktop/src/preload/index.ts', 'utf-8')

  assert.deepEqual(readPreloadApiGroups(preloadSource), readCoworkApiGroups(sharedSource))
})

test('coordination IPC mutations cannot affect cloud-scoped rows', async () => {
  const db = new DatabaseSync(':memory:')
  setCoordinationDatabaseForTests(db)
  try {
    const { context, handlers } = createTestContext()
    registerCoordinationHandlers(context)

    const cloudProject = createCoordinationProject({
      workspaceId: 'cloud:tenant-1',
      title: 'Cloud project',
      objective: 'Cloud rows share SQLite but are not local IPC state.',
    }, { id: 'cloud-project' })
    const cloudTask = createCoordinationTask({
      projectId: cloudProject.id,
      title: 'Cloud task',
      spec: 'Local IPC must not mutate this row.',
    }, { id: 'cloud-task' })
    const cloudWatch = createCoordinationWatch({
      workspaceId: 'cloud:tenant-1',
      target: { kind: 'conversation', id: 'cloud-session' },
      events: ['run.finished'],
      channel: {
        provider: 'telegram',
        agentId: 'cloud-agent',
        channelBindingId: 'cloud-binding',
        target: { chatId: 'cloud-chat' },
      },
    }, { id: 'cloud-watch' })

    const localProject = createCoordinationProject({
      title: 'Local project',
      objective: 'Local rows remain editable through desktop IPC.',
    }, { id: 'local-project' })
    const localTask = createCoordinationTask({
      projectId: localProject.id,
      title: 'Local task',
      spec: 'Local IPC can mutate this row.',
    }, { id: 'local-task' })
    const localWatch = createCoordinationWatch({
      target: { kind: 'project', id: localProject.id },
      events: ['task.moved'],
      channel: {
        provider: 'telegram',
        agentId: 'local-agent',
        channelBindingId: 'local-binding',
        target: { chatId: 'local-chat' },
      },
    }, { id: 'local-watch' })

    const updateProject = handlers.get('coordination:projects:update') as (
      event: unknown,
      projectId: unknown,
      input: unknown,
    ) => Promise<unknown>
    const moveTask = handlers.get('coordination:tasks:move') as (
      event: unknown,
      taskId: unknown,
      input: unknown,
    ) => Promise<unknown>
    const updateWatch = handlers.get('coordination:watches:update') as (
      event: unknown,
      watchId: unknown,
      input: unknown,
    ) => Promise<unknown>
    const pauseWatch = handlers.get('coordination:watches:pause') as (
      event: unknown,
      watchId: unknown,
      options?: unknown,
    ) => Promise<unknown>
    const deleteWatch = handlers.get('coordination:watches:delete') as (
      event: unknown,
      watchId: unknown,
      options?: unknown,
    ) => Promise<unknown>

    assert.equal(await updateProject(null, cloudProject.id, { title: 'Mutated cloud project' }), null)
    assert.equal(await moveTask(null, cloudTask.id, { column: 'done' }), null)
    assert.equal(await updateWatch(null, cloudWatch.id, { status: 'paused' }), null)
    assert.equal(await deleteWatch(null, cloudWatch.id), false)
    assert.equal(getCoordinationProject(cloudProject.id)?.title, 'Cloud project')
    assert.equal(getCoordinationTask(cloudTask.id)?.column, 'backlog')
    assert.equal(getCoordinationWatch(cloudWatch.id)?.status, 'active')

    const movedLocal = await moveTask(null, localTask.id, { column: 'doing' }) as { column?: unknown }
    assert.equal(movedLocal.column, 'doing')
    assert.equal(getCoordinationTask(localTask.id)?.column, 'doing')
    const pausedLocal = await pauseWatch(null, localWatch.id) as { status?: unknown }
    assert.equal(pausedLocal.status, 'paused')
    assert.equal(await deleteWatch(null, localWatch.id), true)
    assert.equal(getCoordinationWatch(localWatch.id), null)
  } finally {
    setCoordinationDatabaseForTests(null)
    db.close()
  }
})

test('knowledge proposal IPC ignores renderer-controlled storage directories', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const appDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-knowledge-ipc-app-'))
  const rendererStorageDir = mkdtempSync(join(tmpdir(), 'open-cowork-knowledge-ipc-renderer-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = appDataDir
  clearConfigCaches()
  clearKnowledgeStoreCache()

  try {
    const { context, handlers } = createTestContext()
    registerKnowledgeHandlers(context)

    const snapshotHandler = handlers.get('knowledge:snapshot') as (
      event: unknown,
      options?: unknown,
    ) => Promise<Record<string, unknown>>
    const createProposal = handlers.get('knowledge:proposal:create') as (
      event: unknown,
      input: unknown,
    ) => Promise<Record<string, unknown>>

    const snapshot = await snapshotHandler(null, {})
    const spaces = snapshot.spaces as Array<{ id: string }>
    const pages = snapshot.pages as Array<{ id: string, title: string }>
    assert.ok(spaces[0]?.id)
    assert.ok(pages[0]?.id)

    const proposal = await createProposal(null, {
      storageDataDir: rendererStorageDir,
      spaceId: spaces[0].id,
      pageId: pages[0].id,
      pageTitle: pages[0].title,
      by: 'renderer',
      summary: 'Renderer storageDataDir must not select the Knowledge database path.',
      body: [{ type: 'p', text: 'The proposal should be stored in local app data.' }],
    })

    assert.equal(proposal.status, 'pending')
    assert.equal(existsSync(join(appDataDir, 'knowledge.sqlite')), true)
    assert.equal(existsSync(join(rendererStorageDir, 'knowledge.sqlite')), false)
  } finally {
    clearKnowledgeStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(appDataDir, { recursive: true, force: true })
    rmSync(rendererStorageDir, { recursive: true, force: true })
  }
})

test('knowledge restore IPC restores a prior version, pins local storage, and validates ids', async () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const appDataDir = mkdtempSync(join(tmpdir(), 'open-cowork-knowledge-restore-app-'))
  const rendererStorageDir = mkdtempSync(join(tmpdir(), 'open-cowork-knowledge-restore-renderer-'))
  process.env.OPEN_COWORK_USER_DATA_DIR = appDataDir
  clearConfigCaches()
  clearKnowledgeStoreCache()

  try {
    const { context, handlers } = createTestContext()
    registerKnowledgeHandlers(context)

    const snapshotHandler = handlers.get('knowledge:snapshot') as (event: unknown, options?: unknown) => Promise<Record<string, unknown>>
    const createProposal = handlers.get('knowledge:proposal:create') as (event: unknown, input: unknown) => Promise<Record<string, unknown>>
    const acceptProposal = handlers.get('knowledge:proposal:accept') as (event: unknown, id: unknown, input?: unknown) => Promise<Record<string, unknown>>
    const restoreVersion = handlers.get('knowledge:page:restore') as (event: unknown, pageId: unknown, versionId: unknown, input?: unknown) => Promise<Record<string, unknown>>

    const snapshot = await snapshotHandler(null, {})
    const pages = snapshot.pages as Array<{ id: string, title: string, version: number }>
    const spaces = snapshot.spaces as Array<{ id: string }>
    const page = pages[0]
    assert.equal(page.version, 1)

    const proposal = await createProposal(null, {
      spaceId: spaces[0].id,
      pageId: page.id,
      pageTitle: page.title,
      summary: 'Rewrite the page so there is a v2 to roll back from.',
      body: [{ type: 'p', text: 'Replacement body.' }],
    })
    const accepted = await acceptProposal(null, proposal.id as string, {})
    assert.equal((accepted.page as { version: number }).version, 2)

    // Restore v1 through the IPC handler; the renderer-supplied storageDataDir must be ignored.
    const restored = await restoreVersion(null, page.id, `version:${page.id}:1`, { storageDataDir: rendererStorageDir })
    const restoredPage = (restored as { page: { version: number, versionId: string, proposalId: string | null } }).page
    assert.equal(restoredPage.version, 3)
    assert.equal(restoredPage.versionId, `version:${page.id}:3`)
    assert.equal(restoredPage.proposalId, null)
    assert.equal(existsSync(join(appDataDir, 'knowledge.sqlite')), true)
    assert.equal(existsSync(join(rendererStorageDir, 'knowledge.sqlite')), false)

    // The handler's arg schema rejects a blank version id before touching the store.
    await assert.rejects(() => restoreVersion(null, page.id, '   '), /version id/i)
  } finally {
    clearKnowledgeStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(appDataDir, { recursive: true, force: true })
    rmSync(rendererStorageDir, { recursive: true, force: true })
  }
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
