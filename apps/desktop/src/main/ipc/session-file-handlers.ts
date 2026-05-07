import type { IpcHandlerContext } from './context.ts'
import { MAX_FILE_SNIPPET_BYTES } from './session-handler-validation.ts'
import { getBrandName } from '../config-loader.ts'
import { readFileCheckedSync } from '../fs-read.ts'
import { getRuntimeHomeDir } from '../runtime.ts'
import { getSessionRecord } from '../session-registry.ts'

export function registerSessionFileHandlers(context: IpcHandlerContext) {
  // File-snippet reader used by the diff viewer's "Show N unchanged
  // lines" affordance. Reads a byte range from a file that must live
  // under the session's working directory — rejects any path that
  // tries to escape via `..`, absolute prefixes, or pointing outside
  // the session directory. Returns a string[] keyed by 1-based line
  // numbers so the caller can render the unchanged context inline.
  context.ipcMain.handle('session:file-snippet', async (
    _event,
    request: { sessionId: string; filePath: string; startLine: number; endLine: number },
  ) => {
    const { sessionId, filePath, startLine, endLine } = request
    const record = getSessionRecord(sessionId)
    if (!record) throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)

    const root = record.opencodeDirectory || getRuntimeHomeDir()
    const { resolve } = await import('path')
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
    if (!(realPath === realRoot || realPath.startsWith(`${realRoot}/`))) {
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
