import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatInputAttachments } from './ChatInputAttachments'
import type { Attachment } from './chat-input-types'

const attachments: Attachment[] = [
  {
    filename: 'chart.png',
    mime: 'image/png',
    url: 'data:image/png;base64,abc',
    preview: 'data:image/png;base64,abc',
  },
  {
    filename: 'brief.pdf',
    mime: 'application/pdf',
    url: 'data:application/pdf;base64,abc',
  },
]

describe('ChatInputAttachments', () => {
  it('renders image previews, file chips, and removal callbacks by index', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()

    render(<ChatInputAttachments attachments={attachments} onRemove={onRemove} />)

    expect(screen.getByAltText('chart.png').getAttribute('src')).toBe('data:image/png;base64,abc')
    expect(screen.getByText('brief.pdf')).toBeTruthy()
    expect(screen.getByText('pdf')).toBeTruthy()

    const removeButtons = screen.getAllByRole('button')
    await user.click(removeButtons[1])

    expect(onRemove).toHaveBeenCalledWith(1)
  })
})
