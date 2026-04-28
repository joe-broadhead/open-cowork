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

// Explorer calls are project-scoped. Returning `null` when the runtime isn't
// up lets each handler serve a stable empty response instead of throwing.
function resolveExplorerClient(directory: string) {
  return getClientForDirectory(directory) || getClient()
}

function resolveExplorerDirectory(context: IpcHandlerContext, directory?: string | null) {
  if (!directory) return null
  try {
    return context.resolveGrantedProjectDirectory(directory)
  } catch (err) {
    context.logHandlerError('explorer:directory', err)
    return undefined
  }
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
    const resolvedDirectory = resolveExplorerDirectory(context, directory)
    if (!resolvedDirectory || !isExplorerPathInsideDirectory(path, resolvedDirectory)) return []
    const client = resolveExplorerClient(resolvedDirectory)
    if (!client) return []
    try {
      const result = await client.file.list({
        path,
        directory: resolvedDirectory,
      })
      return normalizeFileNodes(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:file-list ${path}`, err)
      return []
    }
  })

  context.ipcMain.handle('explorer:file-read', async (_event, path: string, directory?: string | null): Promise<FileContent | null> => {
    const resolvedDirectory = resolveExplorerDirectory(context, directory)
    if (!resolvedDirectory || !isExplorerPathInsideDirectory(path, resolvedDirectory)) return null
    const client = resolveExplorerClient(resolvedDirectory)
    if (!client) return null
    try {
      const result = await client.file.read({
        path,
        directory: resolvedDirectory,
      })
      return normalizeFileContent(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:file-read ${path}`, err)
      return null
    }
  })

  context.ipcMain.handle('explorer:file-status', async (_event, directory?: string | null): Promise<FileStatus[]> => {
    const resolvedDirectory = resolveExplorerDirectory(context, directory)
    if (!resolvedDirectory) return []
    const client = resolveExplorerClient(resolvedDirectory)
    if (!client) return []
    try {
      const result = await client.file.status({ directory: resolvedDirectory })
      return normalizeFileStatuses(result.data)
    } catch (err) {
      context.logHandlerError('explorer:file-status', err)
      return []
    }
  })

  context.ipcMain.handle('explorer:find-files', async (_event, options: FindFilesOptions, directory?: string | null): Promise<string[]> => {
    const resolvedDirectory = resolveExplorerDirectory(context, directory)
    if (!resolvedDirectory) return []
    const client = resolveExplorerClient(resolvedDirectory)
    if (!client) return []
    const query = (options?.query || '').trim()
    if (!query) return []
    try {
      const result = await client.find.files({
        query,
        ...(options.dirs !== undefined ? { dirs: options.dirs ? 'true' : 'false' } : {}),
        ...(options.type ? { type: options.type } : {}),
        ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
        directory: resolvedDirectory,
      })
      return Array.isArray(result.data) ? result.data.filter((entry): entry is string => typeof entry === 'string') : []
    } catch (err) {
      context.logHandlerError(`explorer:find-files ${query}`, err)
      return []
    }
  })

  context.ipcMain.handle('explorer:find-symbols', async (_event, query: string, directory?: string | null): Promise<ExplorerSymbol[]> => {
    const resolvedDirectory = resolveExplorerDirectory(context, directory)
    if (!resolvedDirectory) return []
    const client = resolveExplorerClient(resolvedDirectory)
    if (!client) return []
    const trimmed = (query || '').trim()
    if (!trimmed) return []
    try {
      const result = await client.find.symbols({
        query: trimmed,
        directory: resolvedDirectory,
      })
      return normalizeExplorerSymbols(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:find-symbols ${trimmed}`, err)
      return []
    }
  })

  context.ipcMain.handle('explorer:find-text', async (_event, pattern: string, directory?: string | null): Promise<TextMatch[]> => {
    const resolvedDirectory = resolveExplorerDirectory(context, directory)
    if (!resolvedDirectory) return []
    const client = resolveExplorerClient(resolvedDirectory)
    if (!client) return []
    const trimmed = (pattern || '').trim()
    if (!trimmed) return []
    try {
      const result = await client.find.text({
        pattern: trimmed,
        directory: resolvedDirectory,
      })
      return normalizeTextMatches(result.data)
    } catch (err) {
      context.logHandlerError(`explorer:find-text ${trimmed}`, err)
      return []
    }
  })
}
