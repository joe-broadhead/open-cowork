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
} from '../explorer-normalizers.ts'

// Explorer calls are project-scoped. Returning `null` when the runtime isn't
// up lets each handler serve a stable empty response instead of throwing.
function resolveExplorerClient(directory: string) {
  return getClientForDirectory(directory) || getClient()
}

type ExplorerClient = NonNullable<ReturnType<typeof resolveExplorerClient>>

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

async function runExplorerOperation<T>(
  context: IpcHandlerContext,
  directory: string | null | undefined,
  fallback: T,
  logScope: string,
  operation: (client: ExplorerClient, resolvedDirectory: string) => Promise<T>,
) {
  const resolvedDirectory = resolveExplorerDirectory(context, directory)
  if (!resolvedDirectory) return fallback
  const client = resolveExplorerClient(resolvedDirectory)
  if (!client) return fallback
  try {
    return await operation(client, resolvedDirectory)
  } catch (err) {
    context.logHandlerError(logScope, err)
    return fallback
  }
}

async function runExplorerPathOperation<T>(
  context: IpcHandlerContext,
  path: string,
  directory: string | null | undefined,
  fallback: T,
  logScope: string,
  operation: (client: ExplorerClient, resolvedDirectory: string) => Promise<T>,
) {
  return runExplorerOperation(context, directory, fallback, logScope, async (client, resolvedDirectory) => {
    if (!isExplorerPathInsideDirectory(path, resolvedDirectory)) return fallback
    return operation(client, resolvedDirectory)
  })
}

export function registerExplorerHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('explorer:file-list', async (_event, path: string, directory?: string | null): Promise<FileNode[]> => {
    return runExplorerPathOperation(context, path, directory, [], `explorer:file-list ${path}`, async (client, resolvedDirectory) => {
      const result = await client.file.list({
        path,
        directory: resolvedDirectory,
      })
      return normalizeFileNodes(result.data)
    })
  })

  context.ipcMain.handle('explorer:file-read', async (_event, path: string, directory?: string | null): Promise<FileContent | null> => {
    return runExplorerPathOperation(context, path, directory, null, `explorer:file-read ${path}`, async (client, resolvedDirectory) => {
      const result = await client.file.read({
        path,
        directory: resolvedDirectory,
      })
      return normalizeFileContent(result.data)
    })
  })

  context.ipcMain.handle('explorer:file-status', async (_event, directory?: string | null): Promise<FileStatus[]> => {
    return runExplorerOperation(context, directory, [], 'explorer:file-status', async (client, resolvedDirectory) => {
      const result = await client.file.status({ directory: resolvedDirectory })
      return normalizeFileStatuses(result.data)
    })
  })

  context.ipcMain.handle('explorer:find-files', async (_event, options: FindFilesOptions, directory?: string | null): Promise<string[]> => {
    const query = (options?.query || '').trim()
    if (!query) return []
    return runExplorerOperation(context, directory, [], `explorer:find-files ${query}`, async (client, resolvedDirectory) => {
      const result = await client.find.files({
        query,
        ...(options.dirs !== undefined ? { dirs: options.dirs ? 'true' : 'false' } : {}),
        ...(options.type ? { type: options.type } : {}),
        ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
        directory: resolvedDirectory,
      })
      return Array.isArray(result.data) ? result.data.filter((entry): entry is string => typeof entry === 'string') : []
    })
  })

  context.ipcMain.handle('explorer:find-symbols', async (_event, query: string, directory?: string | null): Promise<ExplorerSymbol[]> => {
    const trimmed = (query || '').trim()
    if (!trimmed) return []
    return runExplorerOperation(context, directory, [], `explorer:find-symbols ${trimmed}`, async (client, resolvedDirectory) => {
      const result = await client.find.symbols({
        query: trimmed,
        directory: resolvedDirectory,
      })
      return normalizeExplorerSymbols(result.data)
    })
  })

  context.ipcMain.handle('explorer:find-text', async (_event, pattern: string, directory?: string | null): Promise<TextMatch[]> => {
    const trimmed = (pattern || '').trim()
    if (!trimmed) return []
    return runExplorerOperation(context, directory, [], `explorer:find-text ${trimmed}`, async (client, resolvedDirectory) => {
      const result = await client.find.text({
        pattern: trimmed,
        directory: resolvedDirectory,
      })
      return normalizeTextMatches(result.data)
    })
  })
}
