import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEscape, type UseEscapeOptions } from './useEscape'

function pressEscape() {
  // Dispatch through the document so the capture-phase window listener sees a
  // real propagation path (matching how keydown reaches window in the app).
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useEscape', () => {
  it('invokes only the top-most enabled handler', () => {
    const lower = vi.fn()
    const top = vi.fn()
    renderHook(() => useEscape(lower))
    renderHook(() => useEscape(top))

    pressEscape()

    expect(top).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
  })

  it('stops propagation so a window-level fallback listener never fires', () => {
    const windowSpy = vi.fn()
    window.addEventListener('keydown', windowSpy)
    const handler = vi.fn()
    renderHook(() => useEscape(handler))

    try {
      const event = pressEscape()
      expect(handler).toHaveBeenCalledTimes(1)
      expect(windowSpy).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(true)
    } finally {
      window.removeEventListener('keydown', windowSpy)
    }
  })

  it('skips disabled (closed) consumers and falls through to the next enabled one', () => {
    const enabled = vi.fn()
    const disabled = vi.fn()
    renderHook(() => useEscape(enabled))
    renderHook(() => useEscape(disabled, { enabled: false }))

    pressEscape()

    expect(disabled).not.toHaveBeenCalled()
    expect(enabled).toHaveBeenCalledTimes(1)
  })

  it('lets the window fallback fire when no enabled consumer is registered', () => {
    const windowSpy = vi.fn()
    window.addEventListener('keydown', windowSpy)
    const disabled = vi.fn()
    renderHook(() => useEscape(disabled, { enabled: false }))

    try {
      pressEscape()
      expect(disabled).not.toHaveBeenCalled()
      expect(windowSpy).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowSpy)
    }
  })

  it('pops the stack on unmount so the next handler takes over', () => {
    const lower = vi.fn()
    const top = vi.fn()
    renderHook(() => useEscape(lower))
    const { unmount } = renderHook(() => useEscape(top))

    pressEscape()
    expect(top).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()

    unmount()
    pressEscape()
    expect(top).toHaveBeenCalledTimes(1)
    expect(lower).toHaveBeenCalledTimes(1)
  })

  it('honours a live enabled flag without re-ordering the stack', () => {
    const lower = vi.fn()
    const top = vi.fn()
    renderHook(() => useEscape(lower))
    const { rerender } = renderHook(
      ({ options }: { options: UseEscapeOptions }) => useEscape(top, options),
      { initialProps: { options: { enabled: true } } },
    )

    pressEscape()
    expect(top).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()

    // Closing the top consumer (enabled=false) should let the lower one run
    // without the top ever having been removed/re-added to the stack.
    rerender({ options: { enabled: false } })
    pressEscape()
    expect(top).toHaveBeenCalledTimes(1)
    expect(lower).toHaveBeenCalledTimes(1)
  })
})
