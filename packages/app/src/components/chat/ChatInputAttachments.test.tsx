import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatInputAttachments } from './ChatInputAttachments'
import type { Attachment } from './chat-input-types'

const attachments: Attachment[] = [
  {
    id: 'attachment-chart',
    filename: 'chart.png',
    mime: 'image/png',
    url: 'data:image/png;base64,abc',
    preview: 'data:image/png;base64,abc',
  },
  {
    id: 'attachment-brief',
    filename: 'brief.pdf',
    mime: 'application/pdf',
    url: 'data:application/pdf;base64,abc',
  },
]

describe('ChatInputAttachments', () => {
  it('renders image previews, file chips, and removal callbacks by stable attachment id', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()

    render(<ChatInputAttachments attachments={attachments} onRemove={onRemove} />)

    expect(screen.getByAltText('chart.png').getAttribute('src')).toBe('data:image/png;base64,abc')
    expect(screen.getByText('brief.pdf')).toBeTruthy()
    expect(screen.getByText('pdf')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Remove brief.pdf' }))

    expect(onRemove).toHaveBeenCalledWith('attachment-brief')
  })
})
