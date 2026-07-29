import test from 'node:test'
import assert from 'node:assert/strict'
import type { CloudWorkspaceSessionAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { registerThreadHandlers } from '../apps/desktop/src/main/ipc/thread-handlers.ts'
import { createWorkspaceGateway } from '../apps/desktop/src/main/workspace-gateway.ts'
import { createIpcHandlerHarness } from './support/ipc-handler-harness.ts'

function createThreadHandlerContext() {
  const { context, handlers } = createIpcHandlerHarness()
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
    () => handlers.get('threads:search')!({}, 'not-a-query'),
    /thread search query to be an object/,
  )
  await assert.rejects(
    () => handlers.get('threads:tags:create')!({}, null),
    /thread tag input to be an object/,
  )
  await assert.rejects(
    () => handlers.get('threads:smart-filters:create')!({}, 'not-a-filter'),
    /smart filter input to be an object/,
  )
  await assert.rejects(
    () => handlers.get('threads:smart-filters:update')!({}, 123, { name: 'x', query: {} }),
    /smart filter id to be a string/,
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
test('thread object IPC validates query and tag payload shape before store access', async () => {
  const { context, handlers } = createIpcHandlerHarness()

  registerThreadHandlers(context)
  const search = handlers.get('threads:search')
  const createTag = handlers.get('threads:tags:create')

  assert.ok(search, 'expected threads:search handler to be registered')
  assert.ok(createTag, 'expected threads:tags:create handler to be registered')
  await assert.rejects(
    () => search({}, { statuses: ['not-a-status'] }),
    /Invalid thread status/,
  )
  await assert.rejects(
    () => createTag({}, { color: '#ffffff' }),
    /Tag name must be a string/,
  )
})

test('thread handlers route cloud workspace calls through the workspace gateway', async () => {
  const { context, handlers } = createIpcHandlerHarness()
  const calls: string[] = []
  const adapter: CloudWorkspaceSessionAdapter = {
    policy: async () => ({
      features: { threadIndex: true },
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
    searchThreads: async () => {
      calls.push('search')
      return { threads: [], nextCursor: null, totalEstimate: 0 }
    },
    threadFacets: async () => {
      calls.push('facets')
      return { projects: [], providers: [], models: [], agents: [], tools: [], mcps: [], statuses: [], tags: [] }
    },
    listThreadTags: async () => {
      calls.push('tags:list')
      return []
    },
    createThreadTag: async (input) => {
      calls.push(`tags:create:${input.name}`)
      return { id: 'tag-1', name: input.name, color: input.color || '#64748b', createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    updateThreadTag: async (tagId, input) => {
      calls.push(`tags:update:${tagId}:${input.name}`)
      return { id: tagId, name: input.name, color: input.color || '#64748b', createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    deleteThreadTag: async (tagId) => {
      calls.push(`tags:delete:${tagId}`)
      return true
    },
    applyThreadTags: async (sessionIds, tagIds) => {
      calls.push(`tags:apply:${sessionIds.join(',')}:${tagIds.join(',')}`)
      return true
    },
    removeThreadTags: async (sessionIds, tagIds) => {
      calls.push(`tags:remove:${sessionIds.join(',')}:${tagIds.join(',')}`)
      return true
    },
    listThreadSmartFilters: async () => {
      calls.push('filters:list')
      return []
    },
    createThreadSmartFilter: async (input) => {
      calls.push(`filters:create:${input.name}`)
      return { id: 'filter-1', name: input.name, query: input.query, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    updateThreadSmartFilter: async (filterId, input) => {
      calls.push(`filters:update:${filterId}:${input.name}`)
      return { id: filterId, name: input.name, query: input.query, createdAt: '2026-05-27T10:00:00.000Z', updatedAt: '2026-05-27T10:00:00.000Z' }
    },
    deleteThreadSmartFilter: async (filterId) => {
      calls.push(`filters:delete:${filterId}`)
      return true
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

  registerThreadHandlers(context)

  await handlers.get('threads:search')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:facets')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:list')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:create')?.({}, { name: 'Important' }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:update')?.({}, 'tag-1', { name: 'Renamed' }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:apply')?.({}, ['session-1'], ['tag-1'], { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:remove')?.({}, ['session-1'], ['tag-1'], { workspaceId: 'cloud:test' })
  await handlers.get('threads:tags:delete')?.({}, 'tag-1', { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:list')?.({}, { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:create')?.({}, { name: 'Mine', query: {} }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:update')?.({}, 'filter-1', { name: 'Updated', query: {} }, { workspaceId: 'cloud:test' })
  await handlers.get('threads:smart-filters:delete')?.({}, 'filter-1', { workspaceId: 'cloud:test' })

  assert.deepEqual(calls, [
    'search',
    'facets',
    'tags:list',
    'tags:create:Important',
    'tags:update:tag-1:Renamed',
    'tags:apply:session-1:tag-1',
    'tags:remove:session-1:tag-1',
    'tags:delete:tag-1',
    'filters:list',
    'filters:create:Mine',
    'filters:update:filter-1:Updated',
    'filters:delete:filter-1',
  ])
})
