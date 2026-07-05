import { act, fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from './MarkdownContent'

function copyButton(container: HTMLElement) {
  return waitFor(() => {
    const button = container.querySelector('[data-slot="markdown-copy-button"]')
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected rendered markdown code block to include a copy button.')
    }
    return button
  })
}

describe('MarkdownContent', () => {
  it('sanitizes untrusted markdown HTML and copies code through the app clipboard bridge', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <MarkdownContent text={'Hello <img src="x" onerror="alert(1)" />\n<script>alert(1)</script>\n\n```ts\nconst value = 42\n```'} />,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect(container.textContent).toContain('Hello')

    const button = await copyButton(container)
    await user.click(button)

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.coworkApi.clipboard.writeText).mock.calls[0]?.[0]).toContain('const value = 42')
    expect(button.getAttribute('aria-label')).toBe('Copied')
  })

  it('forces rel=noopener on links and strips dangerous href protocols (P2-2)', async () => {
    const { container } = render(
      <MarkdownContent text={'[ok](https://example.com) and [bad](javascript:alert(1))'} />,
    )

    await waitFor(() => expect(container.querySelector('a')).not.toBeNull())
    // Every rendered anchor carries rel=noopener noreferrer.
    const anchors = Array.from(container.querySelectorAll('a'))
    expect(anchors.length).toBeGreaterThan(0)
    expect(anchors.every((a) => a.getAttribute('rel') === 'noopener noreferrer')).toBe(true)
    // No anchor retains a dangerous URL scheme (blocked by the explicit protocol allowlist).
    // Mirror the sanitizer contract: case-insensitive, tolerant of leading whitespace/control chars
    // that browsers ignore, and covering every executable scheme (javascript:/data:/vbscript:).
    // eslint-disable-next-line no-control-regex -- matching leading control chars before a scheme is intentional
    const dangerousScheme = /^[\u0000-\u0020]*(?:javascript|data|vbscript):/i
    expect(anchors.some((a) => dangerousScheme.test(a.getAttribute('href') || ''))).toBe(false)
  })

  it('falls back to the browser clipboard when the app clipboard bridge returns false', async () => {
    vi.mocked(window.coworkApi.clipboard.writeText).mockResolvedValueOnce(false)
    const browserWrite = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
    const user = userEvent.setup()
    const { container } = render(<MarkdownContent text={'```txt\ncopy me\n```'} />)

    const button = await copyButton(container)
    await user.click(button)

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('copy me'))
    expect(browserWrite).toHaveBeenCalledWith(expect.stringContaining('copy me'))
    expect(button.getAttribute('aria-label')).toBe('Copied')
  })

  it('restarts code-copy feedback cleanly on repeated clicks', async () => {
    const { container } = render(<MarkdownContent text={'```txt\ncopy me\n```'} />)
    const button = await copyButton(container)
    vi.useFakeTimers()

    await act(async () => {
      fireEvent.click(button)
    })
    expect(button.getAttribute('aria-label')).toBe('Copied')

    await act(() => vi.advanceTimersByTime(1500))
    await act(async () => {
      fireEvent.click(button)
    })
    await act(() => vi.advanceTimersByTime(1999))
    expect(button.getAttribute('aria-label')).toBe('Copied')

    await act(() => vi.advanceTimersByTime(1))
    expect(button.getAttribute('aria-label')).toBe('Copy code')
  })

  it('renders model-collapsed GFM tables after streaming has finished', async () => {
    const text = '| Day | Date (2026) | Sessions | CVR | |---|---|---|---| | Sun | 26 Apr | 152,762 | 3.03% | | Mon | 27 Apr | 185,921 | 2.90% |'
    const { container } = render(<MarkdownContent text={text} />)

    await waitFor(() => {
      expect(container.querySelector('table')).not.toBeNull()
    })

    expect(container.querySelectorAll('thead th')).toHaveLength(4)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(container.textContent).toContain('152,762')
    expect(container.textContent).not.toContain('|---|---')
  })

  it('renders model-collapsed GFM tables during streaming', async () => {
    const text = '| Metric | Current | Previous | |---|---|---| | Sessions | 906,321 | 1,188,957 | | CVR | 2.79% | 2.82% |'
    const { container } = render(<MarkdownContent text={text} streaming />)

    await waitFor(() => {
      expect(container.querySelector('table')).not.toBeNull()
    })

    expect(container.querySelectorAll('thead th')).toHaveLength(3)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(container.textContent).not.toContain('|---|---')
  })

  it('repairs pipe tables that are missing a separator row', async () => {
    const text = '| Date | Sessions | Converting Sessions |\n| May 03 | 145,918 | 4,352 |\n| May 04 | 151,245 | 4,509 |'
    const { container } = render(<MarkdownContent text={text} />)

    await waitFor(() => {
      expect(container.querySelector('table')).not.toBeNull()
    })

    expect(container.querySelectorAll('thead th')).toHaveLength(3)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(container.textContent).toContain('May 03')
  })
})
