import type { IpcHandlerContext } from './context.ts'
import { getThreadIndexService } from '../thread-index/thread-index-service.ts'
import {
  THREAD_BULK_MAX_SESSION_IDS,
  THREAD_FILTER_MAX_VALUES,
  type ThreadSearchQuery,
  type ThreadSmartFilterInput,
  type ThreadTagInput,
  type WorkspaceOptions,
  type WorkspaceScoped,
} from '@open-cowork/shared'
import {
  objectAndOptionalObjectArgs,
  optionalObjectArg,
  registerIpcInvoke,
  stringAndObjectAndOptionalObjectArgs,
  stringAndOptionalObjectArgs,
} from './schema.ts'
import { validateThreadSearchQuery } from './object-validators.ts'
import { normalizeSmartFilterInput, normalizeTagInput } from '../thread-index/thread-index-normalizers.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

function requireStringArray(value: unknown, label: string, max = THREAD_BULK_MAX_SESSION_IDS) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  if (value.length > max) throw new Error(`${label} exceeds ${max} values.`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`${label} entries must be strings.`)
    const trimmed = entry.trim()
    if (!trimmed || trimmed.length > 256) throw new Error(`${label} contains an invalid entry.`)
    return trimmed
  })
}

function normalizeWorkspaceOptions(value: Record<string, unknown>): WorkspaceOptions {
  const workspaceId = readWorkspaceIdOption(value)
  return workspaceId ? { workspaceId } : {}
}

function validateThreadSearchWorkspaceQuery(record: Record<string, unknown>): WorkspaceScoped<ThreadSearchQuery> {
  const workspaceId = readWorkspaceIdOption(record)
  const query = validateThreadSearchQuery(record)
  return workspaceId ? { ...query, workspaceId } : query
}

function workspaceIdFromOptions(options?: WorkspaceOptions | null) {
  return readWorkspaceIdOption(options || undefined)
}

