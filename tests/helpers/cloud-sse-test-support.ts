import assert from 'node:assert/strict'

class SseReadTimeoutError extends Error {}

export async function readSseUntil(
  response: Response,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 1000,
) {
  const reader = response.body?.getReader()
  assert.ok(reader)
  const decoder = new TextDecoder()
  let buffered = ''
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const chunk = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        setTimeout(
          () => reject(new Error('Timed out waiting for SSE event.')),
          remaining,
        ).unref()
      }),
    ])
    if (chunk.done) break
    buffered += decoder.decode(chunk.value, { stream: true })
    const blocks = buffered.split('\n\n')
    buffered = blocks.pop() || ''
    for (const block of blocks) {
      const data = block.split('\n').find((line) => line.startsWith('data: '))
      if (!data) continue
      const event = JSON.parse(data.slice('data: '.length)) as Record<
        string,
        unknown
      >
      if (predicate(event)) return event
    }
  }
  throw new Error('Timed out waiting for SSE event.')
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new SseReadTimeoutError(message)), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function readInitialStreamChunk(response: Response) {
  const reader = response.body?.getReader()
  assert.ok(reader)
  const chunk = await withTimeout(
    reader.read(),
    1000,
    'Timed out waiting for initial SSE chunk.',
  )
  assert.equal(chunk.done, false)
  return reader
}

export async function waitForStreamReaderClosed(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    try {
      const chunk = await withTimeout(
        reader.read(),
        remaining,
        'Timed out waiting for SSE reader to close.',
      )
      if (chunk.done) return
    } catch (error) {
      if (error instanceof SseReadTimeoutError) throw error
      return
    }
  }
  throw new Error('Timed out waiting for SSE reader to close.')
}
