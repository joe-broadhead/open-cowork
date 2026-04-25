import type {
  ExplorerSymbol,
  FileContent,
  FileNode,
  FileStatus,
  FindFilesOptions,
  TextMatch,
} from '@open-cowork/shared'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import type { IpcHandlerContext } from './context.ts'
import { getClient, getClientForDirectory } from '../runtime.ts'
import {
  normalizeExplorerSymbols,
  normalizeFileContent,
  normalizeFileNodes,
  normalizeFileStatuses,
  normalizeTextMatches,
} from '../opencode-adapter.ts'

// Resolve a v2 client for an explorer call. When `directory` is provided we
// route through `getClientForDirectory` so calls stay scoped to the
// workspace the UI is pointed at. Otherwise fall back to the default client.
// Returning `null` when the runtime isn't up lets each handler serve a
// stable empty response instead of throwing — the Explorer panel renders a
// "Runtime not ready" state for that case.
function resolveExplorerClient(directory?: string | null) {
  if (directory) {
    return getClientForDirectory(directory)
  }
  return getClient()
}

export function isExplorerPathInsideDirectory(path: string, directory?: string | null) {
  if (!directory) return false
  if (typeof path !== 'string' || !path.trim()) return false
  try {
    const root = realpathSync.native(resolve(directory))
    const candidate = resolve(root, path)
    if (!existsSync(candidate)) return false
    const realCandidate = realpathSync.native(candidate)
    const relativeToRoot = relative(root, realCandidate)
    return relativeToRoot === '' || (!relativeToRoot.startsWith('..') && !isAbsolute(relativeToRoot))
  } catch {
    return false
  }
}

export function registerExplorerHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('explorer:file-list', async (_event, path: string, directory?: string | null): Promise<FileNode[]> => {
    if (!isExplorerPathInsideDirectory(path, directory)) return []
    const client = resolveExplorerClient(directory)
    if (!client) return []
    try {
      const result = await client.file.list({
        path,
        ...(directory ? { directory } : {}),
      })
      return normalizeFileNodes(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:file-list ${path}`, err)
      return []
    }
  })

  context.ipcMain.handle('explorer:file-read', async (_event, path: string, directory?: string | null): Promise<FileContent | null> => {
    if (!isExplorerPathInsideDirectory(path, directory)) return null
    const client = resolveExplorerClient(directory)
    if (!client) return null
    try {
      const result = await client.file.read({
        path,
        ...(directory ? { directory } : {}),
      })
      return normalizeFileContent(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:file-read ${path}`, err)
      return null
    }
  })

  context.ipcMain.handle('explorer:file-status', async (_event, directory?: string | null): Promise<FileStatus[]> => {
    const client = resolveExplorerClient(directory)
    if (!client) return []
    try {
      const result = await client.file.status(directory ? { directory } : undefined)
      return normalizeFileStatuses(result.data)
    } catch (err) {
      context.logHandlerError('explorer:file-status', err)
      return []
    }
  })

  context.ipcMain.handle('explorer:find-files', async (_event, options: FindFilesOptions, directory?: string | null): Promise<string[]> => {
    const client = resolveExplorerClient(directory)
    if (!client) return []
    const query = (options?.query || '').trim()
    if (!query) return []
    try {
      const result = await client.find.files({
        query,
        ...(options.dirs !== undefined ? { dirs: options.dirs ? 'true' : 'false' } : {}),
        ...(options.type ? { type: options.type } : {}),
        ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
        ...(directory ? { directory } : {}),
      })
      return Array.isArray(result.data) ? result.data.filter((entry): entry is string => typeof entry === 'string') : []
    } catch (err) {
      context.logHandlerError(`explorer:find-files ${query}`, err)
      return []
    }
  })

  context.ipcMain.handle('explorer:find-symbols', async (_event, query: string, directory?: string | null): Promise<ExplorerSymbol[]> => {
    const client = resolveExplorerClient(directory)
    if (!client) return []
    const trimmed = (query || '').trim()
    if (!trimmed) return []
    try {
      const result = await client.find.symbols({
        query: trimmed,
        ...(directory ? { directory } : {}),
      })
      return normalizeExplorerSymbols(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:find-symbols ${trimmed}`, err)
      return []
    }
  })

  context.ipcMain.handle('explorer:find-text', async (_event, pattern: string, directory?: string | null): Promise<TextMatch[]> => {
    const client = resolveExplorerClient(directory)
    if (!client) return []
    const trimmed = (pattern || '').trim()
    if (!trimmed) return []
    try {
      const result = await client.find.text({
        pattern: trimmed,
        ...(directory ? { directory } : {}),
      })
      return normalizeTextMatches(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:find-text ${trimmed}`, err)
      return []
    }
  })
}
