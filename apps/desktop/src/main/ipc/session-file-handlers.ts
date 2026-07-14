import { getSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { readFileCheckedSync } from '@open-cowork/shared/node'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { IpcHandlerContext } from './context.ts'
import { MAX_FILE_SNIPPET_BYTES, normalizeSessionId } from './session-handler-validation.ts'
import { getBrandName } from '@open-cowork/runtime-host/config'

interface PathContainmentSemantics {
  isAbsolute: (path: string) => boolean
  relative: (from: string, to: string) => string
  sep: string
}

const nativePathSemantics: PathContainmentSemantics = { isAbsolute, relative, sep }

export function isPathInsideRoot(
  realRoot: string,
  realPath: string,
  pathSemantics: PathContainmentSemantics = nativePathSemantics,
) {
  const relativePath = pathSemantics.relative(realRoot, realPath)
  return relativePath === '' || (
    !pathSemantics.isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${pathSemantics.sep}`)
  )
}

function normalizeSnippetRequest(request: unknown) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('File snippet request must be an object.')
  }
  const record = request as Record<string, unknown>
  const sessionId = normalizeSessionId(record.sessionId)
  if (typeof record.filePath !== 'string' || !record.filePath.trim()) {
    throw new Error('File snippet path is required.')
  }
  if (Buffer.byteLength(record.filePath, 'utf8') > 4096) {
    throw new Error('File snippet path is too long.')
  }
  if (
    typeof record.startLine !== 'number'
    || typeof record.endLine !== 'number'
    || !Number.isFinite(record.startLine)
    || !Number.isFinite(record.endLine)
  ) {
    throw new Error('File snippet line range must be finite numbers.')
  }
  return {
    sessionId,
    filePath: record.filePath,
    startLine: record.startLine as number,
    endLine: record.endLine as number,
  }
}

export function registerSessionFileHandlers(context: IpcHandlerContext) {
  // File-snippet reader used by the diff viewer's "Show N unchanged
  // lines" affordance. Reads a byte range from a file that must live
  // under the session's working directory — rejects any path that
  // tries to escape via `..`, absolute prefixes, or pointing outside
  // the session directory. Returns a string[] keyed by 1-based line
  // numbers so the caller can render the unchanged context inline.
  context.ipcMain.handle('session:file-snippet', async (
    _event,
    request: unknown,
  ) => {
    const { sessionId, filePath, startLine, endLine } = normalizeSnippetRequest(request)
    const record = getSessionRecord(sessionId)
    if (!record) throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)

    const root = record.opencodeDirectory || getRuntimeHomeDir()
    const { realpathSync } = await import('fs')

    const absoluteRoot = resolve(root)
    const absolutePath = resolve(absoluteRoot, filePath)
    // Dereference symlinks on BOTH sides. Prefix-matching the
    // un-resolved path lets a symlink inside the project dir (e.g.
    // `link -> /etc/passwd`) bypass the containment check; realpath
    // collapses the symlink so the prefix check is semantically
    // meaningful.
    let realRoot: string
    let realPath: string
    try {
      realRoot = realpathSync.native(absoluteRoot)
      realPath = realpathSync.native(absolutePath)
    } catch (err) {
      throw new Error('File is not available for snippet read.', { cause: err })
    }
    if (!isPathInsideRoot(realRoot, realPath)) {
      throw new Error('File snippet path escapes the session directory.')
    }
    let bytes: Buffer
    try {
      ({ bytes } = readFileCheckedSync(realPath, { maxBytes: MAX_FILE_SNIPPET_BYTES }))
    } catch (err) {
      if (err instanceof Error && err.name === 'FileTooLargeError') {
        throw new Error('File is too large for snippet read.', { cause: err })
      }
      throw new Error('File is not available for snippet read.', { cause: err })
    }

    // Cap the range so a pathological request (huge file, wide gap)
    // doesn't paste thousands of lines into the viewer. 500 is plenty
    // of headroom for normal collapsed-context expansion.
    const MAX_LINES = 500
    const safeStart = Math.max(1, Math.floor(startLine))
    const safeEnd = Math.max(safeStart, Math.min(Math.floor(endLine), safeStart + MAX_LINES - 1))

    if (bytes.includes(0)) {
      throw new Error('Binary files are not available for snippet read.')
    }
    const contents = bytes.toString('utf-8')
    const lines = contents.split('\n')
    return lines.slice(safeStart - 1, safeEnd)
  })
}
