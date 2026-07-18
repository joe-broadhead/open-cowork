import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { bufferGatewayResponse, gatewayFetch } from '../cli/shared.js'

describe('CLI daemon response deadlines', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cli-http-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = dir
    clearConfigCacheForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('bounds daemon response bodies before exposing them to JSON callers', async () => {
    await expect(bufferGatewayResponse(new Response('12345'), 4)).rejects.toThrow('response exceeds 4 bytes')
  })

  it('keeps the request deadline active through body consumption and cached parsing', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_input: any, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const pending = gatewayFetch('/readiness')
    const rejection = expect(pending).rejects.toThrow('timed out after 5000ms')
    await vi.advanceTimersByTimeAsync(5_001)
    await rejection
  })
})
