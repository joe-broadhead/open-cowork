import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ChatInput } from './ChatInput'

const HISTORY_KEY = 'open-cowork-prompt-history'

describe('ChatInput', () => {
  it('resizes the textarea when navigating prompt history', async () => {
    installRendererTestCoworkApi({
      app: {
        config: vi.fn(async () => ({
          appId: 'com.opencowork.desktop',
          name: 'Open Cowork',
          helpUrl: 'https://github.com/joe-broadhead/open-cowork',
          defaultModel: null,
          providers: { available: [] },
          auth: { mode: 'none' },
        })),
      },
      on: {
        runtimeReady: vi.fn(() => () => undefined),
      },
    })
    const longPrompt = ['first line', 'second line', 'third line', 'fourth line'].join('\n')
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify([longPrompt]))
    useSessionStore.getState().setSessions([
      {
        id: 'session-1',
        title: 'Session 1',
        directory: '/tmp/project',
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
      },
    ])
    useSessionStore.getState().setCurrentSession('session-1')

    render(<ChatInput />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    let scrollHeight = 240
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })

    textarea.setSelectionRange(0, 0)
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    await waitFor(() => expect(textarea).toHaveValue(longPrompt))
    await waitFor(() => expect(textarea.style.height).toBe('180px'))

    scrollHeight = 48
    textarea.setSelectionRange(longPrompt.length, longPrompt.length)
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })

    await waitFor(() => expect(textarea).toHaveValue(''))
    await waitFor(() => expect(textarea.style.height).toBe('48px'))
  })
})
