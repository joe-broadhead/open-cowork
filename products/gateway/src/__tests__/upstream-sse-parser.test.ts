import { describe, expect, it } from 'vitest'
import { IncrementalSseParser, readUpstreamSseFrames, UpstreamSseParserError } from '../upstream-sse-parser.js'

const encoder = new TextEncoder()

describe('IncrementalSseParser', () => {
  it('parses exact-limit frames when delimiters and UTF-8 code points are split across chunks', () => {
    const frame = 'data: {"text":"€"}'
    const bytes = encoder.encode(`${frame}\n\n`)
    const parser = new IncrementalSseParser({
      maxBufferedBytes: encoder.encode(frame).byteLength,
      maxEventBytes: encoder.encode(frame).byteLength,
    })

    const frames: string[] = []
    for (const byte of bytes) parser.consume(Uint8Array.of(byte), frame => { frames.push(frame) })

    expect(frames).toEqual([frame])
    expect(parser.bufferedBytes).toBe(0)
  })

  it('parses multiple CRLF-delimited frames from one chunk', () => {
    const parser = new IncrementalSseParser({ maxBufferedBytes: 1024, maxEventBytes: 1024 })

    expect(consumeFrames(parser, encoder.encode('event: one\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n'))).toEqual([
      'event: one\r\ndata: 1',
      'data: 2',
    ])
  })

  it('parses CR, LF, CRLF, and mixed legal blank-line boundaries across byte chunks', () => {
    const parser = new IncrementalSseParser({ maxBufferedBytes: 1024, maxEventBytes: 1024 })
    const input = [
      'event: one\rdata: 1\r\n\n',
      'event: two\ndata: 2\n\r\n',
      'event: three\r\ndata: 3\r\n\r',
      'event: four\ndata: 4\r\r\n',
      'event: five\r\ndata: 5\r\n\r\n',
    ].join('')
    const frames: string[] = []

    for (const byte of encoder.encode(input)) {
      parser.consume(Uint8Array.of(byte), frame => { frames.push(frame) })
    }

    expect(frames).toEqual([
      'event: one\rdata: 1',
      'event: two\ndata: 2',
      'event: three\r\ndata: 3',
      'event: four\ndata: 4',
      'event: five\r\ndata: 5',
    ])
    expect(parser.bufferedBytes).toBe(0)
  })

  it('streams many frames to a callback without retaining a per-chunk frame array', () => {
    const parser = new IncrementalSseParser({ maxBufferedBytes: 64, maxEventBytes: 64 })
    let frames = 0

    parser.consume(encoder.encode('data: x\n\n'.repeat(20_000)), () => { frames++ })

    expect(frames).toBe(20_000)
    expect(parser.bufferedBytes).toBe(0)
  })

  it('propagates consumer failures without misclassifying them as malformed upstream data', () => {
    const parser = new IncrementalSseParser({ maxBufferedBytes: 64, maxEventBytes: 64 })
    const consumerError = new Error('consumer failed')

    expect(() => parser.consume(encoder.encode('data: x\n\n'), () => { throw consumerError })).toThrow(consumerError)
    expect(parser.bufferedBytes).toBe(0)
  })

  it('fails once with a typed redacted error when a delimiter-free frame exceeds the buffer limit', () => {
    const parser = new IncrementalSseParser({ maxBufferedBytes: 8, maxEventBytes: 8 })

    expect(() => parser.consume(encoder.encode('private-9'), () => {})).toThrowError(
      expect.objectContaining({
        code: 'UPSTREAM_SSE_BUFFER_LIMIT',
        message: 'upstream SSE frame exceeded the buffered-byte limit',
      }),
    )
    expect(parser.bufferedBytes).toBe(0)
    expect(() => parser.consume(encoder.encode('must-not-copy'), () => {})).toThrow(UpstreamSseParserError)
    expect(parser.bufferedBytes).toBe(0)
  })

  it('distinguishes oversized decoded events from invalid UTF-8 without including frame contents', () => {
    const oversized = new IncrementalSseParser({ maxBufferedBytes: 16, maxEventBytes: 4 })
    expect(() => oversized.consume(encoder.encode('secret\n\n'), () => {})).toThrowError(
      expect.objectContaining({
        code: 'UPSTREAM_SSE_EVENT_LIMIT',
        message: 'upstream SSE event exceeded the decoded-event limit',
      }),
    )

    const malformed = new IncrementalSseParser({ maxBufferedBytes: 16, maxEventBytes: 16 })
    expect(() => malformed.consume(Uint8Array.from([100, 97, 116, 97, 58, 32, 0xc3, 0x28, 10, 10]), () => {})).toThrowError(
      expect.objectContaining({
        code: 'UPSTREAM_SSE_INVALID_ENCODING',
        message: 'upstream SSE event used invalid UTF-8',
      }),
    )
  })

  it('cancels the upstream reader and releases its parser buffer after a limit failure', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('delimiter-free-private-body'))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(readUpstreamSseFrames(body, {
      maxBufferedBytes: 8,
      maxEventBytes: 8,
    }, () => {})).rejects.toMatchObject({ code: 'UPSTREAM_SSE_BUFFER_LIMIT' })
    expect(cancelled).toBe(true)
  })
})

function consumeFrames(parser: IncrementalSseParser, chunk: Uint8Array): string[] {
  const frames: string[] = []
  parser.consume(chunk, frame => { frames.push(frame) })
  return frames
}
