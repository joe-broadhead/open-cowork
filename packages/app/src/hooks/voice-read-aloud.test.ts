import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueReadAloud,
  getVoiceReadAloudState,
  plainTextForTts,
  resetVoiceReadAloudForTests,
  skipReadAloud,
  stopReadAloud,
} from './voice-read-aloud'

describe('plainTextForTts', () => {
  it('strips fences, links, and markdown noise', () => {
    const raw = [
      '# Title',
      '',
      'Hello **world** and `code`.',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'See [docs](https://example.com) for more.',
    ].join('\n')
    const plain = plainTextForTts(raw)
    expect(plain).toContain('Title')
    expect(plain).toContain('Hello world and code')
    expect(plain).toContain('See docs for more')
    expect(plain).not.toContain('```')
    expect(plain).not.toContain('https://')
    expect(plain).not.toContain('const x')
  })
})

describe('voice read-aloud queue', () => {
  afterEach(async () => {
    await stopReadAloud()
    resetVoiceReadAloudForTests()
    // @ts-expect-error test cleanup
    delete window.coworkApi
  })

  it('speaks plain text via host TTS and clears on stop', async () => {
    const speak = vi.fn(async () => ({ phase: 'ready' }))
    const cancelSpeak = vi.fn(async () => ({ phase: 'ready' }))
    // @ts-expect-error test double
    window.coworkApi = {
      voice: { speak, cancelSpeak },
    }

    enqueueReadAloud('m1', 'Hello **assistant** reply')
    await vi.waitFor(() => expect(speak).toHaveBeenCalled())
    expect(speak).toHaveBeenCalledWith({ text: 'Hello assistant reply' })
    await vi.waitFor(() => expect(getVoiceReadAloudState().phase).toBe('idle'))

    enqueueReadAloud('m2', 'Second')
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(2))
    await stopReadAloud()
    expect(cancelSpeak).toHaveBeenCalled()
    expect(getVoiceReadAloudState().phase).toBe('idle')
    expect(getVoiceReadAloudState().messageId).toBe(null)
  })

  it('append queues a second segment and skip advances', async () => {
    let releaseFirst: (() => void) | null = null
    const speak = vi.fn(async (input: { text: string }) => {
      if (input.text === 'First segment') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      return { phase: 'ready' }
    })
    const cancelSpeak = vi.fn(async () => {
      releaseFirst?.()
      return { phase: 'ready' }
    })
    // @ts-expect-error test double
    window.coworkApi = {
      voice: { speak, cancelSpeak },
    }

    enqueueReadAloud('m1', 'First segment')
    await vi.waitFor(() => expect(speak).toHaveBeenCalledWith({ text: 'First segment' }))
    enqueueReadAloud('m2', 'Second segment', { append: true })
    expect(getVoiceReadAloudState().queueLength).toBe(1)

    await skipReadAloud()
    await vi.waitFor(() => expect(speak).toHaveBeenCalledWith({ text: 'Second segment' }))
    await vi.waitFor(() => expect(getVoiceReadAloudState().phase).toBe('idle'))
  })
})
