import { closeSync, fstatSync, openSync, readFileSync } from 'fs'

export function readFileCheckedSync(
  path: string,
  options?: { maxBytes?: number },
): { bytes: Buffer; size: number } {
  // This opens an existing file read-only; it never creates temp files.
  // Descriptor validation below is what closes the stat/read TOCTOU gap.
  // codeql[js/insecure-temporary-file]
  const fd = openSync(path, 'r')
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) {
      throw new Error('Path is not a regular file.')
    }
    if (typeof options?.maxBytes === 'number' && stats.size > options.maxBytes) {
      const error = new Error(`File is too large: ${stats.size} bytes exceeds ${options.maxBytes} bytes.`)
      error.name = 'FileTooLargeError'
      throw error
    }
    return { bytes: readFileSync(fd), size: stats.size }
  } finally {
    closeSync(fd)
  }
}

export function readTextFileCheckedSync(
  path: string,
  options?: { maxBytes?: number },
): { content: string; size: number } {
  const { bytes, size } = readFileCheckedSync(path, options)
  return { content: bytes.toString('utf-8'), size }
}
