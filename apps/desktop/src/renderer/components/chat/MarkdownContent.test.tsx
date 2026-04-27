import { render, waitFor } from '@testing-library/react'
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

  it('leaves the copy affordance unchanged when clipboard writing fails', async () => {
    vi.mocked(window.coworkApi.clipboard.writeText).mockResolvedValueOnce(false)
    const user = userEvent.setup()
    const { container } = render(<MarkdownContent text={'```txt\ncopy me\n```'} />)

    const button = await copyButton(container)
    await user.click(button)

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('copy me'))
    expect(button.getAttribute('aria-label')).toBe('Copy code')
  })
})
