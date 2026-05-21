import type { IpcHandlerContext } from './context.ts'
import { getThreadIndexService } from '../thread-index/thread-index-service.ts'
import {
  THREAD_BULK_MAX_SESSION_IDS,
  THREAD_FILTER_MAX_VALUES,
  type ThreadSearchQuery,
  type ThreadSmartFilterInput,
  type ThreadTagInput,
} from '@open-cowork/shared'
import { objectArg, optionalObjectArg, registerIpcInvoke, stringAndObjectArgs } from './schema.ts'

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

export function registerThreadHandlers(context: IpcHandlerContext) {
  const threads = () => getThreadIndexService()

  registerIpcInvoke(context, 'threads:search', optionalObjectArg<ThreadSearchQuery>('thread search query'), async (_event, query) => (
    threads().search(query)
  ))

  registerIpcInvoke(context, 'threads:facets', optionalObjectArg<ThreadSearchQuery>('thread facet query'), async (_event, query) => (
    threads().facets(query)
  ))

  context.ipcMain.handle('threads:tags:list', async () => (
    threads().listTags()
  ))

  registerIpcInvoke(context, 'threads:tags:create', objectArg<ThreadTagInput>('thread tag input'), async (_event, input) => (
    threads().createTag(input)
  ))

  context.ipcMain.handle('threads:tags:update', async (_event, tagId: unknown, input: unknown) => {
    if (typeof tagId !== 'string') throw new Error('Tag id must be a string.')
    return threads().updateTag(tagId, input as never)
  })

  context.ipcMain.handle('threads:tags:delete', async (_event, tagId: unknown) => {
    if (typeof tagId !== 'string') throw new Error('Tag id must be a string.')
    return threads().deleteTag(tagId)
  })

  context.ipcMain.handle('threads:tags:apply', async (_event, sessionIds: unknown, tagIds: unknown) => {
    const normalizedSessionIds = requireStringArray(sessionIds, 'sessionIds')
    const normalizedTagIds = requireStringArray(tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    return threads().applyTags(normalizedSessionIds, normalizedTagIds)
  })

  context.ipcMain.handle('threads:tags:remove', async (_event, sessionIds: unknown, tagIds: unknown) => {
    const normalizedSessionIds = requireStringArray(sessionIds, 'sessionIds')
    const normalizedTagIds = requireStringArray(tagIds, 'tagIds', THREAD_FILTER_MAX_VALUES)
    return threads().removeTags(normalizedSessionIds, normalizedTagIds)
  })

  context.ipcMain.handle('threads:smart-filters:list', async () => (
    threads().listSmartFilters()
  ))

  registerIpcInvoke(context, 'threads:smart-filters:create', objectArg<ThreadSmartFilterInput>('smart filter input'), async (_event, input) => (
    threads().createSmartFilter(input)
  ))

  registerIpcInvoke(context, 'threads:smart-filters:update', stringAndObjectArgs<ThreadSmartFilterInput>('smart filter id', 'smart filter input'), async (_event, filterId, input) => (
    threads().updateSmartFilter(filterId, input)
  ))

  context.ipcMain.handle('threads:smart-filters:delete', async (_event, filterId: unknown) => {
    if (typeof filterId !== 'string') throw new Error('Smart filter id must be a string.')
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
