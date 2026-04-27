import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ApprovalCard } from './ApprovalCard'
import type { PendingApproval } from '../../stores/session'

const approval: PendingApproval = {
  id: 'permission-1',
  sessionId: 'session-1',
  tool: 'gmail_send_email',
  input: {
    to: 'user@example.com',
    subject: 'Launch notes',
  },
  description: 'Send a message',
  order: 0,
}

describe('ApprovalCard', () => {
  it('summarizes risky tool actions and sends explicit allow/deny decisions', async () => {
    const user = userEvent.setup()
    render(<ApprovalCard approval={approval} />)

    expect(screen.getByText('Send email')).toBeTruthy()
    expect(screen.getByText(/To: user@example\.com.*Launch notes/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(window.coworkApi.permission.respond).toHaveBeenCalledTimes(2))
    expect(window.coworkApi.permission.respond).toHaveBeenNthCalledWith(1, 'permission-1', true, 'session-1')
    expect(window.coworkApi.permission.respond).toHaveBeenNthCalledWith(2, 'permission-1', false, 'session-1')
  })
})