export function registerThreadHandlers(context: IpcHandlerContext) {
  const threads = () => getThreadIndexService()

  registerIpcInvoke(context, 'threads:search', optionalObjectArg<WorkspaceScoped<ThreadSearchQuery>>('thread search query', validateThreadSearchWorkspaceQuery), async (event, query) => {
    const workspaceId = workspaceIdFromOptions(query)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.searchCloudThreads(event, query, workspaceId)
    }
    return threads().search(query)
  })

  registerIpcInvoke(context, 'threads:facets', optionalObjectArg<WorkspaceScoped<ThreadSearchQuery>>('thread facet query', validateThreadSearchWorkspaceQuery), async (event, query) => {
    const workspaceId = workspaceIdFromOptions(query)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.cloudThreadFacets(event, query, workspaceId)
    }
    return threads().facets(query)
  })

  registerIpcInvoke(context, 'threads:tags:list', optionalObjectArg<WorkspaceOptions>('workspace options', normalizeWorkspaceOptions), async (event, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.listCloudThreadTags(event, workspaceId)
    }
    return threads().listTags()
  })

  registerIpcInvoke(context, 'threads:tags:create', objectAndOptionalObjectArgs<ThreadTagInput, WorkspaceOptions>(
    'thread tag input',
    'workspace options',
    (input) => normalizeTagInput(input as unknown as ThreadTagInput),
    normalizeWorkspaceOptions,
  ), async (event, input, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.createCloudThreadTag(event, input, workspaceId)
    }
    return threads().createTag(input)
  })

  registerIpcInvoke(context, 'threads:tags:update', stringAndObjectAndOptionalObjectArgs<ThreadTagInput, WorkspaceOptions>(
    'thread tag id',
    'thread tag input',
    'workspace options',
    {},
    (input) => normalizeTagInput(input as unknown as ThreadTagInput),
    normalizeWorkspaceOptions,
  ), async (event, tagId, input, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.updateCloudThreadTag(event, tagId, input, workspaceId)
    }
    return threads().updateTag(tagId, input)
  })

  registerIpcInvoke(context, 'threads:tags:delete', stringAndOptionalObjectArgs<WorkspaceOptions>('thread tag id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, tagId, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.deleteCloudThreadTag(event, tagId, workspaceId)
    }
    return threads().deleteTag(tagId)
  })

  context.ipcMain.handle('threads:tags:apply', async (event, sessionIds: unknown, tagIds: unknown, options?: unknown) => {
    const normalizedSessionIds = requireStringArray(sessionIds, 'sessionIds')
    const normalizedTagIds = requireStringArray(tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    const workspaceId = readWorkspaceIdOption(options || undefined)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.applyCloudThreadTags(event, normalizedSessionIds, normalizedTagIds, workspaceId)
    }
    return threads().applyTags(normalizedSessionIds, normalizedTagIds)
  })

  context.ipcMain.handle('threads:tags:remove', async (event, sessionIds: unknown, tagIds: unknown, options?: unknown) => {
    const normalizedSessionIds = requireStringArray(sessionIds, 'sessionIds')
    const normalizedTagIds = requireStringArray(tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    const workspaceId = readWorkspaceIdOption(options || undefined)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.removeCloudThreadTags(event, normalizedSessionIds, normalizedTagIds, workspaceId)
    }
    return threads().removeTags(normalizedSessionIds, normalizedTagIds)
  })

  registerIpcInvoke(context, 'threads:smart-filters:list', optionalObjectArg<WorkspaceOptions>('workspace options', normalizeWorkspaceOptions), async (event, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.listCloudThreadSmartFilters(event, workspaceId)
    }
    return threads().listSmartFilters()
  })

  registerIpcInvoke(context, 'threads:smart-filters:create', objectAndOptionalObjectArgs<ThreadSmartFilterInput, WorkspaceOptions>(
    'smart filter input',
    'workspace options',
    (input) => normalizeSmartFilterInput(input as unknown as ThreadSmartFilterInput),
    normalizeWorkspaceOptions,
  ), async (event, input, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.createCloudThreadSmartFilter(event, input, workspaceId)
    }
    return threads().createSmartFilter(input)
  })

  registerIpcInvoke(context, 'threads:smart-filters:update', stringAndObjectAndOptionalObjectArgs<ThreadSmartFilterInput, WorkspaceOptions>(
    'smart filter id',
    'smart filter input',
    'workspace options',
    {},
    (input) => normalizeSmartFilterInput(input as unknown as ThreadSmartFilterInput),
    normalizeWorkspaceOptions,
  ), async (event, filterId, input, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.updateCloudThreadSmartFilter(event, filterId, input, workspaceId)
    }
    return threads().updateSmartFilter(filterId, input)
  })

  registerIpcInvoke(context, 'threads:smart-filters:delete', stringAndOptionalObjectArgs<WorkspaceOptions>('smart filter id', 'workspace options', {}, normalizeWorkspaceOptions), async (event, filterId, options) => {
    const workspaceId = workspaceIdFromOptions(options)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.deleteCloudThreadSmartFilter(event, filterId, workspaceId)
    }
    return threads().deleteSmartFilter(filterId)
  })

  context.ipcMain.handle('threads:suggestions:accept', async (_event, suggestionId: unknown) => {
    if (typeof suggestionId !== 'string') throw new Error('Suggestion id must be a string.')
    return threads().acceptSuggestion(suggestionId)
  })

  context.ipcMain.handle('threads:suggestions:edit', async (_event, suggestionId: unknown, input: unknown) => {
    if (typeof suggestionId !== 'string') throw new Error('Suggestion id must be a string.')
    if (!input || typeof input !== 'object' || typeof (input as { label?: unknown }).label !== 'string') {
      throw new Error('Suggestion edit input must include a label.')
    }
    return threads().editSuggestion(suggestionId, (input as { label: string }).label)
  })

  context.ipcMain.handle('threads:suggestions:dismiss', async (_event, suggestionId: unknown) => {
    if (typeof suggestionId !== 'string') throw new Error('Suggestion id must be a string.')
    return threads().dismissSuggestion(suggestionId)
  })

  context.ipcMain.handle('threads:reindex', async (_event, sessionIds?: unknown) => {
    if (sessionIds === undefined || sessionIds === null) return threads().reindex()
    const normalizedSessionIds = requireStringArray(sessionIds, 'sessionIds')
    return threads().reindex(normalizedSessionIds)
  })
}
