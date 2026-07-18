import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from '../deadlines.js'

describe('deadline helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('passes through successful fetch responses before the timeout', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))

    const res = await fetchWithTimeout('https://gateway.example/health', {}, 100, 'health probe')

    expect(await res.text()).toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.example/health', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('aborts hung fetches at the configured deadline', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal
      signal?.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true })
    }))

    const promise = expect(fetchWithTimeout('https://gateway.example/hung', {}, 5, 'hung probe')).rejects.toThrow('hung probe timed out after 5ms')
    await vi.advanceTimersByTimeAsync(5)
    await promise
  })
})
