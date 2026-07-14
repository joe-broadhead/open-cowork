import { getClient, getClientForDirectory } from '@open-cowork/runtime-host/runtime'
import type {
  ExplorerSymbol,
  FileContent,
  FileNode,
  FileStatus,
  FindFilesOptions,
  TextMatch,
} from '@open-cowork/shared'
import { existsSync, realpathSync } from 'fs'
import { basename, isAbsolute, relative, resolve } from 'path'
import type { IpcHandlerContext } from './context.ts'
import {
  normalizeExplorerSymbols,
  normalizeFileContent,
  normalizeFileStatuses,
  normalizeTextMatches,
} from '../explorer-normalizers.ts'

// Explorer calls are project-scoped. Returning `null` when the runtime isn't
// up lets each handler serve a stable empty response instead of throwing.
function resolveExplorerClient(directory: string) {
  return getClientForDirectory(directory) || getClient()
}

type ExplorerClient = NonNullable<ReturnType<typeof resolveExplorerClient>>
const MAX_FIND_TEXT_PATTERN_BYTES = 512
const NESTED_QUANTIFIER_PATTERN = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+(?:,\d*)?\})/

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

function nativeExplorerRelativePath(path: string, directory: string) {
  const root = realpathSync.native(resolve(directory))
  const target = realpathSync.native(resolve(root, path))
  const relativePath = relative(root, target)
  return relativePath || '.'
}

export function normalizeFindTextPattern(pattern: unknown) {
  if (typeof pattern !== 'string') throw new Error('Find text pattern must be a string.')
  const trimmed = pattern.trim()
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_FIND_TEXT_PATTERN_BYTES) {
    throw new Error(`Find text pattern exceeds ${MAX_FIND_TEXT_PATTERN_BYTES} bytes.`)
  }
  if (NESTED_QUANTIFIER_PATTERN.test(trimmed)) {
    throw new Error('Find text pattern contains a high-cost nested quantifier.')
  }
  return trimmed
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
      const result = await client.v2.fs.list({
        location: { directory: resolvedDirectory },
        path: nativeExplorerRelativePath(path, resolvedDirectory),
      }, { throwOnError: true })
      return result.data.data.map((entry) => ({
        name: basename(entry.path),
        path: entry.path,
        absolute: resolve(resolvedDirectory, entry.path),
        type: entry.type,
        ignored: false,
      }))
    })
  })

  context.ipcMain.handle('explorer:file-read', async (_event, path: string, directory?: string | null): Promise<FileContent | null> => {
    return runExplorerPathOperation(context, path, directory, null, `explorer:file-read ${path}`, async (client, resolvedDirectory) => {
      const result = await client.file.read({
        path,
        directory: resolvedDirectory,
      }, { throwOnError: true })
      return normalizeFileContent(result.data)
    })
  })

  context.ipcMain.handle('explorer:file-status', async (_event, directory?: string | null): Promise<FileStatus[]> => {
    return runExplorerOperation(context, directory, [], 'explorer:file-status', async (client, resolvedDirectory) => {
      const result = await client.file.status({ directory: resolvedDirectory }, { throwOnError: true })
      return normalizeFileStatuses(result.data)
    })
  })

  context.ipcMain.handle('explorer:find-files', async (_event, options: FindFilesOptions, directory?: string | null): Promise<string[]> => {
    const query = (options?.query || '').trim()
    if (!query) return []
    return runExplorerOperation(context, directory, [], `explorer:find-files ${query}`, async (client, resolvedDirectory) => {
      const result = await client.v2.fs.find({
        query,
        ...(options.type
          ? { type: options.type }
          : options.dirs === false
            ? { type: 'file' as const }
            : {}),
        ...(typeof options.limit === 'number' ? { limit: String(options.limit) } : {}),
        location: { directory: resolvedDirectory },
      }, { throwOnError: true })
      return result.data.data.map((entry) => entry.path)
    })
  })

  context.ipcMain.handle('explorer:find-symbols', async (_event, query: string, directory?: string | null): Promise<ExplorerSymbol[]> => {
    const trimmed = (query || '').trim()
    if (!trimmed) return []
    return runExplorerOperation(context, directory, [], `explorer:find-symbols ${trimmed}`, async (client, resolvedDirectory) => {
      const result = await client.find.symbols({
        query: trimmed,
        directory: resolvedDirectory,
      }, { throwOnError: true })
      return normalizeExplorerSymbols(result.data)
    })
  })

  context.ipcMain.handle('explorer:find-text', async (_event, pattern: string, directory?: string | null): Promise<TextMatch[]> => {
    const trimmed = normalizeFindTextPattern(pattern)
    if (!trimmed) return []
    return runExplorerOperation(context, directory, [], `explorer:find-text ${trimmed}`, async (client, resolvedDirectory) => {
      const result = await client.find.text({
        pattern: trimmed,
        directory: resolvedDirectory,
      }, { throwOnError: true })
      return normalizeTextMatches(result.data)
    })
  })
}
