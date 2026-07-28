export interface UpstreamSseParserLimits {
  maxBufferedBytes: number
  maxEventBytes: number
}

export type UpstreamSseParserErrorCode =
  | 'UPSTREAM_SSE_BUFFER_LIMIT'
  | 'UPSTREAM_SSE_EVENT_LIMIT'
  | 'UPSTREAM_SSE_INVALID_ENCODING'

const ERROR_MESSAGES: Record<UpstreamSseParserErrorCode, string> = {
  UPSTREAM_SSE_BUFFER_LIMIT: 'upstream SSE frame exceeded the buffered-byte limit',
  UPSTREAM_SSE_EVENT_LIMIT: 'upstream SSE event exceeded the decoded-event limit',
  UPSTREAM_SSE_INVALID_ENCODING: 'upstream SSE event used invalid UTF-8',
}

export class UpstreamSseParserError extends Error {
  constructor(readonly code: UpstreamSseParserErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'UpstreamSseParserError'
  }
}

/**
 * Incremental, byte-bounded SSE frame parser.
 *
 * Bytes are copied into one geometrically grown buffer and decoded only after
 * a complete blank-line delimiter arrives. Once a limit fails, the buffer is
 * released and every later consume call fails without copying input.
 */
export class IncrementalSseParser {
  private bytes = new Uint8Array(0)
  private length = 0
  private skipOptionalLf = false
  private failed?: UpstreamSseParserError
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(private readonly limits: UpstreamSseParserLimits) {
    if (!Number.isInteger(limits.maxBufferedBytes) || limits.maxBufferedBytes < 1) {
      throw new RangeError('maxBufferedBytes must be a positive integer')
    }
    if (!Number.isInteger(limits.maxEventBytes) || limits.maxEventBytes < 1 || limits.maxEventBytes > limits.maxBufferedBytes) {
      throw new RangeError('maxEventBytes must be a positive integer no larger than maxBufferedBytes')
    }
  }

  get bufferedBytes(): number {
    return this.length
  }

  consume(chunk: Uint8Array, onFrame: (frame: string) => void): void {
    if (this.failed) throw this.failed
    for (const byte of chunk) {
      // A CR line ending may legally be followed by LF. When a CR completed the
      // blank line and dispatched the frame, consume that optional LF as part of
      // the delimiter instead of treating it as the start of the next frame.
      if (this.skipOptionalLf) {
        this.skipOptionalLf = false
        if (byte === 10) continue
      }
      this.ensureCapacity(this.length + 1)
      this.bytes[this.length++] = byte

      const delimiterBytes = endingDelimiterBytes(this.bytes, this.length)
      if (delimiterBytes > 0) {
        const eventBytes = this.length - delimiterBytes
        if (eventBytes > this.limits.maxEventBytes) this.fail('UPSTREAM_SSE_EVENT_LIMIT')
        let frame: string
        try {
          frame = this.decoder.decode(this.bytes.subarray(0, eventBytes))
        } catch {
          this.fail('UPSTREAM_SSE_INVALID_ENCODING')
        }
        this.length = 0
        this.skipOptionalLf = byte === 13
        onFrame(frame)
        continue
      }

      const contentBytes = this.length - pendingDelimiterPrefixBytes(this.bytes, this.length)
      if (contentBytes > this.limits.maxBufferedBytes) this.fail('UPSTREAM_SSE_BUFFER_LIMIT')
    }
  }

  dispose(): void {
    this.length = 0
    this.skipOptionalLf = false
    this.bytes = new Uint8Array(0)
  }

  private ensureCapacity(required: number): void {
    if (required <= this.bytes.byteLength) return
    const physicalLimit = this.limits.maxBufferedBytes + 4
    const capacity = Math.min(physicalLimit, Math.max(required, this.bytes.byteLength ? this.bytes.byteLength * 2 : 64))
    if (capacity < required) this.fail('UPSTREAM_SSE_BUFFER_LIMIT')
    const next = new Uint8Array(capacity)
    next.set(this.bytes.subarray(0, this.length))
    this.bytes = next
  }

  private fail(code: UpstreamSseParserErrorCode): never {
    this.failed = new UpstreamSseParserError(code)
    this.dispose()
    throw this.failed
  }
}

export async function readUpstreamSseFrames(
  body: ReadableStream<Uint8Array>,
  limits: UpstreamSseParserLimits,
  onFrame: (frame: string) => void,
): Promise<void> {
  const parser = new IncrementalSseParser(limits)
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      parser.consume(value, onFrame)
    }
  } finally {
    parser.dispose()
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}

function endingDelimiterBytes(bytes: Uint8Array, length: number): number {
  if (length >= 4 && bytes[length - 4] === 13 && bytes[length - 3] === 10 && bytes[length - 2] === 13 && bytes[length - 1] === 10) return 4
  if (length >= 3 && bytes[length - 3] === 13 && bytes[length - 2] === 10 && bytes[length - 1] === 10) return 3
  if (length >= 3 && bytes[length - 3] === 10 && bytes[length - 2] === 13 && bytes[length - 1] === 10) return 3
  if (length >= 3 && bytes[length - 3] === 13 && bytes[length - 2] === 10 && bytes[length - 1] === 13) return 3
  if (length >= 2 && bytes[length - 2] === 10 && bytes[length - 1] === 10) return 2
  if (length >= 2 && bytes[length - 2] === 13 && bytes[length - 1] === 13) return 2
  if (length >= 2 && bytes[length - 2] === 10 && bytes[length - 1] === 13) return 2
  return 0
}

function pendingDelimiterPrefixBytes(bytes: Uint8Array, length: number): number {
  if (length >= 3 && bytes[length - 3] === 13 && bytes[length - 2] === 10 && bytes[length - 1] === 13) return 3
  if (length >= 2 && bytes[length - 2] === 13 && bytes[length - 1] === 10) return 2
  if (bytes[length - 1] === 10 || bytes[length - 1] === 13) return 1
  return 0
}
