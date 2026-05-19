const OPENCODE_SERVER_LISTENING_PREFIX = 'opencode server listening'
const MAX_MANAGED_OPENCODE_OUTPUT_TAIL_BYTES = 16 * 1024

export interface ManagedOpencodeServerStdoutParseResult {
  buffer: string
  url?: string
  error?: string
}

function extractManagedOpencodeServerUrl(line: string) {
  if (!line.startsWith(OPENCODE_SERVER_LISTENING_PREFIX)) return null
  return line.match(/on\s+(https?:\/\/[^\s]+)/)?.[1] || null
}

export function parseManagedOpencodeServerStdoutChunk(
  buffer: string,
  chunk: string,
): ManagedOpencodeServerStdoutParseResult {
  const text = buffer + chunk
  const lines = text.split('\n')
  const nextBuffer = lines.pop() ?? ''

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const url = extractManagedOpencodeServerUrl(line)
    if (url) return { buffer: nextBuffer, url }
    if (line.startsWith(OPENCODE_SERVER_LISTENING_PREFIX)) {
      return { buffer: nextBuffer, error: `Failed to parse server url from output: ${line}` }
    }
  }

  return { buffer: nextBuffer }
}

export function appendManagedOpencodeOutputTail(current: string, chunk: string) {
  const next = current + chunk
  if (Buffer.byteLength(next) <= MAX_MANAGED_OPENCODE_OUTPUT_TAIL_BYTES) return next
  return next.slice(-MAX_MANAGED_OPENCODE_OUTPUT_TAIL_BYTES)
}

export interface ManagedProcessOutputStreams {
  stdout?: { resume(): unknown } | null
  stderr?: { resume(): unknown } | null
}

export function drainManagedOpencodeProcessOutput(proc: ManagedProcessOutputStreams) {
  // Startup parsing stops once the server URL is known, but the child
  // keeps its stdout/stderr pipes. Keep draining them without retaining
  // logs so noisy runtime output cannot fill the pipe buffer.
  proc.stdout?.resume()
  proc.stderr?.resume()
}
