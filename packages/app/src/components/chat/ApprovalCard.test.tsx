import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'
import { permissionSignature } from './permission-approval-model'
import { useSessionStore } from '../../stores/session'
import type { PendingApproval } from '../../stores/session'

const emailApproval: PendingApproval = {
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

function resetApprovalState() {
  useSessionStore.setState((state) => ({
    recentApprovals: [],
    currentView: { ...state.currentView, pendingApprovals: [] },
  }))
}

afterEach(() => {
  resetApprovalState()
})

describe('ApprovalCard typed copy', () => {
  it('uses the shared Studio ApprovalCard shell as its visual base', () => {
    const { container } = render(<ApprovalCard approval={emailApproval} />)
    const shell = container.querySelector('.studio-decision-card.chat-approval-card')
    expect(shell).toBeTruthy()
    expect(shell).toHaveAttribute('data-approval-base', 'studio')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('renders a typed title, type badge, and structured metadata for a bash command', () => {
    const approval: PendingApproval = {
      id: 'p-bash', sessionId: 'session-1', tool: 'bash',
      input: { command: 'npm run deploy', cwd: '/repo' }, description: 'bash', order: 0,
    }
    render(<ApprovalCard approval={approval} />)

    expect(screen.getByText('Run a terminal command')).toBeTruthy()
    expect(screen.getByText('Terminal')).toBeTruthy()
    expect(screen.getByText('npm run deploy')).toBeTruthy()
    expect(screen.getByText('/repo')).toBeTruthy()
  })

  it('marks a destructive command with a Destructive badge', () => {
    const approval: PendingApproval = {
      id: 'p-rm', sessionId: 'session-1', tool: 'bash',
      input: { command: 'rm -rf build' }, description: 'bash', order: 0,
    }
    render(<ApprovalCard approval={approval} />)

    expect(screen.getByText('Run a destructive command')).toBeTruthy()
    expect(screen.getByText('Destructive')).toBeTruthy()
  })

  it('summarizes an integration action and sends an explicit allow decision', async () => {
    const user = userEvent.setup()
    render(<ApprovalCard approval={emailApproval} />)

    expect(screen.getByText('Send an email')).toBeTruthy()
    expect(screen.getAllByText(/user@example\.com.*Launch notes/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(window.coworkApi.permission.respond).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.permission.respond).toHaveBeenNthCalledWith(1, 'permission-1', true, 'session-1', { workspaceId: 'local' })
  })

  it('sends an explicit deny decision', async () => {
    const user = userEvent.setup()
    render(<ApprovalCard approval={emailApproval} />)

    await user.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(window.coworkApi.permission.respond).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.permission.respond).toHaveBeenNthCalledWith(1, 'permission-1', false, 'session-1', { workspaceId: 'local' })
  })

  it('guards the trust gate: a second click after responding does not fire again', async () => {
    const user = userEvent.setup()
    render(<ApprovalCard approval={emailApproval} />)

    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await user.click(screen.getByRole('button', { name: 'Deny' }))

    await waitFor(() => expect(window.coworkApi.permission.respond).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.permission.respond).toHaveBeenNthCalledWith(1, 'permission-1', true, 'session-1', { workspaceId: 'local' })
  })

  it('shows an optional source action for the triggering tool', async () => {
    const user = userEvent.setup()
    const onOpenSource = vi.fn()
    render(<ApprovalCard approval={emailApproval} onOpenSource={onOpenSource} />)

    await user.click(screen.getByRole('button', { name: /Source/ }))

    expect(onOpenSource).toHaveBeenCalledTimes(1)
  })
})

describe('ApprovalCard runaway detection', () => {
  it('warns about a doom-loop and rejects every pending request like it in one click', async () => {
    const user = userEvent.setup()
    const loopingApproval: PendingApproval = {
      id: 'loop-3', sessionId: 'session-1', tool: 'bash',
      input: { command: 'npm test' }, description: 'bash', order: 3,
    }
    const signature = permissionSignature(loopingApproval)
    const sibling: PendingApproval = { ...loopingApproval, id: 'loop-4', order: 4 }

    useSessionStore.setState((state) => ({
      recentApprovals: [
        { id: 'loop-1', signature, at: 1_000 },
        { id: 'loop-2', signature, at: 2_000 },
        { id: 'loop-3', signature, at: 3_000 },
      ],
      currentView: { ...state.currentView, pendingApprovals: [loopingApproval, sibling] },
    }))

    render(<ApprovalCard approval={loopingApproval} />)

    // The runaway banner surfaces the repeat count.
    expect(screen.getByText('This request keeps repeating')).toBeTruthy()

    const stop = screen.getByRole('button', { name: 'Stop and reject all requests like this' })
    await user.click(stop)

    // Both currently-pending requests sharing the signature are denied.
    await waitFor(() => expect(window.coworkApi.permission.respond).toHaveBeenCalledTimes(2))
    expect(window.coworkApi.permission.respond).toHaveBeenCalledWith('loop-3', false, 'session-1', { workspaceId: 'local' })
    expect(window.coworkApi.permission.respond).toHaveBeenCalledWith('loop-4', false, 'session-1', { workspaceId: 'local' })
  })

  it('does not warn when the request has not repeated', () => {
    render(<ApprovalCard approval={emailApproval} />)
    expect(screen.queryByText('This request keeps repeating')).toBeNull()
  })
})
